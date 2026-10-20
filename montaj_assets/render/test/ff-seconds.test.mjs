// §478: ffmpeg refuses a time in exponent notation ("Invalid duration for option ss"), and String() writes one for any
// |x| under 1e-6, such as the residue an overlay baked from a render slice's start leaves (Sam's export failed on
// "-ss 1.4210854715202004e-14" at 78.40 s). Every time argument the render engine builds goes through ffSeconds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ffSeconds } from '../ff-seconds.js'
import { buildOverlayFilterParts, twoStageSeek } from '../encode-segment.js'

const EXPONENT = /\de[-+]?\d/i

test('ffSeconds: a residue under 1e-6 is "0", never exponent notation, so a > 0 guard drops the seek', () => {
  assert.equal(String(78.4 - 78.39999999999999), '1.4210854715202004e-14') // the failing export's -ss
  assert.equal(ffSeconds(78.4 - 78.39999999999999), '0')
  assert.equal(ffSeconds(1e-14), '0')
  assert.equal(ffSeconds(-1.4210854715202004e-14), '0') // a negative residue too, never "-0"
  assert.equal(ffSeconds(9.99e-7), '0')
  assert.equal(ffSeconds(0), '0')
  assert.equal(Number(ffSeconds(1e-14)) > 0, false)
})

test('ffSeconds: from 1e-6 up, a time is written exactly as String() writes it (the encode args stay byte-identical)', () => {
  assert.equal(ffSeconds(1e-6), '0.000001') // the boundary
  assert.equal(ffSeconds(78.4), '78.4')
  assert.equal(ffSeconds(2), '2')
  assert.equal(ffSeconds(-0.5), '-0.5')
  for (const x of [1e-6, 1.5e-6, 5e-5, 0.1, 1 / 3, 137 / 30, 78.4, 82.96666666666667, 4567.891234567]) {
    assert.equal(ffSeconds(x), String(x), String(x))
    assert.doesNotMatch(ffSeconds(x), EXPONENT)
  }
  // a time handed in as a string keeps its digits, unless it is itself in exponent notation
  assert.equal(ffSeconds('4.500'), '4.500')
  assert.equal(ffSeconds('1e-3'), '0.001')
})

test('an overlay baked from a render slice start (78.40 s): its input -ss is "0", not 1.42e-14', () => {
  const ov = { webmPath: '/tmp/overlay-2--explain-varied-10.mkv', startSeconds: 78.39999999999999, scale: 1 }
  const { inputArgs } = buildOverlayFilterParts(ov, 1080, 1920, 1, '[base]', 78.4, 82.96666666666667 - 78.4, { fps: 30 })
  assert.equal(String(78.4 - ov.startSeconds), '1.4210854715202004e-14')
  assert.deepEqual(inputArgs.slice(0, 2), ['-ss', '0'])
  for (const a of inputArgs) assert.doesNotMatch(String(a), EXPONENT, String(a))
})

test('twoStageSeek: a residue under 1e-6 is no seek at all; any other time keeps its own digits', () => {
  assert.equal(twoStageSeek(1.4210854715202004e-14), null) // was { near: 0, fine: "1.4210854715202004e-14" }
  assert.equal(twoStageSeek(9.99e-7), null)
  assert.deepEqual(twoStageSeek(78.4), { near: 76, fine: '2.4' })
  assert.deepEqual(twoStageSeek(1.5), { near: 0, fine: '1.5' })
  assert.deepEqual(twoStageSeek(0.000001), { near: 0, fine: '0.000001' })
})
