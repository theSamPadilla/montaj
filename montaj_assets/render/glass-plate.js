#!/usr/bin/env node
/**
 * glass-plate.js — the footage under one timeline item, as small blurred frames.
 *
 * An overlay is captured in its own transparent page and composited onto the
 * footage afterwards (renderer.js, encode-segment.js), so CSS backdrop-filter
 * inside it has nothing behind it to blur. Frosted glass gets its footage from
 * a plate instead: the project's video and image tracks for the item's range,
 * scaled down and blurred, one image per frame. The overlay draws plate frame
 * n inside each glass shape, at screen coordinates.
 *
 * The plate is the export's own base composite, not a copy of it. Items are
 * prepared by render.js (normalize, audio strip, remove_bg; an HDR project's
 * per-layer SDR pass), split by planSegments and drawn by encodeSegment, the
 * same calls the export makes before it adds overlays. So every scale, crop,
 * offset, speed and crossfade, and the HDR-to-SDR look of the SDR export, are
 * already in it. Overlays and captions are never drawn.
 *
 * Frame mapping: an overlay's frame 0 is screen frame round(start * fps), and
 * it has round(end * fps) - round(start * fps) frames (render.js
 * collectPuppeteerSegments quantizes both ends to the frame grid first). Plate
 * frame n is screen frame round(start * fps) + n, over the same count.
 *
 * Exports:
 *   plateRange(project, itemId)               → { item, fps, startFrame, endFrame }
 *   plateSize(width, height, shortEdge)       → [w, h]
 *   rangeParts(segments, startFrame, endFrame, fps, vw, vh) → segment parts
 *   renderBaseParts({ projectPath, itemId, shortEdge, sdrCurve, workDir })
 *     → { parts: [{ path, startFrame, frames }], fps, size, startFrame, endFrame }
 *   renderPlates({ projectPath, itemId, shortEdge, sigma, sdrCurve, outDir, ext })
 *     → { frames, fps, size }
 *
 * CLI:
 *   node glass-plate.js --project <project.json> --item <id> --out-dir <dir>
 *     [--short-edge N]   short edge in px (default 270; 0 = the export's own size)
 *     [--sigma S]        gaussian sigma on the small frame (default 2.2; 0 = no blur)
 *     [--sdr-curve <id>] look curve for every HDR-to-SDR conversion
 *     [--ext jpg|png]    frame format (default jpg)
 *
 * stdout: { "frames": [absolute paths], "fps": <project fps>, "size": [w, h] }
 * stderr: progress lines prefixed [montaj glass-plate], JSON error on failure
 * exit 0 success, exit 1 failure
 */
import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

import { isMain as isMainModule } from './is-main.js'
import { ffmpegErrorTail } from './ffmpeg-error.js'
import { requireValidKey, detectFromTransfer, smartDetect, isHdr, DEFAULT_COLOR_SPACE } from './color-space.js'
import { curveIds } from './look.js'
import { planSegments } from './segment-plan.js'
import { encodeSegment, runFfmpeg } from './encode-segment.js'
import { trackItems } from './project-tracks.js'
import {
  collectAllItems, stampSourceProbes, resolveProjectPaths, validateProjectFiles,
  repointStaleUntaggedMasters, prepareVideoItems, prepareSdrPass, outputSize,
} from './render.js'

const isMain = isMainModule(import.meta.url, process.argv[1])

const TTY = process.stderr.isTTY
const C = { cyan: TTY ? '\x1b[96m' : '', reset: TTY ? '\x1b[0m' : '' }

const FFMPEG_TIMEOUT_MS = 600_000
// The overlay design canvas render.js falls back to when a project has no
// settings.resolution (SHORT_EDGE_TARGET on a 9:16 portrait). Only its aspect
// matters here: outputSize returns it when there is no resolution and no clip.
const DESIGN_FALLBACK = [1080, 1920]

/**
 * The item `itemId` names, anywhere in the project (every track, skipped ones
 * included), and the screen frames its overlay would cover.
 * Throws an error whose `plateCode` is 'unknown_item' or 'invalid_item'.
 */
export function plateRange(project, itemId) {
  let item = null
  for (const track of trackItems(project)) {
    item = (track ?? []).find(it => it?.id === itemId) ?? null
    if (item) break
  }
  if (!item) throw codedError('unknown_item', `No item with the id ${JSON.stringify(itemId)} in this project.`)
  if (!Number.isFinite(item.start) || !Number.isFinite(item.end)) {
    throw codedError('invalid_item', `Item ${JSON.stringify(itemId)} has no numeric start and end.`)
  }
  const fps = project.settings?.fps || 30
  // Math.round, as collectPuppeteerSegments' quantize: the overlay's own grid.
  const startFrame = Math.round(item.start * fps)
  const endFrame = Math.round(item.end * fps)
  if (endFrame <= startFrame) {
    throw codedError('invalid_item', `Item ${JSON.stringify(itemId)} covers no frame (start ${item.start}, end ${item.end} at ${fps} fps).`)
  }
  return { item, fps, startFrame, endFrame }
}

/**
 * The plate size for an export of width x height: short edge `shortEdge`, the
 * long edge keeping the aspect, both rounded to even. A falsy `shortEdge` is
 * the export's own size, unscaled.
 */
export function plateSize(width, height, shortEdge) {
  if (!shortEdge) return [width, height]
  const k = shortEdge / Math.min(width, height)
  return [Math.round(width * k / 2) * 2, Math.round(height * k / 2) * 2]
}

/**
 * The planned segments cut to the screen frames [startFrame, endFrame), with
 * a black part (no items) wherever the plan has nothing: before the first
 * clip, after the last, and anywhere the range leaves the timeline. Each part
 * is a planSegments segment, so encodeSegment draws it exactly as the export
 * draws a segment an overlay boundary splits. Frames are counted in integers;
 * the seconds are always `frame / fps`, the planner's own quantized form.
 */
export function rangeParts(segments, startFrame, endFrame, fps, vw, vh) {
  const parts = []
  const push = (seg, a, b) => parts.push({
    ...seg, start: a / fps, end: b / fps, startFrame: a, frames: b - a, vw, vh, fps,
  })
  const black = { items: [], opaqueVideo: false, overlays: [] }
  let f = startFrame
  for (const seg of segments) {
    if (f >= endFrame) break
    const s = Math.round(seg.start * fps)
    const e = Math.round(seg.end * fps)
    if (e <= f) continue
    if (s >= endFrame) break
    if (s > f) { push(black, f, s); f = s }
    const to = Math.min(e, endFrame)
    push(seg, f, to)
    f = to
  }
  if (f < endFrame) push(black, f, endFrame)
  return parts
}

/**
 * The working colour space the export would use, without render.js's write
 * back to project.json (a plate never edits the project): settings.colorSpace
 * when set, else smart-detected from the clips' probed transfers, else SDR.
 */
function workingColorSpace(settings, videoItems) {
  if (settings.colorSpace != null) return requireValidKey(settings.colorSpace)
  if (videoItems.length === 0) return DEFAULT_COLOR_SPACE
  return smartDetect(videoItems
    .filter(it => !(it.remove_bg && it.nobg_src && it.src === it.nobg_src))
    .map(it => detectFromTransfer(it.colorTransfer)))
}

/**
 * The project's image and video items, prepared exactly as the export prepares
 * them, in render.js main()'s order. An SDR project takes the export's own
 * pass; an HDR project takes the per-layer SDR pass that `--export sdr` uses,
 * because a plate is drawn in an overlay page, which is SDR.
 */
async function prepareBaseItems(projectPath) {
  const projectJson = JSON.parse(readFileSync(projectPath, 'utf8'))
  const projectDir = dirname(projectPath)
  resolveProjectPaths(projectJson, projectDir)
  validateProjectFiles(projectJson)
  const pristine = structuredClone(projectJson)
  repointStaleUntaggedMasters(projectJson)
  const settings = projectJson.settings || {}
  const { imageItems, videoItems } = collectAllItems(projectJson)
  const transferCache = new Map()
  stampSourceProbes(videoItems, transferCache)
  const projectColorSpace = workingColorSpace(settings, videoItems)

  let prepared
  if (isHdr(projectColorSpace)) {
    const sdr = await prepareSdrPass(pristine, { projectColorSpace, workspaceDir: projectDir })
    prepared = { imageItems: sdr.imageItems, videoItems: sdr.videoItems }
  } else {
    await prepareVideoItems(videoItems, () => projectColorSpace,
      { settings, workspaceDir: projectDir, transferCache })
    prepared = { imageItems, videoItems }
  }
  // A plate has no sound. Muted, a clip's audio never enters the graph and
  // each part carries encodeSegment's silent track instead; the picture is the same.
  for (const item of prepared.videoItems) item.muted = true
  return { ...prepared, settings, projectJson }
}

/**
 * Render the footage under `itemId` into lossless parts (FFV1 in NUT, the
 * encoder's own intermediate form) in `workDir`, one per planned segment the
 * range crosses. Unblurred: this is the piece a caller that wants plain frames
 * (a tracker, at full or half size) reuses.
 */
export async function renderBaseParts({ projectPath, itemId, shortEdge = 270, sdrCurve = null, workDir }) {
  const absProject = resolve(projectPath)
  const raw = JSON.parse(readFileSync(absProject, 'utf8'))
  const { fps, startFrame, endFrame } = plateRange(raw, itemId)

  const { imageItems, videoItems, settings } = await prepareBaseItems(absProject)
  const [outW, outH] = outputSize(settings, videoItems,
    settings.resolution?.[0] ?? DESIGN_FALLBACK[0], settings.resolution?.[1] ?? DESIGN_FALLBACK[1])
  const [vw, vh] = plateSize(outW, outH, shortEdge)

  // The plan over the whole timeline, then cut to the range, so the range's
  // first part starts mid-segment exactly as an overlay boundary would split it.
  const segments = planSegments([...imageItems, ...videoItems], [], vw, vh, fps)
  const parts = rangeParts(segments, startFrame, endFrame, fps, vw, vh)

  mkdirSync(workDir, { recursive: true })
  const rendered = []
  for (const [i, part] of parts.entries()) {
    part.colorSpace = 'sdr_bt709'
    const path = join(workDir, `part-${String(i).padStart(4, '0')}.nut`)
    log(`part ${i + 1}/${parts.length}: frames ${part.startFrame}-${part.startFrame + part.frames - 1}, ${part.items.length} item(s)`)
    await encodeSegment(part, path, { intermediate: true, sdrCurve })
    rendered.push({ path, startFrame: part.startFrame, frames: part.frames })
  }
  return { parts: rendered, fps, size: [vw, vh], startFrame, endFrame }
}

/**
 * The plate for `itemId`: renderBaseParts, then each part blurred with
 * `sigma` (0 = none) and written one image per frame into `outDir`, named
 * 0000.<ext>, 0001.<ext>, ... from the item's first frame. Every expected
 * file is checked on disk before the list is returned.
 */
export async function renderPlates({ projectPath, itemId, shortEdge = 270, sigma = 2.2, sdrCurve = null, outDir, ext = 'jpg' }) {
  const workDir = join(tmpdir(), `montaj-glass-plate-${randomBytes(6).toString('hex')}`)
  const absOut = resolve(outDir)
  mkdirSync(absOut, { recursive: true })
  try {
    const { parts, fps, size, startFrame, endFrame } =
      await renderBaseParts({ projectPath, itemId, shortEdge, sdrCurve, workDir })
    const vf = sigma > 0 ? ['-vf', `gblur=sigma=${sigma}`] : []
    const quality = ext === 'jpg' ? ['-q:v', '3'] : []
    for (const part of parts) {
      const args = [
        '-y', '-v', 'error', '-i', part.path, ...vf,
        '-frames:v', String(part.frames), ...quality,
        '-start_number', String(part.startFrame - startFrame),
        // image2 reads % in the whole path as a pattern: a folder's own % is doubled.
        join(absOut.replace(/%/g, '%%'), `%04d.${ext}`),
      ]
      const result = await runFfmpeg(args, FFMPEG_TIMEOUT_MS, workDir)
      if (result.status !== 0) {
        // A process the system killed (memory pressure) leaves no stderr: name how it ended.
        const how = result.signal ? `killed by ${result.signal}` : `exit ${result.status}`
        throw new Error(`ffmpeg plate frames failed (${how}): ${result.error?.message ?? ''}${ffmpegErrorTail(result.stderr)}`)
      }
    }
    const frames = []
    for (let n = 0; n < endFrame - startFrame; n++) {
      const p = join(absOut, `${String(n).padStart(4, '0')}.${ext}`)
      if (!existsSync(p)) {
        throw codedError('plate_frame_missing', `plate frame ${n} was not written (${p})`)
      }
      frames.push(p)
    }
    return { frames, fps, size }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

function codedError(code, message) {
  const err = new Error(message)
  err.plateCode = code
  return err
}

function log(msg) {
  process.stderr.write(`${C.cyan}[montaj glass-plate]${C.reset} ${msg}\n`)
}

function fail(code, message) {
  process.stderr.write(JSON.stringify({ error: code, message }) + '\n')
  process.exit(1)
}

if (isMain) {
  const argv = process.argv.slice(2)
  const opts = { shortEdge: 270, sigma: 2.2, sdrCurve: null, ext: 'jpg' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--project')    { opts.projectPath = argv[++i]; continue }
    if (a === '--item')       { opts.itemId = argv[++i]; continue }
    if (a === '--out-dir')    { opts.outDir = argv[++i]; continue }
    if (a === '--short-edge') { opts.shortEdge = Number(argv[++i]); continue }
    if (a === '--sigma')      { opts.sigma = Number(argv[++i]); continue }
    if (a === '--sdr-curve')  { opts.sdrCurve = argv[++i]; continue }
    if (a === '--ext')        { opts.ext = argv[++i]; continue }
    fail('invalid_argument', `unknown argument ${JSON.stringify(a)}`)
  }
  if (!opts.projectPath || opts.itemId == null || !opts.outDir) {
    fail('missing_argument', 'Usage: glass-plate.js --project <project.json> --item <id> --out-dir <dir> '
      + '[--short-edge N] [--sigma S] [--sdr-curve <id>] [--ext jpg|png]')
  }
  if (!existsSync(opts.projectPath)) fail('file_not_found', `project.json not found: ${opts.projectPath}`)
  if (!Number.isInteger(opts.shortEdge) || opts.shortEdge < 0 || opts.shortEdge === 1) {
    fail('invalid_argument', `--short-edge must be 0 or an integer of at least 2, got ${opts.shortEdge}`)
  }
  if (!Number.isFinite(opts.sigma) || opts.sigma < 0) {
    fail('invalid_argument', `--sigma must be a number of at least 0, got ${opts.sigma}`)
  }
  if (opts.sdrCurve != null && !curveIds().includes(opts.sdrCurve)) {
    fail('invalid_sdr_curve', `--sdr-curve ${JSON.stringify(opts.sdrCurve)} is not a known look curve. Expected one of ${curveIds().join(', ')}.`)
  }
  if (!['jpg', 'png'].includes(opts.ext)) fail('invalid_argument', `--ext must be jpg or png, got ${opts.ext}`)

  renderPlates(opts).then(
    result => process.stdout.write(JSON.stringify(result) + '\n'),
    err => fail(err.plateCode ?? 'glass_plate_failed', err.message),
  )
}
