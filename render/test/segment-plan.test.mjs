// render/test/segment-plan.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planSegments } from '../segment-plan.js'

test('planSegments: single clip fills timeline', () => {
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 5, src: '/a.mp4', inPoint: 0, outPoint: 5, trackIdx: 0 }
  ]
  const segs = planSegments(items, [], 1920, 1080, 30)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].start, 0)
  assert.equal(segs[0].end, 5)
  assert.equal(segs[0].items.length, 1)
  assert.equal(segs[0].items[0].src, '/a.mp4')
  assert.equal(segs[0].items[0].type, 'video')
})

test('planSegments: gap between clips produces empty-items segment', () => {
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 3, src: '/a.mp4', inPoint: 0, outPoint: 3, trackIdx: 0 },
    { id: 'c2', type: 'video', start: 5, end: 8, src: '/b.mp4', inPoint: 0, outPoint: 3, trackIdx: 0 },
  ]
  const segs = planSegments(items, [], 1920, 1080, 30)
  assert.equal(segs.length, 3)
  assert.equal(segs[1].start, 3)
  assert.equal(segs[1].end, 5)
  assert.equal(segs[1].items.length, 0) // black — no active items
})

test('planSegments: image item produces looped-image segment', () => {
  const items = [
    { id: 'bg', type: 'image', start: 0, end: 10, src: '/bg.jpg', trackIdx: 0 }
  ]
  const segs = planSegments(items, [], 1920, 1080, 30)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].items[0].type, 'image')
  assert.equal(segs[0].items[0].src, '/bg.jpg')
})

test('planSegments: overlays attached to overlapping segments', () => {
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 10, src: '/a.mp4', inPoint: 0, outPoint: 10, trackIdx: 0 },
  ]
  const puppeteerSegs = [
    { id: 'ov1', startSeconds: 2, endSeconds: 5, webmPath: '/ov.mkv', opaque: false, isCaption: false },
  ]
  const segs = planSegments(items, puppeteerSegs, 1920, 1080, 30)
  assert.equal(segs.length, 3)
  assert.equal(segs[1].overlays.length, 1)
  assert.equal(segs[1].overlays[0].id, 'ov1')
})

test('planSegments: opaque overlay empties items', () => {
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 10, src: '/a.mp4', inPoint: 0, outPoint: 10, trackIdx: 0 },
  ]
  const puppeteerSegs = [
    { id: 'ov1', startSeconds: 0, endSeconds: 3, webmPath: '/ov.mkv', opaque: true, isCaption: false },
  ]
  const segs = planSegments(items, puppeteerSegs, 1920, 1080, 30)
  assert.equal(segs[0].items.length, 0) // opaque overlay replaces all visuals
  assert.equal(segs[0].overlays[0].opaque, true)
})

test('planSegments: multi-track items all included, sorted by trackIdx', () => {
  const items = [
    { id: 'bg', type: 'image', start: 0, end: 10, src: '/bg.jpg', trackIdx: 0, scale: 1, offsetX: 0, offsetY: 0, opacity: 1 },
    { id: 'pip', type: 'video', start: 2, end: 8, src: '/pip.mp4', trackIdx: 1, inPoint: 0, outPoint: 6, scale: 0.3, offsetX: 30, offsetY: 30, opacity: 0.9 },
  ]
  const segs = planSegments(items, [], 1920, 1080, 30)
  // [0-2]: bg only, [2-8]: bg + pip, [8-10]: bg only
  assert.equal(segs.length, 3)
  assert.equal(segs[0].items.length, 1)
  assert.equal(segs[0].items[0].id, 'bg')
  assert.equal(segs[1].items.length, 2)
  assert.equal(segs[1].items[0].id, 'bg')   // trackIdx 0 first (background)
  assert.equal(segs[1].items[1].id, 'pip')   // trackIdx 1 on top
  assert.equal(segs[2].items.length, 1)
  assert.equal(segs[2].items[0].id, 'bg')
})

test('planSegments: captions always sorted after overlays', () => {
  const items = [
    { id: 'c1', type: 'video', start: 0, end: 10, src: '/a.mp4', inPoint: 0, outPoint: 10, trackIdx: 0 },
  ]
  const puppeteerSegs = [
    { id: 'cap', startSeconds: 0, endSeconds: 10, webmPath: '/cap.mkv', isCaption: true },
    { id: 'ov',  startSeconds: 0, endSeconds: 10, webmPath: '/ov.mkv',  isCaption: false },
  ]
  const segs = planSegments(items, puppeteerSegs, 1920, 1080, 30)
  assert.equal(segs[0].overlays.length, 2)
  assert.equal(segs[0].overlays[0].id, 'ov')   // non-caption first
  assert.equal(segs[0].overlays[1].id, 'cap')   // caption last (on top)
})
