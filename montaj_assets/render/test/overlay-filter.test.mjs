// render/test/overlay-filter.test.mjs
//
// buildOverlayFilterParts had zero test coverage until SP7. That absence is a
// direct cause of the four-and-a-half-month overlay cadence regression: the
// function emits a filter string, nothing asserted on it, and a container
// timebase change silently broke every animated overlay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOverlayFilterParts } from '../encode-segment.js'

const OV = { webmPath: '/tmp/ov.mkv', startSeconds: 0, scale: 1 }
const call = (opts) => buildOverlayFilterParts(OV, 1080, 1920, 1, '[base]', 0, 2, opts)

test('(a) a stream overlay is pinned to the segment fps grid', () => {
  const { filterParts } = call({ fps: 30 })
  const fmt = filterParts.find(p => p.includes('format='))
  assert.match(fmt, /setpts=N\/\(30\*TB\)/,
    'overlay input must be re-stamped onto the exact frame grid')
})

test('(b) the pin uses the project fps, not a hardcoded 30', () => {
  for (const fps of [24, 60]) {
    const { filterParts } = call({ fps })
    assert.match(filterParts.find(p => p.includes('format=')),
      new RegExp(`setpts=N/\\(${fps}\\*TB\\)`))
  }
})

test('(c) a missing fps throws rather than silently defaulting', () => {
  assert.throws(() => call({}), /fps is required/,
    'a silent 30 would re-break 24 and 60 fps projects exactly as before')
  assert.throws(() => call({ fps: 0 }), /fps is required/)
})

test('(d) looped single-frame PNG inputs are not pinned', () => {
  const { filterParts } = call({
    loopedInput: true, inputFormatFlag: 'rgba', compositeFormatFlag: 'auto',
  })
  assert.doesNotMatch(filterParts.join('\n'), /setpts=/,
    'sample-frame.js feeds stills, which have no cadence to correct')
})

test('(e) the pin does not disturb sizing or positioning', () => {
  const { filterParts } = call({ fps: 30 })
  const s = filterParts.join('\n')
  assert.match(s, /scale=1080:1920/)
  assert.match(s, /overlay=x=0:y=0:/)
})

test('(f) explicit caller formats still win over the defaults', () => {
  const { filterParts } = call({
    loopedInput: true, inputFormatFlag: 'rgba', compositeFormatFlag: 'auto',
  })
  const s = filterParts.join('\n')
  assert.match(s, /format=rgba/)
  assert.match(s, /overlay=[^\n]*format=auto/)
})
