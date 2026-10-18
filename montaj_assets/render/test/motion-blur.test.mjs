import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveMotionBlur, subframeTimes, motionBlurFilter, shutterTimes, cameraCutFrames, shutterOf, frameTimes } from '../motion-blur.js'

test('absent, 0 or 1 means off (a project saved with 0 renders, unblurred)', () => {
  assert.equal(resolveMotionBlur(undefined), 1)
  assert.equal(resolveMotionBlur(null), 1)
  assert.equal(resolveMotionBlur(0), 1)
  assert.equal(resolveMotionBlur(1), 1)
})
test('accepts integers 2..8', () => {
  assert.equal(resolveMotionBlur(3), 3)
  assert.equal(resolveMotionBlur(8), 8)
})
test('rejects out-of-range or non-integer values', () => {
  for (const bad of [9, 2.5, '3', -1, '0', NaN]) assert.throws(() => resolveMotionBlur(bad), /motionBlur must be an integer from 0 to 8 \(0 or 1 is off\)/)
})
test('sub-frame times split one frame evenly, starting on the frame', () => {
  assert.deepEqual(subframeTimes(10, 1), [10])
  assert.deepEqual(subframeTimes(10, 4), [10, 10.25, 10.5, 10.75])
})
// §390: a 3D overlay's shutter.
const near = (got, want) => { assert.equal(got.length, want.length); got.forEach((x, i) => assert.ok(Math.abs(x - want[i]) < 1e-12, `${got} vs ${want}`)) }
test('the 3D shutter is centred on the frame and half a frame long: 5 samples from f - 0.2 to f + 0.2', () => {
  near(shutterTimes(10, 5), [9.8, 9.9, 10, 10.1, 10.2])
  near(shutterTimes(10, 4), [9.8125, 9.9375, 10.0625, 10.1875])
  assert.deepEqual(shutterTimes(10, 1), [10])
})
test('the 3D shutter never starts before frame 0, the item start', () => {
  near(shutterTimes(0, 5), [0.025, 0.075, 0.125, 0.175, 0.225])
})
test('a camera cut narrows the window to the shot the frame is in: no sub-frame on the far side', () => {
  // A cut at 10.1: frame 10 keeps [9.75, 10.1), frame 11 is the new shot and never reaches back before it.
  near(shutterTimes(10, 5, [10.1]), [9.785, 9.855, 9.925, 9.995, 10.065])
  near(shutterTimes(11, 5, [10.1]), [10.8, 10.9, 11, 11.1, 11.2])
  // A cut exactly on a frame starts that frame's shot: every sample at or after it.
  near(shutterTimes(12, 5, [12]), [12.025, 12.075, 12.125, 12.175, 12.225])
  near(shutterTimes(11, 5, [12]), [10.8, 10.9, 11, 11.1, 11.2])
  // Only the cuts either side matter, and a later one never narrows an earlier frame.
  near(shutterTimes(20, 5, [3, 19.9, 20.2, 40]), [19.93, 19.99, 20.05, 20.11, 20.17])
  for (const t of shutterTimes(20, 5, [19.9, 20.2])) assert.ok(t > 19.9 && t < 20.2)
})
test('cameraCutFrames: finite, ascending, and a cut a rounding error off a whole frame snapped onto it', () => {
  assert.deepEqual(cameraCutFrames([30.000000001, 12.5, NaN, null, 6.999999999, Infinity]), [7, 12.5, 30])
  assert.deepEqual(cameraCutFrames(null), [])
  assert.deepEqual(cameraCutFrames(undefined), [])
})
test('shutterOf: 3D overlays take the centred shutter, everything else the trailing one; a job may name its own', () => {
  assert.equal(shutterOf({ scene3d: true }), 'centred')
  assert.equal(shutterOf({}), 'trailing')
  assert.equal(shutterOf({ scene3d: false, shutter: 'centred' }), 'centred')
  near(frameTimes({ subframes: 5, scene3d: true }, 10, [10.1]), shutterTimes(10, 5, [10.1]))
  assert.deepEqual(frameTimes({ subframes: 4 }, 10, [10.1]), subframeTimes(10, 4))
  assert.deepEqual(frameTimes({ scene3d: true }, 10), [10])
})
test('filter averages each group of N and keeps one frame per group', () => {
  assert.equal(motionBlurFilter(1), null)
  assert.equal(motionBlurFilter(3), "tmix=frames=3,select='eq(mod(n\\,3)\\,2)',setpts=PTS-STARTPTS")
})
test('alpha capture averages premultiplied colour', () => {
  assert.equal(motionBlurFilter(1, { alpha: true }), null)
  assert.equal(motionBlurFilter(3, { alpha: false }), motionBlurFilter(3))
  assert.equal(
    motionBlurFilter(3, { alpha: true }),
    "premultiply=inplace=1,tmix=frames=3,unpremultiply=inplace=1,select='eq(mod(n\\,3)\\,2)',setpts=PTS-STARTPTS",
  )
})
