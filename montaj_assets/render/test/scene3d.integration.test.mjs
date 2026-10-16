// render/test/scene3d.integration.test.mjs (§308)
//
// 3D items through the real pipeline, with a stand-in for the host's 3D stage
// (MONTAJ_SCENE3D_STAGE). The stand-in paints its whole frame one colour: red
// names the 3D (each scene file carries its own), blue is the 3D's own time
// (20 per second of `inPoint + frame / fps`). One pixel says which 3D was
// drawn and at what time in it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG, FFPROBE } from '../ffmpeg-bin.js'
import { sampleScene } from '../sample-frame.js'
import { SCENE3D_SRC, SCENE3D_STAGE_ENV } from '../scene3d.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SAMPLE_JS = join(__dirname, '..', 'sample-frame.js')
const FPS = 10
const [W, H] = [360, 640]
const TIME_SCALE = 20 // blue per second of 3D time

const STAGE_JSX = `export default function Stage({ sceneJson, inPoint }) {
  const scene = JSON.parse(sceneJson)
  const t = (inPoint ?? 0) + frame / fps
  const blue = Math.max(0, Math.min(255, Math.round(t * ${TIME_SCALE})))
  return <div style={{ position: 'absolute', inset: 0, background: \`rgb(\${scene.model.red}, 0, \${blue})\` }} />
}
`

/** A project folder with the project's own 3D (red 140) and saved 3Ds by id. */
function world(scenes = { lab: 250, yard: 60 }) {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-scene3d-it-'))
  const stage = join(dir, 'stage', 'model3d_stage.jsx')
  mkdirSync(dirname(stage), { recursive: true })
  writeFileSync(stage, STAGE_JSX)
  const project = join(dir, 'project')
  const save = (folder, red) => {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'active.json'), JSON.stringify({ model: { name: 'm', red }, moves: {}, scene: {} }))
  }
  save(join(project, 'models'), 140)
  for (const [id, red] of Object.entries(scenes)) save(join(project, 'models', 'scenes', id), red)
  return { dir, stage, project }
}

function writeProject(w, tracks) {
  const path = join(w.project, 'project.json')
  writeFileSync(path, JSON.stringify({
    version: '0.2', id: 'scene3d-it', status: 'final', projectType: 'editing',
    settings: { resolution: [W, H], fps: FPS, colorSpace: 'sdr_bt709' },
    tracks, audio: { tracks: [] },
  }))
  return path
}

/** RGB of the centre pixel of frame `n` of a video, or of a still. */
function centre(path, n = 0) {
  // RGB before the crop: a 1x1 crop of 4:2:0 has no chroma plane left.
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', path, '-map', '0:v:0',
    '-vf', `select=eq(n\\,${n}),format=rgb24,crop=1:1:iw/2:ih/2`,
    '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })
  if (r.status !== 0 || r.stdout.length < 3) throw new Error(`pixel read failed: ${r.stderr}`)
  return [r.stdout[0], r.stdout[1], r.stdout[2]]
}

function size(path) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path], { encoding: 'utf8' })
  return r.stdout.trim()
}

/** The 3D (by its red) and the 3D time a pixel shows. */
const read = ([red, , blue]) => ({ red, t: blue / TIME_SCALE })

function shows(rgb, red, t, why, { tolRed = 8, tolT = 0.2 } = {}) {
  const got = read(rgb)
  assert.ok(Math.abs(got.red - red) <= tolRed && Math.abs(got.t - t) <= tolT,
    `${why}: shows red ${got.red} at ${got.t.toFixed(2)} s, want red ${red} at ${t} s`)
}

async function withStage(w, fn) {
  const before = process.env[SCENE3D_STAGE_ENV]
  process.env[SCENE3D_STAGE_ENV] = w.stage
  try { return await fn() } finally {
    if (before === undefined) delete process.env[SCENE3D_STAGE_ENV]
    else process.env[SCENE3D_STAGE_ENV] = before
  }
}

test('sampleScene: a 3D on no timeline item samples alone, at the project frame, at a 3D time', { timeout: 180_000 }, async () => {
  const w = world()
  try {
    // The timeline shows the project's own 3D; `lab` and `yard` are on no item.
    const projectPath = writeProject(w, [[{ id: 'own', type: 'overlay', src: SCENE3D_SRC, start: 0, end: 2, props: { inPoint: 0 } }]])
    await withStage(w, async () => {
      const at = async (scene, t) => (await sampleScene({ projectJson: projectPath, scene, atSeconds: t, outPath: join(w.dir, `${scene || 'own'}-${t}.png`) })).pngPath
      const lab = await at('lab', 2.5)
      shows(centre(lab), 250, 2.5, 'lab at 2.5 s')
      assert.equal(size(lab), `${W},${H}`, 'the project\'s full frame')
      shows(centre(await at('lab', 7.25)), 250, 7.25, 'lab at 7.25 s: the 3D time is exact, not a timeline frame')
      shows(centre(await at('yard', 0)), 60, 0, 'yard at its start')
      shows(centre(await at('', 1)), 140, 1, "'' is the project's own 3D")
      await assert.rejects(at('nope', 1), /"nope"/, 'a 3D that is not saved fails naming it')
    })
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('sample-frame.js --scene: the CLI samples one 3D alone', { timeout: 120_000 }, () => {
  const w = world()
  try {
    const projectPath = writeProject(w, [[]])
    const out = join(w.dir, 'cli.png')
    const r = spawnSync('node', [SAMPLE_JS, '--mode', 'frame', '--project', projectPath, '--scene', 'yard', '--at', '3', '--out', out],
      { encoding: 'utf8', timeout: 110_000, env: { ...process.env, [SCENE3D_STAGE_ENV]: w.stage } })
    assert.equal(r.status, 0, r.stderr?.slice(-500))
    assert.equal(r.stdout.trim(), out)
    shows(centre(out), 60, 3, 'yard at 3 s')
    const own = join(w.dir, 'own.png')
    const r2 = spawnSync('node', [SAMPLE_JS, '--mode', 'frame', '--project', projectPath, '--scene', '', '--at', '0.5', '--out', own],
      { encoding: 'utf8', timeout: 110_000, env: { ...process.env, [SCENE3D_STAGE_ENV]: w.stage } })
    assert.equal(r2.status, 0, r2.stderr?.slice(-500))
    shows(centre(own), 140, 0.5, "--scene '' is the project's own")
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})
