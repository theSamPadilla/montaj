// render/test/renderer-memory.test.mjs
//
// The render's worker count follows the memory available when it plans
// (planChunks), a 3D scene's estimate and the 3D cap, and the worker loop
// asks the memory governor before each chunk (renderAllSegments). The memory
// readings are injected (`config.memory`), and the browsers and chunks are
// fakes (`config.launchWorker`, `config.renderJob`): no vm_stat, no Chrome,
// no ffmpeg.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planChunks, renderAllSegments, memoryPlanLines } from '../renderer.js'
import { SCENE3D_MAX_WORKERS, PER_WORKER_BYTES } from '../memory.js'

const GB = 1e9
const TOTAL_36GB = 36 * GB

/** `n` segments of 600 frames: with chunkSize 120, 5 jobs each. */
const segments = (n, props = {}) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, frameCount: 600, props }))
const memory = (availableBytes) => ({ readAvailable: () => availableBytes, totalBytes: TOTAL_36GB })

test('planChunks: a 36 GB Mac with 6 GB available runs fewer workers than with 30 GB available', () => {
  const tight = planChunks(segments(4), { workers: 12, chunkSize: 120, memory: memory(6 * GB) })
  const roomy = planChunks(segments(4), { workers: 12, chunkSize: 120, memory: memory(30 * GB) })
  assert.equal(roomy.workerCount, 12)
  assert.equal(tight.workerCount, 1, 'under the 9 GB reserve: one worker')
  assert.equal(tight.memory.limitedBy, 'memory')
  assert.equal(tight.memory.availableBytes, 6 * GB)
  assert.equal(tight.memory.reserveBytes, 9 * GB)
  assert.equal(tight.memory.perWorkerBytes, PER_WORKER_BYTES)
})

test('planChunks: an explicit worker count is a ceiling memory lowers and never raises', () => {
  assert.equal(planChunks(segments(4), { workers: 3, chunkSize: 120, memory: memory(120 * GB) }).workerCount, 3)
  const lowered = planChunks(segments(4), { workers: 8, chunkSize: 120, memory: memory(13.5 * GB) })
  assert.equal(lowered.workerCount, 3, '(13.5 - 9) / 1.5')
  assert.equal(lowered.memory.asked, 8)
})

test('planChunks: a 3D scene sets the per-worker estimate, and a render with 3D is capped however much memory is free', () => {
  const sceneJson = JSON.stringify({ model: { meshes: { m: { position: 'A'.repeat(200000) } } } })
  const plan = planChunks([...segments(2), ...segments(1, { sceneJson })], { workers: 12, chunkSize: 120, memory: memory(120 * GB) })
  assert.equal(plan.workerCount, SCENE3D_MAX_WORKERS)
  assert.equal(plan.memory.limitedBy, '3d')
  assert.equal(plan.memory.footprint.kind, '3d')
  assert.ok(plan.memory.perWorkerBytes > PER_WORKER_BYTES)
  const lines = memoryPlanLines(plan.memory)
  assert.match(lines[0], /^3d worker estimate=\d+\.\dGB /)
  assert.match(lines[1], /^workers capped for 3d: .*workers=2 \(asked 12, cap 2\)$/)
})

test('memoryPlanLines: a render memory lowers names available, reserve, perWorker and the result', () => {
  const plan = planChunks(segments(4), { workers: 12, chunkSize: 120, memory: memory(15 * GB) })
  assert.deepEqual(memoryPlanLines(plan.memory), ['workers lowered by memory: available=15.0GB reserve=9.0GB perWorker=1.5GB workers=4 (asked 12)'])
  assert.deepEqual(memoryPlanLines(planChunks(segments(4), { workers: 12, chunkSize: 120, memory: memory(60 * GB) }).memory), [])
})

// --- the worker loop -------------------------------------------------------

/** Single-chunk segments renderAllSegments accepts: a boundary, an output path. */
const renderable = (n) => Array.from({ length: n }, (_, i) => ({
  id: `seg${i}`, frameCount: 10, fps: 30, width: 108, height: 192, startSeconds: 0, endSeconds: 1,
  outputPath: `/nonexistent/seg${i}.mkv`, boundary: { allows: () => true },
}))

/** Fake browsers and a fake chunk render that records how many chunks run at once. */
function fakes({ ms = 15, onDone = () => {} } = {}) {
  const seen = { running: 0, most: 0, rendered: [] }
  return {
    seen,
    launchWorker: async () => ({ close: async () => {} }),
    renderJob: async (_worker, job) => {
      seen.running++
      seen.most = Math.max(seen.most, seen.running)
      await new Promise((r) => setTimeout(r, ms))
      seen.running--
      seen.rendered.push(job.id)
      onDone(seen)
      return { webmPath: job.outputPath }
    },
  }
}

test('renderAllSegments: memory short after the plan, one chunk runs at a time and every chunk still renders', async () => {
  let reads = 0
  const f = fakes()
  // Room for two workers when the render plans; short from then on.
  const readAvailable = () => (reads++ === 0 ? 30 * GB : 5 * GB)
  const out = await renderAllSegments(renderable(6), {
    workers: 2, chunkSize: 1000, launchWorker: f.launchWorker, renderJob: f.renderJob,
    memory: { readAvailable, totalBytes: TOTAL_36GB, pollMs: 1 },
  })
  assert.equal(out.length, 6)
  assert.deepEqual(f.seen.rendered.sort(), ['seg0', 'seg1', 'seg2', 'seg3', 'seg4', 'seg5'])
  assert.equal(f.seen.most, 1, 'the second worker waited for memory the whole render')
})

test('renderAllSegments: when memory recovers, the waiting worker renders beside the first', async () => {
  let available = 5 * GB
  let reads = 0
  const f = fakes({ ms: 25, onDone: (seen) => { if (seen.rendered.length === 1) available = 30 * GB } })
  const out = await renderAllSegments(renderable(6), {
    workers: 2, chunkSize: 1000, launchWorker: f.launchWorker, renderJob: f.renderJob,
    memory: { readAvailable: () => (reads++ === 0 ? 30 * GB : available), totalBytes: TOTAL_36GB, pollMs: 1 },
  })
  assert.equal(out.length, 6)
  assert.equal(f.seen.most, 2)
})

test('renderAllSegments: with room, both workers render at once from the start', async () => {
  const f = fakes()
  await renderAllSegments(renderable(4), {
    workers: 2, chunkSize: 1000, launchWorker: f.launchWorker, renderJob: f.renderJob,
    memory: { readAvailable: () => 30 * GB, totalBytes: TOTAL_36GB, pollMs: 1 },
  })
  assert.equal(f.seen.most, 2)
})
