import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTotalDuration, compose } from '../compose.js'

const STUB_PROJECT = { settings: { resolution: [1080, 1920], fps: 30 } }

// Helper: run compose in dry-run mode and return the generated args
async function dryCompose(opts) {
  return compose({ projectJson: STUB_PROJECT, puppeteerSegments: [], imageItems: [], videoItems: [], outputPath: '/tmp/out.mp4', ...opts, _dryRun: true })
}

test('computeTotalDuration: uses max end from image items', () => {
  const result = computeTotalDuration(
    [{ start: 0, end: 10.0 }, { start: 10.0, end: 22.5 }],
    [],
    []
  )
  assert.equal(result, 22.5)
})

test('computeTotalDuration: canvas project — max end from overlay and puppeteer items', () => {
  const result = computeTotalDuration(
    [{ end: 5.0 }],
    [{ end: 8.0 }],
    [{ endSeconds: 12.0 }]
  )
  assert.equal(result, 12.0)
})

test('computeTotalDuration: mixed — image + video items', () => {
  const result = computeTotalDuration(
    [{ start: 0, end: 10.0 }],
    [{ end: 15.0 }],
    []
  )
  assert.equal(result, 15.0)
})

test('computeTotalDuration: returns 0 when all empty', () => {
  assert.equal(computeTotalDuration([], [], []), 0)
})

test('computeTotalDuration: items missing end field default to 0', () => {
  const result = computeTotalDuration(
    [{ start: 0 }],  // no end field
    [],
    []
  )
  assert.equal(result, 0)
})

// ---------------------------------------------------------------------------
// compose() dry-run tests
// ---------------------------------------------------------------------------

test('compose: itsoffset = start - inPoint for trimmed video', async () => {
  const videoItems = [{
    id: 'v1', type: 'video', trackIdx: 0,
    src: '/clip.mp4', start: 5, end: 10, inPoint: 2, outPoint: 7,
    offsetX: 0, offsetY: 0, scale: 1, opacity: 1, muted: false,
  }]
  const { inputs } = await dryCompose({ videoItems })
  // -itsoffset should be 5 - 2 = 3, not 5
  const idx = inputs.indexOf('-itsoffset')
  assert.notEqual(idx, -1)
  assert.equal(inputs[idx + 1], '3')
})

test('compose: itsoffset = start when inPoint is 0', async () => {
  const videoItems = [{
    id: 'v1', type: 'video', trackIdx: 0,
    src: '/clip.mp4', start: 7, end: 12, inPoint: 0, outPoint: 5,
    offsetX: 0, offsetY: 0, scale: 1, opacity: 1, muted: false,
  }]
  const { inputs } = await dryCompose({ videoItems })
  const idx = inputs.indexOf('-itsoffset')
  assert.equal(inputs[idx + 1], '7')
})

test('compose: muted video emits no adelay or amix filters', async () => {
  const videoItems = [{
    id: 'v1', type: 'video', trackIdx: 0,
    src: '/clip.mp4', start: 0, end: 5, inPoint: 0, outPoint: 5,
    offsetX: 0, offsetY: 0, scale: 1, opacity: 1, muted: true,
  }]
  const { filterParts } = await dryCompose({ videoItems })
  const fc = filterParts.join(';')
  assert.ok(!fc.includes('adelay'), 'adelay should not appear for muted video')
  assert.ok(!fc.includes('amix'), 'amix should not appear for muted video')
})

test('compose: empty project maps [canvas_v] directly, no [vout]', async () => {
  const { ffmpegArgs, filterParts } = await dryCompose({})
  assert.ok(!filterParts.join(';').includes('[vout]'))
  const mapIdx = ffmpegArgs.indexOf('-map')
  assert.notEqual(mapIdx, -1)
  assert.equal(ffmpegArgs[mapIdx + 1], '[canvas_v]')
})

test('compose: N>0 Q>0 — last item emits [iv{N-1}], last Puppeteer segment emits [vout]', async () => {
  const videoItems = [{
    id: 'v1', type: 'video', trackIdx: 0,
    src: '/clip.mp4', start: 0, end: 5, inPoint: 0, outPoint: 5,
    offsetX: 0, offsetY: 0, scale: 1, opacity: 1, muted: true,
  }]
  const puppeteerSegments = [{
    id: 'seg1', startSeconds: 0, endSeconds: 5, webmPath: '/seg.mkv', isCaption: false,
  }]
  const { filterParts } = await dryCompose({ videoItems, puppeteerSegments })
  const fc = filterParts.join(';')
  // Last item (N-1 = 0) should produce [iv0], not [vout]
  assert.ok(fc.includes('[iv0]'), 'last item should produce [iv0] when Q>0')
  // Last Puppeteer segment should produce [vout]
  assert.ok(fc.includes('[vout]'), 'last Puppeteer segment should produce [vout]')
  assert.ok(!fc.includes('[ov0]'), 'only one Puppeteer segment, no intermediate [ov0]')
})
