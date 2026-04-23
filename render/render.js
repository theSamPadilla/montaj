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
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'fs'
import { resolve, join, dirname, basename, extname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

import { bundleComponent, cleanupBundle } from './bundle.js'
import { renderAllSegments }              from './renderer.js'
import { compose }                        from './compose.js'

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

  // Design resolution — what overlay components are authored for.
  // Defaults to 1080×1920 (portrait) but respects settings.resolution when set,
  // so animations-only projects authored at a different resolution render correctly.
  const renderWidth  = settings.resolution?.[0] ?? 1080
  const renderHeight = settings.resolution?.[1] ?? 1920

  // project.json always lives at the workspace root (written there by project/init.py),
  // so projectDir === workspaceDir. Render outputs go to workspace/<name>/render/.
  const workspaceDir = projectDir
  const renderDir    = join(workspaceDir, 'render')
  const segDir       = join(renderDir, 'segments')
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

  // 3. Run remove_bg on any video items that need it
  await processVideoItems(videoItems, workspaceDir)

  // 4. Bundle + render all overlay and caption segments
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

  // 5. Use settings.resolution when explicitly set; otherwise detect from first video item.
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

  // 6. Compose final MP4
  log('composing final video...')
  await compose({
    projectJson,
    puppeteerSegments: renderedSegments,
    imageItems,
    videoItems,
    outputPath,
    videoWidth:  actualWidth,
    videoHeight: actualHeight,
  })

  // 7. Cleanup temp bundles (always); intermediate segments only if --clean
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
    const { style: _captStyle, segments: _captSegs, ...captionTheme } = captions
    specs.push({
      id:            'captions',
      componentPath: captionTemplatePath(captions.style),
      props:         { segments: captions.segments || [], ...captionTheme },
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
