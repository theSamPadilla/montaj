// sourceCropFilter: the crop on a sampled video frame. The crop fractions go into ffmpeg
// expressions on the decoded frame's size (§668), as text, so each must be a finite number (§563).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceCropFilter } from '../sample-frame.js'

const geometry = (sourceCrop) => ({ sourceWidth: 3840, sourceHeight: 2160, sourceCrop })

test('a valid crop is cut in the decoded frame\'s pixels, never the item\'s source size (§668)', () => {
  const g = geometry({ x: 0.2, y: 0, w: 0.316, h: 1 })
  assert.equal(sourceCropFilter(g), 'crop=w=2*round(iw*0.316/2):h=2*round(ih*1/2):x=round(iw*0.2):y=round(ih*0)')
})

test('no crop, or no source size, is no filter', () => {
  assert.equal(sourceCropFilter({ sourceWidth: 3840, sourceHeight: 2160 }), null)
  assert.equal(sourceCropFilter({ sourceCrop: { x: 0, y: 0, w: 1, h: 1 } }), null)
})

test('a crop value that is not a finite number is refused, naming the field', () => {
  for (const k of ['x', 'y', 'w', 'h']) {
    const sc = { x: 0, y: 0, w: 1, h: 1, [k]: '0.5:x=1' }
    assert.throws(() => sourceCropFilter(geometry(sc)), new RegExp(`sourceCrop\\.${k}`))
  }
  assert.throws(() => sourceCropFilter(geometry({ x: 0, y: 0, w: Infinity, h: 1 })), /sourceCrop\.w/)
})

test('numeric-string crop fractions build the same filter as their numbers', () => {
  const num = geometry({ x: 0.2, y: 0, w: 0.316, h: 1 })
  const str = geometry({ x: '0.2', y: '0', w: '0.316', h: '1' })
  assert.equal(sourceCropFilter(str), sourceCropFilter(num))
})
