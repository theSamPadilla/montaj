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
import { SCENE3D_MAX_WORKERS, SCENE3D_MAX_CHUNK_FRAMES, SCENE3D_UNKNOWN_BYTES, PER_WORKER_BYTES } from '../memory.js'

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
  // 20 MB of inline vertex data: 1 GB + 30 x 20 MB = 1.6 GB, over a 2D worker's 1.5.
  const sceneJson = JSON.stringify({ model: { meshes: { m: { position: 'A'.repeat(20e6) } } } })
  const plan = planChunks([...segments(2), ...segments(1, { sceneJson })], { workers: 12, chunkSize: 120, memory: memory(120 * GB) })
  assert.equal(plan.workerCount, SCENE3D_MAX_WORKERS)
  assert.equal(plan.memory.limitedBy, '3d')
  assert.equal(plan.memory.footprint.kind, '3d')
  assert.ok(plan.memory.perWorkerBytes > PER_WORKER_BYTES)
  const lines = memoryPlanLines(plan.memory)
  assert.match(lines[0], /^3d worker estimate=\d+\.\dGB /)
  assert.match(lines[1], /^workers capped for 3d: .*workers=2 \(asked 12, cap 2\)$/)
})

test('planChunks: a segment marked scene3d with no sceneJson gets the 3D estimate and the 3D cap', () => {
  const plan = planChunks([...segments(2), { id: 'stage', frameCount: 600, scene3d: true, props: {} }], { workers: 12, chunkSize: 120, memory: memory(120 * GB) })
  assert.equal(plan.workerCount, SCENE3D_MAX_WORKERS)
  assert.equal(plan.memory.limitedBy, '3d')
  assert.equal(plan.memory.perWorkerBytes, SCENE3D_UNKNOWN_BYTES)
  assert.match(memoryPlanLines(plan.memory)[0], /^3d worker estimate=3\.6GB from=unknown /)
})

test('planChunks: a 3D segment is cut at most SCENE3D_MAX_CHUNK_FRAMES a chunk; a 2D segment keeps the plan\'s chunk size', () => {
  assert.equal(SCENE3D_MAX_CHUNK_FRAMES, 120)
  const sceneJson = JSON.stringify({ model: { name: 'cube' } })
  const segs = [
    { id: 'title', frameCount: 600 },
    { id: 'stage', frameCount: 600, scene3d: true, props: {} },
    { id: 'scene', frameCount: 250, props: { sceneJson } },
  ]
  const plan = planChunks(segs, { workers: 2, chunkSize: 1000, memory: memory(60 * GB) })
  const of = (id) => plan.jobs.filter((j) => j.id === id)
  assert.equal(plan.chunkSize, 1000)
  assert.deepEqual(of('title').map((j) => [j.frameStart, j.frameEnd]), [[0, 600]], '2D: unchanged')
  assert.deepEqual(of('stage').map((j) => [j.frameStart, j.frameEnd]), [[0, 120], [120, 240], [240, 360], [360, 480], [480, 600]])
  assert.deepEqual(of('scene').map((j) => [j.frameStart, j.frameEnd, j.totalChunks]), [[0, 120, 3], [120, 240, 3], [240, 250, 3]])
  // A chunk size under the cap is kept for 3D too.
  const small = planChunks([{ id: 'stage', frameCount: 200, scene3d: true }], { workers: 2, chunkSize: 50, memory: memory(60 * GB) })
  assert.ok(small.jobs.length === 4 && small.jobs.every((j) => j.frameEnd - j.frameStart === 50))
})

test('planChunks: under motion blur a 3D segment still gets SCENE3D_MAX_CHUNK_FRAMES chunks, not the default divided by its sub-frames', () => {
  // 600 frames at motion blur 5 on 12 workers: the default is max(120, 600 * 5 / 12) / 5 = 50 frames, sized for a
  // capture per sub-frame. A 3D page captures once per frame, so its chunks stay at the cap.
  const plan = planChunks([{ id: 'title', frameCount: 600 }, { id: 'stage', frameCount: 600, scene3d: true }], { workers: 12, motionBlur: 5, memory: memory(60 * GB) })
  assert.equal(plan.chunkSize, 50)
  assert.ok(plan.jobs.filter((j) => j.id === 'title').every((j) => j.frameEnd - j.frameStart === 50), '2D: the default')
  assert.deepEqual(plan.jobs.filter((j) => j.id === 'stage').map((j) => j.frameEnd - j.frameStart), [120, 120, 120, 120, 120])
})

test('planChunks: a 1080x1920 capture budgets a 2D worker at the floor, so the same memory runs more workers than at 4K', () => {
  const at = (captureScale) => segments(4).map((s) => ({ ...s, width: 1080, height: 1920, captureScale }))
  const fourK = planChunks(at(2), { workers: 12, chunkSize: 120, memory: memory(15 * GB) })
  const hd = planChunks(at(1), { workers: 12, chunkSize: 120, memory: memory(15 * GB) })
  assert.equal(fourK.workerCount, 4, '(15 - 9) / 1.5')
  assert.equal(hd.memory.perWorkerBytes, 0.75 * GB)
  assert.equal(hd.workerCount, 8, '(15 - 9) / 0.75')
})

test('planChunks: a motion blur of 0, NaN or garbage is 1 sub-frame and a finite chunk size; 2 to 8 pass through', () => {
  for (const motionBlur of [0, undefined, NaN, 'blur', null]) {
    const plan = planChunks(segments(2), { workers: 4, motionBlur, memory: memory(60 * GB) })
    assert.equal(plan.subframes, 1, String(motionBlur))
    assert.ok(Number.isFinite(plan.chunkSize) && plan.chunkSize >= 1, `${motionBlur}: ${plan.chunkSize}`)
    assert.ok(plan.jobs.every((j) => j.subframes === 1))
  }
  for (const motionBlur of [2, 5, 8]) assert.equal(planChunks(segments(1), { workers: 4, motionBlur, memory: memory(60 * GB) }).subframes, motionBlur)
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

test('renderAllSegments: a worker gets a fresh browser after every 3D chunk, and after RECYCLE_AFTER 2D chunks', async () => {
  const events = []
  const segs = renderable(8).map((seg, i) => (i < 2 ? { ...seg, scene3d: true } : seg))
  await renderAllSegments(segs, {
    workers: 1, chunkSize: 1000,
    launchWorker: async () => { events.push('launch'); return { close: async () => { events.push('close') } } },
    renderJob: async (_worker, job) => { events.push(job.id); return { webmPath: job.outputPath } },
    memory: { readAvailable: () => 30 * GB, totalBytes: TOTAL_36GB, pollMs: 1 },
  })
  assert.deepEqual(events, [
    'launch', 'seg0', 'close', 'launch', 'seg1', 'close', 'launch',
    'seg2', 'seg3', 'seg4', 'seg5', 'seg6', 'close', 'launch', 'seg7', 'close',
  ])
})
