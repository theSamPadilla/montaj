// montaj_assets/render/test/scene3d.test.mjs (§239)
//
// A scene item is an overlay whose src is `engine:scene3d`. materializeScene3d rewrites it, in place, into the plain
// overlay of the host's stage with the scene's file and the in point as props; every other part of the render then
// sees an ordinary overlay. Pure, so these tests use a temp project folder and an injected environment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { SCENE3D_SRC, SCENE3D_STAGE_ENV, Scene3dError, isScene3dItem, materializeScene3d } from '../scene3d.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDER_JS = join(__dirname, '..', 'render.js')

function world({ main = true, scenes = [], stage = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-scene3d-'))
  const stageFile = join(dir, 'engine', 'model3d_stage.jsx')
  if (stage) { mkdirSync(dirname(stageFile), { recursive: true }); writeFileSync(stageFile, 'export default () => null') }
  const project = join(dir, 'project')
  mkdirSync(join(project, 'models'), { recursive: true })
  if (main) writeFileSync(join(project, 'models', 'active.json'), '{}')
  for (const s of scenes) { mkdirSync(join(project, 'models', 'scenes', s), { recursive: true }); writeFileSync(join(project, 'models', 'scenes', s, 'active.json'), '{}') }
  return { dir, project, stageFile, env: stage ? { [SCENE3D_STAGE_ENV]: stageFile } : {} }
}
const scene = (props, extra = {}) => ({ id: 's1', type: 'overlay', src: SCENE3D_SRC, start: 1, end: 4, props, ...extra })
const projectOf = (...items) => ({ settings: { resolution: [1080, 1920], fps: 30 }, tracks: [items] })

test('a scene item becomes the plain overlay of the host stage, with the scene file and the in point as props', () => {
  const w = world({ scenes: ['hands'] })
  try {
    const p = projectOf(scene({ scene: 'hands', inPoint: 2.5, extra: 'kept' }, { offsetX: 5 }))
    assert.equal(materializeScene3d(p, w.project, { env: w.env }), 1)
    const it = p.tracks[0][0]
    assert.equal(it.src, w.stageFile)
    assert.deepEqual(it.props, { scene: 'hands', inPoint: 2.5, extra: 'kept', sceneFile: join(w.project, 'models', 'scenes', 'hands', 'active.json') })
    assert.equal(it.offsetX, 5, 'the overlay\'s own fields are untouched')
    assert.equal(isScene3dItem(it), false)
    assert.equal(materializeScene3d(p, w.project, { env: w.env }), 0, 'a second pass finds nothing')
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('no scene name is the project\'s own scene (models/active.json); inPoint defaults to 0', () => {
  const w = world()
  try {
    const p = projectOf(scene({}))
    materializeScene3d(p, w.project, { env: w.env })
    assert.equal(p.tracks[0][0].props.sceneFile, join(w.project, 'models', 'active.json'))
    assert.equal(p.tracks[0][0].props.inPoint, 0)
    const none = projectOf({ ...scene({}), props: undefined })
    materializeScene3d(none, w.project, { env: w.env })
    assert.equal(none.tracks[0][0].props.inPoint, 0)
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('items that are not scene items are left exactly as they are', () => {
  const w = world()
  try {
    const own = { id: 'o', type: 'overlay', src: '/p/own.jsx', start: 0, end: 2, props: { a: 1 } }
    const clip = { id: 'v', type: 'video', src: 'engine:scene3d', start: 0, end: 2 }
    const p = projectOf(own, clip)
    const before = JSON.stringify(p)
    assert.equal(materializeScene3d(p, w.project, { env: w.env }), 0)
    assert.equal(JSON.stringify(p), before)
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('every refusal names its cause and carries a stable code: no stage, a missing scene, a bad name or in point, no project folder', () => {
  const w = world({ scenes: ['hands'] })
  const refuses = (project, dir, env, code, re) => {
    assert.throws(() => materializeScene3d(project, dir, { env }), (e) => e instanceof Scene3dError && e.code === code && re.test(e.message), code)
  }
  try {
    refuses(projectOf(scene({ scene: 'hands' })), w.project, {}, 'scene3d_stage_unavailable', /Update the Montaj app/)
    refuses(projectOf(scene({ scene: 'hands' })), w.project, { [SCENE3D_STAGE_ENV]: join(w.dir, 'gone.jsx') }, 'scene3d_stage_unavailable', /missing file/)
    refuses(projectOf(scene({ scene: 'nope' })), w.project, w.env, 'scene3d_scene_missing', /"nope"/)
    const bare = world({ main: false })
    try { refuses(projectOf(scene({})), bare.project, bare.env, 'scene3d_scene_missing', /project's own/) } finally { rmSync(bare.dir, { recursive: true, force: true }) }
    for (const name of ['Hands', '../x', '', 7, 'a/b']) refuses(projectOf(scene({ scene: name })), w.project, w.env, 'scene3d_invalid', /scene must be a name/)
    for (const inPoint of [-1, 'soon', NaN, null]) refuses(projectOf(scene({ scene: 'hands', inPoint })), w.project, w.env, 'scene3d_invalid', /inPoint/)
    refuses(projectOf(scene({ scene: 'hands' })), null, w.env, 'scene3d_invalid', /project's folder/)
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('render.js refuses a scene item with no stage before doing any work, as JSON with the code', () => {
  const w = world({ scenes: ['hands'], stage: false })
  try {
    const projectPath = join(w.project, 'project.json')
    writeFileSync(projectPath, JSON.stringify({ status: 'final', ...projectOf(scene({ scene: 'hands' })) }))
    const env = { ...process.env }
    delete env[SCENE3D_STAGE_ENV]
    const r = spawnSync('node', [RENDER_JS, projectPath], { encoding: 'utf8', timeout: 30_000, env })
    assert.equal(r.status, 1)
    const err = JSON.parse((r.stderr || '').trim().split('\n').pop())
    assert.equal(err.error, 'scene3d_stage_unavailable')
    assert.match(err.message, /Update the Montaj app/)
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})
