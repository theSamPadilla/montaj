import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTotalDurationSeconds } from '../render.js'
import { collectDirectItems, collectPuppeteerSegments } from '../render.js'

test('getTotalDurationSeconds: returns 0 for empty tracks', () => {
  assert.equal(getTotalDurationSeconds({ tracks: [[]] }), 0)
})

test('getTotalDurationSeconds: returns max end across all tracks', () => {
  const project = {
    tracks: [
      [{ id: 'c1', end: 10.0 }, { id: 'c2', end: 20.0 }],
      [{ id: 'ov1', end: 15.0 }],
    ],
  }
  assert.equal(getTotalDurationSeconds(project), 20.0)
})

test('getTotalDurationSeconds: canvas project — max end from overlay tracks', () => {
  const project = {
    tracks: [
      [],
      [{ id: 'ov1', end: 8.0 }, { id: 'ov2', end: 12.0 }],
    ],
  }
  assert.equal(getTotalDurationSeconds(project), 12.0)
})

test('getTotalDurationSeconds: returns 0 when tracks is absent', () => {
  assert.equal(getTotalDurationSeconds({}), 0)
})

test('getTotalDurationSeconds: items missing end field default to 0', () => {
  assert.equal(getTotalDurationSeconds({ tracks: [[{ id: 'c1' }]] }), 0)
})

test('collectDirectItems: reads image and video items from tracks[1+]', () => {
  const project = {
    tracks: [
      [{ id: 'clip1', type: 'video', src: '/foo.mp4', start: 0, end: 10 }],
      [
        { id: 'img1',  type: 'image', src: '/bg.png',  start: 0, end: 10, offsetX: 0, offsetY: 0, scale: 1, opacity: 1 },
        { id: 'vid1',  type: 'video', src: '/pip.mp4', start: 2, end: 8, inPoint: 0, outPoint: 6, offsetX: 0, offsetY: 0, scale: 0.5, opacity: 1 },
      ],
    ],
  }
  const { imageItems, videoItems } = collectDirectItems(project)
  assert.equal(imageItems.length, 1)
  assert.equal(imageItems[0].id, 'img1')
  assert.equal(videoItems.length, 1)
  assert.equal(videoItems[0].id, 'vid1')
})

test('collectDirectItems: ignores tracks[0] (primary clips)', () => {
  const project = {
    tracks: [
      [{ id: 'primary', type: 'video', src: '/main.mp4', start: 0, end: 5 }],
    ],
  }
  const { imageItems, videoItems } = collectDirectItems(project)
  assert.equal(imageItems.length, 0)
  assert.equal(videoItems.length, 0)
})

test('collectDirectItems: overlay items are ignored (not image or video)', () => {
  const project = {
    tracks: [
      [],
      [{ id: 'ov1', type: 'overlay', src: '/ov.jsx', start: 0, end: 5 }],
    ],
  }
  const { imageItems, videoItems } = collectDirectItems(project)
  assert.equal(imageItems.length, 0)
  assert.equal(videoItems.length, 0)
})

test('collectPuppeteerSegments: picks up overlay items from tracks[1+]', () => {
  const project = {
    tracks: [
      [{ id: 'clip1', type: 'video', src: '/foo.mp4', start: 0, end: 5 }],
      [{ id: 'ov1', type: 'overlay', src: '/abs/ov.jsx', start: 1.0, end: 4.0 }],
    ],
    settings: { fps: 30 },
  }
  const specs = collectPuppeteerSegments(project, 30, 1080, 1920, '/tmp/seg')
  assert.equal(specs.length, 1)
  assert.equal(specs[0].id, 'overlay-0--ov1')
  assert.equal(specs[0].startSeconds, 1.0)
  assert.equal(specs[0].endSeconds, 4.0)
  assert.equal(specs[0].frameCount, 90)  // ceil((4.0-1.0)*30)
})

test('collectPuppeteerSegments: ignores non-overlay types in tracks[1+]', () => {
  const project = {
    tracks: [
      [],
      [{ id: 'img1', type: 'image', src: '/bg.png', start: 0, end: 5 }],
    ],
    settings: { fps: 30 },
  }
  const specs = collectPuppeteerSegments(project, 30, 1080, 1920, '/tmp/seg')
  assert.equal(specs.length, 0)
})
