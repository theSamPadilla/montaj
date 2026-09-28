import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveMotionBlur, subframeTimes, motionBlurFilter } from '../motion-blur.js'

test('absent or 1 means off', () => {
  assert.equal(resolveMotionBlur(undefined), 1)
  assert.equal(resolveMotionBlur(1), 1)
})
test('accepts integers 2..8', () => {
  assert.equal(resolveMotionBlur(3), 3)
  assert.equal(resolveMotionBlur(8), 8)
})
test('rejects out-of-range or non-integer values', () => {
  for (const bad of [0, 9, 2.5, '3', -1]) assert.throws(() => resolveMotionBlur(bad), /motionBlur/)
})
test('sub-frame times split one frame evenly, starting on the frame', () => {
  assert.deepEqual(subframeTimes(10, 1), [10])
  assert.deepEqual(subframeTimes(10, 4), [10, 10.25, 10.5, 10.75])
})
test('filter averages each group of N and keeps one frame per group', () => {
  assert.equal(motionBlurFilter(1), null)
  assert.equal(motionBlurFilter(3), "tmix=frames=3,select='eq(mod(n\\,3)\\,2)',setpts=PTS-STARTPTS")
})
