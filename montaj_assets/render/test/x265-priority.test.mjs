// libx265's worker pool lowers the whole ffmpeg process to nice 19 (measured), so
// every libx265 encode the render builds asks for pools=none with frame threads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { specFor, encoderArgsFor, X265_THREADS } from '../color-space.js'

const paramsOf = (args) => args[args.indexOf('-x265-params') + 1]

test('HEVC specs get pools=none and frame threads, after the colour params', () => {
  for (const key of ['hdr_hlg', 'hdr_pq']) {
    const spec = specFor(key)
    const p = paramsOf(encoderArgsFor(spec, 5))
    assert.ok(p.endsWith(':pools=none:frame-threads=5'), p)
    assert.ok(p.startsWith(paramsOf(spec.encoderArgs)), 'the spec\'s own params are untouched, in front')
  }
})

test('an x264 spec is unchanged, and the spec itself is not mutated', () => {
  const sdr = specFor('sdr_bt709')
  assert.deepEqual(encoderArgsFor(sdr), sdr.encoderArgs)
  const hlg = specFor('hdr_hlg')
  const before = JSON.stringify(hlg.encoderArgs)
  encoderArgsFor(hlg)
  assert.equal(JSON.stringify(hlg.encoderArgs), before)
})

test('the thread count is 1 to 8', () => {
  assert.ok(X265_THREADS >= 1 && X265_THREADS <= 8)
})

test('both encoders that take the spec go through encoderArgsFor', () => {
  for (const f of ['../encode-segment.js', '../derive-sdr.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.match(src, /\.\.\.encoderArgsFor\(spec\)/, f)
    assert.doesNotMatch(src, /\.\.\.spec\.encoderArgs/, f)
  }
})
