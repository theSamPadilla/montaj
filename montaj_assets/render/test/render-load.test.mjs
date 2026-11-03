// §698: a render leaves the machine room. Its workers default to half the cores, it runs at low priority (its Chrome and
// ffmpeg children inherit it), and a 2D render with little free memory runs fewer workers. All readings are injected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultWorkerTarget, lowerPriority, RENDER_NICE_DEFAULT } from '../load.js'
import { planWorkers2d, FREE_PER_WORKER_BYTES, LOW_MEMORY_MIN_WORKERS, RESERVE_MIN_BYTES } from '../memory.js'
import { planChunks } from '../renderer.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const GB = 1e9
const segments = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, frameCount: 600, props: {} }))

test('workers default to half the cores, never fewer than one, and the env wins', () => {
  assert.equal(defaultWorkerTarget({ cpus: 12, env: {} }), 6)
  assert.equal(defaultWorkerTarget({ cpus: 8, env: {} }), 4)
  assert.equal(defaultWorkerTarget({ cpus: 1, env: {} }), 1)
  assert.equal(defaultWorkerTarget({ cpus: 3, env: {} }), 1)
  assert.equal(defaultWorkerTarget({ cpus: 12, env: { MONTAJ_RENDER_WORKERS: '10' } }), 10)
  assert.equal(defaultWorkerTarget({ cpus: 12, env: { MONTAJ_RENDER_WORKERS: 'junk' } }), 6)
  assert.equal(defaultWorkerTarget({ cpus: 12, env: { MONTAJ_RENDER_WORKERS: '0' } }), 6)
})

test('planChunks: with no count asked, a 12-core Mac renders with 6 workers; an explicit count still wins', () => {
  const memory = { readAvailable: () => 30 * GB, totalBytes: 36 * GB }
  // hermetic: no user config file, no env
  const plan = planChunks(segments(4), { chunkSize: 120, memory, cpus: 12, userConfig: {}, env: {} })
  assert.equal(plan.workerCount, 6)
  assert.equal(plan.targetWorkers, 6)
  assert.equal(planChunks(segments(4), { workers: 12, chunkSize: 120, memory, cpus: 12, userConfig: {}, env: {} }).workerCount, 12)
  assert.equal(planChunks(segments(4), { chunkSize: 120, memory, cpus: 12, userConfig: { render: { workers: 3 } }, env: { MONTAJ_RENDER_WORKERS: '9' } }).workerCount, 3, 'the render config beats the env')
  assert.equal(planChunks(segments(4), { chunkSize: 120, memory, cpus: 12, userConfig: {}, env: { MONTAJ_RENDER_WORKERS: '9' } }).workerCount, 9)
})

test('the render goes to low priority: nice 10 by default, off with 0, a refusal never stops the render', () => {
  const seen = []
  const logs = []
  assert.deepEqual(lowerPriority({ env: {}, setPriority: (pid, n) => seen.push([pid, n]), log: (m) => logs.push(m) }), { applied: true, level: RENDER_NICE_DEFAULT })
  assert.deepEqual(seen, [[0, 10]])
  assert.equal(RENDER_NICE_DEFAULT, 10)
  assert.deepEqual(lowerPriority({ env: { MONTAJ_RENDER_NICE: '15' }, setPriority: (p, n) => seen.push([p, n]) }), { applied: true, level: 15 })
  for (const off of ['0', 'off']) {
    const none = []
    assert.deepEqual(lowerPriority({ env: { MONTAJ_RENDER_NICE: off }, setPriority: (p, n) => none.push([p, n]) }), { applied: false, level: 0 })
    assert.deepEqual(none, [])
  }
  const refused = lowerPriority({ env: {}, setPriority: () => { throw new Error('EPERM') }, log: (m) => logs.push(m) })
  assert.deepEqual(refused, { applied: false, level: RENDER_NICE_DEFAULT })
  assert.ok(logs.some((m) => /priority/.test(m) && /EPERM/.test(m)))
})

test('a 2D render runs fewer workers when memory is short, never below two, and the old count when it is not', () => {
  const total = 36 * GB
  const roomy = planWorkers2d({ target: 6, jobs: 20, totalBytes: total, availableBytes: 30 * GB })
  assert.equal(roomy.workers, 6)
  assert.equal(roomy.limitedBy, null)
  // The 2D reserve is the 4 GB minimum (the 25% share is a 3D render's): this Mac's usual 9.5 GB free still runs all 6.
  assert.equal(planWorkers2d({ target: 6, jobs: 20, totalBytes: total, availableBytes: 9.5 * GB }).workers, 6)
  const tight = planWorkers2d({ target: 12, jobs: 20, totalBytes: total, availableBytes: 8 * GB })
  assert.equal(tight.workers, Math.floor((8 * GB - RESERVE_MIN_BYTES) / FREE_PER_WORKER_BYTES))
  assert.equal(tight.limitedBy, 'memory')
  assert.equal(tight.reserveBytes, RESERVE_MIN_BYTES)
  const starved = planWorkers2d({ target: 6, jobs: 20, totalBytes: total, availableBytes: 2 * GB })
  assert.equal(starved.workers, LOW_MEMORY_MIN_WORKERS)
  assert.equal(starved.limitedBy, 'memory')
  // no reading (a caller that cannot read memory, or a platform that gave none): the total-memory count alone
  assert.equal(planWorkers2d({ target: 6, jobs: 20, totalBytes: total }).workers, 6)
  assert.equal(planWorkers2d({ target: 6, jobs: 20, totalBytes: total, availableBytes: NaN }).workers, 6)
  assert.ok(FREE_PER_WORKER_BYTES < 1.5 * GB && RESERVE_MIN_BYTES === 4 * GB)
})

test('the total-memory cap still binds a 2D render on a small Mac, and says so', () => {
  const small = planWorkers2d({ target: 12, jobs: 20, totalBytes: 6 * GB, availableBytes: 20 * GB })
  assert.equal(small.workers, 4, '6 GB / 1.5 GB')
  assert.equal(small.limitedBy, 'memory')
  assert.equal(small.availableBytes, null, 'reported as the total-memory plan, not as a free-memory one')
})

test('planChunks: no platform reading is no reading (os.freemem would always read as starved on a Mac)', () => {
  const plan = planChunks(segments(4), { workers: 12, chunkSize: 120, memory: { readAvailable: () => null, totalBytes: 36 * GB }, userConfig: {}, env: {} })
  assert.equal(plan.workerCount, 12)
})

test('planChunks reads the free memory for a 2D render too (so a busy Mac gets fewer workers)', () => {
  const tight = planChunks(segments(4), { workers: 12, chunkSize: 120, memory: { readAvailable: () => 8 * GB, totalBytes: 36 * GB }, userConfig: {}, env: {} })
  assert.equal(tight.workerCount, 5)
  assert.equal(tight.memory.limitedBy, 'memory')
})

test('both entry points that render for a person lower their own priority before spawning anything', () => {
  const dir = fileURLToPath(new URL('..', import.meta.url))
  const render = readFileSync(`${dir}render.js`, 'utf8')
  const editor = readFileSync(`${dir}export-editor.js`, 'utf8')
  assert.match(render, /lowerPriority\(\{ log \}\)/)
  assert.ok(render.indexOf('lowerPriority({ log })') < render.indexOf('rendering ${segmentSpecs.length} segment(s) with Puppeteer'))
  assert.match(editor, /if \(isMain\) \{\s*\/\/ §698[^\n]*\n\s*lowerPriority\(/)
})

test('each chunk ffmpeg gets its share of the cores, never all of them (12 encoders x every core was load 42)', async () => {
  const { ffmpegThreads } = await import('../load.js')
  assert.equal(ffmpegThreads({ cpus: 12, workers: 6, env: {} }), 2)
  assert.equal(ffmpegThreads({ cpus: 12, workers: 12, env: {} }), 1)
  assert.equal(ffmpegThreads({ cpus: 12, workers: 1, env: {} }), 12)
  assert.equal(ffmpegThreads({ cpus: 4, workers: 9, env: {} }), 1, 'never below one')
  assert.equal(ffmpegThreads({ cpus: 12, workers: 6, env: { MONTAJ_RENDER_FFMPEG_THREADS: '3' } }), 3)
  assert.equal(ffmpegThreads({ cpus: 12, workers: 6, env: { MONTAJ_RENDER_FFMPEG_THREADS: '0' } }), undefined, '0 removes the cap')
  assert.equal(ffmpegThreads({ cpus: 12, workers: 6, env: { MONTAJ_RENDER_FFMPEG_THREADS: 'junk' } }), 2)
})

test('chunkEncodeArgs: -threads caps the PNG decode and the FFV1 encode; without it the args are exactly as before', async () => {
  const { chunkEncodeArgs } = await import('../renderer.js')
  const job = { fps: 30, opaque: true, subframes: 1 }
  const plain = chunkEncodeArgs(job, '/tmp/c.mkv')
  assert.equal(plain.includes('-threads'), false)
  const capped = chunkEncodeArgs(job, '/tmp/c.mkv', { threads: 2 })
  const at = capped.reduce((a, v, i) => (v === '-threads' ? [...a, i] : a), [])
  assert.equal(at.length, 2)
  assert.ok(at[0] < capped.indexOf('-i'), 'the first is an input option: it caps the decoder')
  assert.ok(at[1] > capped.indexOf('-i') && at[1] < capped.indexOf('ffv1'), 'the second precedes the ffv1 encoder')
  assert.deepEqual(capped.filter((v, i) => !(v === '-threads' || capped[i - 1] === '-threads')), plain, 'nothing else moves')
})

test('renderAllSegments hands every chunk its thread share', async () => {
  const { renderAllSegments } = await import('../renderer.js')
  const seen = []
  const seg = (i) => ({ id: `t${i}`, frameCount: 10, props: {}, outputPath: `/tmp/thr-${i}.webm`, boundary: { allows: () => true }, startSeconds: 0, endSeconds: 1, fps: 30 })
  await renderAllSegments([seg(0), seg(1), seg(2)], {
    workers: 3, chunkSize: 1000, cpus: 12, env: {}, userConfig: {},
    launchWorker: async () => ({ close: async () => {} }),
    renderJob: async (_w, job, o) => { seen.push(o.threads); return { webmPath: job.outputPath } },
    memory: { readAvailable: () => 30 * GB, totalBytes: 36 * GB },
    playback: { isPlaying: () => false },
  })
  assert.deepEqual(seen, [4, 4, 4], '12 cores over 3 workers')
})
