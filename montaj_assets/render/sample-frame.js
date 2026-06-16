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
import { isHdr } from './color-space.js'
import {
  buildImageItemFilterParts,
  buildVideoItemFilterParts,
  buildOverlayFilterParts,
} from './encode-segment.js'

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
      '  sample-frame.js --mode frame --project <path> --at <seconds> --out <path>\n'
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
    if (a === '--out')          { outArg        = argv[++i]; continue }
  }

  if (!mode) fail('missing_argument', '--mode overlay|frame is required')
  if (!outArg) fail('missing_argument', '--out <path> is required')

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
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--allow-file-access-from-files'],
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
 * @returns {Promise<{ pngPath: string }>}
 */
export async function sampleFrame({
  projectJson,
  atSeconds,
  outPath,
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
  const cacheKey = buildFrameCacheKey(projectPath, project, atSeconds)
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

  // Collect active items at atSeconds
  // Convention: start <= atSeconds < end. Handles clip boundary tiebreak: the LATER clip wins.
  const videoItems   = []
  const imageItems   = []
  const overlayItems = []

  for (let trackIdx = 0; trackIdx < (resolvedProject.tracks ?? []).length; trackIdx++) {
    const track = resolvedProject.tracks[trackIdx]
    for (const item of track ?? []) {
      if (item.start <= atSeconds && atSeconds < item.end) {
        if (item.type === 'video') {
          videoItems.push({ ...item, trackIdx })
        } else if (item.type === 'image') {
          imageItems.push({ ...item, trackIdx })
        } else if (item.type === 'overlay') {
          overlayItems.push({ ...item, trackIdx })
        }
        // audio items skipped — sample is silent
      }
    }
  }

  log(`active items: ${videoItems.length} video, ${imageItems.length} image, ${overlayItems.length} overlay`)

  // --- Step 1: Render overlay PNGs in parallel (cap=4) ---
  // Each overlay PNG has transparent background, same design resolution as canvas
  const overlayPngs = await pMap(overlayItems, async (ov) => {
    const overlayFrame = Math.round((atSeconds - ov.start) * fps)
    // Pass the item's real on-screen length so the composited frame is WYSIWYG —
    // an overlay sampled near its own start/end shows its true fade-in/out state.
    const overlayDurationFrames = Math.max(1, Math.round((ov.end - ov.start) * fps))
    const tmpOverlayOut = join(tmpdir(), `montaj-sample-ov-${randomHex()}.png`)
    const ovSrc = ov.src
    const result = await sampleOverlay({
      componentPath: ovSrc,
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
      offsetX:      ov.offsetX ?? 0,
      offsetY:      ov.offsetY ?? 0,
      scale:        ov.scale   ?? 1,
      opaque:       ov.opaque  ?? false,
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

  const videoFramePaths = []
  for (let i = 0; i < videoItems.length; i++) {
    const item = videoItems[i]
    // Use normalized/audioclean cached file if present and fresh (read-only)
    const src = resolveVideoSource(item)
    const seekTime = atSeconds - item.start + (item.inPoint ?? 0)
    const framePng = join(workDir, `video-${i}.png`)

    log(`extracting video frame at t=${seekTime.toFixed(3)}s from ${basename(src)}`)

    // Accurate seek: -ss AFTER -i (slow but frame-accurate, ~5–10s on long HEVC clips)
    const ffmpegExtractArgs = [
      '-y', '-v', 'error',
      '-i', src,
      '-ss', String(Math.max(0, seekTime)),
    ]
    if (hdrProject) {
      // Tonemap HLG/PQ → sRGB BT.709 inline so the PNG lands as a normal SDR image.
      // Must apply the Hable tonemap operator in linear light — without it, HDR
      // highlights above the SDR white point simply clip and the whole frame
      // blows out to near-white. Mirrors the canonical zscale path in
      // lib/normalize.py _build_tonemap_vf_to_sdr / encode-segment.js
      // buildColorConversionFilter.
      ffmpegExtractArgs.push(
        '-vf', 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p',
      )
    }
    ffmpegExtractArgs.push('-frames:v', '1', '-update', '1', framePng)

    const result = spawnSync('ffmpeg', ffmpegExtractArgs, { encoding: 'utf8', timeout: 60_000 })

    if (result.status !== 0) {
      throw new Error(`ffmpeg video frame extract failed: ${result.stderr?.slice(-300)}`)
    }

    videoFramePaths.push(framePng)
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

  // Video items (using their extracted PNG frames as image inputs)
  for (let i = 0; i < videoItems.length; i++) {
    const item = videoItems[i]
    const framePng = videoFramePaths[i]
    // Treat extracted video frame as an image item — it's a PNG at this point
    const pseudoImageItem = {
      src:     framePng,
      scale:   item.scale   ?? 1,
      offsetX: item.offsetX ?? 0,
      offsetY: item.offsetY ?? 0,
      opacity: item.opacity ?? 1,
    }
    const { inputArgs, filterParts: fp, newVideoLabel } =
      buildImageItemFilterParts(pseudoImageItem, actualWidth, actualHeight, inputIdx, videoLabel, duration)
    inputs.push(...inputArgs)
    filterParts.push(...fp)
    videoLabel = newVideoLabel
    inputIdx++
  }

  // Image items (use file directly)
  for (let i = 0; i < imageItems.length; i++) {
    const item = imageItems[i]
    const { inputArgs, filterParts: fp, newVideoLabel } =
      buildImageItemFilterParts(item, actualWidth, actualHeight, inputIdx, videoLabel, duration)
    inputs.push(...inputArgs)
    filterParts.push(...fp)
    videoLabel = newVideoLabel
    inputIdx++
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
  const compResult = spawnSync('ffmpeg', ffmpegArgs, {
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

/** Resolve the best available source file for a video item (audioclean > original). */
function resolveVideoSource(item) {
  const src = item.src
  // Check for _audioclean variant (read-only — don't trigger normalization)
  const audiocleanPath = src.replace(/(\.\w+)$/, '_audioclean.mp4')
  if (existsSync(audiocleanPath)) {
    try {
      const srcStat  = statSync(src)
      const outStat  = statSync(audiocleanPath)
      if (outStat.mtimeMs >= srcStat.mtimeMs) return audiocleanPath
    } catch { /* fall through */ }
  }
  // Check for _normalized_<colorSpace> variant
  // We don't know the colorSpace here, so check for any normalized file
  // by pattern: <stem>_normalized_*.mp4
  const srcDir  = dirname(src)
  const srcBase = basename(src, extname(src))
  try {
    for (const name of readdirSync(srcDir)) {
      if (name.startsWith(srcBase + '_normalized_') && name.endsWith('.mp4')) {
        const normPath = join(srcDir, name)
        try {
          const srcStat  = statSync(src)
          const outStat  = statSync(normPath)
          if (outStat.mtimeMs >= srcStat.mtimeMs) return normPath
        } catch { /* skip */ }
      }
    }
  } catch { /* directory not readable — fall through */ }
  return src
}

/** Resolve relative src paths to absolute, mirroring render.js::resolveProjectPaths. */
function resolveProjectPaths(projectJson, projectDir) {
  for (const track of projectJson.tracks ?? []) {
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
  const allItems = (projectJson.tracks ?? []).flat()
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
function buildFrameCacheKey(projectPath, project, atSeconds) {
  let mtime = '0'
  if (projectPath) {
    try { mtime = String(statSync(projectPath).mtimeMs) } catch {}
  } else {
    mtime = JSON.stringify(project)
  }
  const colorSpace = project?.settings?.colorSpace ?? 'sdr_bt709'
  const raw = [mtime, String(atSeconds), colorSpace].join('|')
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

/** Bounded-concurrency map. */
async function pMap(items, mapper, concurrency) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await mapper(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker))
  return results
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
