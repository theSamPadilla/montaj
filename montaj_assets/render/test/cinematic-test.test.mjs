// render/test/cinematic-test.test.mjs
//
// 3D36: the path-traced look's 2-frame test (render.js --cinematic-test). Pure checks, no Chrome: which frames it renders
// (the longest cinematic shot's first and middle, in that shot's window), what it multiplies out (only the cinematic
// frames, at the mean of the timed frames, with the faster and slower as the range), and the host's per-frame report
// reaching a listener without ever failing a render.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planCinematicTest, cinematicEstimate } from '../render.js'
import { onCinematicFrame, reportCinematicFrame } from '../scene3d-host.js'

const spec = (id, frameCount, extra = {}) => ({ id, frameCount, cinematic: true, ...extra })

test('the test renders the longest cinematic shot, its first and middle frame', () => {
  const p = planCinematicTest([spec('a', 90), { id: 'captions', frameCount: 900 }, spec('b', 360), spec('c', 30)])
  assert.equal(p.spec.id, 'b')
  assert.equal(p.frames, 480)
  assert.equal(p.shots, 3)
  assert.deepEqual(p.testFrames, [0, 180])
})

test('a shot cut to a window (a time slice) is counted and tested within it', () => {
  const p = planCinematicTest([spec('a', 300, { frameFrom: 100, frameTo: 200 })])
  assert.equal(p.frames, 100)
  assert.deepEqual(p.testFrames, [100, 150])
})

test('a one-frame shot is tested once; no cinematic shot tests nothing', () => {
  assert.deepEqual(planCinematicTest([spec('a', 1)]).testFrames, [0])
  const none = planCinematicTest([{ id: 'x', frameCount: 90 }])
  assert.equal(none.spec, null)
  assert.deepEqual(cinematicEstimate(none, []), { frames: 0, shots: 0, secondsPerFrame: null, seconds: 0, lowerSeconds: 0, upperSeconds: 0, testFrames: [] })
})

test('the estimate is the cinematic frames times the mean test frame, with the faster and slower as its range', () => {
  const e = cinematicEstimate({ frames: 360, shots: 1 }, [{ frame: 0, ms: 18000 }, { frame: 180, ms: 22000 }])
  assert.equal(e.secondsPerFrame, 20)
  assert.equal(e.seconds, 7200)
  assert.equal(e.lowerSeconds, 6480)
  assert.equal(e.upperSeconds, 7920)
  assert.deepEqual(e.testFrames.map((t) => t.frame), [0, 180])
})

test('a test that timed nothing fails rather than guessing', () => {
  assert.throws(() => cinematicEstimate({ frames: 90, shots: 1 }, []), /timed no frame/)
  assert.throws(() => cinematicEstimate({ frames: 90, shots: 1 }, [{ frame: 0, ms: NaN }]), /timed no frame/)
})

test("the host's per-frame report reaches a listener; a frame without a time, or a throwing listener, is harmless", () => {
  const heard = []
  const off = onCinematicFrame((f) => heard.push(f))
  const offBad = onCinematicFrame(() => { throw new Error('listener') })
  reportCinematicFrame('s1', { frame: 4, ms: 1234 })
  reportCinematicFrame('s1', undefined)
  reportCinematicFrame('s1', { frame: 5 })
  off(); offBad()
  reportCinematicFrame('s1', { frame: 6, ms: 1 })
  assert.deepEqual(heard, [{ id: 's1', frame: 4, ms: 1234 }])
})
