#!/usr/bin/env node
/**
 * sample-frame.js — Single-frame preview tools for overlay JSX and composed project frames.
 *
 * Exports:
 *   sampleOverlay({ componentPath, props, frame, fps, width, height, googleFonts, measure, outPath })
 *     → { pngPath, measurements? }
 *   sampleFrame({ projectJson, atSeconds, outPath })
 *     → { pngPath }
 *
 * CLI:
 *   node sample-frame.js --mode overlay --component <path> [--frame N] [--fps N]
 *     [--width W] [--height H] [--props '{...}'] [--google-fonts font1,font2]
 *     [--measure] --out <path>
 *
 *   node sample-frame.js --mode frame --project <path> --at <seconds> --out <path>
 *
 * stdout: absolute PNG path (or JSON with measurements if --mode overlay --measure)
 * stderr: progress lines prefixed [montaj sample]
 * exit 0 success, exit 1 failure
 */
import puppeteer from 'puppeteer'
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, copyFileSync, rmSync } from 'fs'
import { resolve, join, dirname, basename, extname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { createHash } from 'crypto'

import { bundleComponent, cleanupBundle } from './bundle.js'
import { pMap } from './p-map.js'
import { FFMPEG } from './ffmpeg-bin.js'
import { isHdr } from './color-space.js'
import { curveIds, lutPath, MASTER_LOOK } from './look.js'
import {
  buildImageItemFilterParts,
  buildVideoItemFilterParts,
  buildOverlayFilterParts,
  buildVividLutChain,
  hasZscale,
  hasLut3d,
} from './encode-segment.js'
import { resolveAt, RESOLVER_VERSION } from '@bycrux/timeline-core'
import { enabledTrackItems, trackItems, withEnabledItemTracks } from './project-tracks.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isMain = resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)

const TTY = process.stderr.isTTY
const C = { cyan: TTY ? '\x1b[96m' : '', reset: TTY ? '\x1b[0m' : '' }

const CACHE_DIR = join(tmpdir(), 'montaj-sample-cache')
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24 hours
const OVERLAY_CONCURRENCY = 4
const SHORT_EDGE_TARGET = 1080

// When previewing a single overlay frame we don't know the item's real on-screen
// length. Overlays commonly fade OUT over the final ~15 frames keyed to the
// `duration` global; if `duration === frame + 1` (the old default) every sampled
// frame renders at the overlay's dying edge and looks faded/washed out. Default
// to a generous tail past the sampled frame so end-of-life animations never fire
// on a standalone preview. Callers that DO know the real length (sampleFrame, and
// the CLI --duration flag) pass it explicitly for a WYSIWYG result.
const PREVIEW_TAIL_FRAMES = 600

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (isMain) {
  const argv = process.argv.slice(2)

  if (!argv.length || argv.includes('--help')) {
    process.stderr.write(
      'Usage:\n' +
      '  sample-frame.js --mode overlay --component <path> [--frame N] [--fps N]\n' +
      '    [--width W] [--height H] [--props \'...\'] [--google-fonts f1,f2]\n' +
      '    [--duration N] [--measure] --out <path>\n' +
      '  sample-frame.js --mode frame --project <path> --at <seconds> [--sdr-curve <id>]\n' +
      '    --out <path>\n'
    )
    process.exit(1)
  }

  let mode          = null
  // overlay args
  let componentArg  = null
  let frameArg      = 0
  let fpsArg        = 30
  let widthArg      = 1080
  let heightArg     = 1920
  let propsArg      = {}
  let googleFontsArg = []
  let measureArg    = false
  let durationArg   = null
  // frame args
  let projectArg    = null
  let atArg         = null
  let sdrCurveArg   = null
  // shared
  let outArg        = null

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mode')         { mode          = argv[++i]; continue }
    if (a === '--component')    { componentArg  = argv[++i]; continue }
    if (a === '--frame')        { frameArg      = parseInt(argv[++i], 10); continue }
    if (a === '--duration')     { durationArg   = parseInt(argv[++i], 10); continue }
    if (a === '--fps')          { fpsArg        = parseInt(argv[++i], 10); continue }
    if (a === '--width')        { widthArg      = parseInt(argv[++i], 10); continue }
    if (a === '--height')       { heightArg     = parseInt(argv[++i], 10); continue }
    if (a === '--props')        { try { propsArg = JSON.parse(argv[++i]) } catch { fail('invalid_props', `--props is not valid JSON`) }; continue }
    if (a === '--google-fonts') { googleFontsArg = argv[++i].split(',').filter(Boolean); continue }
    if (a === '--measure')      { measureArg    = true; continue }
    if (a === '--project')      { projectArg    = argv[++i]; continue }
    if (a === '--at')           { atArg         = parseFloat(argv[++i]); continue }
    if (a === '--sdr-curve')    { sdrCurveArg   = argv[++i]; continue }
    if (a === '--out')          { outArg        = argv[++i]; continue }
  }

  if (!mode) fail('missing_argument', '--mode overlay|frame is required')
  if (!outArg) fail('missing_argument', '--out <path> is required')

  // Validate against the manifest here rather than letting look.js throw deep
  // inside the extract: a typo'd curve id should be a clean CLI error, not a
  // stack trace half a pipeline in.
  if (sdrCurveArg !== null && !curveIds().includes(sdrCurveArg)) {
    fail('invalid_sdr_curve',
      `--sdr-curve '${sdrCurveArg}' is not a known look curve. `
      + `Expected one of ${JSON.stringify(curveIds())}.`)
  }

  if (mode === 'overlay') {
    if (!componentArg) fail('missing_argument', '--component <path> is required for --mode overlay')
    sampleOverlay({
      componentPath: resolve(componentArg),
      props: propsArg,
      frame: frameArg,
      fps: fpsArg,
      width: widthArg,
      height: heightArg,
      googleFonts: googleFontsArg,
      measure: measureArg,
      durationFrames: durationArg,
      outPath: resolve(outArg),
    }).then(result => {
      if (measureArg) {
        process.stdout.write(JSON.stringify({ pngPath: result.pngPath, measurements: result.measurements }) + '\n')
      } else {
        process.stdout.write(result.pngPath + '\n')
      }
    }).catch(err => {
      if (err.sampleError) {
        process.stderr.write(JSON.stringify({ error: err.sampleError, message: err.message }) + '\n')
      } else {
        process.stderr.write(JSON.stringify({ error: 'sample_failed', message: err.message }) + '\n')
      }
      process.exit(1)
    })
  } else if (mode === 'frame') {
    if (!projectArg) fail('missing_argument', '--project <path> is required for --mode frame')
    if (atArg == null) fail('missing_argument', '--at <seconds> is required for --mode frame')
    sampleFrame({
      projectJson: resolve(projectArg),
      atSeconds: atArg,
      outPath: resolve(outArg),
      sdrCurve: sdrCurveArg,
    }).then(result => {
      process.stdout.write(result.pngPath + '\n')
    }).catch(err => {
      process.stderr.write(JSON.stringify({ error: 'sample_failed', message: err.message }) + '\n')
      process.exit(1)
    })
  } else {
    fail('invalid_mode', `--mode must be 'overlay' or 'frame', got '${mode}'`)
  }
}

// ---------------------------------------------------------------------------
// sampleOverlay
// ---------------------------------------------------------------------------

/**
 * Render one overlay JSX at one frame position to a PNG.
 *
 * @param {object} opts
 * @param {string}   opts.componentPath  Absolute path to the .jsx file
 * @param {object}   [opts.props]        Props to pass
 * @param {number}   [opts.frame]        Frame number (default 0)
 * @param {number}   [opts.fps]          Frames per second (default 30)
 * @param {number}   [opts.width]        Canvas width (default 1080)
 * @param {number}   [opts.height]       Canvas height (default 1920)
 * @param {string[]} [opts.googleFonts]  Google Fonts entries
 * @param {boolean}  [opts.measure]      If true, walk DOM and return measurements
 * @param {string}   opts.outPath        Where to write the PNG (required)
 * @returns {Promise<{ pngPath: string, measurements?: object }>}
 */
export async function sampleOverlay({
  componentPath,
  props = {},
  frame = 0,
  fps = 30,
  width = 1080,
  height = 1920,
  googleFonts = [],
  measure = false,
  durationFrames = null,
  outPath,
}) {
  if (!outPath) throw Object.assign(new Error('outPath is required'), { sampleError: 'missing_argument' })
  if (!componentPath) throw Object.assign(new Error('componentPath is required'), { sampleError: 'missing_argument' })

  // Resolve the `duration` global handed to the overlay. When the caller knows
  // the item's real length they pass it (WYSIWYG, incl. fade-in/out); otherwise
  // default to a tail past the sampled frame so end-of-life fades don't fire.
  const effectiveDuration = durationFrames != null
    ? Math.max(1, durationFrames)
    : frame + PREVIEW_TAIL_FRAMES

  // GC cache on every call
  gcCache()

  // Build cache key
  const cacheKey = buildOverlayCacheKey(componentPath, props, frame, width, height, googleFonts, measure, effectiveDuration)
  const cachePng = join(CACHE_DIR, `${cacheKey}.png`)
  const cacheJson = join(CACHE_DIR, `${cacheKey}.json`)

  // Cache hit
  if (existsSync(cachePng)) {
    log(`cache hit for ${basename(componentPath)} frame ${frame}`)
    mkdirSync(dirname(outPath), { recursive: true })
    copyFileSync(cachePng, outPath)
    if (measure && existsSync(cacheJson)) {
      const measurements = JSON.parse(readFileSync(cacheJson, 'utf8'))
      return { pngPath: outPath, measurements }
    }
    return { pngPath: outPath }
  }

  log(`sampling overlay ${basename(componentPath)} at frame ${frame}${measure ? ' (measure)' : ''}`)

  const { htmlPath, workDir } = await bundleComponent({
    componentPath,
    props,
    fps,
    durationFrames: effectiveDuration,
    width,
    height,
    googleFonts,
  })

  let browser = null
  let measurements = undefined

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      // --disable-dev-shm-usage: use /tmp instead of the container's 64MB /dev/shm
      // (Docker default) so heavy renders don't crash Chromium on shm exhaustion.
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-web-security', '--allow-file-access-from-files'],
      protocolTimeout: 300000,
    })

    const page = await browser.newPage()
    await page.setViewport({ width, height, deviceScaleFactor: 1 })

    // Capture page errors so we can surface them on failure
    const pageErrors = []
    page.on('pageerror', err => pageErrors.push(err.message))
    page.on('console', msg => { if (msg.type() === 'error') pageErrors.push(msg.text()) })

    // networkidle0 is critical for font loading — fonts are not loaded until
    // React commits to DOM, and we need the woff2 fetches to complete before
    // we measure text layout.
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' })

    // Verify the component mounted
    const ready = await page.evaluate(() => typeof window.__setFrame === 'function')
    if (!ready) {
      const errDetail = pageErrors.length ? pageErrors.join(' | ') : 'no JS errors captured'
      const err = new Error(`window.__setFrame not initialized: ${errDetail}`)
      err.sampleError = 'overlay_eval_failed'
      throw err
    }

    // Commit React render at the requested frame.
    // Note: __setFrame is always defined (it's in the shim), but calling it
    // may trigger a React re-render that throws (e.g. a broken component).
    // Such throws manifest as page errors, not as a rejected promise from
    // page.evaluate, so we must check pageErrors afterwards.
    await page.evaluate(f => window.__setFrame(f), frame)

    // Check immediately after __setFrame invocation for render errors.
    // If the component throws during React reconciliation, it shows up here
    // rather than causing waitForFunction to throw.
    if (pageErrors.length > 0) {
      const errMsg = pageErrors.join(' | ')
      const err = new Error(`overlay render error: ${errMsg}`)
      err.sampleError = 'overlay_eval_failed'
      throw err
    }

    // Wait until DOM attribute confirms the frame has been committed.
    // If the component threw during render, waitForFunction will time out —
    // but we already checked above and would have thrown by now.
    try {
      await page.waitForFunction(
        f => document.documentElement.dataset.renderedFrame === String(f),
        { timeout: 10000 },
        frame,
      )
    } catch (waitErr) {
      // If we timed out waiting for the frame to render, check if there are
      // page errors that explain why
      if (pageErrors.length > 0) {
        const err = new Error(`overlay render failed: ${pageErrors.join(' | ')}`)
        err.sampleError = 'overlay_eval_failed'
        throw err
      }
      throw waitErr
    }

    // Double rAF: first fires after layout+paint, second after compositor flush
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))

    // Measure DOM if requested
    if (measure) {
      measurements = await page.evaluate((canvasW, canvasH) => {
        const texts = []

        // Walk all elements in document body
        function walk(el) {
          // Skip script/style/head nodes
          const tag = el.tagName
          if (!tag || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'HEAD') return

          const text = el.textContent?.trim() ?? ''
          if (text.length > 0) {
            // Check if this element itself has direct text content
            // (i.e. it's a leaf text-bearing node or has immediate text)
            let hasDirectText = false
            for (const child of el.childNodes) {
              if (child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 0) {
                hasDirectText = true
                break
              }
            }

            if (hasDirectText) {
              const style = window.getComputedStyle(el)
              const rect = el.getBoundingClientRect()
              const bboxX = rect.x
              const bboxY = rect.y
              const bboxW = rect.width
              const bboxH = rect.height

              const overflowLeft   = Math.max(0, -bboxX)
              const overflowRight  = Math.max(0, bboxX + bboxW - canvasW)
              const overflowTop    = Math.max(0, -bboxY)
              const overflowBottom = Math.max(0, bboxY + bboxH - canvasH)

              // Walk parent chain to find first ancestor with overflow clipping.
              //
              // Filter out ancestors whose bbox fills (or exceeds) the viewport.
              // The React shim's mount wrapper and the document body typically
              // have overflow set AND span the full viewport — flagging them as
              // a "clippingAncestor" gives false positives on every overlay
              // element. The intentional-clip case the skill teaches agents to
              // recognise is an ancestor SMALLER than the viewport (e.g. an
              // animation container with a fixed window the children animate
              // through). Only those count.
              let clippingAncestor = null
              let parent = el.parentElement
              while (parent && parent !== document.documentElement) {
                const pStyle = window.getComputedStyle(parent)
                const overflowX = pStyle.overflowX
                const overflowY = pStyle.overflowY
                if (overflowX === 'hidden' || overflowX === 'clip' || overflowX === 'auto' ||
                    overflowY === 'hidden' || overflowY === 'clip' || overflowY === 'auto') {
                  const pRect = parent.getBoundingClientRect()
                  // Skip viewport-spanning wrappers — they're not intentional clips.
                  const spansViewport = pRect.width  >= canvasW - 0.5
                                     && pRect.height >= canvasH - 0.5
                                     && pRect.x <= 0.5 && pRect.y <= 0.5
                  if (!spansViewport) {
                    clippingAncestor = {
                      tag: parent.tagName,
                      className: parent.className || '',
                      bbox: { x: pRect.x, y: pRect.y, w: pRect.width, h: pRect.height },
                    }
                    break
                  }
                }
                parent = parent.parentElement
              }

              texts.push({
                text: text.slice(0, 200),
                tag: el.tagName,
                fontFamily: style.fontFamily,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                position: style.position,
                transform: style.transform,
                bbox: { x: bboxX, y: bboxY, w: bboxW, h: bboxH },
                overflow: {
                  left:   overflowLeft,
                  right:  overflowRight,
                  top:    overflowTop,
                  bottom: overflowBottom,
                },
                clippingAncestor,
              })
            }
          }

          // Recurse into children
          for (const child of el.children) {
            walk(child)
          }
        }

        walk(document.body)

        const anyOverflow = texts.some(t =>
          t.overflow.left > 0 || t.overflow.right > 0 ||
          t.overflow.top > 0  || t.overflow.bottom > 0
        )

        return {
          viewport: { w: canvasW, h: canvasH },
          anyOverflow,
          texts,
        }
      }, width, height)
    }

    // Screenshot — transparent PNG (omitBackground: true matches the renderer)
    mkdirSync(dirname(outPath), { recursive: true })
    await page.screenshot({ path: outPath, omitBackground: true })

    await page.close()
  } catch (err) {
    // Re-surface page errors as structured error if __setFrame wasn't available
    if (!err.sampleError && err.message) {
      err.sampleError = 'overlay_eval_failed'
    }
    throw err
  } finally {
    if (browser) await browser.close()
    cleanupBundle(workDir)
  }

  // Write to cache
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    copyFileSync(outPath, cachePng)
    if (measure && measurements !== undefined) {
      writeFileSync(cacheJson, JSON.stringify(measurements))
    }
  } catch (e) {
    // Cache write failure is non-fatal
    log(`WARNING: cache write failed: ${e.message}`)
  }

  if (measure) {
    return { pngPath: outPath, measurements }
  }
  return { pngPath: outPath }
}

// ---------------------------------------------------------------------------
// sampleFrame
// ---------------------------------------------------------------------------

/**
 * Render the full composited frame at a specific timestamp.
 *
 * @param {object} opts
 * @param {object|string} opts.projectJson  Parsed project.json or absolute path to it
 * @param {number}        opts.atSeconds    Timestamp to sample
 * @param {string}        opts.outPath      Where to write the output PNG
 * @param {string|null}   [opts.sdrCurve]   Look curve id for the HDR→SDR grade;
 *   null uses the master look. Ignored on SDR projects (nothing is converted).
 * @returns {Promise<{ pngPath: string }>}
 */
export async function sampleFrame({
  projectJson,
  atSeconds,
  outPath,
  sdrCurve = null,
}) {
  if (!outPath) throw new Error('outPath is required')
  if (atSeconds == null) throw new Error('atSeconds is required')

  // GC cache on every call
  gcCache()

  // Resolve projectJson: accept path string or parsed object
  let projectPath = null
  let project = null
  if (typeof projectJson === 'string') {
    projectPath = resolve(projectJson)
    if (!existsSync(projectPath)) throw new Error(`project.json not found: ${projectPath}`)
    project = JSON.parse(readFileSync(projectPath, 'utf8'))
  } else {
    project = projectJson
  }

  // Cache key
  const cacheKey = buildFrameCacheKey(projectPath, project, atSeconds, sdrCurve)
  const cachePng = join(CACHE_DIR, `${cacheKey}.png`)

  if (existsSync(cachePng)) {
    log(`cache hit for frame at t=${atSeconds}`)
    mkdirSync(dirname(outPath), { recursive: true })
    copyFileSync(cachePng, outPath)
    return { pngPath: outPath }
  }

  // Resolve relative paths in project
  const projectDir = projectPath ? dirname(projectPath) : null
  const resolvedProject = deepClone(project)
  if (projectDir) {
    resolveProjectPaths(resolvedProject, projectDir)
  }

  const settings = resolvedProject.settings ?? {}
  const fps = settings.fps ?? 30
  const projectColorSpace = settings.colorSpace ?? 'sdr_bt709'

  // Canvas math — same as render.js
  const aspectW = settings.resolution?.[0] ?? 1080
  const aspectH = settings.resolution?.[1] ?? 1920
  const aspectRatio = SHORT_EDGE_TARGET / Math.min(aspectW, aspectH)
  const renderWidth  = Math.round(aspectW * aspectRatio / 2) * 2
  const renderHeight = Math.round(aspectH * aspectRatio / 2) * 2
  const actualWidth  = settings.resolution?.[0] ?? renderWidth
  const actualHeight = settings.resolution?.[1] ?? renderHeight

  // Validate timestamp
  const totalDuration = getTotalDurationSeconds(resolvedProject)
  if (totalDuration > 0 && atSeconds > totalDuration) {
    throw new Error(
      `Requested timestamp ${atSeconds} is past project end ${totalDuration}`,
    )
  }

  log(`sampling frame at t=${atSeconds}s (${actualWidth}×${actualHeight}, colorSpace=${projectColorSpace})`)

  // Collect active items via the shared resolver — the single source of truth
  // for "what's on screen at time T", also used by render.js/segment-plan.js and
  // the editor preview. The 'render' variant matches production exactly:
  // normalizedSrc rebase, nobg_src precedence, and the sourceCrop/fit forwarding
  // below all key off `resolveAt`'s per-item `window`/`geometry`. `containsTime`
  // (start <= atSeconds < end) is the same half-open predicate this file always
  // used — the LATER clip wins an exact boundary tie.
  const scene = resolveAt(withEnabledItemTracks(resolvedProject), atSeconds, { variant: 'render' })

  // Video and image items composite together, back-to-front by trackIdx (ties
  // keep document order) — this replaces the old video-group-then-image-group
  // order, which drew every video before every image regardless of their
  // relative trackIdx. Overlays are collected separately and always composited
  // LAST, on top regardless of trackIdx — that matches encode-segment.js's own
  // split (Step 2 items, then Step 3 overlays, unconditionally), a
  // consumer-side compositing rule the resolver itself does not encode (see
  // @bycrux/timeline-core/src/geometry.js's z-order note).
  const visualItems  = scene.items.filter(ri => ri.kind === 'video' || ri.kind === 'image')
  const overlayItems = scene.items.filter(ri => ri.kind === 'overlay')
  const videoCount = visualItems.filter(ri => ri.kind === 'video').length
  const imageCount = visualItems.length - videoCount

  // An opaque overlay replaces the picture underneath it. Production
  // (segment-plan.js/encode-segment.js) keeps the covered items around anyway so
  // their AUDIO still reaches the mix — irrelevant for a still frame, so the
  // analogue here is simpler: don't composite ANY video/image item while an
  // opaque overlay is active. See KNOWN-DIVERGENCES.md "opaque-in-preview".
  const hasOpaque = overlayItems.some(ri => ri.item.opaque)

  log(`active items: ${videoCount} video, ${imageCount} image` +
      `${hasOpaque ? ' (hidden by opaque overlay)' : ''}, ${overlayItems.length} overlay`)

  // --- Step 1: Render overlay PNGs in parallel (cap=4) ---
  // Each overlay PNG has transparent background, same design resolution as canvas
  const overlayPngs = await pMap(overlayItems, async (ri) => {
    const ov = ri.item
    // ri.seek is the resolver's elapsed-since-start for a non-video item —
    // max(0, atSeconds - ov.start) — identical to the frame math this file
    // always used, just computed once by the resolver instead of by hand.
    const overlayFrame = Math.round(ri.seek * fps)
    // Pass the item's real on-screen length so the composited frame is WYSIWYG —
    // an overlay sampled near its own start/end shows its true fade-in/out state.
    const overlayDurationFrames = Math.max(1, Math.round((ov.end - ov.start) * fps))
    const tmpOverlayOut = join(tmpdir(), `montaj-sample-ov-${randomHex()}.png`)
    const result = await sampleOverlay({
      componentPath: ov.src,
      props: ov.props ?? {},
      frame: overlayFrame,
      fps,
      width: renderWidth,
      height: renderHeight,
      googleFonts: ov.googleFonts ?? [],
      measure: false,
      durationFrames: overlayDurationFrames,
      outPath: tmpOverlayOut,
    })
    return {
      // Shape expected by buildOverlayFilterParts: webmPath, startSeconds, offsetX, offsetY, scale
      webmPath:     result.pngPath,
      startSeconds: ov.start,
      offsetX:      ri.geometry.offsetX,
      offsetY:      ri.geometry.offsetY,
      scale:        ri.geometry.scale,
      opaque:       ov.opaque ?? false,
    }
  }, OVERLAY_CONCURRENCY)

  // --- Step 2: Extract video frames via accurate seek ---
  // For HDR projects: apply tonemap inline during extraction so the extracted
  // PNG is already in sRGB BT.709. This avoids the "no path between colorspaces"
  // error that zscale throws when applied to the composite output — the overlay
  // filter drops colorspace metadata (format=rgba strips tags), and zscale can't
  // figure out the conversion path on the resulting canvas.
  //
  // For SDR projects: extract as-is (no vf filter).
  const hdrProject = isHdr(projectColorSpace)
  const workDir = join(tmpdir(), `montaj-sample-frame-${randomHex()}`)
  mkdirSync(workDir, { recursive: true })

  // ResolvedItem -> extracted-frame PNG path, so Step 3 can look up each video
  // item's frame while walking visualItems in trackIdx order. Skipped entirely
  // under an opaque overlay — nothing composites these frames anyway (see
  // hasOpaque above), so there's no point paying for the ffmpeg extraction.
  const videoFramePaths = new Map()

  if (!hasOpaque) {
    let vi = 0
    for (const ri of visualItems) {
      if (ri.kind !== 'video') continue
      // window = sourceWindow(item, 'render') — src is already the resolver's
      // choice (normalizedSrc/nobg_src/original) with in/outPoint rebased for a
      // normalizedSrc cache. Use normalized/audioclean cached file if present and
      // fresh on top of that (read-only — never triggers normalization).
      const window = ri.window
      const src = resolveVideoSource(window.src)
      // ri.seek === window.inPoint + max(0, atSeconds - item.start) — the
      // resolver's seekTime(item, atSeconds, 'render'), replacing this file's old
      // hand-rolled `atSeconds - item.start + (item.inPoint ?? 0)`, which never
      // rebased for a normalizedSrc cache.
      const seekTime = ri.seek
      const framePng = join(workDir, `video-${vi}.png`)

      log(`extracting video frame at t=${seekTime.toFixed(3)}s from ${src ? basename(src) : '(no src)'}`)

      // Accurate seek: -ss AFTER -i (slow but frame-accurate, ~5–10s on long HEVC clips)
      const ffmpegExtractArgs = [
        '-y', '-v', 'error',
        '-i', src,
        '-ss', String(Math.max(0, seekTime)),
      ]

      // Filter chain: the optional source crop (clips workflow vertical reframe)
      // THEN the HDR→SDR conversion — the geometry-first order
      // encode-segment.js's buildVideoItemFilterParts uses, and for its reason
      // (see the step-order note there): cropping first means the conversion
      // only pays for pixels that survive. The crop is a no-op without both
      // sourceWidth/sourceHeight, matching that function's own gate — see
      // KNOWN-DIVERGENCES.md "sourcecrop-missing-dims-silent-drop".
      //
      // There is no scale/pad step here: this extract produces one full-size
      // source frame, and buildImageItemFilterParts does the canvas fit when the
      // frame is composited (Step 3). So nothing is ever padded before the
      // conversion, which is the property encode-segment's ordering protects.
      const vfParts = []
      const sc = ri.geometry.sourceCrop
      if (sc && ri.geometry.sourceWidth && ri.geometry.sourceHeight) {
        const cw = Math.round(ri.geometry.sourceWidth  * sc.w / 2) * 2  // even: x264 needs even dims
        const ch = Math.round(ri.geometry.sourceHeight * sc.h / 2) * 2  // even: x264 needs even dims
        const cx = Math.round(ri.geometry.sourceWidth  * sc.x)          // origin NOT even-rounded
        const cy = Math.round(ri.geometry.sourceHeight * sc.y)          // origin NOT even-rounded
        vfParts.push(`crop=${cw}:${ch}:${cx}:${cy}`)
      }
      if (hdrProject) {
        // Grade HLG/PQ → SDR BT.709 inline so the PNG lands as a normal SDR
        // image, through the same Montaj Vivid LUT the render and the proxies
        // use — that shared LUT is what lets the preview claim to match the SDR
        // export. Mirrors lib/normalize.py's _build_tonemap_vf_to_sdr and
        // encode-segment.js's buildColorConversionFilter; buildVividLutChain is
        // literally the same builder the segment encoder calls.
        //
        // The chain ends in rgb24, NOT yuv420p: this frame is encoded straight
        // to PNG (`-frames:v 1 ... framePng` below) and ffmpeg's png encoder
        // only accepts rgb24/rgba/gray/pal8-family pixel formats (confirmed via
        // `ffmpeg -h encoder=png`); yuv420p made the encoder fail outright
        // ("Could not open encoder before EOF"). The t=/m=/p=/r= flags on the
        // step before it are still worth setting even though a PNG carries no
        // meaningful transfer tag — they are what makes the RGB→BT.709
        // conversion math right, not just the metadata.
        //
        // Which source transfer to feed the chain comes from the PROJECT's color
        // space, not a per-item probe: this file has no ffprobe pass (render.js
        // stamps item.colorTransfer, sample-frame never does), and an HDR
        // project's video sources are in that project's HDR space by
        // construction — masters are normalized into it at intake.
        //
        // lut3d can be missing from an older ffmpeg build (`montaj doctor` asks
        // for it, but this must not hard-fail a preview), so fall back to the
        // pre-SP6b Hable chain and say so once per extract.
        if (hasZscale() && hasLut3d()) {
          vfParts.push(`${buildVividLutChain(projectColorSpace, sdrCurve)},format=rgb24`)
        } else {
          log('WARNING: ffmpeg lacks zscale and/or lut3d — sampling with the legacy '
            + 'Hable tonemap; this frame will NOT match the render. Run `montaj doctor`.')
          vfParts.push('zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=rgb24')
        }
      }
      if (vfParts.length) ffmpegExtractArgs.push('-vf', vfParts.join(','))

      ffmpegExtractArgs.push('-frames:v', '1', '-update', '1', framePng)

      const result = spawnSync(FFMPEG, ffmpegExtractArgs, { encoding: 'utf8', timeout: 60_000 })

      if (result.status !== 0) {
        throw new Error(`ffmpeg video frame extract failed: ${result.stderr?.slice(-300)}`)
      }

      videoFramePaths.set(ri, framePng)
      vi++
    }
  }

  // --- Step 3: Build composite ffmpeg command ---
  // Using the three shared helpers from encode-segment.js

  // Duration for filter purposes — 1 frame is enough
  const duration = 1 / fps

  const inputs = []
  const filterParts = []
  let videoLabel
  let inputIdx = 0

  // Black canvas base
  inputs.push('-f', 'lavfi', '-i',
    `color=black:size=${actualWidth}x${actualHeight}:rate=${fps}:duration=${duration}`)
  filterParts.push(`[0:v]format=rgba[canvas]`)
  videoLabel = '[canvas]'
  inputIdx++

  // Video + image items, back-to-front in trackIdx order (see the ordering note
  // above collectScene/`scene`). Both composite through buildImageItemFilterParts
  // — a video's extracted frame is a PNG by this point, same as an image item's
  // own file. Skipped entirely under an opaque overlay (hasOpaque).
  if (!hasOpaque) {
    for (const ri of visualItems) {
      let pseudoItem
      if (ri.kind === 'video') {
        const framePng = videoFramePaths.get(ri)
        if (!framePng) continue // defensive — every video RI got a frame extracted above
        // Treat the extracted video frame as an image item — it's a PNG at this point.
        pseudoItem = {
          src:     framePng,
          scale:   ri.geometry.scale,
          offsetX: ri.geometry.offsetX,
          offsetY: ri.geometry.offsetY,
          opacity: ri.geometry.opacity,
          // TRAP: buildImageItemFilterParts defaults to 'cover' when fit is
          // omitted, which CROPS the frame to fill its box. Production video is
          // ALWAYS contain-fit — buildVideoItemFilterParts' own scale step uses
          // force_original_aspect_ratio=decrease unconditionally, never reading
          // item.fit at all (see @bycrux/timeline-core/src/geometry.js's fit
          // note). Forwarding sourceCrop above without ALSO forcing 'contain'
          // here would silently drag the wrong (image) fit rule onto a video
          // frame and crop content the crop step didn't already remove.
          fit: 'contain',
        }
      } else {
        pseudoItem = {
          src:     ri.item.src,
          scale:   ri.geometry.scale,
          offsetX: ri.geometry.offsetX,
          offsetY: ri.geometry.offsetY,
          opacity: ri.geometry.opacity,
          fit:     ri.geometry.fit, // image's own tri-state, default 'cover'
        }
      }
      const { inputArgs, filterParts: fp, newVideoLabel } =
        buildImageItemFilterParts(pseudoItem, actualWidth, actualHeight, inputIdx, videoLabel, duration)
      inputs.push(...inputArgs)
      filterParts.push(...fp)
      videoLabel = newVideoLabel
      inputIdx++
    }
  }

  // Overlay PNGs — call the shared buildOverlayFilterParts helper with PNG-tuned opts.
  // Same positioning/scale math as the production renderer; we override the
  // VP9-specific format flags (rgba input, auto composite output) and switch the
  // input args to looped-still mode since PNGs are single frames, not seekable
  // video. This keeps sample and production paths from drifting on overlay math.
  for (let i = 0; i < overlayPngs.length; i++) {
    const ov = overlayPngs[i]
    const { inputArgs, filterParts: fp, newVideoLabel } = buildOverlayFilterParts(
      ov, actualWidth, actualHeight, inputIdx, videoLabel,
      0,         // segStart: PNG overlays are not seeked (loopedInput=true), so ignored
      duration,
      { inputFormatFlag: 'rgba', compositeFormatFlag: 'auto', loopedInput: true },
    )
    inputs.push(...inputArgs)
    filterParts.push(...fp)
    videoLabel = newVideoLabel
    inputIdx++
  }

  // Note: HDR tonemap is applied during video frame extraction (Step 2 above),
  // not here. Applying zscale to the composite output causes "no path between
  // colorspaces" because format=rgba in the overlay chain drops colorspace tags.
  // The extracted video frames are already in sRGB BT.709 for HDR projects.

  // Write output PNG
  mkdirSync(dirname(outPath), { recursive: true })

  const ffmpegArgs = [
    '-y', '-v', 'error',
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', videoLabel,
    '-frames:v', '1',
    '-update', '1',
    outPath,
  ]

  log(`compositing frame (${actualWidth}×${actualHeight})`)
  const compResult = spawnSync(FFMPEG, ffmpegArgs, {
    encoding: 'utf8',
    timeout: 120_000,
  })

  if (compResult.status !== 0) {
    throw new Error(`ffmpeg composite failed:\n${compResult.stderr?.slice(-500)}`)
  }

  // Cleanup temp files
  try { rmSync(workDir, { recursive: true, force: true }) } catch {}
  for (const ov of overlayPngs) {
    try { rmSync(ov.webmPath, { force: true }) } catch {}
  }

  // Write to cache
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    copyFileSync(outPath, cachePng)
  } catch (e) {
    log(`WARNING: cache write failed: ${e.message}`)
  }

  return { pngPath: outPath }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the best available cached file for `src` (audioclean > normalized >
 * as-is). `src` is whatever @bycrux/timeline-core's `sourceWindow` already
 * chose (original / normalizedSrc / nobg_src) — this layers a further,
 * sample-frame-only, read-only cache-freshness check on top of that choice; it
 * never triggers normalization itself.
 */
function resolveVideoSource(src) {
  if (!src) return src
  // Check for _audioclean variant (read-only — don't trigger normalization)
  const audiocleanPath = src.replace(/(\.\w+)$/, '_audioclean.mp4')
  if (existsSync(audiocleanPath)) {
    try {
      const srcStat  = statSync(src)
      const outStat  = statSync(audiocleanPath)
      if (outStat.mtimeMs >= srcStat.mtimeMs) return audiocleanPath
    } catch { /* fall through */ }
  }
  // Check for _normalized_<colorSpace>[_<look>] variants. We don't know the
  // project's colorSpace here, so match by pattern: <stem>_normalized_*.mp4.
  //
  // When a look-tagged sibling (SP6b Task T3 — this master was produced by
  // tone-mapping an HDR source through the Montaj Vivid LUT, see
  // lib.normalize.normalized_output_path) and an untagged one are BOTH fresh,
  // prefer the tagged one. That's the newer naming scheme's output and
  // reflects the current graded master; an untagged sibling passing the same
  // freshness check is exactly the stale-leftover case (pre-T3 file, or a
  // color-space re-detect) this preference exists to route around.
  const srcDir  = dirname(src)
  const srcBase = basename(src, extname(src))
  const knownLooks = curveIds()
  let bestPath = null
  let bestTagged = false
  try {
    for (const name of readdirSync(srcDir)) {
      if (!name.startsWith(srcBase + '_normalized_') || !name.endsWith('.mp4')) continue
      const normPath = join(srcDir, name)
      try {
        const srcStat = statSync(src)
        const outStat = statSync(normPath)
        if (outStat.mtimeMs < srcStat.mtimeMs) continue
      } catch { continue /* skip: stat failed */ }
      const stem = name.slice(0, -'.mp4'.length)
      const tagged = knownLooks.some((look) => stem.endsWith(`_${look}`))
      if (bestPath === null || (tagged && !bestTagged)) {
        bestPath = normPath
        bestTagged = tagged
      }
    }
  } catch { /* directory not readable — fall through */ }
  return bestPath ?? src
}

/** Resolve relative src paths to absolute, mirroring render.js::resolveProjectPaths. */
function resolveProjectPaths(projectJson, projectDir) {
  for (const track of trackItems(projectJson)) {
    for (const item of track ?? []) {
      if (item.src && !item.src.startsWith('/')) {
        item.src = resolve(projectDir, item.src)
      }
    }
  }
  for (const track of projectJson.audio?.tracks ?? []) {
    if (track.src && !track.src.startsWith('/')) {
      track.src = resolve(projectDir, track.src)
    }
  }
}

/** Total project duration in seconds. */
function getTotalDurationSeconds(projectJson) {
  // Enabled tracks only, matching render.js — a sampled frame must agree with
  // the export about where the project ends.
  const allItems = enabledTrackItems(projectJson).flat()
  if (allItems.length === 0) return 0
  return Math.max(...allItems.map(i => i.end ?? 0))
}

/** Build a content-hash cache key for sampleOverlay. */
function buildOverlayCacheKey(componentPath, props, frame, width, height, googleFonts, measure, durationFrames) {
  let mtime = '0'
  try { mtime = String(statSync(componentPath).mtimeMs) } catch {}
  const raw = [
    `${componentPath}:${mtime}`,
    JSON.stringify(props),
    String(frame),
    String(width),
    String(height),
    googleFonts.join(','),
    measure ? 'measure' : '',
    String(durationFrames),
  ].join('|')
  return createHash('sha256').update(raw).digest('hex')
}

/** Build a content-hash cache key for sampleFrame. */
function buildFrameCacheKey(projectPath, project, atSeconds, sdrCurve = null) {
  let mtime = '0'
  if (projectPath) {
    try { mtime = String(statSync(projectPath).mtimeMs) } catch {}
  } else {
    mtime = JSON.stringify(project)
  }
  const colorSpace = project?.settings?.colorSpace ?? 'sdr_bt709'
  // Salted with the resolver's own version so a semantic change in
  // @bycrux/timeline-core (e.g. this T9 alignment) invalidates any frame cached
  // by the pre-alignment logic instead of silently serving it back.
  //
  // MASTER_LOOK and the requested curve are in the key for the same reason
  // (SP6b decision 10): the PNG's colors come out of a .cube, so a look bump —
  // or two curves sampled at the same timestamp for the RenderModal's
  // side-by-side thumbnails — must not collide. Without them a LUT change would
  // serve the pre-change frame back forever, since nothing else in the key
  // moves when the manifest does.
  const raw = [RESOLVER_VERSION, mtime, String(atSeconds), colorSpace,
               MASTER_LOOK, sdrCurve ?? MASTER_LOOK].join('|')
  return createHash('sha256').update(raw).digest('hex')
}

/** Scan cache dir and delete entries older than CACHE_TTL_MS. Safe to fail silently. */
function gcCache() {
  try {
    if (!existsSync(CACHE_DIR)) return
    const now = Date.now()
    for (const name of readdirSync(CACHE_DIR)) {
      try {
        const full = join(CACHE_DIR, name)
        const st   = statSync(full)
        if (now - st.mtimeMs > CACHE_TTL_MS) {
          rmSync(full, { force: true })
        }
      } catch { /* skip */ }
    }
  } catch { /* permissions issue — don't break sampling */ }
}

/** Deep-clone a JSON-serializable object. */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

/** Hex random string for temp file names. */
function randomHex() {
  return Math.random().toString(16).slice(2, 10)
}

function log(msg) {
  process.stderr.write(`${C.cyan}[montaj sample]${C.reset} ${msg}\n`)
}

function fail(code, message) {
  process.stderr.write(JSON.stringify({ error: code, message }) + '\n')
  process.exit(1)
}

// Exported purely for unit testing (no ffmpeg/puppeteer involved) — mirrors
// render.js's bottom export list for its own filesystem-only helpers.
// buildFrameCacheKey is here so the look/curve components (SP6b decision 10)
// can be asserted directly: proving it through rendered pixels only works for
// colors where two cubes happen to disagree, which is not a property a cache
// test should depend on.
export { resolveVideoSource, buildFrameCacheKey }
