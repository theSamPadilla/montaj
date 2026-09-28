import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loudnessFilter } from '../mix-audio.js'

test('no target means no filter', () => {
  assert.equal(loudnessFilter('[amid2]', undefined), null)
})
test('a target appends loudnorm with a -1 dBTP ceiling', () => {
  assert.deepEqual(loudnessFilter('[amid2]', -14), {
    part: '[amid2]loudnorm=I=-14:TP=-1:LRA=11[aloud]',
    label: '[aloud]',
  })
})
test('rejects targets outside -30..-5 LUFS', () => {
  assert.throws(() => loudnessFilter('[a]', -40), /loudness/)
  assert.throws(() => loudnessFilter('[a]', 0), /loudness/)
})
