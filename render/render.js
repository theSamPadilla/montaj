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
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { resolve, join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

import { bundleComponent, cleanupBundle } from './bundle.js'
import { renderAllSegments }              from './renderer.js'
import { compose }                        from './compose.js'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const MONTAJ_ROOT = process.env.MONTAJ_ROOT || join(__dirname, '..')

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
  const [width, height] = settings.resolution || [1080, 1920]

  // Overlay components are authored for a 1080×1920 canvas. For 4K output (2160×3840)
  // the design pixel ratio is 2. Render segments at design resolution to avoid timing
  // instability from oversized Puppeteer screenshots; compose.js upscales to full res.
  const pixelRatio   = Math.max(1, Math.round(width / 1080))
  const renderWidth  = Math.round(width  / pixelRatio)
  const renderHeight = Math.round(height / pixelRatio)

  // project.json always lives at the workspace root (written there by project/init.py),
  // so projectDir === workspaceDir. Render outputs go to workspace/<name>/render/.
  const workspaceDir = projectDir
  const renderDir    = join(workspaceDir, 'render')
  const segDir       = join(renderDir, 'segments')
  mkdirSync(segDir, { recursive: true })

  const outputPath = out ? resolve(out) : join(renderDir, 'final.mp4')

  // 2. Build base video (trim + concat source clips)
  log('building base video...')
  const baseVideoPath = join(workspaceDir, 'render', 'base.mp4')
  buildBaseVideo(projectJson, baseVideoPath)

  // 3. Bundle + render all overlay and caption segments
  const segmentSpecs = collectSegments(projectJson, fps, renderWidth, renderHeight, segDir)
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
      offsetX:        spec.offsetX ?? 0,
      offsetY:        spec.offsetY ?? 0,
      scale:          spec.scale   ?? 1,
    })
    spec.htmlPath = htmlPath
    workDirs.push(workDir)
  }

  const renderedSegments = await renderAllSegments(segmentSpecs, { workers })

  // Attach positioning offsets + pixelRatio back onto rendered segments
  // so compose.js can apply x/y coordinates and upscale segments to video resolution.
  for (const rSeg of renderedSegments) {
    const spec = segmentSpecs.find(s => s.id === rSeg.id)
    if (spec) {
      rSeg.offsetX    = spec.offsetX ?? 0
      rSeg.offsetY    = spec.offsetY ?? 0
      rSeg.scale      = spec.scale   ?? 1
      rSeg.opaque     = spec.opaque  ?? false
      rSeg.pixelRatio = pixelRatio
    }
  }

  // 4. Compose final MP4
  log('composing final video...')
  await compose({ projectJson, baseVideoPath, segments: renderedSegments, outputPath })

  // 5. Cleanup temp bundles (always); intermediate segments only if --clean
  for (const dir of workDirs) cleanupBundle(dir)

  if (clean) {
    rmSync(join(renderDir, 'base.mp4'),   { force: true })
    rmSync(segDir, { recursive: true, force: true })
    log('intermediate files cleaned')
  }

  // Step output convention: final path on stdout
  process.stdout.write(outputPath + '\n')
}

// ---------------------------------------------------------------------------
// Base video: trim + concat source clips
// ---------------------------------------------------------------------------

function buildBaseVideo(projectJson, outputPath) {
  const videoTrack = projectJson.tracks?.find(t => t.type === 'video')

  if (!videoTrack?.clips?.length) {
    // Canvas project — generate synthetic black base from overlay duration
    const allItems = (projectJson.overlay_tracks || []).flat()
    if (allItems.length === 0) {
      fail('no_duration', 'Canvas project has no overlay items — cannot infer duration.')
    }
    const duration = Math.max(...allItems.map(i => i.end))
    if (!duration || duration <= 0) {
      fail('no_duration', 'Canvas project has no overlay items with valid end timestamps.')
    }
    log(`canvas project — generating ${duration}s synthetic black base...`)
    const fps = projectJson.settings?.fps ?? 30
    const [width, height] = projectJson.settings?.resolution ?? [1080, 1920]
    const result = spawnSync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', `color=black:size=${width}x${height}:rate=${fps}`,
      '-t', String(duration),
      '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
      '-pix_fmt', 'yuv420p',
      outputPath,
    ], { encoding: 'utf8', timeout: 300_000 })
    if (result.status !== 0) fail('ffmpeg_error', `Synthetic base failed: ${result.stderr}`)
    log('base video ready (synthetic)')
    return
  }

  // --- existing clip trim/concat logic continues below unchanged ---

  const clips = [...videoTrack.clips].sort((a, b) => a.order - b.order)
  const tmpDir = outputPath + '.tmp'
  mkdirSync(tmpDir, { recursive: true })

  if (clips.length === 1) {
    const clip   = clips[0]
    log(`trimming clip 1/1 (${basename(clip.src)})...`)
    // Stream copy — no re-encode. compose re-encodes with overlays anyway.
    // Input-side -ss for fast keyframe seek; -t is duration relative to seek point.
    const result = spawnSync('ffmpeg', [
      '-y',
      '-ss', String(clip.inPoint),
      '-i', clip.src,
      '-t', String(clip.outPoint - clip.inPoint),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      outputPath,
    ], { encoding: 'utf8', timeout: 300_000 })
    if (result.status !== 0) fail('ffmpeg_error', `Trim failed: ${result.stderr}`)
    rmSync(tmpDir, { recursive: true, force: true })
    log('base video ready')
    return
  }

  // Trim each clip individually, then concat
  const trimmedPaths = []
  for (let i = 0; i < clips.length; i++) {
    const clip      = clips[i]
    log(`trimming clip ${i + 1}/${clips.length} (${basename(clip.src)})...`)
    const trimPath  = join(tmpDir, `clip-${i}.mp4`)
    const result = spawnSync('ffmpeg', [
      '-y',
      '-ss', String(clip.inPoint),
      '-i', clip.src,
      '-t', String(clip.outPoint - clip.inPoint),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      trimPath,
    ], { encoding: 'utf8', timeout: 300_000 })
    if (result.status !== 0) fail('ffmpeg_error', `Trim clip ${i} failed: ${result.stderr}`)
    trimmedPaths.push(trimPath)
  }

  const listFile = join(tmpDir, 'concat.txt')
  writeFileSync(listFile, trimmedPaths.map(p => `file '${p}'`).join('\n'))

  const concat = spawnSync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', outputPath,
  ], { encoding: 'utf8', timeout: 300_000 })
  if (concat.status !== 0) fail('ffmpeg_error', `Concat failed: ${concat.stderr}`)

  rmSync(tmpDir, { recursive: true, force: true })
  log('base video ready')
}

// ---------------------------------------------------------------------------
// Segment collection: one spec per caption track + per overlay item
// ---------------------------------------------------------------------------

function collectSegments(projectJson, fps, width, height, segDir) {
  const specs     = []
  const totalSecs = getTotalDurationSeconds(projectJson)

  for (const track of projectJson.tracks || []) {
    if (track.type === 'caption') {
      // Caption component renders for the full video duration.
      // The component itself decides which words/segments are visible at each frame.
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
      })
    }

  }

  for (let trackIdx = 0; trackIdx < (projectJson.overlay_tracks || []).length; trackIdx++) {
    const overlayItems = projectJson.overlay_tracks[trackIdx]
    for (const item of overlayItems || []) {
      const durationSecs = item.end - item.start
      const frameCount   = Math.ceil(durationSecs * fps)

      const { id, start, end, src, offsetX = 0, offsetY = 0, scale: overlayScale = 1, opaque = false } = item
      const props = item.props ?? {}

      specs.push({
        id:            `overlay-${trackIdx}--${id}`,
        componentPath: overlayTemplatePath(item),
        props,
        offsetX,
        offsetY,
        scale:         overlayScale,
        opaque,
        frameCount,
        fps,
        startSeconds:  start,
        endSeconds:    end,
        outputPath:    join(segDir, `overlay-${trackIdx}--${id}.mkv`),
        width,
        height,
      })
    }
  }

  return specs
}

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
  if (item.type === 'custom') return resolve(item.src)
  fail('unknown_overlay_type', `Overlay type '${item.type}' is not supported. Set "type": "custom" and provide a "src" path to a JSX file.`)
}

// ---------------------------------------------------------------------------
// Path resolution + validation
// ---------------------------------------------------------------------------

function resolveProjectPaths(projectJson, projectDir) {
  for (const track of projectJson.tracks || []) {
    if (track.type === 'video') {
      for (const clip of track.clips || []) {
        if (clip.src && !clip.src.startsWith('/')) {
          clip.src = resolve(projectDir, clip.src)
        }
      }
    }
  }
  for (const overlayTrack of projectJson.overlay_tracks || []) {
    for (const item of overlayTrack || []) {
      if (item.src && !item.src.startsWith('/')) {
        item.src = resolve(projectDir, item.src)
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

  for (const track of projectJson.tracks || []) {
    if (track.type === 'video') {
      for (const clip of track.clips || []) {
        if (clip.src && !existsSync(clip.src)) missing.push(clip.src)
      }
    }
  }
  for (const overlayTrack of projectJson.overlay_tracks || []) {
    for (const item of overlayTrack || []) {
      if (item.type === 'custom' && item.src && !existsSync(item.src)) missing.push(item.src)
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
// Utilities
// ---------------------------------------------------------------------------

function getTotalDurationSeconds(projectJson) {
  const videoTrack = projectJson.tracks?.find(t => t.type === 'video')
  if (videoTrack?.clips?.length) {
    return videoTrack.clips.reduce((sum, c) => sum + (c.outPoint - c.inPoint), 0)
  }
  // Canvas project — infer duration from overlay_tracks
  const allItems = (projectJson.overlay_tracks || []).flat()
  if (allItems.length === 0) return 0
  return Math.max(...allItems.map(i => i.end))
}

function log(msg) {
  process.stderr.write(`[montaj render] ${msg}\n`)
}

function fail(code, message) {
  process.stderr.write(JSON.stringify({ error: code, message }) + '\n')
  process.exit(1)
}
