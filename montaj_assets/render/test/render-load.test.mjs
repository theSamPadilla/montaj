// §698: a render leaves the machine room. Its workers default to half the cores, it runs at low priority (its Chrome and
// ffmpeg children inherit it), and a 2D render with little free memory runs fewer workers. All readings are injected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultWorkerTarget, lowerPriority, RENDER_NICE_DEFAULT } from '../load.js'
import { planWorkers2d, FREE_PER_WORKER_BYTES, LOW_MEMORY_MIN_WORKERS, RESERVE_MIN_BYTES } from '../memory.js'
import { planChunks } from '../renderer.js'

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
  const plan = planChunks(segments(4), { chunkSize: 120, memory, cpus: 12 })
  assert.equal(plan.workerCount, 6)
  assert.equal(plan.targetWorkers, 6)
  assert.equal(planChunks(segments(4), { workers: 12, chunkSize: 120, memory, cpus: 12 }).workerCount, 12)
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
  const tight = planWorkers2d({ target: 6, jobs: 20, totalBytes: total, availableBytes: 13 * GB })
  // (13 - 9 reserve) / 0.8 = 5
  assert.equal(tight.workers, Math.floor((13 * GB - 9 * GB) / FREE_PER_WORKER_BYTES))
  assert.equal(tight.limitedBy, 'memory')
  const starved = planWorkers2d({ target: 6, jobs: 20, totalBytes: total, availableBytes: 2 * GB })
  assert.equal(starved.workers, LOW_MEMORY_MIN_WORKERS)
  assert.equal(starved.limitedBy, 'memory')
  // no reading (a caller that cannot read memory): as before
  assert.equal(planWorkers2d({ target: 6, jobs: 20, totalBytes: total }).workers, 6)
  assert.ok(FREE_PER_WORKER_BYTES < 1.5 * GB && RESERVE_MIN_BYTES === 4 * GB)
})

test('planChunks reads the free memory for a 2D render too (so a busy Mac gets fewer workers)', () => {
  const tight = planChunks(segments(4), { workers: 12, chunkSize: 120, memory: { readAvailable: () => 13 * GB, totalBytes: 36 * GB } })
  assert.equal(tight.workerCount, 5)
  assert.equal(tight.memory.limitedBy, 'memory')
})
