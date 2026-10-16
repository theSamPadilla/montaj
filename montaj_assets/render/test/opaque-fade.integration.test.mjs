// render/test/opaque-fade.integration.test.mjs (§309)
//
// An opaque overlay fading out shows what is beneath it, in the export and in
// a sampled frame. Before, the export captured a fading opaque overlay with no
// alpha, so the fade showed the page background (white) and never the overlay
// or footage under it, and both culled the footage for the overlay's whole
// span. Solid colours, so one pixel says which layers were drawn.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG } from '../ffmpeg-bin.js'
import { sampleFrame } from '../sample-frame.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDER_JS = join(__dirname, '..', 'render.js')
const FPS = 10
const [W, H] = [360, 640]

const FILL_JSX = `export default function Fill({ color }) {
  return <div style={{ position: 'absolute', inset: 0, background: color }} />
}
`

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-opaque-fade-'))
  const jsx = join(dir, 'fill.jsx')
  writeFileSync(jsx, FILL_JSX)
  const green = join(dir, 'green.png')
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x00ff00:size=${W}x${H}:rate=1`,
    '-frames:v', '1', '-update', '1', green], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`fixture failed: ${r.stderr}`)
  return { dir, jsx, green }
}

const fill = (jsx, id, color, start, end, keyframes) => ({
  id, type: 'overlay', src: jsx, props: { color }, start, end, opaque: true,
  ...(keyframes ? { keyframes: [{ prop: 'opacity', points: keyframes.map(([t, value]) => ({ t, value })) }] } : {}),
})

/** RGB of the centre pixel of frame `n` of a video, or of a still. */
function centre(path, n = 0) {
  // RGB before the crop: a 1x1 crop of 4:2:0 has no chroma plane left.
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', path, '-map', '0:v:0',
    '-vf', `select=eq(n\\,${n}),format=rgb24,crop=1:1:iw/2:ih/2`,
    '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })
  if (r.status !== 0 || r.stdout.length < 3) throw new Error(`pixel read failed: ${r.stderr}`)
  return [r.stdout[0], r.stdout[1], r.stdout[2]]
}

const near = (rgb, want, why, tol = 40) => {
  assert.ok(rgb.every((v, i) => Math.abs(v - want[i]) <= tol), `${why}: got ${rgb}, want about ${want}`)
}

test('render: an opaque overlay fading out shows the opaque overlay and the footage beneath it', { timeout: 300_000 }, () => {
  const w = world()
  try {
    // Footage (green) under everything. 0-2 s: a red opaque overlay, and over
    // it a blue one fading 1 -> 0 from 0.5 s to 1.5 s (a 3D crossfade's shape).
    // 2-4 s: a blue opaque overlay fading 1 -> 0 over the footage alone.
    const project = {
      version: '0.2', id: 'opaque-fade', status: 'final', projectType: 'editing',
      settings: { resolution: [W, H], fps: FPS, colorSpace: 'sdr_bt709' },
      tracks: [
        [{ id: 'bg', type: 'image', src: w.green, start: 0, end: 4, scale: 1 }],
        [fill(w.jsx, 'lower', '#ff0000', 0, 2)],
        [fill(w.jsx, 'upper', '#0000ff', 0, 2, [[0.5, 1], [1.5, 0]]), fill(w.jsx, 'last', '#0000ff', 2, 4, [[0, 1], [1, 0]])],
      ],
      audio: {},
    }
    const projectPath = join(w.dir, 'project.json')
    writeFileSync(projectPath, JSON.stringify(project))
    const out = join(w.dir, 'out.mp4')
    const r = spawnSync('node', [RENDER_JS, projectPath, '--out', out], { encoding: 'utf8', timeout: 280_000 })
    assert.equal(r.status, 0, `render failed: ${r.stderr?.slice(-600)}`)
    assert.ok(existsSync(out))

    near(centre(out, 2), [0, 0, 255], 'before the fade the top overlay covers everything')
    near(centre(out, 10), [128, 0, 128], 'mid-fade the opaque overlay beneath shows through')
    near(centre(out, 17), [255, 0, 0], 'faded out, the overlay beneath is all there is')
    near(centre(out, 25), [0, 128, 128], 'mid-fade over footage, the footage shows through')
    near(centre(out, 35), [0, 255, 0], 'faded out, the footage is drawn')
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('sample_frame: the footage under an opaque overlay mid-fade is drawn', { timeout: 120_000 }, async () => {
  const w = world()
  try {
    const project = {
      version: '0.2', status: 'final',
      settings: { resolution: [W, H], fps: FPS, colorSpace: 'sdr_bt709' },
      tracks: [
        [{ id: 'bg', type: 'image', src: w.green, start: 0, end: 4, scale: 1 }],
        [fill(w.jsx, 'top', '#0000ff', 0, 4, [[1, 1], [2, 0]])],
      ],
      audio: { tracks: [] },
    }
    const projectPath = join(w.dir, 'project.json')
    writeFileSync(projectPath, JSON.stringify(project))
    const at = async (t) => centre((await sampleFrame({ projectJson: projectPath, atSeconds: t, outPath: join(w.dir, `at-${t}.png`) })).pngPath)
    near(await at(0.5), [0, 0, 255], 'at full opacity the overlay replaces the picture')
    near(await at(1.5), [0, 128, 128], 'mid-fade the footage shows through')
    near(await at(2.5), [0, 255, 0], 'faded out, the footage is drawn')
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})
