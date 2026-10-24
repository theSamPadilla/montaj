// sourceCropFilter: the crop on a sampled video frame. With a proxy the crop fractions go into
// ffmpeg expressions as text, so each must be a finite number (§563); valid crops are unchanged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceCropFilter } from '../sample-frame.js'

const geometry = (sourceCrop) => ({ sourceWidth: 3840, sourceHeight: 2160, sourceCrop })

test('a valid crop builds the same filter as before, proxy and master', () => {
  const g = geometry({ x: 0.2, y: 0, w: 0.316, h: 1 })
  assert.equal(sourceCropFilter(g, true), 'crop=w=2*round(iw*0.316/2):h=2*round(ih*1/2):x=round(iw*0.2):y=round(ih*0)')
  assert.equal(sourceCropFilter(g, false), 'crop=1214:2160:768:0')
})

test('no crop, or no source size, is no filter', () => {
  assert.equal(sourceCropFilter({ sourceWidth: 3840, sourceHeight: 2160 }, true), null)
  assert.equal(sourceCropFilter({ sourceCrop: { x: 0, y: 0, w: 1, h: 1 } }, true), null)
})

test('a crop value that is not a finite number is refused on the proxy path, naming the field', () => {
  for (const k of ['x', 'y', 'w', 'h']) {
    const sc = { x: 0, y: 0, w: 1, h: 1, [k]: '0.5:x=1' }
    assert.throws(() => sourceCropFilter(geometry(sc), true), new RegExp(`sourceCrop\\.${k}`))
  }
  assert.throws(() => sourceCropFilter(geometry({ x: 0, y: 0, w: Infinity, h: 1 }), true), /sourceCrop\.w/)
})
