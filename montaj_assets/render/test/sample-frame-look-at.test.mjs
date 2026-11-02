// §673 fix 3: sample_frame's look_at. A 3D item in the sampled frame is drawn from a close-up camera on one bone,
// by rewriting the scene text the stage reads; the scene file and the saved scene are never touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { materializeScene3d, Scene3dError, SCENE3D_SRC, SCENE3D_STAGE_ENV } from '../scene3d.js'
import { buildFrameCacheKey, sampleFrame, frameErrorCode, SAMPLE_CACHE_VERSION } from '../sample-frame.js'

const scene = { model: { name: 'm' }, cast: [{ model: 'a' }, { model: 'b' }], camera: { lens: 35, location: [[0, [1, 2, 3]]], target: [[0, [0, 0, 0]]] } }
const text = JSON.stringify(scene)
const opts = (extra = {}) => ({ env: { [SCENE3D_STAGE_ENV]: '/stage.jsx' }, exists: () => true, read: () => text, log: () => {}, ...extra })
const project = () => ({ tracks: [[{ type: 'overlay', src: SCENE3D_SRC, start: 0, end: 2, props: { scene: 'hands' } }]] })

test('look_at rewrites the camera to one POV shot on the bone, at the distance, with the lens', () => {
  const p = project()
  const follow = { cast: 1, bone: 'hand_r' }
  materializeScene3d(p, '/p', opts({ closeUp: { follow, distance: 0.4, lens: 85 } }))
  const cam = JSON.parse(p.tracks[0][0].props.sceneJson).camera
  assert.equal(cam.lens, 85)
  assert.equal(cam.location, undefined)
  assert.equal(cam.shots.length, 1)
  const [shot] = cam.shots
  assert.equal(shot.start, 0)
  assert.ok(shot.end > 3600)
  assert.deepEqual(shot.pov.follow, follow)
  assert.equal(shot.pov.look, undefined, 'looks at what it rides')
  assert.equal(shot.pov.frame, 'world')
  assert.ok(Math.abs(Math.hypot(...shot.pov.offset) - 0.4) < 1e-9)
  assert.ok(shot.pov.offset.some((x) => x !== 0))
  assert.ok(Array.isArray(shot.from.at) && Array.isArray(shot.from.look), 'a shot needs its from')
})

test('a part ref is followed as given', () => {
  const p = project()
  materializeScene3d(p, '/p', opts({ closeUp: { follow: { cast: 0, part: 'palm' }, distance: 1, lens: 50 } }))
  assert.deepEqual(JSON.parse(p.tracks[0][0].props.sceneJson).camera.shots[0].pov.follow, { cast: 0, part: 'palm' })
})

test('without look_at the scene text is handed to the stage untouched', () => {
  const p = project()
  materializeScene3d(p, '/p', opts())
  assert.equal(p.tracks[0][0].props.sceneJson, text)
})

test('a cast that is not in the scene is a clear error naming the 3D', () => {
  assert.throws(
    () => materializeScene3d(project(), '/p', opts({ closeUp: { follow: { cast: 2, bone: 'hand_r' }, distance: 0.4, lens: 50 } })),
    (e) => e instanceof Scene3dError && e.code === 'scene3d_invalid' && /cast 2/.test(e.message) && /2 cast/.test(e.message))
})

test('the sample cache key changes with look_at, its distance and its lens, and not without it', () => {
  const proj = { settings: {}, tracks: [[]] }
  const key = (look) => buildFrameCacheKey(null, proj, 1, null, false, SAMPLE_CACHE_VERSION, null, false, look)
  const a = { follow: { cast: 0, bone: 'hand_r' }, distance: 0.4, lens: 50 }
  assert.equal(key(undefined), key(null))
  assert.notEqual(key(a), key(null))
  assert.notEqual(key(a), key({ ...a, distance: 0.5 }))
  assert.notEqual(key(a), key({ ...a, lens: 85 }))
  assert.notEqual(key(a), key({ ...a, follow: { cast: 0, bone: 'hand_l' } }))
  assert.equal(key(a), key({ ...a }))
})

test('a frame with no 3D on screen answers look_at_no_3d', async () => {
  const proj = { settings: { resolution: [180, 320], fps: 10, colorSpace: 'sdr_bt709' }, tracks: [[]], audio: { tracks: [] } }
  await assert.rejects(
    sampleFrame({ projectJson: proj, projectDir: '/p', atSeconds: 1, outPath: '/Users/Shared/c5-lookat-tmp/tmp/x.png', lookAt: { follow: { cast: 0, bone: 'b' }, distance: 0.4, lens: 50 } }),
    (e) => frameErrorCode(e) === 'look_at_no_3d' && /no 3D/.test(e.message))
})
