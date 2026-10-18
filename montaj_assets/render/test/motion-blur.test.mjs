import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveMotionBlur, subframeTimes, motionBlurFilter } from '../motion-blur.js'

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
