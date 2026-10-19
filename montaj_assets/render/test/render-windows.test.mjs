// montaj_assets/render/test/render-windows.test.mjs
//
// §434: a segment's frameFrom/frameTo window, the render-wide bake counter that
// spans several renderAllSegments calls, and the result times of a windowed
// segment. The browser and the chunk render are fakes (config.launchWorker,
// config.renderJob): no Chrome, no ffmpeg.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planChunks, renderAllSegments, bakeTotal, createBakeProgress, currentRenderPlan } from '../renderer.js'

const seg = (id, frameCount, extra = {}) => ({
  id, frameCount, fps: 30, width: 108, height: 192, startSeconds: 2, endSeconds: 2 + frameCount / 30,
  outputPath: `/nonexistent/${id}.mkv`, boundary: { allows: () => true }, ...extra,
})
const ranges = (jobs) => jobs.map((j) => [j.id, j.frameStart, j.frameEnd, j.chunkIndex, j.totalChunks])

test('planChunks without a window is what it was before (snapshots of the pre-§434 planner)', () => {
  const plain = (id, n, extra = {}) => ({ id, frameCount: n, fps: 30, ...extra })
  const shape = (jobs) => jobs.map((j) => [j.id, j.frameStart, j.frameEnd, j.chunkIndex, j.totalChunks, j.opaque, j.subframes])
  let p = planChunks([plain('a', 10)], { workers: 2, chunkSize: 4 })
  assert.deepEqual(shape(p.jobs), [['a', 0, 4, 0, 3, false, 1], ['a', 4, 8, 1, 3, false, 1], ['a', 8, 10, 2, 3, false, 1]])
  assert.equal(p.chunkSize, 4)
  p = planChunks([plain('a', 10), plain('b', 3)], { workers: 2, chunkSize: 10 })
  assert.deepEqual(shape(p.jobs), [['a', 0, 10, 0, 1, false, 1], ['b', 0, 3, 0, 1, false, 1]])
  p = planChunks([plain('a', 250, { opaque: true })], { workers: 3, chunkSize: 100, motionBlur: 2 })
  assert.deepEqual(shape(p.jobs), [['a', 0, 100, 0, 3, true, 2], ['a', 100, 200, 1, 3, true, 2], ['a', 200, 250, 2, 3, true, 2]])
  assert.equal(p.chunkSize, 100)
})

test('planChunks cuts only the window, chunk by chunk', () => {
  const p = planChunks([seg('a', 100, { frameFrom: 30, frameTo: 75 })], { workers: 2, chunkSize: 20 })
  assert.deepEqual(ranges(p.jobs), [['a', 30, 50, 0, 3], ['a', 50, 70, 1, 3], ['a', 70, 75, 2, 3]])
})

test('a window that fits one chunk is one job over exactly the window', () => {
  const p = planChunks([seg('a', 100, { frameFrom: 10, frameTo: 40 })], { workers: 2, chunkSize: 50 })
  assert.deepEqual(ranges(p.jobs), [['a', 10, 40, 0, 1]])
})

test('the chunk size plans on the window, not on the whole overlay', () => {
  const whole = planChunks([seg('a', 6000)], { workers: 4 })
  const win = planChunks([seg('a', 6000, { frameFrom: 0, frameTo: 100 })], { workers: 4 })
  assert.equal(win.chunkSize, planChunks([seg('a', 100)], { workers: 4 }).chunkSize)
  assert.notEqual(win.chunkSize, whole.chunkSize)
})

test('bakeTotal sums the frames the jobs write', () => {
  const segs = [seg('a', 100, { frameFrom: 30, frameTo: 75 }), seg('b', 20)]
  assert.equal(bakeTotal(segs, { workers: 2, chunkSize: 20 }), 45 + 20)
})

function fakes(seen = []) {
  return {
    seen,
    launchWorker: async () => ({ close: async () => {} }),
    renderJob: async (_worker, job, { onFrame } = {}) => {
      seen.push([job.id, job.frameStart, job.frameEnd, job.outputPath])
      for (let f = job.frameStart; f < job.frameEnd; f++) onFrame?.()
      return { webmPath: job.outputPath }
    },
  }
}

test('a windowed result carries the window start and end in seconds, at the caller outputPath', async () => {
  const f = fakes()
  const [r] = await renderAllSegments([seg('a', 100, { frameFrom: 30, frameTo: 60, outputPath: '/nonexistent/a-s1.mkv' })],
    { workers: 1, chunkSize: 100, launchWorker: f.launchWorker, renderJob: f.renderJob })
  assert.deepEqual(r, { id: 'a', webmPath: '/nonexistent/a-s1.mkv', startSeconds: 3, endSeconds: 4, opaque: false })
  assert.deepEqual(f.seen, [['a', 30, 60, '/nonexistent/a-s1.mkv']])
  assert.deepEqual(currentRenderPlan(), { workers: 1, chunkFrames: 100 })
})

test('an unwindowed result is as before', async () => {
  const f = fakes()
  const [r] = await renderAllSegments([seg('a', 30)], { workers: 1, chunkSize: 100, launchWorker: f.launchWorker, renderJob: f.renderJob })
  assert.deepEqual(r, { id: 'a', webmPath: '/nonexistent/a.mkv', startSeconds: 2, endSeconds: 3, opaque: false })
  assert.deepEqual(f.seen, [['a', 0, 30, '/nonexistent/a.mkv']])
})

test('one bakeProgress spans two calls and reaches exactly the sum of their totals', async () => {
  const lines = []
  const slices = [
    [seg('a', 100, { frameFrom: 0, frameTo: 40, outputPath: '/nonexistent/a-0.mkv' })],
    [seg('a', 100, { frameFrom: 40, frameTo: 100, outputPath: '/nonexistent/a-1.mkv' })],
  ]
  const cfg = { workers: 1, chunkSize: 100 }
  const total = slices.reduce((n, s) => n + bakeTotal(s, cfg), 0)
  assert.equal(total, 100)
  const bakeProgress = createBakeProgress({ total, log: (m) => lines.push(m) })
  const f = fakes()
  for (const s of slices) await renderAllSegments(s, { ...cfg, bakeProgress, launchWorker: f.launchWorker, renderJob: f.renderJob })
  const baked = lines.filter((l) => l.startsWith('baked '))
  assert.equal(baked.at(-1), 'baked 100/100 frames')
  assert.ok(baked.includes('baked 40/100 frames'))
  assert.deepEqual(f.seen.map((x) => x[3]), ['/nonexistent/a-0.mkv', '/nonexistent/a-1.mkv'])
})
