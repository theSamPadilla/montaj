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
import { SCENE3D_SRC, SCENE3D_STAGE_ENV, Scene3dError, isScene3dItem, materializeScene3d, isThreeStageOverlay, STAGE_BUNDLE_HEAD } from '../scene3d.js'
import { collectPuppeteerSegments } from '../render.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDER_JS = join(__dirname, '..', 'render.js')

const SCENE_JSON = JSON.stringify({ model: { name: 'm' }, moves: {}, scene: {} })
function world({ main = true, scenes = [], stage = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-scene3d-'))
  const stageFile = join(dir, 'engine', 'model3d_stage.jsx')
  if (stage) { mkdirSync(dirname(stageFile), { recursive: true }); writeFileSync(stageFile, 'export default () => null') }
  const project = join(dir, 'project')
  mkdirSync(join(project, 'models'), { recursive: true })
  if (main) writeFileSync(join(project, 'models', 'active.json'), SCENE_JSON)
  for (const s of scenes) { mkdirSync(join(project, 'models', 'scenes', s), { recursive: true }); writeFileSync(join(project, 'models', 'scenes', s, 'active.json'), SCENE_JSON) }
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
    assert.deepEqual(it.props, { scene: 'hands', inPoint: 2.5, extra: 'kept', sceneFile: join(w.project, 'models', 'scenes', 'hands', 'active.json'), sceneJson: SCENE_JSON })
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
    assert.equal(p.tracks[0][0].props.sceneJson, SCENE_JSON)
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
    assert.throws(() => materializeScene3d(project, dir, { env, log: () => {} }), (e) => e instanceof Scene3dError && e.code === code && re.test(e.message), code)
  }
  try {
    refuses(projectOf(scene({ scene: 'hands' })), w.project, {}, 'scene3d_stage_unavailable', /Update the Montaj app/)
    refuses(projectOf(scene({ scene: 'hands' })), w.project, { [SCENE3D_STAGE_ENV]: join(w.dir, 'gone.jsx') }, 'scene3d_stage_unavailable', /Update the Montaj app/)
    refuses(projectOf(scene({ scene: 'nope' })), w.project, w.env, 'scene3d_scene_missing', /"nope"/)
    const bare = world({ main: false })
    try { refuses(projectOf(scene({})), bare.project, bare.env, 'scene3d_scene_missing', /project's own/) } finally { rmSync(bare.dir, { recursive: true, force: true }) }
    for (const name of ['Hands', '../x', '', 7, 'a/b']) refuses(projectOf(scene({ scene: name })), w.project, w.env, 'scene3d_invalid', /its 3D must be named with lowercase letters, digits and - \(got/)
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

test('a scene that cannot be read, or has no model, fails naming it (never a blank frame)', () => {
  const w = world({ scenes: ['bad', 'empty'] })
  try {
    writeFileSync(join(w.project, 'models', 'scenes', 'bad', 'active.json'), 'not json')
    writeFileSync(join(w.project, 'models', 'scenes', 'empty', 'active.json'), '{"moves":{}}')
    for (const name of ['bad', 'empty']) {
      assert.throws(() => materializeScene3d(projectOf(scene({ scene: name })), w.project, { env: w.env }), (e) => e instanceof Scene3dError && e.code === 'scene3d_invalid' && e.message.includes(`its 3D "${name}"`))
    }
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('a scene name takes the same rule as save_model: a-z, 0-9 and -, up to 48', () => {
  const w = world()
  try {
    for (const name of ['a_b', 'A', 'x'.repeat(49), '-a', '../x']) {
      assert.throws(() => materializeScene3d(projectOf(scene({ scene: name })), w.project, { env: w.env }), (e) => e.code === 'scene3d_invalid', name)
    }
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('every message a user can read on export says 3D, never scene (§308); the codes stay', () => {
  const w = world({ main: false, scenes: ['bad', 'empty'] })
  try {
    writeFileSync(join(w.project, 'models', 'scenes', 'bad', 'active.json'), 'not json')
    writeFileSync(join(w.project, 'models', 'scenes', 'empty', 'active.json'), '{"moves":{}}')
    mkdirSync(join(w.project, 'models', 'scenes', 'dir', 'active.json'), { recursive: true })
    const cases = [
      [projectOf(scene({ scene: 'lab' })), w.project, {}, 'scene3d_stage_unavailable', 'A 3D item needs the 3D stage, and this Montaj has none. Update the Montaj app.'],
      [projectOf(scene({ scene: 'lab' })), w.project, { [SCENE3D_STAGE_ENV]: '/x/model3d_scene_stage.jsx' }, 'scene3d_stage_unavailable', 'A 3D item needs the 3D stage, and this Montaj has none. Update the Montaj app.'],
      [projectOf(scene({ scene: 'lab' }, { id: 'ov-1' })), w.project, w.env, 'scene3d_scene_missing', '3D item "ov-1": its 3D "lab" is not saved yet.'],
      [projectOf(scene({}, { id: 'ov-1' })), w.project, w.env, 'scene3d_scene_missing', '3D item "ov-1": the project\'s own 3D is not saved yet.'],
      [projectOf(scene({ scene: 'a_b' }, { id: 'ov-1' })), w.project, w.env, 'scene3d_invalid', '3D item "ov-1": its 3D must be named with lowercase letters, digits and - (got "a_b").'],
      [projectOf(scene({ scene: 'lab' }, { id: undefined })), null, w.env, 'scene3d_invalid', 'A 3D item needs the project\'s folder to find its 3D.'],
      [projectOf(scene({ scene: 'empty' }, { id: 'ov-1' })), w.project, w.env, 'scene3d_invalid', '3D item "ov-1": its 3D "empty" has no model in it.'],
      [projectOf(scene({ scene: 'dir' }, { id: 'ov-1' })), w.project, w.env, 'scene3d_invalid', '3D item "ov-1": its 3D "dir" cannot be read (EISDIR).'],
    ]
    for (const [project, dir, env, code, message] of cases) {
      assert.throws(() => materializeScene3d(project, dir, { env, log: () => {} }), (e) => {
        assert.equal(e.code, code)
        assert.equal(e.message, message)
        return true
      })
    }
    assert.throws(() => materializeScene3d(projectOf(scene({ scene: 'bad' })), w.project, { env: w.env }),
      (e) => e.code === 'scene3d_invalid' && /^3D item "s1": its 3D "bad" cannot be read \(/.test(e.message) && !/scene/i.test(e.message))
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('a missing stage is named in the log, never in the message', () => {
  const w = world({ scenes: ['lab'] })
  try {
    const lines = []
    const missing = '/x/model3d_scene_stage.jsx'
    assert.throws(() => materializeScene3d(projectOf(scene({ scene: 'lab' })), w.project, { env: { [SCENE3D_STAGE_ENV]: missing }, log: (l) => lines.push(l) }),
      (e) => e.code === 'scene3d_stage_unavailable' && !e.message.includes(missing) && !/scene/i.test(e.message))
    assert.equal(lines.length, 1)
    assert.ok(lines[0].includes(missing) && lines[0].includes(SCENE3D_STAGE_ENV), lines[0])
    lines.length = 0
    assert.throws(() => materializeScene3d(projectOf(scene({ scene: 'lab' })), w.project, { env: {}, log: (l) => lines.push(l) }), (e) => e.code === 'scene3d_stage_unavailable')
    assert.match(lines[0], /is not set/)
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

// §377: an overlay that draws a 3D stage averages its motion blur in its page. Two kinds: a scene item, and the
// per-project stage an older project placed as a plain overlay, a generated bundle that starts with this header.
const STAGE_HEAD = `${STAGE_BUNDLE_HEAD} from library/model3d/stage-overlay.jsx and the modules it imports. Do not edit;\n`
  + '// run `npm --prefix library run build:model3d`. The 3D stage overlay; reads ../models/active.json.\n'

function stageFiles() {
  const w = world({ scenes: ['lab'] })
  const overlays = join(w.project, 'overlays')
  mkdirSync(overlays, { recursive: true })
  const legacy = join(overlays, 'model3d_land_stage.jsx')
  writeFileSync(legacy, STAGE_HEAD + 'export default function S(){return null}\n' + 'x'.repeat(4096))
  const plain = join(overlays, 'title.jsx')
  writeFileSync(plain, '// a title card\nexport default function T(){return null}\n')
  // The header further down than the first line is not a stage.
  const quoted = join(overlays, 'quoted.jsx')
  writeFileSync(quoted, '// see below\n' + STAGE_HEAD)
  return { ...w, legacy, plain, quoted, missing: join(overlays, 'gone.jsx') }
}

test('isThreeStageOverlay: a scene item, before and after it is materialized, and a generated stage overlay', () => {
  const w = stageFiles()
  try {
    const item = scene({ scene: 'lab', inPoint: 0 })
    assert.equal(isThreeStageOverlay(item, undefined, { env: w.env }), true, 'engine:scene3d itself')
    const p = projectOf(item)
    materializeScene3d(p, w.project, { env: w.env })
    assert.equal(isThreeStageOverlay(p.tracks[0][0], p.tracks[0][0].src, { env: w.env }), true, 'materialized: its source is the host stage')
    assert.equal(isThreeStageOverlay({ ...p.tracks[0][0] }, w.stageFile, { env: w.env }), true, 'a copy of it too (no identity needed)')
    const legacy = { id: 'land', type: 'overlay', src: w.legacy, start: 0, end: 2 }
    assert.equal(isThreeStageOverlay(legacy, w.legacy, { env: {} }), true, 'an older project\'s own stage overlay')
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('isThreeStageOverlay: a plain overlay, a missing or unreadable file, and a header off the first line are not 3D', () => {
  const w = stageFiles()
  try {
    const at = (path) => isThreeStageOverlay({ id: 'x', type: 'overlay', src: path, start: 0, end: 1 }, path, { env: w.env })
    assert.equal(at(w.plain), false)
    assert.equal(at(w.missing), false, 'missing')
    assert.equal(at(w.project), false, 'a folder cannot be read as a file')
    assert.equal(at(w.quoted), false)
    assert.equal(isThreeStageOverlay({ type: 'overlay', src: 'x' }, '', { env: w.env }), false)
    // Only the head is read.
    let asked = 0
    isThreeStageOverlay({ type: 'overlay' }, w.legacy, { env: {}, head: (_, n) => { asked = n; return STAGE_HEAD } })
    assert.ok(asked > 0 && asked <= 512, `reads ${asked} bytes`)
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('collectPuppeteerSegments: a 3D stage spec carries scene3d: true, any other has no such key', () => {
  const w = stageFiles()
  const before = process.env[SCENE3D_STAGE_ENV]
  process.env[SCENE3D_STAGE_ENV] = w.stageFile
  try {
    const p = {
      settings: { resolution: [1080, 1920], fps: 30 },
      tracks: [[
        scene({ scene: 'lab', inPoint: 0 }, { id: 'scene', start: 0, end: 1 }),
        { id: 'land', type: 'overlay', src: w.legacy, start: 1, end: 2 },
        { id: 'title', type: 'overlay', src: w.plain, start: 2, end: 3 },
        { id: 'gone', type: 'overlay', src: w.missing, start: 3, end: 4 },
      ]],
    }
    materializeScene3d(p, w.project)
    const specs = collectPuppeteerSegments(p, 30, 1080, 1920, join(w.dir, 'seg'))
    const byId = Object.fromEntries(specs.map(s => [s.id.split('--')[1], s]))
    assert.equal(byId.scene.scene3d, true)
    assert.equal(byId.land.scene3d, true)
    assert.equal('scene3d' in byId.title, false, 'a plain overlay\'s spec is as it was')
    assert.equal('scene3d' in byId.gone, false)
  } finally {
    if (before === undefined) delete process.env[SCENE3D_STAGE_ENV]
    else process.env[SCENE3D_STAGE_ENV] = before
    rmSync(w.dir, { recursive: true, force: true })
  }
})
