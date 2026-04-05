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
import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs'
import { resolve, join, dirname, basename, extname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

import { bundleComponent, cleanupBundle } from './bundle.js'
import { renderAllSegments }              from './renderer.js'
import { compose }                        from './compose.js'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const MONTAJ_ROOT = process.env.MONTAJ_ROOT || join(__dirname, '..')
const PYTHON = process.env.MONTAJ_PYTHON || 'python3'

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

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

  // Design resolution — what overlay components are authored for (always 1080-wide).
  // Puppeteer renders at this size regardless of the actual output video resolution.
  const renderWidth  = 1080
  const renderHeight = 1920

  // project.json always lives at the workspace root (written there by project/init.py),
  // so projectDir === workspaceDir. Render outputs go to workspace/<name>/render/.
  const workspaceDir = projectDir
  const renderDir    = join(workspaceDir, 'render')
  const segDir       = join(renderDir, 'segments')
  mkdirSync(segDir, { recursive: true })

  const outputPath = out ? resolve(out) : join(renderDir, 'final.mp4')

  // 2. Collect segments and items
  const baseTrackClips = projectJson.base_track || []
  const segmentSpecs = collectPuppeteerSegments(projectJson, fps, renderWidth, renderHeight, segDir)
  const { imageItems, videoItems } = collectDirectItems(projectJson)

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

  // 5. Detect base video dimensions (probe first clip in base_track, or use settings).
  let actualWidth  = renderWidth
  let actualHeight = renderHeight
  if (baseTrackClips.length > 0) {
    const dims = probeVideoDimensions(baseTrackClips[0].src)
    if (dims) { [actualWidth, actualHeight] = dims }
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
    baseTrackClips,
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
  const specs     = []
  const totalSecs = getTotalDurationSeconds(projectJson)

  // NEW schema: visual_tracks — process overlay type items
  for (let trackIdx = 0; trackIdx < (projectJson.visual_tracks || []).length; trackIdx++) {
    const track = projectJson.visual_tracks[trackIdx]
    for (const item of track || []) {
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
      // image and video types → handled by collectDirectItems, not Puppeteer
    }
  }

  // captions is a top-level object
  const captions = projectJson.captions
  if (captions?.segments?.length > 0 || captions?.style) {
    const frameCount = Math.ceil(totalSecs * fps)
    specs.push({
      id:            'captions',
      componentPath: captionTemplatePath(captions.style),
      props:         { segments: captions.segments || [] },
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

  // OLD schema fallback: tracks[type=caption]
  for (const track of projectJson.tracks || []) {
    if (track.type === 'caption') {
      const frameCount = Math.ceil(totalSecs * fps)
      specs.push({
        id:            track.id,
        componentPath: captionTemplatePath(track.style),
        props:         { segments: track.segments || [] },
        frameCount,
        fps,
        startSeconds:  0,
        endSeconds:    totalSecs,
        outputPath:    join(segDir, `${track.id}.webm`),
        width,
        height,
        isCaption:     true,
      })
    }
  }

  return specs
}

// ---------------------------------------------------------------------------
// Direct items: image and video visual_tracks items (no Puppeteer)
// ---------------------------------------------------------------------------

function collectDirectItems(projectJson) {
  const imageItems = []
  const videoItems = []

  for (let trackIdx = 0; trackIdx < (projectJson.visual_tracks || []).length; trackIdx++) {
    const track = projectJson.visual_tracks[trackIdx]
    for (const item of track || []) {
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
          // Use nobg_src (ProRes 4444 with alpha) for render when available; src stays for preview
          src:        item.nobg_src && item.remove_bg ? item.nobg_src : item.src,
          inPoint:    item.inPoint,
          outPoint:   item.outPoint,
          remove_bg:  item.remove_bg ?? false,
          muted:      item.muted ?? false,
        })
      }
    }
  }

  return { imageItems, videoItems }
}

// ---------------------------------------------------------------------------
// remove_bg pre-processing for video items
// ---------------------------------------------------------------------------

async function processVideoItems(videoItems, workspaceDir) {
  for (const item of videoItems) {
    if (item.remove_bg) {
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
  // NEW schema: base_track clips
  for (const clip of projectJson.base_track || []) {
    if (clip.src && !clip.src.startsWith('/')) {
      clip.src = resolve(projectDir, clip.src)
    }
  }

  // NEW schema: visual_tracks items (overlay, image, video all have src)
  for (const track of projectJson.visual_tracks || []) {
    for (const item of track || []) {
      if (item.src && !item.src.startsWith('/')) {
        item.src = resolve(projectDir, item.src)
      }
    }
  }

  // OLD schema fallback: tracks[type=video].clips
  for (const track of projectJson.tracks || []) {
    if (track.type === 'video') {
      for (const clip of track.clips || []) {
        if (clip.src && !clip.src.startsWith('/')) {
          clip.src = resolve(projectDir, clip.src)
        }
      }
    }
  }

  if (projectJson.audio?.music?.src) {
    const src = projectJson.audio.music.src
    if (!src.startsWith('/')) {
      projectJson.audio.music.src = resolve(projectDir, src)
    }
  }
}

function validateProjectFiles(projectJson) {
  const missing = []

  // NEW schema: base_track clips
  for (const clip of projectJson.base_track || []) {
    if (clip.src && !existsSync(clip.src)) missing.push(clip.src)
  }

  // NEW schema: visual_tracks items
  for (const track of projectJson.visual_tracks || []) {
    for (const item of track || []) {
      if ((item.type === 'overlay' || item.type === 'image' || item.type === 'video') && item.src && !existsSync(item.src)) {
        missing.push(item.src)
      }
    }
  }

  // OLD schema fallback: tracks[type=video].clips
  for (const track of projectJson.tracks || []) {
    if (track.type === 'video') {
      for (const clip of track.clips || []) {
        if (clip.src && !existsSync(clip.src)) missing.push(clip.src)
      }
    }
  }

  if (projectJson.audio?.music?.src && !existsSync(projectJson.audio.music.src)) {
    missing.push(projectJson.audio.music.src)
  }

  if (missing.length > 0) {
    fail('missing_files', `Referenced files not found:\n  ${missing.join('\n  ')}`)
  }
}

// ---------------------------------------------------------------------------
// Duration calculation
// ---------------------------------------------------------------------------

function getTotalDurationSeconds(projectJson) {
  // NEW schema: base_track clips
  if (projectJson.base_track?.length > 0) {
    return projectJson.base_track.reduce((sum, c) => sum + (c.outPoint - c.inPoint), 0)
  }

  // Canvas project — infer duration from visual_tracks
  const visualItems = (projectJson.visual_tracks || []).flat()
  if (visualItems.length > 0) {
    return Math.max(...visualItems.map(i => i.end))
  }

  return 0
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(`[montaj render] ${msg}\n`)
}

function fail(code, message) {
  process.stderr.write(JSON.stringify({ error: code, message }) + '\n')
  process.exit(1)
}
