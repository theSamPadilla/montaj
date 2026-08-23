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
import { renderAllSegments }              from './renderer.js'
import { compose, embedThumbnail }        from './compose.js'
import { FFMPEG, FFPROBE }                from './ffmpeg-bin.js'
import { requireValidKey, detectFromTransfer, smartDetect, isHdr, DEFAULT_COLOR_SPACE } from './color-space.js'
import { pMap }                           from './p-map.js'
import { fileHasAudio }                   from './encode-segment.js'
import { deriveSdr, probeColorTransfer }  from './derive-sdr.js'
import { sourceWindow }                   from '@bycrux/timeline-core'
import { MASTER_LOOK, curveIds }          from './look.js'
import { effectiveItemAudio, enabledTrackItems, enabledTracks, trackItems } from './project-tracks.js'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const isMain = resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)
// MONTAJ_ROOT is two levels above montaj_assets/render/ (i.e. the Python project root).
const MONTAJ_ROOT = process.env.MONTAJ_ROOT || join(__dirname, '..', '..')
const PYTHON = process.env.MONTAJ_PYTHON || 'python3'
export const REMOVE_BG_SCRIPT = join(MONTAJ_ROOT, 'steps', 'transform', 'remove_bg.py')

const TTY = process.stderr.isTTY
const C = { cyan: TTY ? '\x1b[96m' : '', reset: TTY ? '\x1b[0m' : '' }

// ---------------------------------------------------------------------------
// Export modes (SP6b Task T7)
//
// auto — render the project at its own working color space. Exactly the
//        pre-SP6b behavior, and the default: one file, no derive pass.
// sdr  — emit only a Rec.709 SDR file. An HDR project still renders its HDR
//        master first (that's the only way to get the edit), but the master is
//        scratch: it lands on a temp name and is deleted once derived.
// both — emit the HDR master AND an SDR sibling derived from it.
//
// Declared above the CLI block rather than beside its resolvers below because
// the flag is validated during module evaluation — a `const` further down the
// file is still in its temporal dead zone at that point.
// ---------------------------------------------------------------------------
const EXPORT_MODES = ['auto', 'sdr', 'both']

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

// Image tone modes for HDR overlay-image conversion. Keep in sync with
// lib/normalize_image.py::TONE_MODES and the editor's imageTone.ts.
const IMAGE_TONE_MODES = ['vivid', 'broadcast', 'punchy', 'raw']
const DEFAULT_IMAGE_TONE = 'vivid'

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
 * Decide what this render emits and where the compose pass writes.
 *
 * @param {object} args
 * @param {string} args.exportMode          'auto' | 'sdr' | 'both'
 * @param {string} args.projectColorSpace   the project's working color space
 * @param {string} args.outputPath          the file the user asked for
 * @returns {{
 *   mode: string,            effective mode — 'auto' once an SDR project downgrades
 *   composePath: string,     where compose writes the render
 *   derivePath: string|null, the SDR rendition to derive, or null for no derive
 *   tempMaster: string|null, composePath when it is scratch to delete afterwards
 *   outputs: string[],       files this render emits, primary first
 *   notice: string|null,     one-line explanation of a downgraded request
 * }}
 */
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

function planExport({ exportMode, projectColorSpace, outputPath }) {
  // An SDR project's render already IS the SDR rendition — there is no HDR
  // master to derive from and nothing to convert. Say so once, then behave
  // exactly like auto rather than emitting a pointless second identical file.
  if (exportMode === 'auto' || !isHdr(projectColorSpace)) {
    const notice = exportMode === 'auto' ? null
      : `--export ${exportMode}: this project is already SDR (${projectColorSpace}) — `
        + `its render is the SDR rendition; emitting one file`
    return {
      mode: 'auto',
      composePath: outputPath,
      derivePath: null,
      tempMaster: null,
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
      tempMaster: null,
      outputs: [outputPath, derivePath],
      notice: null,
    }
  }

  // 'sdr' on an HDR project: the user's name belongs to the SDR file, so the
  // HDR master renders to a temp sibling (same directory — compose writes its
  // scratch beside its output) and is removed once the derive succeeds.
  const tempMaster = siblingPath(outputPath, '-hdrmaster.tmp')
  return {
    mode: 'sdr',
    composePath: tempMaster,
    derivePath: outputPath,
    tempMaster,
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

  const settings = projectJson.settings || {}
  const fps    = settings.fps || 30

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
  // compositing onto the final video (2× up at 4K, fractional down for a
  // sub-1080 source), so the same JSX fits every output size.
  const SHORT_EDGE_TARGET = 1080
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

  // Pre-probe color_transfer once per unique source so the segment encoder can
  // build per-item conversion filters without re-probing per segment. A typical
  // project breaks one clip into many segments — without this cache, a 50-segment
  // project with 5 items would do 250 ffprobes.
  const transferCache = new Map()
  for (const item of videoItems) {
    if (!transferCache.has(item.src)) {
      transferCache.set(item.src, probeColorTransfer(item.src))
    }
    item.colorTransfer = transferCache.get(item.src) ?? 'unknown'
  }

  // Pre-probe audio presence once per unique source, same rationale as
  // transferCache above — without it, a 50-segment project with 5 items
  // would run fileHasAudio's ffprobe up to 250 times instead of 5.
  const audioCache = new Map()
  for (const item of videoItems) {
    if (!audioCache.has(item.src)) {
      audioCache.set(item.src, fileHasAudio(item.src))
    }
    item.hasAudio = audioCache.get(item.src)
  }

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

  // 3. Normalize non-conformant video items to project format (parallel, cap=2)
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
    // tonemapped: this item's own probed transfer is HDR and the project is
    // SDR — the one case normalizeIfNeeded's ffmpeg chain (via lib.normalize)
    // actually runs the HDR→SDR Montaj Vivid LUT. Mirrors the Python sites'
    // `is_hdr(detect_from_transfer(...)) and color_space == "sdr_bt709"` check.
    const tonemapped = isHdr(detectFromTransfer(item.colorTransfer)) && projectColorSpace === 'sdr_bt709'
    const normalizedPath = await normalizeIfNeeded(item.src, projectColorSpace, tonemapped)
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

  // 5. Bundle + render all overlay and caption segments
  // PHASE MARKERS: serve's `_render_phase_for` (serve/routes/projects.py) maps
  // "with Puppeteer" + "bundling segment" → rendering, and a `(captions)` segment
  // id → captions. Keep these substrings in sync if you reword these log lines.
  log(`rendering ${segmentSpecs.length} segment(s) with Puppeteer...`)

  const workDirs = []

  for (let i = 0; i < segmentSpecs.length; i++) {
    const spec = segmentSpecs[i]
    log(`bundling segment ${i + 1}/${segmentSpecs.length} (${spec.id})...`)
    const { htmlPath, workDir } = await bundleComponent({
      componentPath:  spec.componentPath,
      props:          spec.props,
      fps,
      durationFrames: spec.frameCount,
      width:          renderWidth,
      height:         renderHeight,
      offsetX:        spec.offsetX     ?? 0,
      offsetY:        spec.offsetY     ?? 0,
      scale:          spec.scale       ?? 1,
      googleFonts:    spec.googleFonts ?? [],
    })
    spec.htmlPath = htmlPath
    workDirs.push(workDir)
  }

  const effectiveImageTone = resolveImageTone(imageTone, settings)
  const renderedSegments = await renderAllSegments(segmentSpecs, { workers, colorSpace: projectColorSpace, imageTone: effectiveImageTone })

  // Attach positioning offsets back onto rendered segments so compose.js can apply
  // x/y coordinates. Overlay size is derived from the output canvas at compose
  // time (see encode-segment.js), so no scale factor is stamped here.
  for (const rSeg of renderedSegments) {
    const spec = segmentSpecs.find(s => s.id === rSeg.id)
    if (spec) {
      rSeg.offsetX   = spec.offsetX   ?? 0
      rSeg.offsetY   = spec.offsetY   ?? 0
      rSeg.scale     = spec.scale     ?? 1
      rSeg.opaque    = spec.opaque    ?? false
      rSeg.isCaption = spec.isCaption ?? false
    }
  }

  // 6. Use settings.resolution when explicitly set; otherwise detect from first video item.
  let actualWidth  = settings.resolution?.[0] ?? renderWidth
  let actualHeight = settings.resolution?.[1] ?? renderHeight
  if (!settings.resolution) {
    const firstVideo = [...videoItems].sort((a, b) => a.trackIdx - b.trackIdx)[0]
    if (firstVideo) {
      const dims = probeVideoDimensions(firstVideo.src)
      if (dims) { [actualWidth, actualHeight] = dims }
    }
  }
  // Overlays are composited by scaling the 1080-design canvas to the actual
  // output dimensions (actualWidth×actualHeight) at compose time — see
  // buildOverlayFilterParts in encode-segment.js. No per-segment scale factor is
  // stamped here; the compositor derives the size from the output canvas
  // directly, so overlays fit any resolution (4K up, sub-1080 down, non-integer
  // multiples) instead of being cropped onto smaller canvases.

  // 7. Compose final MP4
  // PHASE MARKER: "composing final video" → encoding in serve's _render_phase_for.
  log('composing final video...')
  await compose({
    projectJson,
    puppeteerSegments: renderedSegments,
    imageItems,
    videoItems,
    outputPath: exportPlan.composePath,
    videoWidth:  actualWidth,
    videoHeight: actualHeight,
    colorSpace:  projectColorSpace,
    sdrCurve,
  })

  // 7b. Derive the SDR rendition from the finished HDR master — one ffmpeg pass
  //     through the Montaj Vivid LUT, audio stream-copied, not a second render.
  //     Only reached for an HDR project under --export sdr|both; auto skips it
  //     entirely and this whole block is a no-op.
  if (exportPlan.derivePath) {
    // PHASE MARKER: "deriving SDR rendition" → `sdr_derive` in serve's
    // _render_phase_for (serve/routes/projects.py); the editor's render stepper
    // keys off that phase name. Keep this substring in sync if you reword.
    log(`deriving SDR rendition → ${basename(exportPlan.derivePath)}...`)
    await deriveSdr(exportPlan.composePath, exportPlan.derivePath, { sdrCurve })
    // The derived file is Rec.709 already, so its poster needs no tone-map —
    // passing sdr_bt709 (not the project's HDR key) is what keeps the extract
    // from running the LUT a second time over already-graded pixels.
    embedThumbnail(exportPlan.derivePath, 'sdr_bt709')
    if (exportPlan.tempMaster) {
      // --export sdr: the HDR master was scaffolding. Removed only on success —
      // if the derive threw, the master is the one salvageable artifact of a
      // long render and is worth more on disk than a tidy directory.
      rmSync(exportPlan.tempMaster, { force: true })
    }
  }

  // 8. Cleanup temp bundles (always); intermediate segments only if --clean
  for (const dir of workDirs) cleanupBundle(dir)

  if (clean) {
    rmSync(segDir, { recursive: true, force: true })
    log('intermediate files cleaned')
  }

  // Step output convention: final path on stdout. --export both emits two files;
  // the master keeps line 1 so every single-path reader (montaj render, Hub,
  // serve's job.result) still sees the same thing it always has, and the derived
  // SDR sibling follows on line 2.
  process.stdout.write(exportPlan.outputs.join('\n') + '\n')
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

// probeColorTransfer lives in derive-sdr.js — the derive pass needs the same
// "what color space is this file, really" read, and one implementation beats
// two copies of the trailing-comma workaround its doc comment explains.

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

  // Overlay items live in tracks[1+]; tracks[0] is primary footage
  const overlayTracks = enabledTrackItems(projectJson).slice(1)
  for (let trackIdx = 0; trackIdx < overlayTracks.length; trackIdx++) {
    const track = overlayTracks[trackIdx]
    for (const item of track ?? []) {
      if (item.type === 'overlay') {
        const startSeconds = quantize(item.start)
        const endSeconds   = quantize(item.end)
        const frameCount   = Math.round((endSeconds - startSeconds) * fps)
        specs.push({
          id:            `overlay-${trackIdx}--${item.id}`,
          componentPath: overlayTemplatePath(item),
          props:         item.props ?? {},
          offsetX:       item.offsetX ?? 0,
          offsetY:       item.offsetY ?? 0,
          scale:         item.scale   ?? 1,
          opacity:       item.opacity ?? 1,
          opaque:        item.opaque  ?? false,
          googleFonts:   item.googleFonts ?? [],
          frameCount,
          fps,
          startSeconds,
          endSeconds,
          outputPath:    join(segDir, `overlay-${trackIdx}--${item.id}.mkv`),
          width,
          height,
        })
      }
      // image and video types → handled by collectAllItems, not Puppeteer
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
    // when the caller hasn't specified one, so the render isn't silently
    // falling back to a system font.
    if (captions.style === 'clean' && (captionFonts == null || captionFonts.length === 0)) {
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

function collectAllItems(projectJson) {
  const imageItems = []
  const videoItems = []

  const tracks = enabledTracks(projectJson)
  for (let trackIdx = 0; trackIdx < tracks.length; trackIdx++) {
    const track = tracks[trackIdx]
    for (const item of track.items ?? []) {
      const base = {
        id:      item.id,
        src:     item.src,
        start:   item.start,
        end:     item.end,
        offsetX: item.offsetX ?? 0,
        offsetY: item.offsetY ?? 0,
        scale:   item.scale   ?? 1,
        opacity: item.opacity ?? 1,
        trackIdx,
      }
      if (item.type === 'image') {
        imageItems.push({ ...base, fit: item.fit ?? 'cover' })
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
        videoItems.push({
          ...base,
          // The whitelist below is exhaustive by design — these objects are what
          // encode-segment.js reads (and mutates), so a field omitted here is
          // dropped silently, with no type error. That has shipped as a bug twice:
          // once for `sourceCrop` & friends (see below) and once for image `fit`.
          src,
          nobg_src:     item.nobg_src,
          normalizedSrc: item.normalizedSrc,
          // `inPoint` is already in the CHOSEN src's coordinates. Paired with
          // `start` (from `base`) it is exactly the input encode-segment.js:216-218
          // needs: `actualIn = inPoint + max(0, segStart - start)`, which is the
          // resolver's `seekTime(item, segStart, 'render')` written out by hand.
          inPoint,
          // null normalizes to undefined here (source-window.js:221); no render
          // consumer reads this field today.
          outPoint,
          // Source crop (clips workflow vertical reframe) — applied at encode
          // time by buildVideoItemFilterParts. normalizeIfNeeded/normalize_window
          // does NOT bake the crop into normalizedSrc (the cache stays at full
          // source dimensions), so these MUST be forwarded or the crop is lost
          // and the full frame is letterboxed into the output canvas instead.
          // The resolver has no opinion on them (they are geometry, not source
          // window), so they stay hand-forwarded here, by reference.
          sourceCrop:   item.sourceCrop,
          sourceWidth:  item.sourceWidth,
          sourceHeight: item.sourceHeight,
          remove_bg: item.remove_bg ?? false,
          muted,
          volume,
          // Per-clip playback speed (montaj/speed feature). Not defaulted here —
          // encode-segment.js treats a missing/undefined speed as 1 (no-op), so
          // forwarding the raw value (possibly undefined) is correct.
          speed: item.speed,
        })
      }
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
function buildNormalizedOutputPath(src, projectColorSpace, tonemapped) {
  const lookSuffix = tonemapped ? `_${MASTER_LOOK}` : ''
  return src.replace(/(\.\w+)$/, `_normalized_${projectColorSpace}${lookSuffix}.mp4`)
}

async function normalizeIfNeeded(src, projectColorSpace, tonemapped) {
  const out = buildNormalizedOutputPath(src, projectColorSpace, tonemapped)

  // Idempotency cache: if the deterministic output already exists and is
  // fresher than the source, the previous render already paid the cost — skip
  // the python spawn entirely. Critical for legacy projects whose tracks[0]
  // srcs point at never-normalized originals: without this, every render
  // re-encodes every clip from scratch (minutes per clip on a 4K HEVC source).
  // mtime check (not just existsSync) means re-recording or replacing a source
  // file correctly invalidates the cached output.
  if (existsSync(out)) {
    try {
      const srcStat = statSync(src)
      const outStat = statSync(out)
      if (outStat.mtimeMs >= srcStat.mtimeMs) {
        return out
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

    proc.on('close', (code) => {
      clearTimeout(timer)
      // `code` is null when the process was killed by signal (e.g. our SIGKILL on
      // the 600s timeout). The `code !== 0` check correctly treats null as failure
      // and falls back to src — do NOT "fix" this to `code != null && code !== 0`,
      // which would treat a timeout-killed proc as success and resolve with stdout
      // (likely empty or partial → bogus path).
      if (code !== 0) {
        // Preserve original behaviour: on failure, fall back to the source path.
        // Surface stderr to render's log so the user sees what went wrong.
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

export { getTotalDurationSeconds, collectPuppeteerSegments, collectAllItems, resolveFilePath, shouldSkipNormalize, buildNormalizedOutputPath,
         EXPORT_MODES, resolveExportMode, resolveSdrCurve, planExport }
