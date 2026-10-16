// render/nle/graphics.js
/**
 * The graphics of an editor export: every overlay (a `kind: 'graphic'` clip of
 * `nle/timeline.js`) and the caption layer, each rendered ONCE into a
 * full-canvas ProRes 4444 movie with alpha that the FCP7 XML (`nle/xmeml.js`)
 * places untransformed over the clip's own window.
 *
 * `renderNleGraphics(project, timeline, { projectDir, outDir, onProgress })`
 * writes `outDir/graphics/<clip id>.mov` per graphic and `outDir/captions.mov`
 * for the caption layer, and returns `{ graphics, captions, seconds, warnings }`
 * (`graphics` maps clip id to absolute path, the shape `writeXmeml` takes).
 *
 * ── THE CONTRACT (xmeml.js) ─────────────────────────────────────────────────
 *
 * Frame 0 of a movie is its clip's `startFrame`, and it is exactly
 * `endFrame - startFrame` frames long at the sequence fps, at the project's
 * `settings.resolution`. The layer's transform, keyframes, opacity and motion
 * blur are in the pixels. The captions movie spans `captionsTrack`'s clip the
 * same way.
 *
 * ── THE SAME PIXELS AS THE RENDER ───────────────────────────────────────────
 *
 * Nothing here draws. Each movie is the render's own two stages for that one
 * layer:
 *
 *   1. The capture. `collectPuppeteerSegments` (render.js) builds the layer's
 *      segment spec from the whole project, exactly as a render does (props,
 *      fonts, keyframes, the opaque and crossfade-incoming flags), and
 *      `bundleSegmentSpec` bundles it on the render's design canvas
 *      (`designCanvasFor`) at its capture scale (`captureScaleFor`).
 *      `renderAllSegments` (renderer.js) then captures it headless, with the
 *      project's motion blur, into the render's FFV1 chunk. The one thing a
 *      render never does is start partway in: `frameFrom`/`frameTo` (renderer.js's
 *      window) capture only the clip's window of the page's own clock (an overlay that starts before
 *      the timeline, or the caption layer, whose page runs on timeline time
 *      from 0).
 *   2. The composite. `buildOverlayFilterParts` (encode-segment.js), the
 *      compositor every render segment uses, places that capture on the output
 *      canvas from the descriptor `overlayDescriptor` (slice-run.js) builds:
 *      the design-to-output scale, the static offset, scale, rotation and
 *      opacity, or the identity for a keyframed layer, whose motion is already
 *      in the capture. The canvas under it is transparent instead of black,
 *      and ffmpeg's `overlay` over a transparent canvas keeps the layer's own
 *      colour and alpha (straight alpha, which xmeml.js declares).
 *
 * ── COLOUR ──────────────────────────────────────────────────────────────────
 *
 * The movie is SDR, Rec.709, tagged so: the capture's BT.601 encode is turned
 * into BT.709 in the compositor's own scale step, as an SDR render does
 * (`captureToBt709`). An HDR project's render maps graphics into HLG or PQ
 * (hdr-graphics.js); the editor movie does not, and a warning says the editor
 * has to place it in its HDR timeline itself.
 *
 * ── LEFT OUT ────────────────────────────────────────────────────────────────
 *
 * `renderMode: 'ffmpeg-drawtext'` draws captions with ffmpeg drawtext
 * (lyrics_render.py), which cannot write alpha, so that caption layer is not
 * rendered: a warning says so and `captions` is null.
 *
 * Scratch (bundles, frame PNGs, capture chunks) goes to the OS temp dir, never
 * the project, and each movie's is removed as soon as the movie is written.
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'

import {
  collectPuppeteerSegments,
  captureScaleFor,
  designCanvasFor,
  bundleSegmentSpec,
  resolveProjectPaths,
} from '../render.js'
import { overlayDescriptor } from '../slice-run.js'
import { renderAllSegments } from '../renderer.js'
import { cleanupBundle } from '../bundle.js'
import { cleanFileName } from './file-name.js'
import { prefetchPropsUrls } from '../page-guard.js'
import { namedPropsUrls } from '../overlay-build.js'
import { buildOverlayFilterParts } from '../encode-segment.js'
import { FFMPEG } from '../ffmpeg-bin.js'
import { externalizeFilterGraph } from '../filter-script.js'
import { isHdr } from '../color-space.js'
import { trackItems } from '../project-tracks.js'

/** Where a movie's composite and encode may run before it is called stuck. */
const FFMPEG_TIMEOUT_MS = 600_000

/** The tags of the SDR movie: Rec.709, limited range (the render's SDR canvas). */
const BT709_PARAMS = 'setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709:range=tv'

/**
 * ProRes 4444 with a 16-bit alpha plane, 10-bit 4:4:4, tagged Rec.709. `-vendor
 * apl0` writes the vendor Apple's own encoder writes into each ProRes FRAME
 * header (measured: the string is in the file once). The container's sample
 * description keeps ffmpeg's own `FFMP` vendor either way (a `vendor_id`
 * stream tag does not change it, measured), and editors read both.
 */
const PRORES_4444_ARGS = [
  '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
  '-alpha_bits', '16', '-vendor', 'apl0',
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
]

/**
 * Render the editor export's graphics and caption movies.
 *
 * @param {object} project  The Montaj project (as on disk; never mutated).
 * @param {import('./timeline.js').NleTimeline} timeline  `buildNleTimeline(project, { projectDir })`.
 * @param {{
 *   projectDir: string,
 *   outDir: string,
 *   onProgress?: (p: { done: number, total: number, label: string }) => void,
 *   workers?: number,
 * }} options
 *   `projectDir`: the folder holding project.json. `outDir`: the export folder;
 *   graphics go to `outDir/graphics/`, the captions to `outDir/captions.mov`.
 *   `onProgress` is called once per finished movie, `label` being the clip id
 *   (or `'captions'`). `workers` caps the capture's browsers, as render.js
 *   `--workers` does.
 * @returns {Promise<{
 *   graphics: Object<string, string>,
 *   captions: string | null,
 *   seconds: number,
 *   warnings: string[],
 * }>}  `graphics` maps each rendered clip's id to its movie (absolute);
 *   `seconds` is the wall time taken.
 */
export async function renderNleGraphics(project, timeline, { projectDir, outDir, onProgress, workers } = /** @type {any} */ ({})) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    throw new TypeError('renderNleGraphics: options.projectDir is required')
  }
  if (typeof outDir !== 'string' || outDir.length === 0) {
    throw new TypeError('renderNleGraphics: options.outDir is required')
  }
  const startedAt = Date.now()
  const absOutDir = resolve(outDir)
  const absProjectDir = resolve(projectDir)
  const warnings = []

  // The render's own view of the project: paths resolved as render.js resolves
  // them, on a copy.
  const work = structuredClone(project)
  resolveProjectPaths(work, absProjectDir)

  const fps = timeline.fps
  const settings = work.settings ?? {}
  const [designW, designH] = designCanvasFor(settings.resolution)
  const captureScale = captureScaleFor(settings.resolution)
  const motionBlur = timeline.motionBlur ?? 1

  if (isHdr(timeline.colorSpace)) {
    warnings.push(`HDR project (${timeline.colorSpace}): graphics and captions are SDR (Rec.709) movies with alpha; `
      + 'place them in the HDR timeline in the editor, which sets their brightness there')
  }

  // Each graphic's item is renamed to a token on the copy, so its segment spec
  // can be found by id whatever the item's own id is (missing, repeated, or
  // holding characters a spec id cannot).
  const graphicClips = timeline.videoTracks.flatMap((t) => t.clips.filter((c) => c.kind === 'graphic'))
  const tokens = new Map()
  const items = trackItems(work)
  graphicClips.forEach((clip, n) => {
    const item = items[clip.trackIndex]?.[clip.itemIndex]
    if (item?.type !== 'overlay') return
    const token = `__nle_graphic_${n}__`
    item.id = token
    tokens.set(clip, token)
  })

  // The specs' own outputPath is never used: each capture writes to its movie's scratch.
  const specs = collectPuppeteerSegments(work, fps, designW, designH, tmpdir())
  for (const spec of specs) spec.captureScale = captureScale

  /** @type {{ label: string, key: string | null, spec: object, frameOffset: number, frameCount: number, outPath: string }[]} */
  const jobs = []
  const names = new Set()
  for (const clip of graphicClips) {
    const token = tokens.get(clip)
    const spec = token && specs.find((s) => s.id === `overlay-${clip.trackIndex}--${token}`)
    if (!spec) {
      warnings.push(`graphic ${clip.id}: the render draws nothing for it; not rendered`)
      continue
    }
    const fileName = uniqueFileName(clip.id, names)
    jobs.push({
      label: clip.id,
      key: clip.id,
      spec,
      // The overlay's own clock at the clip's first frame (timeline.js sourceIn).
      frameOffset: Math.round(clip.sourceIn * fps),
      frameCount: clip.endFrame - clip.startFrame,
      outPath: join(absOutDir, 'graphics', `${fileName}.mov`),
    })
  }

  const captionsClip = timeline.captionsTrack?.clips?.[0] ?? null
  if (captionsClip) {
    if (work.renderMode === 'ffmpeg-drawtext') {
      warnings.push('captions: renderMode ffmpeg-drawtext draws them with ffmpeg, which writes no alpha; '
        + 'the caption layer is not rendered for the editor')
    } else {
      const spec = specs.find((s) => s.id === 'captions')
      if (!spec) {
        warnings.push('captions: the render draws no caption layer; not rendered')
      } else {
        jobs.push({
          label: 'captions',
          key: null,
          spec,
          // The caption page runs on timeline time from 0.
          frameOffset: captionsClip.startFrame,
          frameCount: captionsClip.endFrame - captionsClip.startFrame,
          outPath: join(absOutDir, 'captions.mov'),
        })
      }
    }
  }

  // Every props URL the pages name, fetched once by Node, as render.js does.
  await prefetchPropsUrls(jobs.flatMap((j) => namedPropsUrls(j.spec.props)))

  const graphics = {}
  let captions = null
  let done = 0
  for (const job of jobs) {
    await renderMovie(job, { fps, width: timeline.width, height: timeline.height, designW, designH, projectDir: absProjectDir, motionBlur, workers })
    if (job.key === null) captions = job.outPath
    else graphics[job.key] = job.outPath
    done++
    onProgress?.({ done, total: jobs.length, label: job.label })
  }

  return { graphics, captions, seconds: (Date.now() - startedAt) / 1000, warnings }
}

/**
 * One movie: bundle the layer's page, capture its window, composite it on a
 * transparent output canvas and encode ProRes 4444. Its scratch is gone when
 * this returns, and so is a half-written movie when it throws.
 */
async function renderMovie(job, { fps, width, height, designW, designH, projectDir, motionBlur, workers }) {
  const { spec, frameOffset, frameCount, outPath } = job
  if (frameCount <= 0) throw new Error(`renderNleGraphics: ${job.label} has no frames`)
  if (frameOffset < 0 || frameOffset + frameCount > spec.frameCount) {
    throw new Error(`renderNleGraphics: ${job.label} asks for frames ${frameOffset} to ${frameOffset + frameCount}, `
      + `but its layer has ${spec.frameCount}`)
  }

  const scratch = mkdtempSync(join(tmpdir(), 'montaj-nle-graphics-'))
  let bundleDir = null
  try {
    // The page is the render's, built for the layer's FULL length; only the
    // capture is windowed.
    bundleDir = await bundleSegmentSpec(spec, { fps, width: designW, height: designH, projectDir })
    const segment = {
      ...spec,
      id: `nle-${job.label}`.replace(/[^A-Za-z0-9._-]/g, '_'),
      // renderer.js's window (§434): frames frameOffset to frameOffset + frameCount of the page's own clock
      frameFrom: frameOffset,
      frameTo: frameOffset + frameCount,
      outputPath: join(scratch, 'capture.mkv'),
    }
    const [captured] = await renderAllSegments([segment], { workers, motionBlur })

    // The capture's frame 0 is the movie's frame 0.
    const duration = frameCount / fps
    const ov = { webmPath: captured.webmPath, startSeconds: 0 }
    overlayDescriptor(spec, ov)

    mkdirSync(dirname(outPath), { recursive: true })
    await encodeMovie(ov, { fps, width, height, frameCount, duration, outPath, scratch })
  } catch (err) {
    rmSync(outPath, { force: true })
    throw err
  } finally {
    if (bundleDir) cleanupBundle(bundleDir)
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * The capture onto a transparent `width` x `height` canvas through the render's
 * compositor, then ProRes 4444. `overlay` over a canvas whose alpha is 0 takes
 * the layer's colour wherever the layer has any alpha, and its alpha as is.
 */
async function encodeMovie(ov, { fps, width, height, frameCount, duration, outPath, scratch }) {
  // One frame past the end, so the canvas can never come up a frame short;
  // -frames:v cuts at exactly frameCount.
  const canvasSeconds = (frameCount + 1) / fps
  const filterParts = [
    `[0:v]format=yuva420p,${BT709_PARAMS}[canvas]`,
  ]
  const { inputArgs, filterParts: ovParts, newVideoLabel } = buildOverlayFilterParts(
    ov, width, height, 1, '[canvas]', 0, duration, { fps, captureToBt709: true })
  filterParts.push(...ovParts, `${newVideoLabel}format=yuva444p10le,${BT709_PARAMS}[vout]`)

  // The graph goes to ffmpeg as a file, as every render spawn's does (WIN1b,
  // filter-script.js), though one layer's graph is far under Windows' cap.
  const script = externalizeFilterGraph([
    '-y', '-v', 'error',
    // The format stays INSIDE the lavfi input: the input stream otherwise
    // leaves the device as yuv420p, and the canvas comes out opaque black.
    '-f', 'lavfi', '-i', `color=c=black@0.0:size=${width}x${height}:rate=${fps}:duration=${canvasSeconds},format=yuva420p`,
    ...inputArgs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[vout]',
    '-frames:v', String(frameCount),
    '-r', String(fps),
    ...PRORES_4444_ARGS,
    '-an',
    outPath,
  ], scratch)
  try {
    await runFfmpeg(script.args)
  } finally {
    script.cleanup()
  }
  if (!existsSync(outPath)) throw new Error(`renderNleGraphics: ffmpeg wrote no movie at ${outPath}`)
}

function runFfmpeg(args) {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(FFMPEG, args)
    let stderr = ''
    const timer = setTimeout(() => proc.kill('SIGKILL'), FFMPEG_TIMEOUT_MS)
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`renderNleGraphics: ffmpeg failed (${signal ? `killed by ${signal}` : `exit ${code}`}):\n${stderr.slice(-800)}`))
    })
  })
}

/**
 * A file name for a clip id: the id itself when it is a safe name, with any
 * path or reserved character replaced, and made unique without regard to case
 * (macOS and Windows folders are case-insensitive).
 */
function uniqueFileName(id, taken) {
  const base = cleanFileName(id)
  let name = base
  let n = 2
  while (taken.has(name.toLowerCase())) name = `${base}-${n++}`
  taken.add(name.toLowerCase())
  return name
}
