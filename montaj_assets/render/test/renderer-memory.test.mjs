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
import { planChunks, renderAllSegments, memoryPlanLines, relaunchWorker } from '../renderer.js'
import { SCENE3D_MAX_WORKERS, SCENE3D_MAX_CHUNK_FRAMES, SCENE3D_UNKNOWN_BYTES, PER_WORKER_BYTES } from '../memory.js'

const GB = 1e9
const TOTAL_36GB = 36 * GB

/** `n` segments of 600 frames: with chunkSize 120, 5 jobs each. */
const segments = (n, props = {}) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, frameCount: 600, props }))
const memory = (availableBytes) => ({ readAvailable: () => availableBytes, totalBytes: TOTAL_36GB })
/** `n` 3D stages of 600 frames whose scene cannot be read: SCENE3D_UNKNOWN_BYTES a worker. Only a render with 3D is sized by memory. */
const stages = (n) => segments(n).map((s) => ({ ...s, scene3d: true }))

test('planChunks: with 3D, a 36 GB Mac with 6 GB available runs fewer workers than with 30 GB available', () => {
  const tight = planChunks(stages(4), { workers: 12, chunkSize: 120, memory: memory(6 * GB) })
  const roomy = planChunks(stages(4), { workers: 12, chunkSize: 120, memory: memory(30 * GB) })
  assert.equal(roomy.workerCount, SCENE3D_MAX_WORKERS, '(30 - 9) / 4.7 = 4, then the 3D cap')
  assert.equal(tight.workerCount, 1, 'under the 9 GB reserve: one worker')
  assert.equal(tight.memory.limitedBy, 'memory')
  assert.equal(tight.memory.availableBytes, 6 * GB)
  assert.equal(tight.memory.reserveBytes, 9 * GB)
  assert.equal(tight.memory.perWorkerBytes, SCENE3D_UNKNOWN_BYTES)
})

test('planChunks: a 2D-only render keeps 1.3.10\'s worker count whatever memory is available', () => {
  let reads = 0
  const at = (availableBytes) => ({ readAvailable: () => { reads++; return availableBytes }, totalBytes: TOTAL_36GB })
  for (const available of [6 * GB, 30 * GB]) {
    const plan = planChunks(segments(4), { workers: 12, chunkSize: 120, memory: at(available) })
    assert.equal(plan.workerCount, 12, `${available}`)
    assert.equal(plan.memory.limitedBy, null)
    assert.equal(plan.memory.availableBytes, null)
  }
  assert.equal(reads, 0, 'no memory read')
  // Only the machine's total lowers it, as 1.3.10's workerCap: one per 1.5 GB.
  const small = planChunks(segments(4), { workers: 12, chunkSize: 120, memory: { readAvailable: () => 0, totalBytes: 6 * GB } })
  assert.deepEqual([small.workerCount, small.memory.limitedBy], [4, 'memory'])
  assert.deepEqual(memoryPlanLines(small.memory), ['workers lowered by memory: total=6.0GB perWorker=1.5GB workers=4 (asked 12)'])
})

test('planChunks: with 3D, an explicit worker count is a ceiling memory lowers and never raises', () => {
  assert.equal(planChunks(stages(4), { workers: 1, chunkSize: 120, memory: memory(120 * GB) }).workerCount, 1)
  const lowered = planChunks(stages(4), { workers: 8, chunkSize: 120, memory: memory(13.5 * GB) })
  assert.equal(lowered.workerCount, 1, '(13.5 - 9) / 4.7')
  assert.equal(lowered.memory.limitedBy, 'memory')
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
  assert.match(memoryPlanLines(plan.memory)[0], /^3d worker estimate=4\.7GB from=unknown /)
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

test('planChunks: with 3D, a capture larger than the scene sets the per-worker estimate', () => {
  const cube = { id: 'cube', frameCount: 600, props: { sceneJson: JSON.stringify({ model: { name: 'cube' } }) } }
  const at = (captureScale) => [...segments(2).map((s) => ({ ...s, width: 2160, height: 3840, captureScale })), cube]
  assert.equal(planChunks(at(2), { workers: 2, chunkSize: 120, memory: memory(60 * GB) }).memory.perWorkerBytes, 4 * PER_WORKER_BYTES, 'an 8K capture')
  assert.ok(planChunks(at(1), { workers: 2, chunkSize: 120, memory: memory(60 * GB) }).memory.perWorkerBytes < 2 * GB, 'the cube')
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

test('memoryPlanLines: a 3D render memory lowers names available, reserve, perWorker and the result', () => {
  const plan = planChunks(stages(4), { workers: 12, chunkSize: 120, memory: memory(15 * GB) })
  assert.deepEqual(memoryPlanLines(plan.memory).slice(1), ['workers lowered by memory: available=15.0GB reserve=9.0GB perWorker=4.7GB workers=1 (asked 12)'])
  assert.deepEqual(memoryPlanLines(planChunks(stages(4), { workers: 12, chunkSize: 120, memory: memory(60 * GB) }).memory).slice(1),
    ['workers capped for 3d: one GPU draws every worker, workers=2 (asked 12, cap 2)'])
  assert.deepEqual(memoryPlanLines(planChunks(segments(4), { workers: 12, chunkSize: 120, memory: memory(1 * GB) }).memory), [], '2D-only')
})

// --- the worker loop -------------------------------------------------------

/** Single-chunk segments renderAllSegments accepts: a boundary, an output path. */
const renderable = (n) => Array.from({ length: n }, (_, i) => ({
  id: `seg${i}`, frameCount: 10, fps: 30, width: 108, height: 192, startSeconds: 0, endSeconds: 1,
  outputPath: `/nonexistent/seg${i}.mkv`, boundary: { allows: () => true },
}))
const renderable3d = (n) => renderable(n).map((seg) => ({ ...seg, scene3d: true }))

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

test('renderAllSegments: with 3D, memory short after the plan, one chunk runs at a time and every chunk still renders', async () => {
  let reads = 0
  const f = fakes()
  // Room for two workers when the render plans; short from then on.
  const readAvailable = () => (reads++ === 0 ? 30 * GB : 5 * GB)
  const out = await renderAllSegments(renderable3d(6), {
    workers: 2, chunkSize: 1000, launchWorker: f.launchWorker, renderJob: f.renderJob,
    memory: { readAvailable, totalBytes: TOTAL_36GB, pollMs: 1 },
  })
  assert.equal(out.length, 6)
  assert.deepEqual(f.seen.rendered.sort(), ['seg0', 'seg1', 'seg2', 'seg3', 'seg4', 'seg5'])
  assert.equal(f.seen.most, 1, 'the second worker waited for memory the whole render')
})

test('renderAllSegments: with 3D, when memory recovers, the waiting worker renders beside the first', async () => {
  let available = 5 * GB
  let reads = 0
  const f = fakes({ ms: 25, onDone: (seen) => { if (seen.rendered.length === 1) available = 30 * GB } })
  const out = await renderAllSegments(renderable3d(6), {
    workers: 2, chunkSize: 1000, launchWorker: f.launchWorker, renderJob: f.renderJob,
    memory: { readAvailable: () => (reads++ === 0 ? 30 * GB : available), totalBytes: TOTAL_36GB, pollMs: 1 },
  })
  assert.equal(out.length, 6)
  assert.equal(f.seen.most, 2)
})

test('renderAllSegments: with 3D and room, both workers render at once from the start', async () => {
  const f = fakes()
  await renderAllSegments(renderable3d(4), {
    workers: 2, chunkSize: 1000, launchWorker: f.launchWorker, renderJob: f.renderJob,
    memory: { readAvailable: () => 30 * GB, totalBytes: TOTAL_36GB, pollMs: 1 },
  })
  assert.equal(f.seen.most, 2)
})

test('renderAllSegments: a 2D-only render never reads memory and never waits', async () => {
  let reads = 0
  const f = fakes()
  const out = await renderAllSegments(renderable(6), {
    workers: 2, chunkSize: 1000, launchWorker: f.launchWorker, renderJob: f.renderJob,
    memory: { readAvailable: () => { reads++; return 1 * GB }, totalBytes: TOTAL_36GB, pollMs: 1 },
  })
  assert.equal(out.length, 6)
  assert.equal(f.seen.most, 2, 'both workers render at once on 1 GB available')
  assert.equal(reads, 0)
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

test('relaunchWorker (§395): a failed browser relaunch is tried once more, and a second failure fails', async () => {
  const lines = []
  let calls = 0
  const flaky = async () => { if (++calls === 1) throw new Error('launch timed out'); return 'browser' }
  assert.equal(await relaunchWorker(flaky, { label: 'worker 0', delayMs: 0, write: (l) => lines.push(l) }), 'browser')
  assert.equal(calls, 2)
  assert.deepEqual(lines, ['worker 0: browser relaunch failed (launch timed out); trying once more'])
  let tries = 0
  await assert.rejects(relaunchWorker(async () => { tries++; throw new Error(`no ${tries}`) }, { label: 'worker 1', delayMs: 0, write: () => {} }), /no 2/)
  assert.equal(tries, 2)
  let once = 0
  assert.equal(await relaunchWorker(async () => { once++; return 'b' }, { label: 'w', delayMs: 0, write: () => {} }), 'b')
  assert.equal(once, 1, 'a launch that works runs once')
})

test('renderAllSegments (§395): a browser relaunch after a 3D chunk that fails once is retried, and the render finishes', async () => {
  const f = fakes()
  let launches = 0
  const launchWorker = async () => { if (++launches === 2) throw new Error('launch timed out'); return { close: async () => {} } }
  const out = await renderAllSegments(renderable3d(3), {
    workers: 1, chunkSize: 1000, launchWorker, renderJob: f.renderJob, relaunchDelayMs: 0,
    memory: { readAvailable: () => 30 * GB, totalBytes: TOTAL_36GB, pollMs: 1 },
  })
  assert.equal(out.length, 3)
  assert.equal(launches, 4, 'the pool, a failed relaunch, its retry, and the next relaunch')
})
