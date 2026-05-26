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
import { compose }                        from './compose.js'
import { requireValidKey, detectFromTransfer, smartDetect, DEFAULT_COLOR_SPACE } from './color-space.js'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const isMain = resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)
const MONTAJ_ROOT = process.env.MONTAJ_ROOT || join(__dirname, '..')
const PYTHON = process.env.MONTAJ_PYTHON || 'python3'

const TTY = process.stderr.isTTY
const C = { cyan: TTY ? '\x1b[96m' : '', reset: TTY ? '\x1b[0m' : '' }

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

if (isMain) {
  const argv = process.argv.slice(2)

  if (!argv.length || argv[0] === '--help') {
    process.stderr.write('Usage: render.js <project.json> [--out <path>] [--workers <n>] [--clean]\n')
    process.exit(1)
  }

  let projectArg = null
  let outArg     = null
  let workersArg = null
  let cleanArg   = false

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out')     { outArg     = argv[++i]; continue }
    if (argv[i] === '--workers') { workersArg = parseInt(argv[++i], 10); continue }
    if (argv[i] === '--clean')   { cleanArg   = true; continue }
    if (!projectArg) projectArg = argv[i]
  }

  if (!projectArg) fail('missing_argument', 'No project.json path provided')

  main(projectArg, { out: outArg, workers: workersArg, clean: cleanArg }).catch(err => {
    fail('render_error', err.message)
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(projectPath, { out, workers, clean }) {
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
  // then upscales the captured frame by pixelRatio = actualWidth / renderWidth
  // (= 2 at 4K) when overlaying onto the final video.
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

  const outputPath = out ? resolve(out) : join(renderDir, 'final.mp4')

  // Early exit: ffmpeg drawtext path — bypass Puppeteer, delegate to lyrics_render.py
  if (projectJson.renderMode === 'ffmpeg-drawtext') {
    const captions = projectJson.captions
    if (!captions?.segments?.length) {
      fail('missing_captions', 'renderMode ffmpeg-drawtext requires project.json captions.segments')
    }
    const firstAudioTrack = (projectJson.audio?.tracks ?? []).find(t => !t.muted)
    if (!firstAudioTrack?.src) fail('missing_audio', 'renderMode ffmpeg-drawtext requires at least one unmuted audio track')
    const audioSrc = firstAudioTrack.src

    // Write captions to temp file. Captions in project.json are already in project-timeline
    // coordinates (0-based), so audioInPoint=0 — no timestamp offset needed.
    // The audio seek is passed separately via --audio-inpoint.
    const captionsPath = join(renderDir, 'captions_ffmpeg.json')
    mkdirSync(renderDir, { recursive: true })
    const captionsWithOffset = { ...captions, audioInPoint: 0 }
    writeFileSync(captionsPath, JSON.stringify(captionsWithOffset))

    // Optional background video: first video item in tracks[0]
    const bgItem = (projectJson.tracks?.[0] ?? []).find(i => i.type === 'video')

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

    log('rendering via ffmpeg drawtext (skipping Puppeteer)...')
    const result = spawnSync(PYTHON, lyricsRenderArgs, { encoding: 'utf8', timeout: 600_000 })
    if (result.status !== 0) {
      fail('lyrics_render_failed', result.stderr?.trim() || 'lyrics_render.py failed')
    }

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
    const normalizedPath = await normalizeIfNeeded(item.src, projectColorSpace)
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

  const renderedSegments = await renderAllSegments(segmentSpecs, { workers })

  // Attach positioning offsets back onto rendered segments so compose.js can apply
  // x/y coordinates. pixelRatio is stamped after base video resolution is detected below.
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
  // pixelRatio: how many actual pixels correspond to one design pixel.
  const pixelRatio = Math.max(1, Math.round(actualWidth / renderWidth))

  // Re-stamp pixelRatio on rendered segments now that we know the true video dimensions.
  for (const rSeg of renderedSegments) {
    rSeg.pixelRatio = pixelRatio
  }

  // 7. Compose final MP4
  log('composing final video...')
  await compose({
    projectJson,
    puppeteerSegments: renderedSegments,
    imageItems,
    videoItems,
    outputPath,
    videoWidth:  actualWidth,
    videoHeight: actualHeight,
    colorSpace:  projectColorSpace,
  })

  // 8. Cleanup temp bundles (always); intermediate segments only if --clean
  for (const dir of workDirs) cleanupBundle(dir)

  if (clean) {
    rmSync(segDir, { recursive: true, force: true })
    log('intermediate files cleaned')
  }

  // Step output convention: final path on stdout
  process.stdout.write(outputPath + '\n')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return [width, height] of the first video stream in a file, or null on error. */
function probeVideoDimensions(filePath) {
  const result = spawnSync('ffprobe', [
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

/** Return the ffprobe color_transfer string (e.g. 'bt709', 'arib-std-b67',
 *  'smpte2084') for the first video stream, or null on error / missing tag.
 *
 *  Note: `-of csv=p=0` emits a trailing comma even on single-field stream
 *  queries (e.g. `arib-std-b67,\n`). Strip both whitespace and trailing
 *  commas before returning, otherwise downstream string equality against
 *  COLOR_SPACE_SPECS.transferValues silently misses every HDR clip and the
 *  whole project gets mis-classified as SDR. */
function probeColorTransfer(filePath) {
  const result = spawnSync('ffprobe', [
    '-v', 'quiet', '-select_streams', 'v:0',
    '-show_entries', 'stream=color_transfer',
    '-of', 'csv=p=0', filePath,
  ], { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) return null
  const value = (result.stdout || '').trim().replace(/,+$/, '')
  return value || null
}

// ---------------------------------------------------------------------------
// Segment collection: Puppeteer segments (overlay + captions)
// ---------------------------------------------------------------------------

function collectPuppeteerSegments(projectJson, fps, width, height, segDir) {
  const specs = []
  const totalSecs = getTotalDurationSeconds(projectJson)

  // Overlay items live in tracks[1+]; tracks[0] is primary footage
  const overlayTracks = (projectJson.tracks ?? []).slice(1)
  for (let trackIdx = 0; trackIdx < overlayTracks.length; trackIdx++) {
    const track = overlayTracks[trackIdx]
    for (const item of track ?? []) {
      if (item.type === 'overlay') {
        const frameCount = Math.ceil((item.end - item.start) * fps)
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
          startSeconds:  item.start,
          endSeconds:    item.end,
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
    const frameCount = Math.ceil(totalSecs * fps)
    // googleFonts is a spec-level field (consumed by bundleComponent), not a
    // prop on the caption component — pull it out before spreading the rest
    // into captionTheme.
    const { style: _captStyle, segments: _captSegs, googleFonts: captionFonts, ...captionTheme } = captions
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
  // removed — in v0.2, projectJson.tracks is always an array of arrays, never typed objects.

  return specs
}

// ---------------------------------------------------------------------------
// Direct items: image and video items from all tracks (no Puppeteer)
// ---------------------------------------------------------------------------

function collectAllItems(projectJson) {
  const imageItems = []
  const videoItems = []

  for (let trackIdx = 0; trackIdx < (projectJson.tracks ?? []).length; trackIdx++) {
    const track = projectJson.tracks[trackIdx]
    for (const item of track ?? []) {
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
        imageItems.push(base)
      } else if (item.type === 'video') {
        videoItems.push({
          ...base,
          src:       item.nobg_src && item.remove_bg ? item.nobg_src : item.src,
          nobg_src:  item.nobg_src,
          inPoint:   item.inPoint,
          outPoint:  item.outPoint,
          remove_bg: item.remove_bg ?? false,
          muted:     item.muted ?? false,
          volume:    item.volume,
        })
      }
    }
  }

  return { imageItems, videoItems }
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
        join(MONTAJ_ROOT, 'steps', 'remove_bg.py'),
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
    'word-by-word': 'word-by-word.jsx',
    'pop':          'pop.jsx',
    'karaoke':      'karaoke.jsx',
    'subtitle':     'subtitle.jsx',
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
  // v0.2: tracks is an array of arrays; every item in every track may have a src
  for (const track of projectJson.tracks ?? []) {
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

  // v0.2: tracks is an array of arrays; check src existence on every item in every track
  for (const track of projectJson.tracks ?? []) {
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
  const allItems = (projectJson.tracks ?? []).flat()
  if (allItems.length === 0) return 0
  return Math.max(...allItems.map(i => i.end ?? 0))
}

// ---------------------------------------------------------------------------
// Normalize pre-pass
// ---------------------------------------------------------------------------

async function normalizeIfNeeded(src, projectColorSpace) {
  // Output filename is namespaced per color space so SDR-then-HDR re-normalize
  // doesn't collide. Matches the suffix produced by lib.normalize.main().
  const out = src.replace(/(\.\w+)$/, `_normalized_${projectColorSpace}.mp4`)

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
    const proc = spawn('python3', [
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
  const probe = spawnSync('ffprobe', [
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
    const proc = spawn('ffmpeg', [
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

// Bounded-concurrency map. Cap matches materialize_cut.py's libx264 worker pool.
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
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(`${C.cyan}[montaj render]${C.reset} ${msg}\n`)
}

function fail(code, message) {
  process.stderr.write(JSON.stringify({ error: code, message }) + '\n')
  process.exit(1)
}

export { getTotalDurationSeconds, collectPuppeteerSegments, collectAllItems, resolveFilePath }
