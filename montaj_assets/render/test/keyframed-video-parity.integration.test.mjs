// render/test/keyframed-video-parity.integration.test.mjs (§672)
//
// A keyframed video item exports as the preview draws it. The preview's truth is timeline-core's geometryAt and
// opacityAt, the functions the editor and sample_frame read; the export is measured on a solid red clip over a dark
// background: the red box's edges (where the red has risen halfway from the background to its own opacity-scaled
// level) against the box geometryAt gives, and its level against opacityAt.
//
// Cases (each the shape of a real project's items): ease-out keyframes on scale, offset and opacity from t 0; the
// same with the first keyframe LATE (0.25 s into the item); ease-in-out keyframes with a blur and opacity; ease-in-out
// with no opacity track (the control); and the same ease-out from a 360x640 clip on a 720x1280 canvas (a 1080
// project exported at 4K).
// The failure this pins: a keyframed or static opacity went through colorchannelmixer on an opaque 4:2:0 frame, which
// has no alpha plane, so it was ignored, and (keyframed) the mixer sitting AFTER the animated scale froze the box at its
// first size, drawing the item at the wrong size and position.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { geometryAt, opacityAt, toPixelBox } from '@bycrux/timeline-core'
import { FFMPEG } from '../ffmpeg-bin.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDER_JS = join(__dirname, '..', 'render.js')
const FPS = 30
const BG = 0x20 // the background's red level
const RED = 0xfb // the clip's red level after yuv420p

const kf = (prop, points) => ({ prop, points })
const ease = (t, value, easing) => ({ t, value, ...(easing ? { easing } : {}) })

function frameRgb(path, t, W, H) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', path, '-frames:v', '1', '-vf', 'format=rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0 || r.stdout.length < W * H * 3) throw new Error(`frame read failed: ${r.stderr}`)
  return r.stdout
}

/** The red box in a frame: its edges where the red passes halfway between the background and `level`. */
function redBox(buf, W, H, level) {
  const half = BG + (level - BG) / 2
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 3
      if (buf[i] >= half && buf[i + 1] < 90) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 2, y1: y1 + 2 }
}

function build(dir, { W, H, srcW, srcH }) {
  const media = (name, color, d) => {
    const p = join(dir, name)
    const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:size=${srcW}x${srcH}:rate=${FPS}:duration=${d}`, '-pix_fmt', 'yuv420p', '-g', '30', p], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return p
  }
  const red = media('red.mp4', '0xff0000', 8)
  const bg = media('bg.mp4', `0x${BG.toString(16)}2020`, 8)
  const png = join(dir, 'red.png')
  const pr = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0xff0000:size=${srcW}x${srcH}:rate=1`, '-frames:v', '1', '-update', '1', png], { encoding: 'utf8' })
  assert.equal(pr.status, 0, pr.stderr)
  const item = (id, start, end, over) => ({
    id, type: 'video', src: red, start, end, inPoint: 0.2, outPoint: 0.2 + (end - start), sourceWidth: srcW, sourceHeight: srcH,
    sourceDuration: 8, muted: true, scale: 0.45, offsetX: -10, offsetY: -8, ...over,
  })
  const items = [
    // ease-out from the first instant, with an opacity ramp
    item('easeOut', 0, 1.5, { keyframes: [
      kf('scale', [ease(0, 0.2, 'ease-out'), ease(0.9, 0.45)]),
      kf('offsetY', [ease(0, -4, 'ease-out'), ease(0.9, -8)]),
      kf('opacity', [ease(0, 0, 'ease-out'), ease(0.9, 1)]),
    ] }),
    // the same, first keyframe 0.25 s in
    item('late', 1.5, 3, { keyframes: [
      kf('scale', [ease(0.25, 0.2, 'ease-out'), ease(1.15, 0.45)]),
      kf('offsetY', [ease(0.25, -4, 'ease-out'), ease(1.15, -8)]),
      kf('opacity', [ease(0.25, 0, 'ease-out'), ease(1.15, 1)]),
    ] }),
    // blur, ease-in-out on scale, offsets and opacity, down and back up
    item('blur', 3, 4.5, { blur: 6, keyframes: [
      kf('scale', [ease(0, 0.45, 'ease-in-out'), ease(0.5, 0.25), ease(1.0, 0.25, 'ease-in-out'), ease(1.4, 0.45)]),
      kf('offsetX', [ease(0, -10, 'ease-in-out'), ease(0.5, -22), ease(1.0, -22, 'ease-in-out'), ease(1.4, -10)]),
      kf('offsetY', [ease(0, -8, 'ease-in-out'), ease(0.5, -20), ease(1.0, -20, 'ease-in-out'), ease(1.4, -8)]),
      kf('opacity', [ease(0, 0.5, 'ease-in-out'), ease(0.5, 1)]),
    ] }),
    // the control: ease-in-out geometry, no opacity track
    item('control', 4.5, 6, { keyframes: [
      kf('scale', [ease(0, 0.45, 'ease-in-out'), ease(0.8, 0.25)]),
      kf('offsetX', [ease(0, -10, 'ease-in-out'), ease(0.8, -22)]),
    ] }),
    // a still, the same ease-out landing (its chain has the same mixer)
    { id: 'still', type: 'image', src: png, start: 6, end: 7.5, scale: 0.45, offsetX: -10, offsetY: -8, keyframes: [
      kf('scale', [ease(0, 0.2, 'ease-out'), ease(0.9, 0.45)]),
      kf('opacity', [ease(0, 0, 'ease-out'), ease(0.9, 1)]),
    ] },
  ]
  const project = {
    version: '0.2', id: 'kf-parity', status: 'final', projectType: 'editing',
    settings: { resolution: [W, H], fps: FPS, colorSpace: 'sdr_bt709', proxy: false },
    tracks: [
      { id: 'bg', items: [{ id: 'bg', type: 'video', src: bg, start: 0, end: 7.5, inPoint: 0, outPoint: 7.5, sourceWidth: srcW, sourceHeight: srcH, sourceDuration: 8, muted: true }] },
      { id: 'up', items },
    ],
    audio: { tracks: [] },
  }
  const projectPath = join(dir, 'project.json')
  writeFileSync(projectPath, JSON.stringify(project))
  return { projectPath, items }
}

for (const [name, size] of [
  ['1080-style canvas (source as large as the canvas)', { W: 360, H: 640, srcW: 360, srcH: 640 }],
  ['a 1080 source on a canvas twice its size (4K from 1080)', { W: 720, H: 1280, srcW: 360, srcH: 640 }],
]) {
  test(`keyframed video items export as the preview draws them: ${name}`, { timeout: 600_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'montaj-kf-parity-'))
    try {
      const { W, H } = size
      const { projectPath, items } = build(dir, size)
      const out = join(dir, 'out.mp4')
      const r = spawnSync('node', [RENDER_JS, projectPath, '--out', out], { encoding: 'utf8', timeout: 560_000 })
      assert.equal(r.status, 0, `render failed: ${r.stderr?.slice(-600)}`)
      const probes = { easeOut: [0.1, 0.4, 1.0], late: [0.3, 0.6, 1.3], blur: [0.2, 0.6, 1.1], control: [0.2, 0.5, 1.2], still: [0.1, 0.4, 1.0] }
      for (const item of items) {
        for (const local of probes[item.id]) {
          const t = item.start + local
          const g = geometryAt(item, item.type, local)
          const box = toPixelBox(g, W, H)
          const x0 = Math.round((W - box.width) / 2 + (g.offsetX / 100) * W)
          const y0 = Math.round((H - box.height) / 2 + (g.offsetY / 100) * H)
          const alpha = Math.min(1, Math.max(0, opacityAt(item, local)))
          const level = BG + (RED - BG) * alpha
          const got = redBox(frameRgb(out, t, W, H), W, H, level)
          const why = `${item.id} at ${local}s (scale ${g.scale.toFixed(3)}, opacity ${alpha.toFixed(2)})`
          assert.ok(got, `${why}: no red box drawn`)
          // A still lands about half a frame behind its curve (the image input's timestamps), a blur softens the edge.
          const tol = (item.blur ? 8 : item.type === 'image' ? 6 : 4) * (W / 360)
          for (const [k, want] of [['x0', x0], ['y0', y0], ['x1', x0 + box.width], ['y1', y0 + box.height]]) {
            assert.ok(Math.abs(got[k] - want) <= tol, `${why}: ${k} is ${got[k]}, the preview's box has ${want} (${JSON.stringify(got)})`)
          }
          // the box's level, away from a blurred edge: the middle of it
          const buf = frameRgb(out, t, W, H)
          const cx = Math.round(x0 + box.width / 2)
          const cy = Math.round(y0 + box.height / 2)
          const mid = buf[(cy * W + cx) * 3]
          assert.ok(Math.abs(mid - level) <= (item.type === 'image' ? 20 : 14), `${why}: its red is ${mid}, the preview's opacity gives about ${Math.round(level)}`)
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
