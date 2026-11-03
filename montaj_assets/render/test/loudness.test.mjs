import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loudnessFilter, masterGainDb } from '../mix-audio.js'

test('no target means no filter', () => {
  assert.equal(loudnessFilter('[amid2]', undefined), null)
})
test('§697 a target appends ONE static gain, a -1.5 dBFS limiter that never auto-levels, and resamples to 48kHz', () => {
  // The export levels by a static master gain (target - I, measured once on
  // the speech or the whole mix), as the preview does, never a dynamic
  // loudnorm: a fader is heard as set. The limiter matches the preview's
  // master bus (-1.5 dBFS, fast attack, 100 ms release); level=disabled keeps
  // alimiter from re-levelling its output, latency=1 keeps the sound on the picture.
  assert.deepEqual(loudnessFilter('[amid2]', -14, 12.7), {
    part: '[amid2]volume=12.7dB,alimiter=limit=0.841395:attack=1:release=100:level=disabled:latency=1,aresample=48000[aloud]',
    label: '[aloud]',
  })
  assert.doesNotMatch(loudnessFilter('[a]', -14, 0).part, /loudnorm/)
})
test('§697 no gain given is 0 dB; a non-finite gain is 0 dB', () => {
  assert.match(loudnessFilter('[a]', -14).part, /^\[a\]volume=0dB,alimiter=/)
  assert.match(loudnessFilter('[a]', -14, NaN).part, /^\[a\]volume=0dB,alimiter=/)
})
test('§697 masterGainDb is target - I, clamped to -30..+30 as the preview clamps it, 0 when silent or unknown', () => {
  assert.equal(masterGainDb(-14, -26.7), 12.7)
  assert.equal(masterGainDb(-14, -8), -6)
  assert.equal(masterGainDb(-14, -60), 30)
  assert.equal(masterGainDb(-14, 20), -30)
  assert.equal(masterGainDb(-14, -Infinity), 0)
  assert.equal(masterGainDb(-14, -75), 0)
  assert.equal(masterGainDb(-14, null), 0)
  assert.equal(masterGainDb(null, -20), 0)
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
