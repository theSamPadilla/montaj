// montaj_assets/render/test/scene3d.test.mjs (§239)
//
// A scene item is an overlay whose src is `engine:scene3d`. materializeScene3d rewrites it, in place, into the plain
// overlay of the host's stage with the scene's file and the in point as props; every other part of the render then
// sees an ordinary overlay. Pure, so these tests use a temp project folder and an injected environment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { SCENE3D_SRC, SCENE3D_STAGE_ENV, Scene3dError, isScene3dItem, materializeScene3d, isThreeStageOverlay, STAGE_BUNDLE_HEAD, cloneSharingSceneText, PIECES_HEAD, stageTakesPieces, sceneBakeKey, bakeFileOf, overlayBakeScene } from '../scene3d.js'
import { keyFields, cacheKey } from '../segment-cache.js'
import { buildFrameCacheKey } from '../sample-frame.js'
import { createHash } from 'node:crypto'
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
    for (const timeMap of [[], [[0, 0]], [[1, 0, 2]], [[0, 0, 0]], [[0, 0, 2], [1, 3, 1]], 'x']) refuses(projectOf(scene({ scene: 'hands', timeMap })), w.project, w.env, 'scene3d_invalid', /timeMap/)
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

test('a well-formed timeMap passes through to the stage untouched', () => {
  const w = world({ scenes: ['hands'] })
  try {
    const timeMap = [[0, 0, 1.04], [1.04, 1.76, 0.74]]
    const p = projectOf(scene({ scene: 'hands', inPoint: 0, timeMap }))
    materializeScene3d(p, w.project, { env: w.env })
    assert.deepEqual(p.tracks[0][0].props.timeMap, timeMap)
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

// 3D5: a scene by reference (the Montaj app's library/model3d/store.js format) inlines to what an inline scene gives.
const MID = '0123456789abcdef', MID2 = 'fedcba9876543210', TID = 'aaaaaaaaaaaaaaaa', TID2 = 'bbbbbbbbbbbbbbbb', KEY = 'k1_pool'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), JPG = Buffer.from([0xff, 0xd8, 0xff, 9, 8])
const MESH = { v: 1, count: 3, position: 'AAAA' }, MESH2 = { v: 1, count: 6, position: 'BBBB' }
const POOL = { moves: { wave: { duration: 1 } } }
const refModel = { name: 'm', meshRefs: [MID], textureRefs: [TID, TID2], parts: [{ mesh: MID }] }
const refScene = { duration: 2, props: [{ model: { meshRefs: [MID2], textureRefs: [TID] } }] }
const inlineOf = () => ({
  slug: 'hands',
  model: { name: 'm', meshes: { [MID]: MESH }, textures: { [TID]: `data:image/png;base64,${PNG.toString('base64')}`, [TID2]: `data:image/jpeg;base64,${JPG.toString('base64')}` }, parts: [{ mesh: MID }] },
  moves: POOL,
  scene: { duration: 2, props: [{ model: { meshes: { [MID2]: MESH2 }, textures: { [TID]: `data:image/png;base64,${PNG.toString('base64')}` } } }] },
})
function refWorld(names = ['hands']) {
  const w = world({ main: false })
  const store = join(w.project, 'models', '_store')
  for (const d of ['meshes', 'textures', 'moves']) mkdirSync(join(store, d), { recursive: true })
  writeFileSync(join(store, 'meshes', `${MID}.json`), JSON.stringify(MESH))
  writeFileSync(join(store, 'meshes', `${MID2}.json`), JSON.stringify(MESH2))
  writeFileSync(join(store, 'textures', `${TID}.png`), PNG)
  writeFileSync(join(store, 'textures', `${TID2}.jpg`), JPG)
  writeFileSync(join(store, 'moves', `${KEY}.json`), JSON.stringify(POOL))
  for (const n of names) {
    mkdirSync(join(w.project, 'models', 'scenes', n), { recursive: true })
    writeFileSync(join(w.project, 'models', 'scenes', n, 'active.json'), JSON.stringify({
      byRef: { v: 1, slug: 'hands', store: '../../_store', moves: KEY, model: refModel, scene: refScene },
      model: { name: 'card' }, moves: { moves: {} }, scene: { duration: 2 },
    }))
  }
  return w
}
const sceneOf = (name, w, opts = {}) => { const p = projectOf(scene({ scene: name })); materializeScene3d(p, w.project, { env: w.env, ...opts }); return p.tracks[0][0].props.sceneJson }

test('a scene by reference inlines to the text an inline scene of the same content gives, textures as data URIs of the right type', () => {
  const w = refWorld()
  try {
    assert.equal(sceneOf('hands', w), JSON.stringify(inlineOf()))
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('a texture two scene items share is read once', () => {
  const w = refWorld(['hands', 'feet'])
  try {
    const reads = []
    const p = projectOf(scene({ scene: 'hands' }), scene({ scene: 'feet' }, { id: 's2' }))
    materializeScene3d(p, w.project, { env: w.env, readBytes: (f) => { reads.push(f); return readFileSync(f) } })
    assert.equal(reads.filter((f) => f.endsWith(`${TID}.png`)).length, 1)
    assert.equal(p.tracks[0][1].props.sceneJson, JSON.stringify(inlineOf()))
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('a scene materialized again unchanged is not inlined again (render.js loads its project twice); a changed one is', () => {
  const w = refWorld()
  try {
    const reads = []
    const readBytes = (f) => { reads.push(f); return readFileSync(f) }
    const first = sceneOf('hands', w, { readBytes })
    const once = reads.length
    assert.ok(once > 0)
    assert.equal(sceneOf('hands', w, { readBytes }), first)
    assert.equal(reads.length, once, 'the store is not read again')
    const f = join(w.project, 'models', 'scenes', 'hands', 'active.json')
    const j = JSON.parse(readFileSync(f, 'utf8')); j.byRef.slug = 'hands-2'; writeFileSync(f, JSON.stringify(j))
    assert.equal(JSON.parse(sceneOf('hands', w, { readBytes })).slug, 'hands-2')
    assert.ok(reads.length > once, 'a changed scene is read again')
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('cloneSharingSceneText copies the project, its scene text included, and leaves the original whole', () => {
  const w = refWorld(['hands', 'feet'])
  try {
    const p = { tracks: [{ id: 'trk-0', items: [scene({ scene: 'hands' })] }, [scene({ scene: 'feet' }, { id: 's2' }), { id: 'o', type: 'overlay', src: '/x.jsx', props: { a: [1] } }]] }
    materializeScene3d(p, w.project, { env: w.env })
    const before = JSON.stringify(p)
    const copy = cloneSharingSceneText(p)
    assert.equal(JSON.stringify(p), before)
    assert.equal(JSON.stringify(copy), before)
    copy.tracks[1][1].props.a.push(2)
    copy.tracks[0].items[0].props.sceneJson = 'x'
    assert.equal(JSON.stringify(p), before, 'the copy is its own')
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('a missing mesh, texture or move pool fails in words, with no path', () => {
  for (const [file, what] of [[`meshes/${MID}.json`, `mesh ${MID}`], [`textures/${TID2}.jpg`, `texture ${TID2}`], [`moves/${KEY}.json`, `move pool ${KEY}`]]) {
    const w = refWorld()
    try {
      rmSync(join(w.project, 'models', '_store', file))
      assert.throws(() => sceneOf('hands', w), (e) => e instanceof Scene3dError && e.code === 'scene3d_invalid' &&
        e.message === `3D item "s1": its 3D "hands" is missing part of its 3D (${what}). Open the project in Montaj and save that 3D again.` && !e.message.includes(w.dir))
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  }
})

test('a store folder other than the project\'s models/_store is refused', () => {
  for (const store of ['../../../..', '../../..', '/etc', '../..', '', '../../scenes', '..', '../../_store/meshes']) {
    const w = refWorld()
    try {
      const f = join(w.project, 'models', 'scenes', 'hands', 'active.json')
      const j = JSON.parse(readFileSync(f, 'utf8')); j.byRef.store = store; writeFileSync(f, JSON.stringify(j))
      assert.throws(() => sceneOf('hands', w), (e) => e instanceof Scene3dError && e.code === 'scene3d_invalid' && /outside the project's models\/_store folder/.test(e.message), `store ${JSON.stringify(store)}`)
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  }
})

test('a store folder or piece that is a symlink is refused', () => {
  for (const what of ['store', 'mesh', 'texture', 'moves']) {
    const w = refWorld()
    try {
      const store = join(w.project, 'models', '_store')
      const elsewhere = join(w.dir, 'elsewhere')
      cpSync(store, elsewhere, { recursive: true })
      if (what === 'store') { rmSync(store, { recursive: true }); symlinkSync(elsewhere, store) }
      else {
        const rel = { mesh: `meshes/${MID}.json`, texture: `textures/${TID}.png`, moves: `moves/${KEY}.json` }[what]
        rmSync(join(store, rel)); symlinkSync(join(elsewhere, rel), join(store, rel))
      }
      assert.throws(() => sceneOf('hands', w), (e) => e instanceof Scene3dError && e.code === 'scene3d_invalid' && !e.message.includes(w.dir), what)
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  }
})

test('an inline scene is unchanged by the by-reference path, and a by-reference one with no model is still "no model"', () => {
  const w = world({ scenes: ['hands'] })
  try {
    assert.equal(sceneOf('hands', w), SCENE_JSON)
    writeFileSync(join(w.project, 'models', 'scenes', 'hands', 'active.json'), JSON.stringify({ byRef: { v: 1, slug: 'hands', store: '../../_store', moves: KEY } }))
    assert.throws(() => sceneOf('hands', w), (e) => e instanceof Scene3dError && e.code === 'scene3d_invalid')
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

// §773: 100 cast entries of one tree carried its meshes and textures 100 times (sample_too_large). For a stage that fills a
// packed scene, each piece goes once under `pieces`, the refs left in place.
const fillPieces = (v, P) => {
  if (Array.isArray(v)) return v.map((x) => fillPieces(x, P))
  if (!v || typeof v !== 'object') return v
  const o = {}
  for (const [k, x] of Object.entries(v)) {
    if (k === 'meshRefs') { o.meshes = {}; for (const id of x) o.meshes[id] = P.meshes[id] }
    else if (k === 'textureRefs') { o.textures = {}; for (const id of x) o.textures[id] = P.textures[id] }
    else o[k] = fillPieces(x, P)
  }
  return o
}
const unpack = (text) => { const { pieces, ...r } = JSON.parse(text); return { ...r, model: fillPieces(r.model, pieces), ...(r.scene !== undefined ? { scene: fillPieces(r.scene, pieces) } : {}) } }

test('§773: a by-reference scene packed: pieces first, each piece once, and filling it back gives the inline text exactly', () => {
  const w = refWorld()
  try {
    const text = sceneOf('hands', w, { pieces: true })
    assert.ok(text.startsWith(PIECES_HEAD), text.slice(0, 30))
    const d = JSON.parse(text)
    assert.deepEqual(Object.keys(d.pieces.meshes).sort(), [MID, MID2].sort())
    assert.deepEqual(Object.keys(d.pieces.textures).sort(), [TID, TID2].sort())
    assert.deepEqual(d.model.meshRefs, [MID])
    assert.equal(JSON.stringify(unpack(text)), JSON.stringify(inlineOf()))
    assert.equal(sceneOf('hands', w, { pieces: false }), JSON.stringify(inlineOf()), 'a stage that cannot fill it gets the inline text')
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('§773: 100 cast entries of one model carry its meshes and textures once', () => {
  const w = refWorld()
  try {
    const f = join(w.project, 'models', 'scenes', 'hands', 'active.json'), j = JSON.parse(readFileSync(f, 'utf8'))
    j.byRef.scene = { duration: 2, cast: Array.from({ length: 100 }, (_, i) => ({ model: { ...refModel }, at: [i, 0, 0] })) }
    writeFileSync(f, JSON.stringify(j))
    const inline = sceneOf('hands', w, { pieces: false }), packed = sceneOf('hands', w, { pieces: true })
    const mesh = JSON.stringify(MESH).length
    assert.ok(inline.split(JSON.stringify(MESH)).length - 1 === 101, 'inline: the model and its 100 entries each hold the mesh')
    assert.equal(packed.split(JSON.stringify(MESH)).length - 1, 1, 'packed: once')
    assert.ok(packed.length < inline.length - 99 * mesh, `${packed.length} vs ${inline.length}`)
    assert.equal(JSON.stringify(unpack(packed)), inline)
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('§773: an inline scene is packed only when a piece repeats in it, and filling it back gives it exactly', () => {
  const w = world({ main: false, scenes: ['one', 'two'] })
  try {
    const once = inlineOf(); once.scene = { duration: 2 } // inlineOf's prop shares texture TID with the model: drop it
    writeFileSync(join(w.project, 'models', 'scenes', 'one', 'active.json'), JSON.stringify(once))
    assert.equal(sceneOf('one', w, { pieces: true }), JSON.stringify(once), 'nothing repeats: the file text as it is')
    const twice = inlineOf(); twice.scene.cast = [{ model: structuredClone(twice.model) }, { model: structuredClone(twice.model) }]
    writeFileSync(join(w.project, 'models', 'scenes', 'two', 'active.json'), JSON.stringify(twice))
    const text = sceneOf('two', w, { pieces: true })
    assert.ok(text.startsWith(PIECES_HEAD))
    assert.equal(JSON.stringify(unpack(text)), JSON.stringify(twice))
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('§773 stageTakesPieces: "SCENE_PIECES v1" in the stage header\'s first three lines; elsewhere, none or no file is no; materialize asks it', () => {
  const w = refWorld()
  try {
    const head = (l2, more = '') => `// GENERATED by x. Do not edit;\n// run it. ${l2}\n// notices\n// ENGINE_VERSION 46\n${more}export default () => null\n`
    writeFileSync(w.stageFile, head('The stage. SCENE_PIECES v1: a sceneJson may give its meshes once.'))
    assert.equal(stageTakesPieces(w.stageFile), true)
    assert.ok(sceneOf('hands', w).startsWith(PIECES_HEAD), 'the default asks the stage')
    const other = join(w.dir, 'engine', 'old.jsx')
    writeFileSync(other, head('The stage.', '// SCENE_PIECES v1\n'))
    assert.equal(stageTakesPieces(other), false, 'past the header is not the header')
    assert.equal(stageTakesPieces(join(w.dir, 'engine', 'gone.jsx')), false)
    const p = projectOf(scene({ scene: 'hands' })); materializeScene3d(p, w.project, { env: { [SCENE3D_STAGE_ENV]: other } })
    assert.equal(p.tracks[0][0].props.sceneJson, JSON.stringify(inlineOf()), 'an older stage gets the inline text')
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

// 3D39: a scene's physics bake, bake/<key>.mjbk beside its file (key: the first 32 hex of the sha256 of the file's bytes).
const BAKE = Buffer.from('MJBK\x02\x00\x00\x00bake bytes \xff\x00\x01', 'latin1')
const writeBake = (file, bytes = BAKE, key = sceneBakeKey(readFileSync(file, 'utf8'))) => {
  mkdirSync(join(dirname(file), 'bake'), { recursive: true })
  writeFileSync(bakeFileOf(file, key), bytes)
  return key
}
const propsOf = (w, name, opts = {}) => {
  const p = projectOf(scene(name === undefined ? {} : { scene: name }))
  materializeScene3d(p, w.project, { env: w.env, ...opts })
  return p.tracks[0][0].props
}
// The segment cache's key for a 3D chunk of the stage with these props (segment-cache.js keyFields, cacheKey).
const chunkKey = (w, props) => {
  const htmlPath = join(w.dir, 'index.html')
  writeFileSync(htmlPath, '<html></html>')
  writeFileSync(join(w.dir, 'bundle.js'), '')
  return cacheKey(keyFields({ props, htmlPath, componentPath: w.stageFile, fps: 30, width: 1080, height: 1920, scene3d: true, frameStart: 0, frameEnd: 10 }, { engine: 'e', context: {}, env: w.env }))
}

test('3D39: the scene file\'s bake rides as props.physicsBake (base64 of its bytes); none, or one for another key, adds nothing', () => {
  const w = world({ scenes: ['hands'] })
  try {
    const file = join(w.project, 'models', 'scenes', 'hands', 'active.json')
    assert.equal(sceneBakeKey(SCENE_JSON), createHash('sha256').update(Buffer.from(SCENE_JSON)).digest('hex').slice(0, 32))
    assert.equal('physicsBake' in propsOf(w, 'hands'), false, 'no bake: keyed motion, no prop')
    writeBake(file, BAKE, 'f'.repeat(32))
    assert.equal('physicsBake' in propsOf(w, 'hands'), false, 'a bake for another version of the scene is not this one\'s')
    writeBake(file)
    const props = propsOf(w, 'hands')
    assert.equal(props.physicsBake, BAKE.toString('base64'))
    assert.deepEqual(Buffer.from(props.physicsBake, 'base64'), BAKE)
    assert.equal(props.sceneJson, SCENE_JSON, 'the scene text is unchanged')
    // the project's own scene: models/bake/ beside models/active.json
    writeBake(join(w.project, 'models', 'active.json'), Buffer.from('MJBK own'))
    assert.equal(Buffer.from(propsOf(w).physicsBake, 'base64').toString(), 'MJBK own')
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('3D39: a physicsBake the item already carried is dropped: the bake is always the file\'s', () => {
  const w = world()
  try {
    const p = projectOf(scene({ physicsBake: 'c3RhbGU=' }))
    materializeScene3d(p, w.project, { env: w.env })
    assert.equal('physicsBake' in p.tracks[0][0].props, false)
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('3D39: a bake that lands after the scene was read is picked up on the next pass; an edited scene leaves its old bake behind', () => {
  const w = refWorld()
  try {
    const file = join(w.project, 'models', 'scenes', 'hands', 'active.json')
    assert.equal('physicsBake' in propsOf(w, 'hands'), false)
    writeBake(file) // the scene text is cached now (sceneTexts): its key must be too
    assert.equal(propsOf(w, 'hands').physicsBake, BAKE.toString('base64'))
    // the key is the file's own bytes, not the inlined text handed to the stage
    assert.notEqual(sceneBakeKey(propsOf(w, 'hands').sceneJson), sceneBakeKey(readFileSync(file, 'utf8')))
    writeBake(file, Buffer.from('MJBK rebaked'))
    assert.equal(Buffer.from(propsOf(w, 'hands').physicsBake, 'base64').toString(), 'MJBK rebaked', 'a bake rewritten in place is read again')
    const j = JSON.parse(readFileSync(file, 'utf8')); j.byRef.slug = 'hands-2'; writeFileSync(file, JSON.stringify(j))
    assert.equal('physicsBake' in propsOf(w, 'hands'), false, 'the edited scene has no bake yet')
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('3D39: a bake or bake folder that is a link is not read', () => {
  const w = world({ scenes: ['hands', 'feet'] })
  try {
    const hands = join(w.project, 'models', 'scenes', 'hands', 'active.json')
    const outside = join(w.dir, 'outside.mjbk'); writeFileSync(outside, BAKE)
    mkdirSync(join(dirname(hands), 'bake'))
    symlinkSync(outside, bakeFileOf(hands, sceneBakeKey(SCENE_JSON)))
    const logs = []
    assert.equal('physicsBake' in propsOf(w, 'hands', { log: (l) => logs.push(l) }), false)
    assert.match(logs.join('\n'), /is a link/)
    const feet = join(w.project, 'models', 'scenes', 'feet', 'active.json')
    const dir = join(w.dir, 'bakes'); mkdirSync(dir); writeFileSync(join(dir, `${sceneBakeKey(SCENE_JSON)}.mjbk`), BAKE)
    symlinkSync(dir, join(dirname(feet), 'bake'))
    assert.equal('physicsBake' in propsOf(w, 'feet', { log: () => {} }), false)
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('3D39: the segment cache keys on the bake: a new or changed bake re-renders, the same bake and an untouched scene reuse', () => {
  const w = world({ scenes: ['hands', 'feet'] })
  try {
    const hands = join(w.project, 'models', 'scenes', 'hands', 'active.json')
    const feet = join(w.project, 'models', 'scenes', 'feet', 'active.json')
    writeBake(feet)
    const none = chunkKey(w, propsOf(w, 'hands')), feet0 = chunkKey(w, propsOf(w, 'feet'))
    writeBake(hands)
    const baked = chunkKey(w, propsOf(w, 'hands'))
    assert.ok(none && baked && feet0, 'every chunk has a key')
    assert.notEqual(baked, none, 'a bake that lands re-renders')
    assert.equal(chunkKey(w, propsOf(w, 'hands')), baked, 'the same bake reuses')
    assert.equal(chunkKey(w, propsOf(w, 'hands', { read: (f) => readFileSync(f, 'utf8') })), baked, 'read fresh (another process) gives the same key')
    writeBake(hands, Buffer.from('MJBK other physics'))
    assert.notEqual(chunkKey(w, propsOf(w, 'hands')), baked, 'a changed bake re-renders')
    // a camera-only edit of hands (the app copies its bake under the new key) leaves feet's chunks alone
    const cam = JSON.stringify({ model: { name: 'm' }, moves: {}, scene: { camera: { lens: 50 } } })
    writeFileSync(hands, cam); writeBake(hands)
    assert.equal(chunkKey(w, propsOf(w, 'hands')) === baked, false)
    assert.equal(chunkKey(w, propsOf(w, 'feet')), feet0, 'the other scene\'s chunks are reused')
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('3D39: a sampled frame\'s cache key moves with its bakes, and a frame with none keeps the key it had', () => {
  const p = (props) => projectOf({ ...scene({}), src: '/stage.jsx', props: { sceneJson: SCENE_JSON, ...props } })
  const plain = buildFrameCacheKey('/nowhere/project.json', p({}), 1)
  assert.equal(buildFrameCacheKey('/nowhere/project.json', p({ physicsBake: '' }), 1), plain)
  const baked = buildFrameCacheKey('/nowhere/project.json', p({ physicsBake: BAKE.toString('base64') }), 1)
  assert.notEqual(baked, plain, 'a bake that landed after the frame was sampled misses')
  assert.equal(buildFrameCacheKey('/nowhere/project.json', p({ physicsBake: BAKE.toString('base64') }), 1), baked)
  assert.notEqual(buildFrameCacheKey('/nowhere/project.json', p({ physicsBake: Buffer.from('MJBK 2').toString('base64') }), 1), baked)
})

// 3D39 T1.9: the model-3d template's overlay (overlays/model3d_stage.jsx, a generated stage that bundles models/active.json)
// names its scene in its header and takes that scene's bake the same way.
const OVERLAY_HEAD = (marker = 'PHYSICS_BAKE v1 scene=../models/active.json', at = 1) => {
  const lines = [STAGE_BUNDLE_HEAD + ' from library/model3d/stage-overlay.jsx. Do not edit;', '// run the build. The 3D stage overlay; reads ../models/active.json.', '// Third-party code in this bundle: none.', 'import S from"../models/active.json";export default()=>null']
  if (marker) lines[at] += ` ${marker}`
  return lines.join('\n')
}
function overlayWorld(head = OVERLAY_HEAD()) {
  const w = world()
  mkdirSync(join(w.project, 'overlays'), { recursive: true })
  writeFileSync(join(w.project, 'overlays', 'model3d_stage.jsx'), head)
  return { ...w, scene: join(w.project, 'models', 'active.json') }
}
const overlayItem = (props, extra = {}) => ({ id: 'stage', type: 'overlay', src: 'overlays/model3d_stage.jsx', start: 0, end: 4, opaque: true, ...(props === undefined ? {} : { props }), ...extra })
const materialized = (w, item, opts = {}) => { const p = projectOf(item); const n = materializeScene3d(p, w.project, { env: w.env, ...opts }); return { n, item: p.tracks[0][0] } }

test('T1.9: the template overlay takes models/active.json\'s bake as props.physicsBake; it stays a plain overlay and is not counted', () => {
  const w = overlayWorld()
  try {
    assert.equal(overlayBakeScene(join(w.project, 'overlays', 'model3d_stage.jsx')), w.scene)
    let r = materialized(w, overlayItem({ keep: 1 }))
    assert.equal(r.n, 0)
    assert.deepEqual(r.item.props, { keep: 1 }, 'no bake yet: keyed motion, no prop')
    writeBake(w.scene)
    r = materialized(w, overlayItem({ keep: 1 }))
    assert.equal(r.n, 0, 'an overlay is not a scene item')
    assert.equal(r.item.src, 'overlays/model3d_stage.jsx', 'its source is untouched')
    assert.deepEqual(r.item.props, { keep: 1, physicsBake: BAKE.toString('base64') })
    assert.equal(materialized(w, overlayItem(undefined)).item.props.physicsBake, BAKE.toString('base64'), 'an item with no props')
    assert.equal(materialized(w, overlayItem({}, { src: join(w.project, 'overlays', 'model3d_stage.jsx') })).item.props.physicsBake, BAKE.toString('base64'), 'an absolute source')
    // the key is the scene file's bytes: an edited scene has no bake until the app writes one
    writeFileSync(w.scene, JSON.stringify({ model: { name: 'edited' } }))
    assert.equal('physicsBake' in materialized(w, overlayItem({ physicsBake: 'c3RhbGU=' })).item.props, false, 'and a carried one is dropped')
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})

test('T1.9: an overlay without the marker (an older copy, a hand-made overlay) is left exactly as it is', () => {
  for (const head of [OVERLAY_HEAD(null), OVERLAY_HEAD(undefined, 3), 'export default () => null // PHYSICS_BAKE v1 scene=../models/active.json']) {
    const w = overlayWorld(head)
    try {
      writeBake(w.scene)
      const props = { physicsBake: 'Y2FycmllZA==' }
      const r = materialized(w, overlayItem(props))
      assert.equal(r.item.props, props, 'the same props object, untouched')
      assert.equal(overlayBakeScene(join(w.project, 'overlays', 'model3d_stage.jsx')), null)
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  }
})

test('T1.9: a scene outside the project\'s models folder, a linked bake, a missing source or an item not on screen gets no bake', () => {
  const w = overlayWorld(OVERLAY_HEAD('PHYSICS_BAKE v1 scene=../outside.json'))
  try {
    const outside = join(w.project, 'outside.json')
    writeFileSync(outside, SCENE_JSON); writeBake(outside)
    assert.equal('physicsBake' in materialized(w, overlayItem({})).item.props, false, 'outside models/')
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
  const v = overlayWorld()
  try {
    const target = join(v.dir, 'elsewhere.mjbk'); writeFileSync(target, BAKE)
    mkdirSync(join(v.project, 'models', 'bake'))
    symlinkSync(target, bakeFileOf(v.scene, sceneBakeKey(SCENE_JSON)))
    assert.equal('physicsBake' in materialized(v, overlayItem({}), { log: () => {} }).item.props, false, 'a linked bake')
    rmSync(join(v.project, 'models', 'bake'), { recursive: true }); writeBake(v.scene)
    assert.equal(materialized(v, overlayItem({}, { src: 'overlays/missing.jsx' })).item.props.physicsBake, undefined, 'a missing source')
    assert.equal('physicsBake' in materialized(v, overlayItem({}), { only: () => false }).item.props, false, 'off screen (only)')
    assert.equal(materialized(v, overlayItem({}), { only: () => true }).item.props.physicsBake, BAKE.toString('base64'), 'on screen')
  } finally { rmSync(v.dir, { recursive: true, force: true }) }
})

test('T1.9: the overlay\'s chunks re-render when its bake lands or changes and reuse it otherwise', () => {
  const w = overlayWorld()
  try {
    const key = (item) => chunkKey(w, materialized(w, item).item.props)
    const none = key(overlayItem({}))
    writeBake(w.scene)
    const baked = key(overlayItem({}))
    assert.ok(none && baked)
    assert.notEqual(baked, none)
    assert.equal(key(overlayItem({})), baked)
    writeBake(w.scene, Buffer.from('MJBK rebaked'))
    assert.notEqual(key(overlayItem({})), baked)
  } finally { rmSync(w.dir, { recursive: true, force: true }) }
})
