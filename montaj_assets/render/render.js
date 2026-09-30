#!/usr/bin/env node
/**
 * render.js — CLI entry point for the montaj render engine.
 *
 * Usage:
 *   node render/render.js <project.json> [--out <path>] [--workers <n>] [--clean]
 *
 * stdout: absolute path to the final MP4 (follows step output convention)
 * stderr: progress lines + JSON error on failure
 * exit 0 on success, exit 1 on failure
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, openSync, writeSync, closeSync } from 'fs'
import { resolve, join, dirname, basename, extname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync, spawn } from 'child_process'

import { bundleComponent, cleanupBundle } from './bundle.js'
import { isMain as isMainModule }        from './is-main.js'
import { renderAllSegments }              from './renderer.js'
import { prefetchPropsUrls }              from './page-guard.js'
import { namedPropsUrls }                 from './overlay-build.js'
import { compose, embedThumbnail }        from './compose.js'
import { FFMPEG, FFPROBE }                from './ffmpeg-bin.js'
import { requireValidKey, detectFromTransfer, smartDetect, isHdr, DEFAULT_COLOR_SPACE } from './color-space.js'
import { pMap }                           from './p-map.js'
import { fileHasAudio, probeVideoGeometry } from './encode-segment.js'
import { probeColorTransfer }             from './derive-sdr.js'
import { sdrLayerFor, gradeKeyFor, probeMedia, defaultDeps } from './sdr-layer.js'
import { sourceWindow, transitionPairs }  from '@bycrux/timeline-core'
import { MASTER_LOOK, curveIds }          from './look.js'
import { resolveMotionBlur }              from './motion-blur.js'
import { loudnessFilter }                 from './mix-audio.js'
import { effectiveItemAudio, enabledTrackItems, enabledTracks, trackItems } from './project-tracks.js'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const isMain = isMainModule(import.meta.url, process.argv[1])
// MONTAJ_ROOT is two levels above montaj_assets/render/ (i.e. the Python project root).
const MONTAJ_ROOT = process.env.MONTAJ_ROOT || join(__dirname, '..', '..')
const PYTHON = process.env.MONTAJ_PYTHON || 'python3'
// Absolute directory holding a vendored fonts.css, set by whoever spawns this
// process (the Electron shell; nothing in the CLI/OSS case). Configuration,
// never project data — see bundleComponent's fontsBaseDir doc (bundle.js) for
// why a base must never travel inside a project file. Unset → '', which
// bundleComponent's own default already treats as "no base" and falls back to
// today's googleapis output byte-for-byte.
const MONTAJ_FONTS_DIR = process.env.MONTAJ_FONTS_DIR || ''
export const REMOVE_BG_SCRIPT = join(MONTAJ_ROOT, 'steps', 'transform', 'remove_bg.py')

const TTY = process.stderr.isTTY
const C = { cyan: TTY ? '\x1b[96m' : '', reset: TTY ? '\x1b[0m' : '' }

// ---------------------------------------------------------------------------
// Export modes (SP6b Task T7)
//
// auto: render the project at its own working color space. Exactly the
//       pre-SP6b behavior, and the default: one file, no SDR pass.
// sdr:  emit only a Rec.709 SDR file. On an HDR project that file is the
//       per-layer SDR pass alone (PV42): no HDR master is composed at all.
// both: emit the HDR master, then (sequentially) an SDR sibling composed per
//       layer. Neither file is derived from the other.
//
// Declared above the CLI block rather than beside its resolvers below because
// the flag is validated during module evaluation — a `const` further down the
// file is still in its temporal dead zone at that point.
// ---------------------------------------------------------------------------
const EXPORT_MODES = ['auto', 'sdr', 'both']

// ---------------------------------------------------------------------------
// collectAllItems' preview-field drop-list (SP-fixes-batch T2)
//
// Preview-only artifacts that collectAllItems (below) must never let reach a
// render item, even though its passthrough spread forwards everything else on
// the item by default. `proxySrc` is the SP3 full-source 720p editing proxy —
// instant-scrub preview only; render always resolves the master via
// `src`/`normalizedSrc` through `sourceWindow`, never the proxy.
// `nobg_preview_src` is the preview-resolution VP9-with-alpha
// background-removal cache; render's own remove_bg pipeline produces (and
// reads) `nobg_src`, a ProRes 4444 master, instead. See schema.ts for both
// fields' full docs and KNOWN-DIVERGENCES.md `nobg-precedence` for why preview
// and render disagree here on purpose.
//
// Declared up here beside EXPORT_MODES, not down by collectAllItems itself,
// for the SAME reason spelled out in the comment above: the CLI block right
// below calls `main()` synchronously during module evaluation, and `main()`
// reaches `collectAllItems()` before its first `await` — so a `const`
// declared near collectAllItems would still be in its temporal dead zone the
// first time a real render hits it.
// ---------------------------------------------------------------------------
const DROPPED_PREVIEW_FIELDS = ['proxySrc', 'nobg_preview_src']

// ---------------------------------------------------------------------------
// SDR masters of untagged sources (see repointStaleUntaggedMasters). Up here
// for the same temporal-dead-zone reason as DROPPED_PREVIEW_FIELDS: main()
// reads them before its first await.
// ---------------------------------------------------------------------------
/** Keep identical to lib/normalize.py's UNTAGGED_MASTER_MARKER. */
const UNTAGGED_MASTER_MARKER = 'montaj: untagged source read as BT.709'
const SDR_MASTER_SUFFIX = '_normalized_sdr_bt709.mp4'
const VIDEO_EXT = /^\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts|ts|3gp|mxf|mpg|mpeg|wmv|flv)$/i

// The SDR pass's layer (sdr-layer.js's sdrLayerFor) for one video item, carried
// on the item under a symbol. collectAllItems copies an item with object spread,
// which copies symbol keys too, so each render item keeps the layer its source
// item was given; JSON never sees it.
const SDR_LAYER = Symbol('montaj.sdrLayer')

// Image tone modes for HDR overlay-image conversion. Keep in sync with
// lib/normalize_image.py::TONE_MODES and the editor's imageTone.ts. Up here for
// the same TDZ reason: under --export sdr on an HDR project (no HDR prepare)
// main() reaches resolveImageTone before its first await.
const IMAGE_TONE_MODES = ['vivid', 'broadcast', 'punchy', 'raw']
const DEFAULT_IMAGE_TONE = 'vivid'

// ---------------------------------------------------------------------------
// Design resolution for overlay capture — always 1080 on the short edge,
// with the aspect ratio of settings.resolution (or 9:16 portrait by default).
//
// Why "always 1080 short edge" and not settings.resolution itself: overlay
// JSX is authored in fixed design-px coordinates (fontSize: 120, top: 350).
// If the Puppeteer viewport scaled with settings.resolution (e.g. 2160×3840
// for a 4K project), those same hardcoded sizes would be interpreted at the
// larger canvas — a 120px headline would only cover ~5% of canvas width
// instead of ~11%, and overlays would render small + top-left-cornered.
//
// Keeping the overlay canvas at 1080 short edge means JSX coordinates have
// one consistent meaning regardless of output resolution; the compose step
// then scales the captured overlay to the actual output dimensions when
// compositing onto the final video, so the same JSX fits every output size.
//
// Note the compose-time scale is NOT the design-canvas-to-output ratio: the
// capture is taken at captureScaleFor's deviceScaleFactor, so it already
// arrives on the output's own pixel grid wherever that scale is exact (an
// identity at 4K and at 1080p alike). Compose only rescales where it isn't —
// a sub-1080 output, or a project with no settings.resolution.
//
// Hoisted to module scope (rather than local to main()) so main()'s
// renderWidth/renderHeight math and captureScaleFor, below, share one
// definition of what "1080" means.
// ---------------------------------------------------------------------------
const SHORT_EDGE_TARGET = 1080

/**
 * Puppeteer capture scale (deviceScaleFactor) for a project's output resolution.
 *
 * Captures on the OUTPUT's own pixel grid so the compose-time scale from
 * captured-overlay to final-video is an identity, not a resample.
 * `deviceScaleFactor: 2` is correct only when the output is exactly 2× the
 * SHORT_EDGE_TARGET design canvas — i.e. a 4K (2160 short edge) project,
 * where 1080 × 2 = 2160. At 1080p output that same fixed 2× forces compose
 * to downscale the capture 2160 → 1080, discarding roughly a third of the
 * detail Chrome actually drew for no benefit.
 *
 * Clamped to [1, 2]: the floor of 1 keeps a sub-1080 output from capturing
 * BELOW the design canvas (the capture itself would be blurrier than the
 * design, before compose ever runs); the ceiling of 2 stops an 8K project
 * from quadrupling capture memory/CPU without that being a deliberate
 * decision.
 *
 * Takes `settings.resolution` directly rather than the eventually-resolved
 * output width/height, and deliberately does NOT fall back to probing a video
 * item when resolution is unset.
 *
 * Why not: `probeVideoDimensions` reads *coded* dimensions and ignores rotation
 * side-data. The step-"6." probe below runs late, on the POST-normalize source,
 * and normalize re-encodes through ffmpeg without `-noautorotate` — so it bakes
 * rotation into the pixels and strips the side-data, leaving coded == display.
 * Running the same probe early, before normalize, would instead read the
 * pre-normalize source, where rotated footage (an iPhone vertical clip: coded
 * 1920×1080, rotation −90, display 1080×1920) reports its dimensions
 * TRANSPOSED relative to what step 6 sees. Deriving a capture scale from that
 * is how a portrait project silently captures landscape.
 *
 * So a project with no settings.resolution keeps today's unconditional 2× — a
 * safe, deliberate no-op — rather than gaining the improvement at the cost of
 * an early probe that can be transposed.
 */
function captureScaleFor(resolution) {
  // Array.isArray, not `?? []`: settings.resolution comes from JSON.parse, so a
  // hand-edited project can hold an object, string, number or boolean there.
  // Those are not nullish, so `?? []` would pass them to the destructure, and
  // anything non-iterable throws — aborting the whole render on a malformed
  // field that every other consumer (settings.resolution?.[0] ?? 1080) has
  // always tolerated. Array.isArray splits the JSON value space exactly.
  const [rawW, rawH] = Array.isArray(resolution) ? resolution : []
  // Coerced, not type-checked, to stay consistent with the design-canvas math
  // below, which reaches the same numbers through Math.min/Math.round and so
  // accepts numeric strings. Without this, ["1920","1080"] would build a real
  // 1920x1080 canvas there while silently falling back to 2 here — the same
  // "two places disagree about a dimension" shape this change exists to fix.
  const w = Number(rawW)
  const h = Number(rawH)
  // Non-positive is malformed, not merely small: it must degrade to 2 like any
  // other bad value rather than reach the clamp, which would floor it to 1 and
  // quietly contradict this function's own contract.
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 2
  return Math.min(2, Math.max(1, Math.min(w, h) / SHORT_EDGE_TARGET))
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

if (isMain) {
  const argv = process.argv.slice(2)

  if (!argv.length || argv[0] === '--help') {
    process.stderr.write('Usage: render.js <project.json> [--out <path>] [--workers <n>] [--clean] '
      + '[--image-tone <vivid|broadcast|punchy|raw>] [--export <auto|sdr|both>] [--sdr-curve <id>]\n')
    process.exit(1)
  }

  let projectArg   = null
  let outArg       = null
  let workersArg   = null
  let cleanArg     = false
  let imageToneArg = null
  let exportArg    = null
  let sdrCurveArg  = null

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out')        { outArg       = argv[++i]; continue }
    if (argv[i] === '--workers')    { workersArg   = parseInt(argv[++i], 10); continue }
    if (argv[i] === '--clean')      { cleanArg     = true; continue }
    if (argv[i] === '--image-tone') { imageToneArg = argv[++i]; continue }
    if (argv[i] === '--export')     { exportArg    = argv[++i]; continue }
    if (argv[i] === '--sdr-curve')  { sdrCurveArg  = argv[++i]; continue }
    if (!projectArg) projectArg = argv[i]
  }

  if (!projectArg) fail('missing_argument', 'No project.json path provided')

  // Both resolvers throw rather than exiting so they stay unit-testable; the
  // CLI is the layer that turns a bad flag into the JSON-on-stderr + exit 1
  // convention. Validated here, before any work starts, so a typo costs
  // nothing instead of surfacing after a 10-minute render.
  let exportMode = 'auto'
  let sdrCurve   = null
  try {
    exportMode = resolveExportMode(exportArg)
    sdrCurve   = resolveSdrCurve(sdrCurveArg)
  } catch (err) {
    fail('invalid_argument', err.message)
  }

  main(projectArg, {
    out: outArg, workers: workersArg, clean: cleanArg, imageTone: imageToneArg,
    exportMode, sdrCurve,
  }).catch(err => {
    fail('render_error', err.message)
  })
}

/**
 * Resolve the effective image tone: CLI flag > project settings > default.
 * Fails fast on an invalid value from either source — a typo silently falling
 * back to the default would be a color bug nobody can see in the logs.
 */
function resolveImageTone(cliValue, settings) {
  const chosen = cliValue ?? settings?.imageTone ?? DEFAULT_IMAGE_TONE
  if (!IMAGE_TONE_MODES.includes(chosen)) {
    fail('invalid_argument',
      `Unknown image tone ${JSON.stringify(chosen)} — expected one of ${IMAGE_TONE_MODES.join(', ')}`)
  }
  return chosen
}

/** Validate `--export`. Returns the mode ('auto' when omitted); throws on an unknown value. */
function resolveExportMode(value) {
  const chosen = value ?? 'auto'
  if (!EXPORT_MODES.includes(chosen)) {
    throw new Error(`Unknown export mode ${JSON.stringify(chosen)} — expected one of ${EXPORT_MODES.join(', ')}`)
  }
  return chosen
}

/**
 * Validate `--sdr-curve` against the look registry. Returns null when omitted
 * (meaning "the master look"); throws listing the valid ids on an unknown one.
 * A silent fallback to the master look would be a color bug the user can only
 * find by eye, so this is a hard error.
 */
function resolveSdrCurve(value) {
  if (value == null) return null
  const ids = curveIds()
  if (!ids.includes(value)) {
    throw new Error(
      `Unknown sdr curve ${JSON.stringify(value)} — expected one of ${ids.join(', ')}. `
      + `Check montaj_assets/luts/looks.json.`)
  }
  return value
}

/**
 * `<name>.mp4` + '-sdr' → `<name>-sdr.mp4`, the compose.js `.replace(/(\.\w+)$/,…)`
 * idiom. Falls back to plain appending when the path has no extension (`--out
 * /tmp/clip`): the point of a sibling name is that it is a DIFFERENT file, and
 * a no-op replace would hand ffmpeg the same path to read and write.
 */
function siblingPath(path, suffix) {
  return /(\.\w+)$/.test(path)
    ? path.replace(/(\.\w+)$/, `${suffix}$1`)
    : `${path}${suffix}`
}

/**
 * Decide what this render emits and where each compose writes.
 *
 * @param {object} args
 * @param {string} args.exportMode          'auto' | 'sdr' | 'both'
 * @param {string} args.projectColorSpace   the project's working color space
 * @param {string} args.outputPath          the file the user asked for
 * @returns {{
 *   mode: string,              effective mode: 'auto' once an SDR project downgrades
 *   composePath: string|null,  where the project-colour-space compose writes, or
 *                              null when there is none (--export sdr on HDR)
 *   derivePath: string|null,   where the per-layer SDR pass writes, or null for none
 *   outputs: string[],         files this render emits, primary first
 *   notice: string|null,       one-line explanation of a downgraded request
 * }}
 */
function planExport({ exportMode, projectColorSpace, outputPath }) {
  // An SDR project's render already IS the SDR rendition, so there is no second
  // pass to run. Say so once, then behave exactly like auto rather than emitting
  // a pointless second identical file.
  if (exportMode === 'auto' || !isHdr(projectColorSpace)) {
    const notice = exportMode === 'auto' ? null
      : `--export ${exportMode}: this project is already SDR (${projectColorSpace}) — `
        + `its render is the SDR rendition; emitting one file`
    return {
      mode: 'auto',
      composePath: outputPath,
      derivePath: null,
      outputs: [outputPath],
      notice,
    }
  }

  if (exportMode === 'both') {
    const derivePath = siblingPath(outputPath, '-sdr')
    return {
      mode: 'both',
      composePath: outputPath,
      derivePath,
      outputs: [outputPath, derivePath],
      notice: null,
    }
  }

  // 'sdr' on an HDR project: the SDR pass composes the project per layer
  // straight into the user's name (PV42). Nothing needs an HDR master, so none
  // is composed: no scratch file, nothing to clean up.
  return {
    mode: 'sdr',
    composePath: null,
    derivePath: outputPath,
    outputs: [outputPath],
    notice: null,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(projectPath, { out, workers, clean, imageTone, exportMode = 'auto', sdrCurve = null }) {
  // 1. Validate + resolve paths
  const absProjectPath = resolve(projectPath)
  if (!existsSync(absProjectPath)) fail('file_not_found', `project.json not found: ${absProjectPath}`)

  const projectJson = JSON.parse(readFileSync(absProjectPath, 'utf8'))

  if (projectJson.status !== 'final') {
    fail('invalid_status', `Project status must be 'final', got '${projectJson.status ?? 'undefined'}'`)
  }

  const projectDir = dirname(absProjectPath)
  resolveProjectPaths(projectJson, projectDir)
  validateProjectFiles(projectJson)
  // The project as the user wrote it (paths resolved), for the per-layer SDR
  // pass (7b). Taken before anything below mutates projectJson: the repoint
  // right after this, collectAllItems' cache swaps and every src the HDR pass
  // rewrites all act on projectJson, never on this copy.
  const pristineProject = structuredClone(projectJson)
  // Before collectAllItems swaps in any cache: an SDR master an older montaj
  // built from an untagged source is sent back to its source, so the normalize
  // pass (3) rebuilds it. See repointStaleUntaggedMasters.
  repointStaleUntaggedMasters(projectJson)

  const settings = projectJson.settings || {}
  const fps    = settings.fps || 30
  // Validated here, before normalisation and bundling, so a bad value fails fast.
  const motionBlur = (() => { try { return resolveMotionBlur(settings.motionBlur) } catch (e) { fail('invalid_argument', e.message) } })()
  // Same reasoning as motionBlur above: a bad settings.loudness should fail
  // before any work starts, not surface as an opaque ffmpeg loudnorm error deep
  // in the mix pass. loudnessFilter's own range/finiteness check is reused
  // here; the built filter string is discarded.
  try { loudnessFilter('[x]', settings.loudness) } catch (e) { fail('invalid_argument', e.message) }

  // See SHORT_EDGE_TARGET's module-level comment for why the overlay design
  // canvas is always 1080 on the short edge, independent of settings.resolution.
  const aspectW = settings.resolution?.[0] ?? 1080
  const aspectH = settings.resolution?.[1] ?? 1920
  const aspectRatio = SHORT_EDGE_TARGET / Math.min(aspectW, aspectH)
  // Round to even pixels — odd dimensions break some yuv420 encoders.
  const renderWidth  = Math.round(aspectW * aspectRatio / 2) * 2
  const renderHeight = Math.round(aspectH * aspectRatio / 2) * 2

  // project.json always lives at the workspace root (written there by project/init.py),
  // so projectDir === workspaceDir. Render outputs go to workspace/<name>/render/.
  const workspaceDir = projectDir
  const renderDir    = join(workspaceDir, 'render')
  const segDir       = join(renderDir, 'segments')

  // Concurrent-render guard. The segment wipe below is destructive — if a second
  // render starts while the first is still encoding, the wipe deletes the first
  // render's in-progress segment files, producing corrupt output (e.g. two
  // ffmpeg processes both writing to seg-NNNN.mp4 leave AAC packet payloads as
  // zeros where one process's faststart-reopen seek crosses the other's writes).
  //
  // Acquisition uses openSync('wx') — O_CREAT | O_EXCL — which is atomic at the
  // OS level. A check-then-write sequence is NOT enough: two processes that
  // start at nearly the same instant can both observe "no lock present," both
  // write their PID, and both proceed. EXCL makes the create-or-fail single-step.
  //
  // Stale-lock reclamation: if EEXIST and the recorded PID is dead, we delete
  // the lockfile and retry once. If the retry also EEXISTs, another process
  // beat us to reclaiming it — bail out.
  mkdirSync(renderDir, { recursive: true })
  const lockPath = join(renderDir, '.render.lock')
  function tryAcquireLock() {
    try {
      const fd = openSync(lockPath, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (e) {
      if (e.code === 'EEXIST') return false
      throw e
    }
  }
  if (!tryAcquireLock()) {
    let ownerPid = 0
    try { ownerPid = parseInt(readFileSync(lockPath, 'utf8').trim(), 10) } catch {}
    let alive = false
    if (ownerPid > 0) {
      try { process.kill(ownerPid, 0); alive = true } catch {}
    }
    if (alive) {
      fail('concurrent_render', `another render is in progress (pid ${ownerPid}). Wait for it to finish, or remove ${lockPath} if it's dead.`)
    }
    rmSync(lockPath, { force: true })
    if (!tryAcquireLock()) {
      fail('concurrent_render', `another render claimed the stale lock`)
    }
  }
  process.on('exit', () => { try { rmSync(lockPath, { force: true }) } catch {} })

  // Always wipe segments from previous runs — stale files cause FFV1 decode errors in compose.
  rmSync(segDir, { recursive: true, force: true })
  mkdirSync(segDir, { recursive: true })

  const outputPath = out ? resolve(out) : join(renderDir, `${safeFilename(projectJson.name)}.mp4`)

  // Early exit: ffmpeg drawtext path — bypass Puppeteer, delegate to lyrics_render.py
  if (projectJson.renderMode === 'ffmpeg-drawtext') {
    const captions = projectJson.captions
    if (!captions?.segments?.length) {
      fail('missing_captions', 'renderMode ffmpeg-drawtext requires project.json captions.segments')
    }
    const firstAudioTrack = (projectJson.audio?.tracks ?? []).find(t => !t.muted)
    if (!firstAudioTrack?.src) fail('missing_audio', 'renderMode ffmpeg-drawtext requires at least one unmuted audio track')
    const audioSrc = firstAudioTrack.src

    // Caption LANES (rows) have no counterpart on this path. lyrics_render.py
    // builds one flat drawtext filter chain and derives each word's end time
    // from the NEXT segment's start, which assumes a single ordered,
    // non-overlapping stream of captions — there is nowhere to hang a second
    // row, and no per-row anchor. Every row is therefore drawn at the same
    // anchor and they will overlap. That is honest; silently dropping the rows
    // an operator built would be worse, so warn and render. The Puppeteer path
    // (below) draws rows properly.
    const laneCount = new Set(captions.segments.map(s => s.lane ?? 0)).size
    if (laneCount > 1) {
      log(`captions span ${laneCount} rows, but renderMode ffmpeg-drawtext has no per-row concept: `
        + `all rows will be drawn at the same anchor and may overlap`)
    }

    // Write captions to temp file. Captions in project.json are already in project-timeline
    // coordinates (0-based), so audioInPoint=0 — no timestamp offset needed.
    // The audio seek is passed separately via --audio-inpoint.
    const captionsPath = join(renderDir, 'captions_ffmpeg.json')
    mkdirSync(renderDir, { recursive: true })
    const captionsWithOffset = { ...captions, audioInPoint: 0 }
    writeFileSync(captionsPath, JSON.stringify(captionsWithOffset))

    // Optional background video: first video item in tracks[0]
    const bgItem = (enabledTrackItems(projectJson)[0] ?? []).find(i => i.type === 'video')

    const projectDuration = getTotalDurationSeconds(projectJson)
    const lyricsRenderArgs = [
      join(MONTAJ_ROOT, 'steps', 'lyrics', 'lyrics_render.py'),
      '--captions', captionsPath,
      '--audio',    audioSrc,
      '--width',    String(renderWidth),
      '--height',   String(renderHeight),
      '--fps',      String(fps),
      '--duration', String(projectDuration),
      '--out',      outputPath,
    ]
    const audioInPoint = firstAudioTrack.inPoint ?? 0
    if (bgItem)                    lyricsRenderArgs.push('--input',         bgItem.src)
    if (audioInPoint)              lyricsRenderArgs.push('--audio-inpoint', String(audioInPoint))
    if (captions.position)         lyricsRenderArgs.push('--position',      captions.position)
    // color: 'auto' is the default — only pass explicit colors
    if (captions.color && captions.color !== 'auto')
                                   lyricsRenderArgs.push('--color',         captions.color)
    if (captions.fontsize)         lyricsRenderArgs.push('--fontsize',      String(captions.fontsize))
    if (captions.bgColor)          lyricsRenderArgs.push('--bg-color',      captions.bgColor)
    if (captions.windowSize)       lyricsRenderArgs.push('--window-size',   String(captions.windowSize))
    if (captions.wordsPerLine)     lyricsRenderArgs.push('--words-per-line', String(captions.wordsPerLine))
    if (captions.accumulate)       lyricsRenderArgs.push('--accumulate')
    if (captions.box)              lyricsRenderArgs.push('--box')

    // lyrics_render.py emits SDR h264 whatever settings.colorSpace claims, so
    // there is no HDR master here to derive an SDR rendition from.
    if (exportMode !== 'auto') {
      log(`--export ${exportMode} has no effect for renderMode ffmpeg-drawtext — `
        + `its output is always SDR; emitting one file`)
    }

    log('rendering via ffmpeg drawtext (skipping Puppeteer)...')
    const result = spawnSync(PYTHON, lyricsRenderArgs, { encoding: 'utf8', timeout: 600_000 })
    if (result.status !== 0) {
      fail('lyrics_render_failed', result.stderr?.trim() || 'lyrics_render.py failed')
    }

    // lyrics_render.py is pure SDR (drawtext over solid colour or SDR bg video);
    // pass the project's setting if any, helper treats unset as SDR.
    embedThumbnail(outputPath, settings.colorSpace ?? null)

    process.stdout.write(outputPath + '\n')
    return
  }

  // 2. Collect segments and items
  const segmentSpecs = collectPuppeteerSegments(projectJson, fps, renderWidth, renderHeight, segDir)
  const { imageItems, videoItems } = collectAllItems(projectJson)

  // Every http(s) URL an overlay's props name, fetched once, now, by Node: the
  // pages are served from this cache and reach nothing themselves (PV54,
  // page-guard.js). A failure is logged here and fails the render only if a
  // page asks for that URL (props also hold URLs shown only as text).
  await prefetchPropsUrls(segmentSpecs.flatMap(spec => namedPropsUrls(spec.props)))

  // Puppeteer overlay capture scale — derived from settings.resolution alone
  // (not the eventual actualWidth/actualHeight below, which for a project with
  // no settings.resolution isn't resolved until AFTER normalize/remove_bg have
  // run — see captureScaleFor's doc comment for why an early probe of the
  // pre-normalize src would be unsafe for rotated footage). Computed once here
  // and stamped onto every segment spec so renderAllSegments' `{ ...seg, ... }`
  // job spread (renderer.js) carries it through to each Puppeteer capture.
  const captureScale = captureScaleFor(settings.resolution)
  for (const spec of segmentSpecs) spec.captureScale = captureScale

  // colorTransfer and hasAudio, once per unique source (see stampSourceProbes).
  const transferCache = new Map()
  stampSourceProbes(videoItems, transferCache)

  // Project working color space — drives normalize CLI flag, segment encoder
  // codec/pix_fmt, and per-item conversion filter.
  //
  // Resolution order:
  //   1. settings.colorSpace present → validate strictly (hand-edited bad
  //      values fail loudly rather than silently coercing).
  //   2. Missing → smart-detect from probed transfers (modal-wins, mirrors
  //      init.py). This handles legacy projects predating the colorSpace
  //      field: without backfill they'd default to SDR and trigger normalize
  //      on every iPhone-HLG clip. Persist the resolved key back to project.json
  //      so subsequent renders skip the detection step.
  //   3. No video items at all (canvas project) → default SDR.
  let projectColorSpace
  if (settings.colorSpace != null) {
    projectColorSpace = requireValidKey(settings.colorSpace)
  } else if (videoItems.length > 0) {
    const detectedKeys = videoItems
      .filter(it => !(it.remove_bg && it.nobg_src && it.src === it.nobg_src))
      .map(it => detectFromTransfer(it.colorTransfer))
    projectColorSpace = smartDetect(detectedKeys)
    log(`colorSpace not set — smart-detected ${projectColorSpace} from ${detectedKeys.length} clip(s); writing back to project.json`)
    // Re-read the raw JSON to patch settings.colorSpace — projectJson in memory
    // has been mutated by resolveProjectPaths (relative srcs → absolute), and
    // serialising that would corrupt the on-disk project.json.
    const rawProject = JSON.parse(readFileSync(absProjectPath, 'utf8'))
    rawProject.settings = { ...(rawProject.settings ?? {}), colorSpace: projectColorSpace }
    writeFileSync(absProjectPath, JSON.stringify(rawProject, null, 2))
  } else {
    projectColorSpace = DEFAULT_COLOR_SPACE
  }

  // 2b. Export plan — what this render emits, and where compose writes. Resolved
  //     as soon as the working color space is known so a downgraded request
  //     ("--export sdr on an already-SDR project") is reported before the
  //     expensive work rather than after it.
  const exportPlan = planExport({ exportMode, projectColorSpace, outputPath })
  if (exportPlan.notice) log(exportPlan.notice)

  // 3 to 4b. Conform every video item to the project's own colour space: the
  //     HDR pass, exactly what it always was. Skipped under --export sdr on
  //     an HDR project, which composes no HDR master; the SDR pass (7b) prepares
  //     its own items instead.
  if (exportPlan.composePath) {
    await prepareVideoItems(videoItems, () => projectColorSpace, { settings, workspaceDir, transferCache })
  }

  // 5. Bundle + render all overlay and caption segments
  // PHASE MARKERS: serve's `_render_phase_for` (serve/routes/projects.py) maps
  // "with Puppeteer" + "bundling segment" → rendering, and a `(captions)` segment
  // id → captions. Keep these substrings in sync if you reword these log lines.
  log(`rendering ${segmentSpecs.length} segment(s) with Puppeteer...`)

  const workDirs = []

  for (let i = 0; i < segmentSpecs.length; i++) {
    const spec = segmentSpecs[i]
    log(`bundling segment ${i + 1}/${segmentSpecs.length} (${spec.id})...`)
    // The geometry below is read by generateShim (bundle.js) ONLY when the item
    // carries `keyframes` — the one case where the ffmpeg composite cannot do
    // the positioning, because the filter graph places an overlay once for a
    // whole segment and an animated one has to move within it. That item's
    // transform is baked into the Puppeteer capture per frame instead, and
    // buildOverlayFilterParts (encode-segment.js) then composites it full-canvas.
    //
    // For every other overlay — the overwhelmingly common case — these five are
    // still DEAD PARAMETERS, exactly as they were before SP9b: generateShim
    // accepts them, emits nothing, and positioning happens entirely at ffmpeg
    // composite time. The un-baked shim is byte-identical to the pre-keyframes
    // one, deliberately, which is what keeps the render goldens valid. Don't
    // "fix" that apparent omission for a static overlay: it isn't one.
    const { htmlPath, workDir, boundary, needsGoogleFonts } = await bundleComponent({
      componentPath:  spec.componentPath,
      props:          spec.props,
      fps,
      durationFrames: spec.frameCount,
      width:          renderWidth,
      height:         renderHeight,
      offsetX:        spec.offsetX     ?? 0,
      offsetY:        spec.offsetY     ?? 0,
      scale:          spec.scale       ?? 1,
      // Per-axis siblings, resolved with the same `?? scale ?? 1` chain the
      // timeline-core resolver uses, so a legacy uniform item forwards three
      // identical numbers and bakes exactly what it always baked.
      scaleX:         spec.scaleX ?? spec.scale ?? 1,
      scaleY:         spec.scaleY ?? spec.scale ?? 1,
      rotation:       spec.rotation    ?? 0,
      opacity:        spec.opacity     ?? 1,
      keyframes:      spec.keyframes   ?? null,
      googleFonts:    spec.googleFonts ?? [],
      fontsBaseDir:   MONTAJ_FONTS_DIR,
      projectDir,
    })
    spec.htmlPath = htmlPath
    // The page guard's inputs (page-guard.js), carried on the spec so the SDR
    // re-capture's `{ ...spec }` keeps them too. The cache is this page's own
    // props URLs, all fetched above.
    spec.boundary = boundary
    spec.needsGoogleFonts = needsGoogleFonts
    spec.propsCache = await prefetchPropsUrls(boundary.urls)
    workDirs.push(workDir)
  }

  const effectiveImageTone = resolveImageTone(imageTone, settings)
  // Captured in the colour space of the first compose that composites them: the
  // project's, or sdr_bt709 when --export sdr on an HDR project composes only
  // the SDR pass. (Colour space reaches a capture only through the <img>
  // interceptor in renderer.js.)
  const captureColorSpace = exportPlan.composePath ? projectColorSpace : 'sdr_bt709'
  const renderedSegments = await renderAllSegments(segmentSpecs, { workers, colorSpace: captureColorSpace, imageTone: effectiveImageTone, motionBlur })

  // Attach positioning offsets back onto rendered segments so compose.js can apply
  // x/y coordinates. Overlay size is derived from the output canvas at compose
  // time (see encode-segment.js), so no scale factor is stamped here.
  for (const rSeg of renderedSegments) {
    const spec = segmentSpecs.find(s => s.id === rSeg.id)
    if (spec) {
      rSeg.offsetX   = spec.offsetX   ?? 0
      rSeg.offsetY   = spec.offsetY   ?? 0
      rSeg.scale     = spec.scale     ?? 1
      // Same reference-flow argument as rotation below, and the same shape of
      // partial failure: buildOverlayFilterParts sizes a non-keyframed overlay
      // from `geometryFor(ov, 'overlay')` read off THIS object, and that
      // resolver reads `scaleX`/`scaleY` before falling back to `scale`. Miss
      // these two lines and a non-uniform overlay renders as a uniform box
      // while the preview shows it stretched.
      rSeg.scaleX    = spec.scaleX ?? spec.scale ?? 1
      rSeg.scaleY    = spec.scaleY ?? spec.scale ?? 1
      // rotation must be restated here too: these rSeg objects flow BY REFERENCE
      // through segment-plan.js's `overlays` array (built via activeIn() over
      // puppeteerSegs, preserving object identity) into buildOverlayFilterParts,
      // which reads rotation off this very object via geometryFor(ov, 'overlay').
      // Skipping this line is the worst partial failure: images/videos rotate
      // correctly while overlays silently don't.
      rSeg.rotation  = spec.rotation  ?? 0
      // The OTHER half of the missing-overlay-opacity bug. collectPuppeteerSegments
      // has always collected `opacity` onto the spec, but it stopped here — so even
      // once buildOverlayFilterParts learned to emit `colorchannelmixer=aa=`, it
      // would have read `undefined` off every descriptor and emitted nothing. Both
      // halves are required; neither alone does anything.
      rSeg.opacity   = spec.opacity   ?? 1
      rSeg.opaque    = spec.opaque    ?? false
      rSeg.isCaption = spec.isCaption ?? false
      // Same reference-flow argument as rotation directly above, and the same
      // worst-case partial failure: buildOverlayFilterParts reads `keyframes`
      // off THIS object to decide that the capture is already positioned. Miss
      // this line and an animated overlay gets its transform applied TWICE —
      // once baked into the pixels, once by the compositor. Assigned only when
      // the spec actually has tracks, so a static overlay's descriptor keeps no
      // `keyframes` key at all and takes the byte-identical filter path.
      if (spec.keyframes?.length) rSeg.keyframes = spec.keyframes
    }
  }

  // 6. Output size: see outputSize. Overlays are composited by scaling the
  // 1080-design canvas to the actual output dimensions at compose time (see
  // buildOverlayFilterParts in encode-segment.js). No per-segment scale factor is
  // stamped here; the compositor derives the size from the output canvas
  // directly, so overlays fit any resolution (4K up, sub-1080 down, non-integer
  // multiples) instead of being cropped onto smaller canvases.
  let outputDims = null

  // 7. Compose final MP4 at the project's colour space (every mode but --export
  //    sdr on an HDR project).
  if (exportPlan.composePath) {
    outputDims = outputSize(settings, videoItems, renderWidth, renderHeight)
    // PHASE MARKER: "composing final video" → encoding in serve's _render_phase_for.
    log('composing final video...')
    await compose({
      projectJson,
      puppeteerSegments: renderedSegments,
      imageItems,
      videoItems,
      outputPath: exportPlan.composePath,
      videoWidth:  outputDims[0],
      videoHeight: outputDims[1],
      colorSpace:  projectColorSpace,
      sdrCurve,
    })
  }

  // 7b. The SDR rendition of an HDR project (--export sdr|both), composed per
  //     layer (PV42): a second compose at sdr_bt709 in which each video layer is
  //     brought to SDR on its own. HDR-origin clips are graded once, in the
  //     segment encoder; SDR-origin clips come from their SDR original,
  //     ungraded; overlays and images composite as authored. The HDR master is
  //     neither read nor touched. For `both` it runs after the HDR compose,
  //     never beside it (Sam, PV42 Q3). auto skips this block entirely.
  if (exportPlan.derivePath) {
    // PHASE MARKER: "deriving SDR rendition" → `sdr_derive` in serve's
    // _render_phase_for (serve/routes/projects.py); the editor's render stepper
    // keys off that phase name, and serve keeps it once reached, through this
    // pass's own compose lines. Keep this substring in sync if you reword.
    log(`deriving SDR rendition → ${basename(exportPlan.derivePath)} (per layer)...`)
    const sdr = await prepareSdrPass(pristineProject, { projectColorSpace, workspaceDir })
    // One size for both files: the HDR pass's, when there is one.
    const [sdrWidth, sdrHeight] = outputDims ?? outputSize(settings, sdr.videoItems, renderWidth, renderHeight)
    // The overlay captures the SDR pass composites: the ones above, as they are
    // (under --export sdr they were taken at sdr_bt709 already, so hdrImages is
    // 0 and nothing is redone). Only a capture whose <img> was served a converted
    // body by the HDR interceptor (renderer.js) differs in SDR; those segments,
    // and only those, are captured again at sdr_bt709 (PV42 T7).
    const recapture = renderedSegments.filter(s => s.hdrImages > 0)
    let sdrCaptures = []
    if (recapture.length > 0) {
      // Deliberately avoids the phase-marker substrings ("bundling segment",
      // "with Puppeteer"): serve would read them as a new bundling phase.
      log(`re-capturing ${recapture.length} overlay segment(s) with images for SDR`)
      sdrCaptures = await renderAllSegments(sdrRecaptureSpecs(recapture, segmentSpecs), {
        workers, colorSpace: 'sdr_bt709', imageTone: effectiveImageTone, motionBlur,
      })
    }
    const sdrOverlaySegments = mergeSdrCaptures(renderedSegments, sdrCaptures)
    // compose embeds this file's poster itself, as SDR: no LUT on the extract.
    await compose({
      projectJson: sdr.project,
      puppeteerSegments: sdrOverlaySegments,
      imageItems:  sdr.imageItems,
      videoItems:  sdr.videoItems,
      outputPath:  exportPlan.derivePath,
      videoWidth:  sdrWidth,
      videoHeight: sdrHeight,
      colorSpace:  'sdr_bt709',
      sdrCurve,
    })
  }

  // 8. Cleanup temp bundles (always); intermediate segments only if --clean
  for (const dir of workDirs) cleanupBundle(dir)

  if (clean) {
    rmSync(segDir, { recursive: true, force: true })
    log('intermediate files cleaned')
  }

  // Step output convention: final path on stdout. --export both emits two files;
  // the master keeps line 1 so every single-path reader (montaj render, Hub,
  // serve's job.result) still sees the same thing it always has, and the SDR
  // sibling follows on line 2.
  process.stdout.write(exportPlan.outputs.join('\n') + '\n')
}

/**
 * The specs to capture again for the SDR pass: those of the already-rendered
 * `recapture` segments, each writing to its own `-sdr` path so the HDR capture
 * (still needed by the HDR compose) is not overwritten.
 */
export function sdrRecaptureSpecs(recapture, segmentSpecs) {
  return recapture.map(r => {
    const spec = segmentSpecs.find(s => s.id === r.id)
    // A sibling `sdr/` dir, not a `-sdr` suffix: overlay `foo`'s suffixed capture
    // (`overlay-N--foo-sdr.mkv`) is overlay `foo-sdr`'s own capture path.
    return { ...spec, outputPath: join(dirname(spec.outputPath), 'sdr', basename(spec.outputPath)) }
  })
}

/**
 * Overlay segments for the SDR compose: each segment keeps every field the
 * geometry loop attached (offsets, scale, opacity, keyframes ...), and a
 * re-captured one only swaps in its SDR capture's `webmPath`.
 */
export function mergeSdrCaptures(renderedSegments, sdrCaptures) {
  const byId = new Map(sdrCaptures.map(c => [c.id, c]))
  return renderedSegments.map(r => byId.has(r.id) ? { ...r, webmPath: byId.get(r.id).webmPath } : r)
}

// ---------------------------------------------------------------------------
// Video item preparation: steps 3 to 4b, and the per-layer SDR pass (PV42)
// ---------------------------------------------------------------------------

/**
 * Stamp each video item's `colorTransfer` and `hasAudio`, probing each unique
 * path once. A typical project breaks one clip into many segments; without the
 * caches, a 50-segment project with 5 items would run each ffprobe 250 times
 * instead of 5.
 *
 * This first transfer stamp is the transfer of the file an item points at
 * BEFORE preparation. It is what the colorSpace smart-detect and the normalize
 * pass (3) need. It is NOT what the segment encoder needs: normalize swaps
 * `item.src` for an already-converted master, so 4b re-stamps from the final
 * src. See the note there.
 */
function stampSourceProbes(videoItems, transferCache, audioCache = new Map()) {
  for (const item of videoItems) {
    if (!transferCache.has(item.src)) {
      transferCache.set(item.src, probeColorTransfer(item.src))
    }
    item.colorTransfer = transferCache.get(item.src) ?? 'unknown'
    // Derived by prepareSdrPass only; a stray project.json field must not
    // change the HDR pass's conversion.
    delete item.gradeFrom
    delete item.alphaGrade
  }
  for (const item of videoItems) {
    if (!audioCache.has(item.src)) {
      audioCache.set(item.src, fileHasAudio(item.src))
    }
    item.hasAudio = audioCache.get(item.src)
  }
}

/**
 * Steps 3 to 4b for one pass, mutating the items: normalize each video item into
 * `targetFor(item)`, strip extra audio streams, run remove_bg, then probe the
 * file each item will actually decode (display size, alpha, and its transfer
 * again). The HDR pass passes `() => projectColorSpace`, which is exactly what
 * main() ran here before PV42; the SDR pass passes a per-layer target (see
 * prepareSdrPass).
 *
 * @param {object[]} videoItems  collectAllItems' video items, stamped by stampSourceProbes
 * @param {(item: object) => string} targetFor  the colour space to normalize an item into
 * @param {object} opts
 * @param {object} opts.settings         the project's settings (lazy normalize)
 * @param {string} opts.workspaceDir     where remove_bg writes
 * @param {Map}    [opts.transferCache]  path → transfer, shared with stampSourceProbes
 * @param {string|null} [opts.timingLabel]  when set, each normalize call logs its duration
 */
async function prepareVideoItems(videoItems, targetFor,
  { settings, workspaceDir, transferCache = new Map(), timingLabel = null }) {
  // 3. Normalize non-conformant video items to their target (parallel, cap=2)
  //    Cap matches materialize_cut.py's libx264 worker count — memory-heavy at 4K.
  //    Requires normalizeIfNeeded to be async (see below) — pMap with a sync mapper
  //    runs sequentially.
  //
  //    Skip remove_bg outputs (nobg_src). collectAllItems swaps `item.src` to
  //    `item.nobg_src` for items with remove_bg: true so downstream stages read
  //    the alpha-channel ProRes file directly. Those nobg files are render-only
  //    artifacts (yuva* pix_fmt, BT.709 SDR) — running them through the
  //    HLG/PQ normalize path fails (libx265 can't open with the resulting
  //    pix_fmt + transfer combination) and would be wrong even if it worked
  //    (we don't want to lose the alpha channel).
  const NORMALIZE_WORKERS = 2
  await pMap(videoItems, async (item) => {
    if (item.remove_bg && item.nobg_src && item.src === item.nobg_src) return
    // Lazy normalize: a pre-built normalizedSrc cache already conforms — skip the
    // python spawn. collectAllItems already substituted it as item.src and
    // rebased inPoint. Without a cache (lazy or eager), fall through to normalize.
    if (shouldSkipNormalize(settings, item)) return
    const target = targetFor(item)
    // tonemapped: this item's own probed transfer is HDR and the target is
    // SDR: the one case normalizeIfNeeded's ffmpeg chain (via lib.normalize)
    // actually runs the HDR→SDR Montaj Vivid LUT. Mirrors the Python sites'
    // `is_hdr(detect_from_transfer(...)) and color_space == "sdr_bt709"` check.
    const tonemapped = isHdr(detectFromTransfer(item.colorTransfer)) && target === 'sdr_bt709'
    // sdrStretch: an SDR source into an HDR target (lib.normalize's stretch at
    // 203 nits). Mirrors the Python sites' `sdr_stretch`.
    const sdrStretch = !isHdr(detectFromTransfer(item.colorTransfer)) && isHdr(target)
    const startedAt = Date.now()
    const normalizedPath = await normalizeIfNeeded(item.src, target, tonemapped,
      { untaggedSource: item.colorTransfer === 'unknown', sdrStretch })
    // Every call, changed path or not: a normalize killed at normalizeIfNeeded's
    // 600 s limit falls back to the unconformed source (normalizeIfNeeded logs the
    // failure), and this line is the one place its duration shows.
    if (timingLabel) {
      log(`${timingLabel}: normalized ${basename(item.src)} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
    }
    if (normalizedPath !== item.src) {
      log(`normalized ${item.src.split('/').pop()} → ${normalizedPath.split('/').pop()}`)
      item.src = normalizedPath
    }
  }, NORMALIZE_WORKERS)

  // 3b. Strip extra (non-AAC) audio streams via stream-copy. iPhone .MOV files
  //     ship TWO audio streams: stream 1 = clean stereo AAC, stream 2 = APAC
  //     (Apple Positional Audio Codec, codec_name=unknown). Even when our
  //     filter graph only references [idx:a:0] (the AAC), ffmpeg's demuxer
  //     still reads the apac packets, and under certain timing / memory
  //     conditions those packets contaminate the AAC decoder context —
  //     producing AAC bitstream output that decodes with "Prediction is not
  //     allowed in AAC-LC" / "channel element X.Y is not allocated" /
  //     "Reserved bit set" errors at concat time, eventually aborting with
  //     "Rematrix is needed between N channels and stereo". The contamination
  //     is non-deterministic — sometimes the same input renders cleanly,
  //     sometimes it produces 400+ decode errors per segment.
  //
  //     Defensive fix: produce a `_audioclean.mov` per source that contains
  //     only video + the first audio stream (`-map 0:v -map 0:a:0 -c copy`).
  //     Stream-copy, no re-encode, ~1s per clip. After this runs, encode-segment
  //     reads a file that ffmpeg cannot possibly mis-demux because the apac
  //     stream literally does not exist in the input. Eliminates the class.
  await pMap(videoItems, async (item) => {
    if (item.remove_bg && item.nobg_src && item.src === item.nobg_src) return
    const cleanPath = await stripExtraAudioStreams(item.src)
    if (cleanPath !== item.src) {
      log(`audio-stripped ${item.src.split('/').pop()} → ${cleanPath.split('/').pop()}`)
      item.src = cleanPath
    }
  }, NORMALIZE_WORKERS)

  // 4. Run remove_bg on any video items that need it
  await processVideoItems(videoItems, workspaceDir)

  // 4b. Probe each video item's display size and alpha, once per unique source,
  //     the same pre-probe idiom as stampSourceProbes. It runs HERE rather than
  //     beside that because it must read the FINAL `item.src`:
  //     normalize (3), the audio strip (3b) and remove_bg (4) can each swap it,
  //     and remove_bg's swap is to the alpha file whose alpha this records.
  //     encode-segment.js reads these to decide whether a video's decrease-fit
  //     leaves bars that must be transparent (see buildVideoItemFilterParts).
  //     Stored on probed* fields, never on sourceWidth/sourceHeight: those are
  //     project-authored and gate the sourceCrop step. A failed probe stamps
  //     nulls, and the encoder then emits its opaque-pad string unchanged.
  //
  //     colorTransfer is re-stamped here for the same reason. The encoder
  //     converts every item whose transfer differs from the project's, so it
  //     must see the transfer of the file it decodes (and the SDR pass takes
  //     its grade key from this stamp; see prepareSdrPass). Normalize hands an HLG
  //     source in an SDR project a master already graded through the Montaj
  //     Vivid LUT; the source's stale `arib-std-b67` sent that master through
  //     the LUT a second time (orange skin, neon colours) while sample_frame,
  //     which decodes the same master untouched, looked right. Pinned by
  //     test/hdr-normalize-parity.integration.test.mjs. A normalize that failed
  //     leaves the HDR source in place, and the encoder still converts it.
  const geometryCache = new Map()
  for (const item of videoItems) {
    if (!geometryCache.has(item.src)) {
      geometryCache.set(item.src, probeVideoGeometry(item.src))
    }
    const geom = geometryCache.get(item.src)
    item.probedWidth  = geom?.width  ?? null
    item.probedHeight = geom?.height ?? null
    item.probedAlpha  = geom?.alpha  ?? null
    if (!transferCache.has(item.src)) {
      transferCache.set(item.src, probeColorTransfer(item.src))
    }
    item.colorTransfer = transferCache.get(item.src) ?? 'unknown'
  }
}

/**
 * The SDR pass's project and items (PV42), ready to compose at sdr_bt709.
 *
 * Starts from the pristine project, never the HDR pass's mutated one, forces
 * sdr_bt709, and replaces each video item with its SDR layer (applySdrLayers):
 * sdr-layer.js's sdrLayerFor is the one place that decides whether a layer is
 * graded, and an SDR-origin item may come back on its SDR original with its HDR
 * conversion cache dropped. Then 5.5.5's repointStaleUntaggedMasters (this is
 * an SDR project now, so a stale unmarked SDR master is rebuilt as it would be
 * in one) and collectAllItems.
 *
 * What each layer is prepared into:
 *   - HDR origin: the project's HDR space, exactly as the HDR pass conformed it,
 *     so both passes decode the same file (a cache hit after the HDR pass). An
 *     HLG clip in a PQ project is converted to PQ here too. Never tone-mapped by
 *     normalize: the grade runs in the segment encoder, after scale. A file that
 *     is already SDR (an HLG clip whose normalizedSrc is a graded SDR master) is
 *     conformed as SDR instead: stretching it into HDR only for the encoder to
 *     grade it back down would grade it twice.
 *   - SDR origin: sdr_bt709, which only conforms (GOP, an untagged file read as
 *     BT.709) and never converts colour.
 *   - a cutout: as the HDR pass prepares it (remove_bg; normalize skips it).
 *
 * After preparation, when 4b has re-stamped colorTransfer from the file each
 * item decodes, every item gets `gradeFrom` (gradeKeyFor: the Vivid source key,
 * or null for no grade) and `alphaGrade` (a cutout of HDR footage). The key is
 * never taken from a probe made before normalize.
 */
async function prepareSdrPass(pristineProject, { projectColorSpace, workspaceDir }) {
  const project = structuredClone(pristineProject)
  project.settings = { ...(project.settings ?? {}), colorSpace: 'sdr_bt709' }
  applySdrLayers(project)
  repointStaleUntaggedMasters(project)
  const { imageItems, videoItems } = collectAllItems(project)

  // A remove_bg item with no cached cutout has nothing to grade as a cutout, so
  // the SDR export shows it as its plain source: say so rather than diverge quietly.
  for (const item of videoItems) {
    if (item.remove_bg && !item.nobg_src) {
      log(`WARNING: ${basename(item.src)} has remove_bg but no nobg_src; it is rendered ungraded in the SDR export`)
    }
  }

  const transferCache = new Map()
  stampSourceProbes(videoItems, transferCache)

  const targetFor = (item) => {
    const layer = item[SDR_LAYER]
    const hdrOrigin = layer.grade && layer.cutoutKey === null
    return hdrOrigin && isHdr(detectFromTransfer(item.colorTransfer)) ? projectColorSpace : 'sdr_bt709'
  }
  await prepareVideoItems(videoItems, targetFor,
    { settings: project.settings, workspaceDir, transferCache, timingLabel: 'SDR pass' })

  for (const item of videoItems) {
    const layer = item[SDR_LAYER]
    item.gradeFrom  = gradeKeyFor(layer, item.colorTransfer)
    item.alphaGrade = layer.cutoutKey !== null
  }
  return { project, imageItems, videoItems }
}

/**
 * Replace each video item on an enabled track of `project` with its SDR layer's
 * item (sdrLayerFor), carrying the layer under SDR_LAYER. Disabled tracks render
 * nothing and are left alone. Rewrites project.tracks, keeping its shape; the
 * raw items are never mutated.
 */
function applySdrLayers(project) {
  if (!Array.isArray(project.tracks)) return
  // One ffprobe per distinct path per call, not one per item.
  const probed = new Map()
  const deps = {
    ...defaultDeps,
    probe: (path) => {
      if (!probed.has(path)) probed.set(path, probeMedia(path))
      return probed.get(path)
    },
  }
  const toLayer = (item) => {
    if (item?.type !== 'video') return item
    const layer = sdrLayerFor(item, deps)
    layer.item[SDR_LAYER] = layer
    return layer.item
  }
  project.tracks = project.tracks.map((track) => {
    if (Array.isArray(track)) return track.map(toLayer)
    if (track && Array.isArray(track.items) && track.enabled !== false) {
      return { ...track, items: track.items.map(toLayer) }
    }
    return track
  })
}

/**
 * The output frame size: settings.resolution when set, otherwise the coded size
 * of the first video item's prepared file, otherwise the design canvas.
 */
function outputSize(settings, videoItems, renderWidth, renderHeight) {
  let width  = settings.resolution?.[0] ?? renderWidth
  let height = settings.resolution?.[1] ?? renderHeight
  if (!settings.resolution) {
    const firstVideo = [...videoItems].sort((a, b) => a.trackIdx - b.trackIdx)[0]
    if (firstVideo) {
      const dims = probeVideoDimensions(firstVideo.src)
      if (dims) { [width, height] = dims }
    }
  }
  return [width, height]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return [width, height] of the first video stream in a file, or null on error. */
function probeVideoDimensions(filePath) {
  const result = spawnSync(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', filePath,
  ], { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) return null
  try {
    const streams = JSON.parse(result.stdout).streams ?? []
    const video = streams.find(s => s.codec_type === 'video')
    if (video?.width && video?.height) return [video.width, video.height]
  } catch {}
  return null
}

// probeColorTransfer lives in derive-sdr.js, which render.js no longer uses for
// the SDR rendition (PV42: it is composed per layer, 7b) but which keeps this
// read: one implementation beats two copies of the trailing-comma workaround its
// doc comment explains.

// ---------------------------------------------------------------------------
// Segment collection: Puppeteer segments (overlay + captions)
// ---------------------------------------------------------------------------

function collectPuppeteerSegments(projectJson, fps, width, height, segDir) {
  const specs = []
  // Quantize every spec time to the frame grid so it matches the segment
  // planner's quantization (segment-plan.js). Without this the overlay's
  // startSeconds/endSeconds disagree with the segment boundaries that display
  // it, off by up to half a frame — the compose-time seek (`segStart -
  // ov.startSeconds`) goes negative on the first segment of the overlay and the
  // frameCount over-shoots by one frame, producing a stray trailing frame the
  // segment never displays.
  const quantize = t => Math.round(t * fps) / fps
  const totalSecs = quantize(getTotalDurationSeconds(projectJson))

  // EVERY enabled track, tracks[0] included. The `item.type === 'overlay'`
  // test below is what keeps footage out of the Puppeteer path, so scanning
  // track 0 picks up its overlays without touching its video or images —
  // those still belong to `collectAllItems`.
  //
  // This used to be `.slice(1)`, on the assumption that tracks[0] is always
  // primary footage. That holds for a filmed edit and fails outright for an
  // agent-authored one: the animations workflow emits projects that are ONE
  // track of nothing but overlays. Those collected zero overlay segments, so
  // the render composited nothing and reported success over an empty output.
  //
  // `trackIdx` shifts by one for overlays that were already on tracks[1+], but
  // it only ever reaches a spec's id and its segment filename — both per-run,
  // and the segment dir is wiped at the start of every render. It is NOT the
  // overlay z-order: overlays composite last and in emission order (see
  // sample-frame.js's ordering note and encode-segment.js), which track order
  // still gives us, so a lower track's overlay stays beneath a higher one's.
  const overlayTracks = enabledTrackItems(projectJson)
  for (let trackIdx = 0; trackIdx < overlayTracks.length; trackIdx++) {
    const track = overlayTracks[trackIdx]
    // Specs this track just produced, keyed by the item's OWN id (not the
    // compound `overlay-${trackIdx}--${item.id}` spec id) — that's the id
    // `transitionPairs` below hands back on `pair.to`.
    const specsById = new Map()
    for (const item of track ?? []) {
      if (item.type === 'overlay') {
        const startSeconds = quantize(item.start)
        const endSeconds   = quantize(item.end)
        const frameCount   = Math.round((endSeconds - startSeconds) * fps)
        const spec = {
          id:            `overlay-${trackIdx}--${item.id}`,
          componentPath: overlayTemplatePath(item),
          props:         item.props ?? {},
          offsetX:       item.offsetX ?? 0,
          offsetY:       item.offsetY ?? 0,
          scale:         item.scale   ?? 1,
          // Per-axis siblings beside `scale`, never instead of it: everything
          // downstream of this spec (bundleComponent's bake, the rSeg
          // descriptor, buildOverlayFilterParts) resolves an axis as
          // `scaleX ?? scale ?? 1`, so a legacy uniform item carries three
          // identical numbers and takes the path it always took.
          scaleX:        item.scaleX ?? item.scale ?? 1,
          scaleY:        item.scaleY ?? item.scale ?? 1,
          rotation:      item.rotation ?? 0,
          opacity:       item.opacity ?? 1,
          opaque:        item.opaque  ?? false,
          googleFonts:   item.googleFonts ?? [],
          // Keyframes drive BOTH ends of the render: bundleComponent bakes the
          // animated transform into the capture, and buildOverlayFilterParts
          // then composites that capture full-canvas instead of positioning it
          // (see both for why). Spread conditionally, NOT defaulted to `[]` —
          // an item that animates nothing must leave the key absent so it
          // reaches the un-baked shim and the byte-identical filter graph.
          ...(item.keyframes?.length ? { keyframes: item.keyframes } : {}),
          frameCount,
          fps,
          startSeconds,
          endSeconds,
          outputPath:    join(segDir, `overlay-${trackIdx}--${item.id}.mkv`),
          width,
          height,
        }
        specs.push(spec)
        specsById.set(item.id, spec)
      }
      // image and video types → handled by collectAllItems, not Puppeteer
    }

    // An opaque overlay that is the INCOMING side of a crossfade needs an alpha
    // capture — see `captureOptionsFor` (renderer.js) for why. Derived here from
    // the same `transitionPairs` the editor and the resolver use, so render can
    // never disagree with them about which item is the incoming one.
    //
    // Fed the RAW (un-quantized) item start/end, filtered to this track's
    // `overlay`-type items only — exactly what the editor's own
    // `computeVisualCrossfade` passes (timeline-model.ts), so render's pairing
    // decision can never diverge from the one that derived the fade in the
    // first place.
    const overlayItems = (track ?? []).filter(it => it.type === 'overlay')
    for (const pair of transitionPairs(overlayItems)) {
      const toSpec = specsById.get(pair.to.id)
      if (toSpec && toSpec.opaque) toSpec.transitionTo = true
    }
  }

  // Captions: top-level projectJson.captions object (unchanged from v0.1)
  const captions = projectJson.captions
  if (captions?.segments?.length > 0 || captions?.style) {
    const frameCount = Math.round(totalSecs * fps)
    // googleFonts is a spec-level field (consumed by bundleComponent), not a
    // prop on the caption component — pull it out before spreading the rest
    // into captionTheme.
    let { style: _captStyle, segments: _captSegs, googleFonts: captionFonts, ...captionTheme } = captions
    // Normalise the legacy lowercase `fontsize` key (used by the old ffmpeg
    // path / editor) to the camelCase `fontSize` prop the JSX templates
    // expect. Never send both.
    if (captionTheme.fontsize != null) {
      captionTheme.fontSize = captionTheme.fontsize
      delete captionTheme.fontsize
    }
    // The 'clean' style is built around Figtree — default its google font
    // when the caller hasn't specified one AND hasn't chosen their own font
    // family. Otherwise a project asking for e.g. Baloo 2 would also fetch
    // Figtree, and if the chosen family string is malformed the CSS cascade
    // would silently fall back to Figtree rather than to system-ui, which is
    // a confusing failure mode.
    if (captions.style === 'clean' && (captionFonts == null || captionFonts.length === 0) && captionTheme.fontFamily == null) {
      captionFonts = ['Figtree:wght@700']
    }
    specs.push({
      id:            'captions',
      componentPath: captionTemplatePath(captions.style),
      props:         { segments: captions.segments || [], ...captionTheme },
      googleFonts:   captionFonts ?? [],
      frameCount,
      fps,
      startSeconds:  0,
      endSeconds:    totalSecs,
      outputPath:    join(segDir, 'captions.mkv'),
      width,
      height,
      isCaption:     true,
    })
  }

  // NOTE: The old schema had a tracks[type=caption] fallback block here. It has been
  // removed — `tracks` may be on disk in either the legacy array-of-arrays shape
  // or the object shape; `trackItems()` absorbs the difference.

  return specs
}

// ---------------------------------------------------------------------------
// Direct items: image and video items from all tracks (no Puppeteer)
// ---------------------------------------------------------------------------

// DROPPED_PREVIEW_FIELDS is declared near the top of the file, beside
// EXPORT_MODES, not here — see the comment there for what it drops, why, and
// why its position (ahead of the `if (isMain)` CLI block) is load-bearing.

// Shallow-copies obj and deletes `fields` from the copy. Used to build the
// passthrough item literal below without mutating the source item.
function omitFields(obj, fields) {
  const copy = { ...obj }
  for (const field of fields) delete copy[field]
  return copy
}

function collectAllItems(projectJson) {
  const imageItems = []
  const videoItems = []

  const tracks = enabledTracks(projectJson)
  for (let trackIdx = 0; trackIdx < tracks.length; trackIdx++) {
    const track = tracks[trackIdx]
    // The object this collector emitted for each SOURCE item on this track, so
    // the crossfade pass below can stamp the emitted copies. Keyed by the source
    // item because that is what `transitionPairs` hands back on `pair.from` /
    // `pair.to` — the same indirection collectPuppeteerSegments uses for the
    // opaque-overlay `transitionTo` flag.
    const emitted = new Map()
    for (const item of track.items ?? []) {
      const passthrough = omitFields(item, DROPPED_PREVIEW_FIELDS)
      const geometryDefaults = {
        offsetX: item.offsetX ?? 0,
        offsetY: item.offsetY ?? 0,
        scale:   item.scale   ?? 1,
        // `scaleX`/`scaleY` are NOT defaulted here: `passthrough` carries them
        // only when the item has them, and every reader in encode-segment.js
        // resolves `scaleX ?? scale ?? 1` itself (geometryFor/geometryAt). A
        // default stamped here made every item look as if it had authored
        // per-axis values, and whether one is authored is exactly what decides
        // if a keyframed uniform `scale` moves the box (geometryAt, and
        // animatedGeometry's mirror of it). Stamped, a legacy clip's `scale`
        // animation had to be read ahead of the per-axis values, which then
        // stretched a per-axis band (scaleX 1, scaleY 0.316) to a canvas-aspect box.
        opacity: item.opacity ?? 1,
      }
      if (item.type === 'image') {
        const emit = { ...passthrough, ...geometryDefaults, fit: item.fit ?? 'cover', trackIdx }
        imageItems.push(emit)
        emitted.set(item, emit)
      } else if (item.type === 'video') {
        // Prefer the normalizedSrc cache when present (and not on the nobg
        // path). A normalizedSrc cache covers [normalizedInPoint, normalizedInPoint + duration]
        // of the original and plays from time 0. When we substitute it we must
        // rebase inPoint and outPoint by the cache origin so encode-segment seeks
        // to the right position inside the short cache file (actualIn = inPoint +
        // seekOffset). The cache origin is `normalizedInPoint ?? inPoint ?? 0`
        // (legacy clips without normalizedInPoint assumed origin == inPoint → rebase
        // to 0, which is reproduced by the fallback). The nobg_src path is NOT
        // a normalized cache and must keep the original inPoint/outPoint unchanged.
        //
        // ── SP2 T8: the arithmetic above moved ───────────────────────────────
        //
        // That whole computation now lives once, in `@bycrux/timeline-core`'s
        // `sourceWindow(item, 'render')` (src/source-window.js), shared with the
        // editor preview so the two engines can no longer drift apart — this used
        // to be duplicated by hand in useVideoPlayback.ts and the copies had
        // already diverged. The comment above stays because it records a real
        // production bug (Bug A: a start-trim after the cache was built), and the
        // resolver reproduces the reasoning verbatim next to the branch that
        // implements it. Two copies of a bug's history is cheap; zero is how the
        // bug comes back.
        //
        // The `'render'` variant is load-bearing. Preview and render legitimately
        // disagree on src precedence — render never loads `nobg_preview_src` and
        // only loads `nobg_src` when `remove_bg` is actually on — so the resolver
        // is variant-aware rather than unifying them, which would change render
        // output. See KNOWN-DIVERGENCES.md `nobg-precedence`.
        //
        // SANCTIONED BEHAVIOR CHANGE (the only one in this swap): the origin's
        // `?? 0` tail. The line this replaced read `item.normalizedInPoint ??
        // item.inPoint` with no tail, so an item carrying a normalizedSrc but
        // NEITHER origin field computed `undefined - undefined` = NaN and sent it
        // to ffmpeg's `-ss` (encode-segment.js:216's `?? 0` does not catch it —
        // NaN is not nullish). A missing origin means origin 0. The editor always
        // had the tail; render now matches. Pinned by render-helpers.test.mjs and
        // by timeline-core's fixtures/nan-case.json.
        //
        // NOT changed, deliberately: `src` may still be `undefined` here for an
        // item with neither `src` nor `normalizedSrc`. The render variant has no
        // `?? ''` tail (preview does), because `''` and `undefined` fail
        // DIFFERENTLY downstream and such an item is unrenderable either way.
        // Same for the `undefined === undefined` quirk that makes that item count
        // as "using the cache". Both are ported verbatim; making render total is a
        // behavior change with its own plan.
        //
        // Guarded permanently by test/encode-args-golden.test.mjs, which runs this
        // function + planSegments + encodeSegment(...,{_dryRun:true}) over the
        // shared corpus and deep-equals the result against goldens captured from
        // the pre-SP2 pipeline.
        const { src, inPoint, outPoint } = sourceWindow(item, 'render')
        // Track-wide volume/mute folded in here — the one fold point the
        // render path needs. `effectiveItemAudio` multiplies volume (never
        // replaces, so a clip an editor already turned down stays
        // proportionally quieter under a track pulled down too) and ORs mute
        // (either one silences it). Formula and rationale:
        // project-tracks.js's effectiveItemAudio; feature background:
        // docs/plans/2026-08-21-track-skip.md ("F1 · Track-wide volume and
        // mute").
        const { volume, muted } = effectiveItemAudio(track, item)
        const emit = {
          ...passthrough,
          ...geometryDefaults,
          trackIdx,
          // This object used to be built field-by-field from a hand-written
          // whitelist — and a field left off it was dropped silently, with no
          // type error, before it ever reached encode-segment.js. That
          // shipped as a real production bug twice: once for `sourceCrop` &
          // friends, once for image `fit`. It's built as a spread now —
          // `{...item, <overrides>}` minus DROPPED_PREVIEW_FIELDS — so a
          // field nobody's written an explicit line for here still reaches
          // encode-segment.js instead of silently vanishing. Only the fields
          // below are the explicit part: src/inPoint/outPoint (transformed by
          // sourceWindow), volume/muted (folded by effectiveItemAudio),
          // trackIdx (synthesized above), and the geometry/remove_bg
          // defaults. Unknown fields flow; transforms and drops are the
          // explicit part. Do not add sourceCrop/sourceWidth/sourceHeight/
          // nobg_src/normalizedSrc to DROPPED_PREVIEW_FIELDS — those are
          // render inputs (crop geometry and cache substitutes), not preview
          // artifacts; only proxySrc and nobg_preview_src belong on that
          // list. One newly-passed-through field the encoder actually reads
          // today: `type` -- encode-segment.js's isImageItem() checks
          // `item.type === 'image'` before falling back to a filename-
          // extension regex, so an image whose `src` lacks a recognised
          // extension (`.avif`, `.heic`, an extensionless cache path, a URL
          // with a query string) now correctly routes to the image filter
          // path, where it previously fell through to the video one.
          src,
          // `inPoint` is already in the CHOSEN src's coordinates. Paired with
          // `start` (passed through from `item`) it is exactly the input
          // encode-segment.js:216-218 needs: `actualIn = inPoint + max(0,
          // segStart - start)`, which is the resolver's `seekTime(item,
          // segStart, 'render')` written out by hand.
          inPoint,
          // null normalizes to undefined here (source-window.js:221); no render
          // consumer reads this field today.
          outPoint,
          remove_bg: item.remove_bg ?? false,
          muted,
          volume,
          // Per-clip playback speed (montaj/speed feature). Not defaulted here —
          // encode-segment.js treats a missing/undefined speed as 1 (no-op), so
          // forwarding the raw value (possibly undefined) is correct. The
          // spread already carries `item.speed` through; this override keeps
          // the "not defaulted" contract visible in the diff rather than
          // relying on spread behavior alone.
          speed: item.speed,
        }
        videoItems.push(emit)
        emitted.set(item, emit)
      }
    }

    // ── Clip crossfades, derived per track ────────────────────────────────
    //
    // Derived from the SAME `transitionPairs` the editor's
    // `computeVisualCrossfade` and the resolver's `crossfadesAt` use, so render
    // can never disagree with either about which items are paired. Fed the RAW
    // source items, exactly as the overlay `transitionTo` pass above does.
    //
    // PER TRACK, and CLIPS ONLY (`image`/`video`). Two items on different tracks
    // are stacked, not sequenced, so blending them would be meaningless; and an
    // overlay's crossfade is already real `opacity` keyframe data baked into the
    // Puppeteer capture, so stamping one here would apply the fade twice. Both
    // rules are activation.js's `crossfadesAt`, reproduced.
    //
    // ── TWO FIELDS NAMED `crossfade`, AND THEY ARE NOT THE SAME SHAPE ──────
    //
    //   render (here):       { role, start, end }  — the pair's TIMELINE SPAN
    //   resolver:            { role, p }           — progress AT ONE INSTANT
    //                                                (activation.js's ItemCrossfade)
    //
    // They differ because the two paths are asked different questions. The
    // resolver answers for a single instant — preview's playhead, sample_frame's
    // requested time — so a scalar `p` is the whole answer and recomputing it
    // costs one call. Render fans ONE item object across MANY segments:
    // `planSegments`'s `activeIn` hands every segment the same objects (it
    // "preserves input order and object identity"), so there is no such thing as
    // "the" progress for this item and a scalar would be wrong in every segment
    // but one. The span is the segment-invariant fact, and encode-segment.js's
    // `crossfadeIn` derives `p0`/`p1` from the segment it is actually handed.
    //
    // Do NOT "unify" these by copying one shape onto the other path. Give the
    // render item a scalar `p` and every segment past the first renders the
    // wrong frame; give the resolver a span and every consumer has to redo the
    // clamp it already does. Same name, same concept, different question.
    //
    // Written on EVERY clip, `null` when it is not transitioning, so this field
    // is authoritative rather than something a hand-authored project item could
    // leak through the passthrough spread.
    const clips = (track.items ?? []).filter(it => it.type === 'image' || it.type === 'video')
    for (const it of clips) {
      const emit = emitted.get(it)
      if (emit) emit.crossfade = null
    }
    for (const pair of transitionPairs(clips)) {
      const from = emitted.get(pair.from)
      const to   = emitted.get(pair.to)
      if (from) from.crossfade = { role: 'from', start: pair.start, end: pair.end }
      if (to)   to.crossfade   = { role: 'to',   start: pair.start, end: pair.end }
    }
  }

  return { imageItems, videoItems }
}

// Whether the normalize pre-pass can skip this item. Under lazy normalization a
// pre-built normalizedSrc cache already conforms to the project color space, so
// re-running normalize would be wasted work (and collectAllItems has already
// substituted it as item.src). When lazy but no cache exists, we must NOT skip
// — fall through to normalizeIfNeeded so the source still gets conformed. Eager
// mode (settings.normalize absent) never skips: behaviour is identical to before.
function shouldSkipNormalize(settings, item) {
  return settings.normalize === 'lazy' && !!item.normalizedSrc
}

// ---------------------------------------------------------------------------
// remove_bg pre-processing
// ---------------------------------------------------------------------------

async function processVideoItems(videoItems, workspaceDir) {
  for (const item of videoItems) {
    if (item.remove_bg) {
      if (item.nobg_src && existsSync(item.nobg_src)) {
        // Already processed — reuse the existing alpha clip
        item.src = item.nobg_src
        continue
      }
      log(`running remove_bg on ${basename(item.src)}...`)
      const stem    = join(workspaceDir, 'render', basename(item.src, extname(item.src)))
      const nobgPath = `${stem}_nobg.mov`
      const result = spawnSync(PYTHON, [
        REMOVE_BG_SCRIPT,
        '--input', item.src,
        '--out',   nobgPath,
      ], { encoding: 'utf8', timeout: 600_000 })
      if (result.status !== 0) {
        fail('remove_bg_failed', `remove_bg failed for ${item.src}: ${result.stderr}`)
      }
      item.src = nobgPath
    }
  }
}

// ---------------------------------------------------------------------------
// Caption / overlay template path resolution
// ---------------------------------------------------------------------------

function captionTemplatePath(style) {
  const styleMap = {
    'word-by-word':  'word-by-word.jsx',
    'pop':           'pop.jsx',
    'karaoke':       'karaoke.jsx',
    'subtitle':      'subtitle.jsx',
    'highlight-box': 'highlight-box.jsx',
    'outline':       'outline.jsx',
    'clean':         'clean.jsx',
  }
  const file = styleMap[style] ?? 'subtitle.jsx'
  return join(__dirname, 'templates', 'captions', file)
}

function overlayTemplatePath(item) {
  if (item.type === 'overlay') return resolve(item.src)
  fail('unknown_overlay_type', `Overlay type '${item.type}' is not supported. Set "type": "overlay" and provide a "src" path to a JSX file.`)
}

// ---------------------------------------------------------------------------
// Path resolution + validation
// ---------------------------------------------------------------------------

function resolveProjectPaths(projectJson, projectDir) {
  // EVERY track, including skipped ones: this mutates `item.src` in place, and
  // resolving a path for an item we then don't render costs nothing, whereas
  // leaving a skipped track's paths unresolved would surprise anything that
  // reads them later.
  for (const track of trackItems(projectJson)) {
    for (const item of track ?? []) {
      if (item.src && !item.src.startsWith('/')) {
        item.src = resolve(projectDir, item.src)
      }
      // Normalise macOS narrow no-break space (\u202f) in filenames
      if (item.src) {
        const actual = resolveFilePath(item.src)
        if (actual) item.src = actual
      }
      // nobg_src and nobg_preview_src are always absolute (written by remove_bg step)
    }
  }

  for (const track of projectJson.audio?.tracks ?? []) {
    if (track.src && !track.src.startsWith('/')) {
      track.src = resolve(projectDir, track.src)
    }
    const actual = resolveFilePath(track.src)
    if (actual) track.src = actual
  }
}

/** Resolve a path that may contain a macOS narrow no-break space (\u202f) instead
 *  of a regular space — e.g. screenshot filenames like "Screenshot … 12.44.47 PM.png".
 *  Returns the actual path on disk, or null if not found. */
function resolveFilePath(p) {
  if (existsSync(p)) return p
  // Normalise both sides: replace \u202f with regular space and compare
  const dn = dirname(p)
  const bn = basename(p)
  const target = bn.replace(/\u202f/g, ' ')
  try {
    for (const name of readdirSync(dn)) {
      if (name.replace(/\u202f/g, ' ') === target) return join(dn, name)
    }
  } catch { /* parent dir missing */ }
  return null
}

function validateProjectFiles(projectJson) {
  const missing = []

  // Only the tracks that will actually be rendered: a missing source file on a
  // SKIPPED track must not fail the render — leaving it out is the whole point.
  for (const track of enabledTrackItems(projectJson)) {
    for (const item of track ?? []) {
      if (item.src && !resolveFilePath(item.src)) missing.push(item.src)
    }
  }

  for (const track of projectJson.audio?.tracks ?? []) {
    if (track.src && !resolveFilePath(track.src)) missing.push(track.src)
  }

  if (missing.length > 0) {
    fail('missing_files', `Referenced files not found:\n  ${missing.join('\n  ')}`)
  }
}

// ---------------------------------------------------------------------------
// Duration calculation
// ---------------------------------------------------------------------------

function getTotalDurationSeconds(projectJson) {
  // Enabled tracks only: skipping the track that held the last clip shortens the
  // output rather than padding it with blank tail. See docs/plans/2026-08-21-track-skip.md.
  const allItems = enabledTrackItems(projectJson).flat()
  if (allItems.length === 0) return 0
  return Math.max(...allItems.map(i => i.end ?? 0))
}

// ---------------------------------------------------------------------------
// Normalize pre-pass
// ---------------------------------------------------------------------------

/**
 * Build the deterministic normalized-master output path for `src`, mirroring
 * lib.normalize.normalized_output_path() (the one place the Python side
 * builds this name). Namespaced per color space so SDR-then-HDR re-normalize
 * doesn't collide. When `tonemapped` is true (this item's own probed
 * transfer is HDR and the project is SDR — the HDR→SDR Montaj Vivid LUT
 * chain runs) the current master look is appended (SP6b Task T3).
 */
function buildNormalizedOutputPath(src, projectColorSpace, tonemapped, sdrStretch = false) {
  // `_w203`: SDR white moved from 100 to 203 nits (PV42), so an SDR-into-HDR
  // master is named apart from any old one. Twin: lib.normalize.
  let lookSuffix = tonemapped ? `_${MASTER_LOOK}` : ''
  if (sdrStretch) lookSuffix += '_w203'
  return src.replace(/(\.\w+)$/, `_normalized_${projectColorSpace}${lookSuffix}.mp4`)
}

// ---------------------------------------------------------------------------
// SDR masters of untagged sources
// ---------------------------------------------------------------------------
//
// An untagged source (most web downloads) is BT.709 underneath. montaj up to
// 5.5.4 normalized one reading it as BT.601 and converting to bt709, and the
// segment encoder's then-untagged canvas converted it most of the way back, so
// the error mostly cancelled. The canvas is tagged now, which exposes any
// master still carrying that conversion (measured cloth patch: source
// 158/50/102, old master 149/35/98). lib/normalize.py now reads an untagged
// source as BT.709 and marks the master; a master of an untagged source
// without the mark is rebuilt, once, in place.

/** Whether `master` carries UNTAGGED_MASTER_MARKER. One ffprobe; false on any failure. */
function hasUntaggedMasterMarker(master) {
  const r = spawnSync(FFPROBE, [
    '-v', 'quiet', '-show_entries', 'format_tags=comment', '-of', 'default=nw=1:nk=1', master,
  ], { encoding: 'utf8', timeout: 30_000 })
  return r.status === 0 && r.stdout.trim() === UNTAGGED_MASTER_MARKER
}

/**
 * The source an untagged-look SDR master (`<stem>_normalized_sdr_bt709.mp4`)
 * was built from: the one video `<stem>.<ext>` beside it. null when the path is
 * not such a master or the source is missing or ambiguous (two candidates).
 */
function originalOfSdrMaster(path) {
  const name = basename(path)
  if (!name.endsWith(SDR_MASTER_SUFFIX)) return null
  const stem = name.slice(0, -SDR_MASTER_SUFFIX.length)
  let names
  try { names = readdirSync(dirname(path)) } catch { return null }
  const found = names.filter((n) => n.startsWith(`${stem}.`) && VIDEO_EXT.test(n.slice(stem.length)))
  return found.length === 1 ? join(dirname(path), found[0]) : null
}

/**
 * Send every video item that would render an unmarked SDR master of an
 * untagged source back to that source, in the in-memory project only
 * (project.json is not rewritten). The normalize pass then rebuilds the master
 * at its usual path, which heals every pointer serve holds to it. Two shapes:
 *
 *   - `normalizedSrc` (a lazy cache) built from the item's untagged `src`:
 *     dropped, so the item renders from `src` and is normalized in full.
 *   - `src` itself is the master: serve's background normalize swaps `src`
 *     onto `<stem>_normalized_sdr_bt709.mp4`. Pointed back at `<stem>.<ext>`.
 *
 * SDR projects only (or no colorSpace yet): an HDR master is never touched.
 * The probes are paid only by items that have a cache to judge, and the
 * marker only by untagged sources; an iPhone (HLG) or tagged source costs one
 * transfer probe and is left alone.
 */
function repointStaleUntaggedMasters(projectJson) {
  const colorSpace = projectJson.settings?.colorSpace
  if (colorSpace != null && colorSpace !== 'sdr_bt709') return
  const untagged = new Map()
  const isUntagged = (p) => {
    if (!untagged.has(p)) untagged.set(p, (probeColorTransfer(p) ?? 'unknown') === 'unknown')
    return untagged.get(p)
  }
  for (const items of enabledTrackItems(projectJson)) {
    for (const item of items ?? []) {
      if (item?.type !== 'video' || typeof item.src !== 'string') continue
      if (item.remove_bg && item.nobg_src) continue  // renders nobg_src; no master involved
      if (item.normalizedSrc && existsSync(item.src) && isUntagged(item.src)
          && !hasUntaggedMasterMarker(item.normalizedSrc)) {
        log(`not using ${basename(item.normalizedSrc)}: it was built before untagged sources were read as BT.709`)
        delete item.normalizedSrc
        delete item.normalizedInPoint
        continue
      }
      const original = originalOfSdrMaster(item.src)
      if (original && !hasUntaggedMasterMarker(item.src) && isUntagged(original)) {
        log(`${basename(item.src)} was built before untagged sources were read as BT.709; rebuilding it from ${basename(original)}`)
        item.src = original
      }
    }
  }
}

async function normalizeIfNeeded(src, projectColorSpace, tonemapped, { untaggedSource = false, sdrStretch = false } = {}) {
  const out = buildNormalizedOutputPath(src, projectColorSpace, tonemapped, sdrStretch)

  // Idempotency cache: if the deterministic output already exists and is
  // fresher than the source, the previous render already paid the cost — skip
  // the python spawn entirely. Critical for legacy projects whose tracks[0]
  // srcs point at never-normalized originals: without this, every render
  // re-encodes every clip from scratch (minutes per clip on a 4K HEVC source).
  // mtime check (not just existsSync) means re-recording or replacing a source
  // file correctly invalidates the cached output.
  //
  // One more condition, for an UNTAGGED source's SDR master only: it must carry
  // UNTAGGED_MASTER_MARKER. Without it the master was built reading the source
  // as BT.601 and has that conversion baked in, so it is rebuilt here, in
  // place. Every other master (tagged or HDR sources, the iPhone `_vivid1`
  // ones) is reused on mtime alone and costs no probe.
  if (existsSync(out)) {
    try {
      const srcStat = statSync(src)
      const outStat = statSync(out)
      if (outStat.mtimeMs >= srcStat.mtimeMs) {
        if (!(untaggedSource && projectColorSpace === 'sdr_bt709' && !tonemapped)
            || hasUntaggedMasterMarker(out)) {
          return out
        }
        log(`rebuilding ${basename(out)}: it was built before untagged sources were read as BT.709`)
      }
    } catch { /* fall through to re-encode */ }
  }

  return new Promise((resolve) => {
    const proc = spawn(PYTHON, [
      '-m', 'lib.normalize',
      '--input', src,
      '--color-space', projectColorSpace,
      '--out', out,
    ], { cwd: MONTAJ_ROOT })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })

    // Match the original 600s timeout — kill the process if it overruns
    const timer = setTimeout(() => proc.kill('SIGKILL'), 600_000)

    proc.on('close', (code, signal) => {
      clearTimeout(timer)
      // `code` is null when the process was killed by signal (e.g. our SIGKILL on
      // the 600s timeout). The `code !== 0` check correctly treats null as failure
      // and falls back to src — do NOT "fix" this to `code != null && code !== 0`,
      // which would treat a timeout-killed proc as success and resolve with stdout
      // (likely empty or partial → bogus path).
      if (code !== 0) {
        // Preserve original behaviour: on failure, fall back to the source path.
        // Surface stderr to render's log so the user sees what went wrong.
        log(`normalize of ${basename(src)} failed (${signal ? `killed by ${signal}` : `exit ${code}`}); rendering the unconformed source`)
        if (stderr.trim()) log(`normalize stderr: ${stderr.trim().slice(-500)}`)
        resolve(src)
        return
      }
      const outputPath = stdout.trim()
      resolve(outputPath || src)
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      log(`normalize spawn error: ${err.message}`)
      resolve(src)
    })
  })
}

// ---------------------------------------------------------------------------
// Strip extra audio streams (defensive — see comment at call site for the
// non-deterministic apac contamination this fixes)
// ---------------------------------------------------------------------------

async function stripExtraAudioStreams(src) {
  // Probe: how many audio streams does this file have?
  const probe = spawnSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index',
    '-of', 'csv=p=0', src,
  ], { encoding: 'utf8', timeout: 30_000 })

  if (probe.status !== 0) {
    // Probe failure — leave the file alone; encode-segment will surface any real issue.
    return src
  }
  const audioStreamCount = probe.stdout.trim().split('\n').filter(Boolean).length
  if (audioStreamCount <= 1) {
    // Already has at most one audio stream; nothing to strip.
    return src
  }

  // Idempotency: deterministic output path, skip if already fresh.
  const out = src.replace(/(\.\w+)$/, '_audioclean.mp4')
  if (existsSync(out)) {
    try {
      const srcStat = statSync(src)
      const outStat = statSync(out)
      if (outStat.mtimeMs >= srcStat.mtimeMs) return out
    } catch { /* fall through to re-extract */ }
  }

  return new Promise((resolve) => {
    // -map 0:v -map 0:a:0 — copy all video streams plus the FIRST audio stream
    // only. -c copy keeps everything stream-copy (fast, no re-encode). The
    // output container is MP4, which doesn't support Apple's mebx data streams
    // (those would only be needed in a MOV roundtrip anyway).
    const proc = spawn(FFMPEG, [
      '-y', '-v', 'error',
      '-i', src,
      '-map', '0:v', '-map', '0:a:0',
      '-c', 'copy',
      out,
    ])
    let stderr = ''
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    proc.on('close', (code) => {
      if (code !== 0) {
        if (stderr.trim()) log(`audio-strip stderr: ${stderr.trim().slice(-500)}`)
        // Fall back to the original file — encode-segment will still use [a:0]
        // and may still trip the bug, but no worse than before this fix.
        resolve(src)
        return
      }
      resolve(out)
    })
    proc.on('error', (err) => {
      log(`audio-strip spawn error: ${err.message}`)
      resolve(src)
    })
  })
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

// Derive a filesystem-safe basename (no extension) from a project name.
// Strips path separators, reserved chars, and control chars, collapses
// whitespace, and trims leading/trailing dots+spaces. Falls back to 'final'
// when the name is missing or sanitizes to nothing.
function safeFilename(name) {
  if (!name) return 'final'
  const cleaned = String(name)
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  return cleaned || 'final'
}

function log(msg) {
  process.stderr.write(`${C.cyan}[montaj render]${C.reset} ${msg}\n`)
}

function fail(code, message) {
  process.stderr.write(JSON.stringify({ error: code, message }) + '\n')
  process.exit(1)
}

export { stampSourceProbes, getTotalDurationSeconds, collectPuppeteerSegments, collectAllItems, resolveFilePath, shouldSkipNormalize, buildNormalizedOutputPath,
         EXPORT_MODES, resolveExportMode, resolveSdrCurve, planExport, captureScaleFor,
         UNTAGGED_MASTER_MARKER, originalOfSdrMaster }
