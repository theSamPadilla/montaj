// render/test/encode-segment.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeSegment } from '../encode-segment.js'

test('encodeSegment is a function', () => {
  assert.equal(typeof encodeSegment, 'function')
})

test('dry-run: black canvas when no items', () => {
  const seg = { start: 0, end: 5, items: [], overlays: [], vw: 1920, vh: 1080, fps: 30 }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.inputs.some(f => f.includes('color=black')))
  assert.ok(result.inputs.some(f => f.includes('anullsrc')))
  assert.ok(result.filterParts.some(f => f.includes('setparams=colorspace=bt709')))
})

test('dry-run: item opacity applies colorchannelmixer', () => {
  const seg = {
    start: 0, end: 3, items: [
      { type: 'video', src: '/a.mp4', start: 0, end: 3, inPoint: 0, trackIdx: 0,
        scale: 1, offsetX: 0, offsetY: 0, opacity: 0.5, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.filterParts.some(f => f.includes('colorchannelmixer=aa=0.5')))
})

test('dry-run: multi-item segment layers both items', () => {
  const seg = {
    start: 0, end: 5, items: [
      { type: 'image', src: '/bg.jpg', start: 0, end: 5, trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1 },
      { type: 'video', src: '/pip.mp4', start: 0, end: 5, inPoint: 0, trackIdx: 1, scale: 0.3, offsetX: 30, offsetY: 30, opacity: 1, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  // Both items produce overlay filters
  const overlayFilters = result.filterParts.filter(f => f.includes('overlay='))
  assert.equal(overlayFilters.length, 2)
  // Second item should have scale * vw ≈ 576 (0.3 * 1920, rounded to even)
  assert.ok(result.filterParts.some(f => f.includes('scale=576:324')))
})

test('dry-run: overlay positioning uses pixelRatio, offset, scale', () => {
  const seg = {
    start: 0, end: 5, items: [], overlays: [
      { webmPath: '/ov.mkv', startSeconds: 0, endSeconds: 5, isCaption: false,
        scale: 0.8, pixelRatio: 2, offsetX: 10, offsetY: -5 },
    ], vw: 1920, vh: 1080, fps: 30,
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  // pixelRatio*scale = 1.6 → scale filter should reference 1.6
  assert.ok(result.filterParts.some(f => f.includes('scale=iw*1.6:ih*1.6')))
  // Offset math: x = round(1920 * (0.5*(1-0.8) + 10/100)) = round(1920 * 0.2) = 384
  assert.ok(result.filterParts.some(f => f.includes('overlay=x=384')))
})

test('dry-run: .mov input uses format=auto for alpha preservation', () => {
  const seg = {
    start: 0, end: 3, items: [
      { type: 'video', src: '/nobg.mov', start: 0, end: 3, inPoint: 0, trackIdx: 0,
        scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: false },
    ], overlays: [], vw: 1920, vh: 1080, fps: 30,
  }
  const result = encodeSegment(seg, '/tmp/test.mp4', { _dryRun: true })
  assert.ok(result.filterParts.some(f => f.includes('format=auto')))
})
