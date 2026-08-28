// render/test/overlay-track0.test.mjs
//
// Overlays on tracks[0] must still render.
//
// `collectPuppeteerSegments` used to read its overlay items out of
// `enabledTrackItems(project).slice(1)`, on the assumption that tracks[0] is
// always the primary footage track. That assumption holds for a filmed edit and
// fails completely for an agent-authored one: the animations workflow emits
// projects that are ONE track of nothing but overlays. Those collected zero
// overlay segments, so the render composited nothing and reported success over
// an empty output.
//
// The `.slice(1)` was also redundant as a filter — the loop already selects
// `item.type === 'overlay'`, so video and image items on any track are still
// left to `collectAllItems`. Removing it changes which TRACKS are scanned, not
// which item kinds are picked up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectPuppeteerSegments } from '../render.js'

const overlay = (id, start, end) => ({ id, type: 'overlay', src: `/abs/${id}.jsx`, start, end })
const video   = (id, start, end) => ({ id, type: 'video',   src: `/abs/${id}.mp4`, start, end })

const specIds = specs => specs.filter(s => s.id.startsWith('overlay-')).map(s => s.id)

test('an overlay-only project on tracks[0] produces overlay segments', () => {
  // The shape that surfaced this: one track, overlays only, no footage at all.
  const project = {
    settings: { fps: 30 },
    tracks: [[overlay('s01', 0, 5), overlay('s02', 5, 12)]],
  }
  const specs = collectPuppeteerSegments(project, 30, 1920, 1080, '/tmp/seg')
  assert.equal(specIds(specs).length, 2, 'both track-0 overlays must be collected')
  const [a, b] = specs
  assert.equal(a.startSeconds, 0)
  assert.equal(a.endSeconds, 5)
  assert.equal(b.startSeconds, 5)
  assert.equal(b.endSeconds, 12)
  assert.equal(a.frameCount, 150)
})

test('overlays on tracks[1+] still collected, alongside a track-0 overlay', () => {
  const project = {
    settings: { fps: 30 },
    tracks: [[overlay('base', 0, 4)], [overlay('upper', 1, 3)]],
  }
  const ids = specIds(collectPuppeteerSegments(project, 30, 1920, 1080, '/tmp/seg'))
  assert.equal(ids.length, 2)
  // Track order is preserved, so a lower track's overlay is emitted first and
  // therefore composited beneath — the same back-to-front rule as before.
  assert.ok(ids[0].endsWith('--base'), `expected the track-0 overlay first, got ${ids[0]}`)
  assert.ok(ids[1].endsWith('--upper'), `expected the track-1 overlay second, got ${ids[1]}`)
})

test('video and image items are never turned into overlay segments', () => {
  // The type filter, not the track index, is what keeps footage out of the
  // Puppeteer path — this is what makes dropping `.slice(1)` safe.
  const project = {
    settings: { fps: 30 },
    tracks: [[video('v', 0, 6), { id: 'img', type: 'image', src: '/a.png', start: 0, end: 6 }]],
  }
  assert.deepEqual(specIds(collectPuppeteerSegments(project, 30, 1920, 1080, '/tmp/seg')), [])
})

test('a track-0 overlay beside track-0 footage is still collected', () => {
  // Mixed track 0: the footage goes to collectAllItems, the overlay here.
  const project = {
    settings: { fps: 30 },
    tracks: [[video('v', 0, 10), overlay('badge', 2, 4)]],
  }
  const ids = specIds(collectPuppeteerSegments(project, 30, 1920, 1080, '/tmp/seg'))
  assert.equal(ids.length, 1)
  assert.ok(ids[0].endsWith('--badge'))
})

test('a disabled track contributes no overlay segments', () => {
  const project = {
    settings: { fps: 30 },
    tracks: [
      { id: 'trk-0', items: [overlay('kept', 0, 3)] },
      { id: 'trk-1', items: [overlay('skipped', 0, 3)], enabled: false },
    ],
  }
  const ids = specIds(collectPuppeteerSegments(project, 30, 1920, 1080, '/tmp/seg'))
  assert.equal(ids.length, 1)
  assert.ok(ids[0].endsWith('--kept'))
})
