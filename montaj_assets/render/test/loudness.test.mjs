import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loudnessFilter } from '../mix-audio.js'

test('no target means no filter', () => {
  assert.equal(loudnessFilter('[amid2]', undefined), null)
})
test('a target appends loudnorm with a -1 dBTP ceiling and resamples back to 48kHz', () => {
  // loudnorm resamples internally to 192kHz for true-peak limiting; without an
  // explicit aresample back down, the AAC encode downstream inherits that rate
  // and the deliverable comes out at 96kHz instead of the pipeline's 48kHz.
  assert.deepEqual(loudnessFilter('[amid2]', -14), {
    part: '[amid2]loudnorm=I=-14:TP=-1:LRA=11,aresample=48000[aloud]',
    label: '[aloud]',
  })
})
test('rejects targets outside -30..-5 LUFS', () => {
  assert.throws(() => loudnessFilter('[a]', -40), /loudness/)
  assert.throws(() => loudnessFilter('[a]', 0), /loudness/)
})
test('rejects NaN', () => {
  // typeof NaN === 'number', so the old `typeof lufs !== 'number'` check let a
  // NaN settings.loudness straight through — `NaN < -30` and `NaN > -5` are
  // both false, so the range check never fired either, and loudnorm would have
  // received a literal `I=NaN`. !Number.isFinite(lufs) catches it.
  assert.throws(() => loudnessFilter('[a]', NaN), /loudness/)
})
test('rejects Infinity', () => {
  assert.throws(() => loudnessFilter('[a]', Infinity), /loudness/)
  assert.throws(() => loudnessFilter('[a]', -Infinity), /loudness/)
})

// ── silence detection for the loudnorm pre-pass ────────────────────────────
import { parseLoudnormInputI, isSilentInputI } from '../mix-audio.js'

test('parseLoudnormInputI reads input_i from the loudnorm JSON block, -inf included', () => {
  const block = (v) => `noise\n[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "${v}",\n\t"input_tp" : "-inf"\n}\n`
  assert.equal(parseLoudnormInputI(block('-23.54')), -23.54)
  assert.equal(parseLoudnormInputI(block('-inf')), -Infinity)
  assert.equal(parseLoudnormInputI('no json here'), null)
})
test('isSilentInputI: -inf and anything at or under the -70 LUFS gate is silent; unknown is not', () => {
  assert.equal(isSilentInputI(-Infinity), true)
  assert.equal(isSilentInputI(-70), true)
  assert.equal(isSilentInputI(-69.9), false)
  assert.equal(isSilentInputI(-14), false)
  assert.equal(isSilentInputI(null), false)
})
