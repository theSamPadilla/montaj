// render/test/layering.integration.test.mjs (§308 P3)
//
// An image on a track above an overlay draws over it in the export, as it does
// in the editor preview. The export used to draw every image under every
// overlay. And an opaque overlay replaces only what is below it: the image
// above it is drawn. Solid colours, so one pixel says which layer is on top.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG } from '../ffmpeg-bin.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDER_JS = join(__dirname, '..', 'render.js')
const FPS = 10
const [W, H] = [360, 640]

const FILL_JSX = `export default function Fill({ color }) {
  return <div style={{ position: 'absolute', inset: 0, background: color }} />
}
`

/** RGB of the pixel at fractional (fx, fy) of frame `n` of a video. */
export function pixel(path, n, fx = 0.5, fy = 0.5) {
  // RGB before the crop: a 1x1 crop of 4:2:0 has no chroma plane left.
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', path, '-map', '0:v:0',
    '-vf', `select=eq(n\\,${n}),format=rgb24,crop=1:1:iw*${fx}:ih*${fy}`,
    '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })
  if (r.status !== 0 || r.stdout.length < 3) throw new Error(`pixel read failed: ${r.stderr}`)
  return [r.stdout[0], r.stdout[1], r.stdout[2]]
}

export function near(rgb, want, why, tol = 40) {
  assert.ok(rgb.every((v, i) => Math.abs(v - want[i]) <= tol), `${why}: got ${rgb}, want about ${want}`)
}

test('render: an image on a track above an overlay draws over it, and over an opaque one too', { timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-layering-'))
  try {
    const jsx = join(dir, 'fill.jsx')
    writeFileSync(jsx, FILL_JSX)
    const green = join(dir, 'green.mp4')
    const blue = join(dir, 'blue.png')
    for (const args of [
      ['-f', 'lavfi', '-i', `color=c=0x00ff00:size=${W}x${H}:rate=${FPS}:duration=2`, '-pix_fmt', 'yuv420p', green],
      ['-f', 'lavfi', '-i', `color=c=0x0000ff:size=${W}x${H}:rate=1`, '-frames:v', '1', '-update', '1', blue],
    ]) {
      const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
    }
    // Footage on track 0; a red full-screen overlay on track 1 (plain for the
    // first second, opaque for the second); a half-size blue image on track 2.
    const overlay = (id, start, end, opaque) => ({ id, type: 'overlay', src: jsx, props: { color: '#ff0000' }, start, end, ...(opaque ? { opaque: true } : {}) })
    const project = {
      version: '0.2', id: 'layering', status: 'final', projectType: 'editing',
      settings: { resolution: [W, H], fps: FPS, colorSpace: 'sdr_bt709' },
      tracks: [
        [{ id: 'footage', type: 'video', src: green, start: 0, end: 2, inPoint: 0, outPoint: 2 }],
        [overlay('plain', 0, 1, false), overlay('cover', 1, 2, true)],
        [{ id: 'img', type: 'image', src: blue, start: 0, end: 2, scale: 0.5 }],
      ],
      audio: {},
    }
    const projectPath = join(dir, 'project.json')
    writeFileSync(projectPath, JSON.stringify(project))
    const out = join(dir, 'out.mp4')
    const r = spawnSync('node', [RENDER_JS, projectPath, '--out', out], { encoding: 'utf8', timeout: 280_000 })
    assert.equal(r.status, 0, `render failed: ${r.stderr?.slice(-600)}`)
    assert.ok(existsSync(out))

    near(pixel(out, 5), [0, 0, 255], 'the image on the higher track is on top of the overlay')
    near(pixel(out, 5, 0.05, 0.05), [255, 0, 0], 'around it, the overlay')
    near(pixel(out, 15), [0, 0, 255], 'the image above an opaque overlay is drawn')
    near(pixel(out, 15, 0.05, 0.05), [255, 0, 0], 'the opaque overlay still replaces the footage under it')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
