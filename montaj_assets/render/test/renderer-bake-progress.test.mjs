// render/test/renderer-bake-progress.test.mjs
//
// createBakeProgress (renderer.js): the bake's one overall frame counter, the
// line the app's export bar moves on between whole chunks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBakeProgress, renderAllSegments, chunkJobs } from '../renderer.js'
import { createBakeTally } from '../bake-tally.js'

test('one line per whole percent, ending at the total', () => {
  const lines = []
  const note = createBakeProgress({ total: 250, log: (m) => lines.push(m) })
  for (let i = 0; i < 250; i++) note()
  assert.equal(lines.length, 101)
  assert.equal(lines[0], 'baked 1/250 frames')
  assert.equal(lines.at(-1), 'baked 250/250 frames')
})

test('a small total logs every frame; a chunk run again never passes the total', () => {
  const lines = []
  const note = createBakeProgress({ total: 3, log: (m) => lines.push(m) })
  for (let i = 0; i < 5; i++) note()
  assert.deepEqual(lines, ['baked 1/3 frames', 'baked 2/3 frames', 'baked 3/3 frames'])
})

test('no frames to bake logs nothing', () => {
  const lines = []
  const note = createBakeProgress({ total: 0, log: (m) => lines.push(m) })
  note()
  assert.deepEqual(lines, [])
})

test('the line the app reads: "baked <n>/<total> frames"', () => {
  const lines = []
  createBakeProgress({ total: 10, log: (m) => lines.push(m) })()
  assert.match(lines[0], /^baked (\d+)\/(\d+) frames$/)
})

// --- 3D chunk timing and `bake left` (§737) ---------------------------------

const GB = 1e9
const seg = (id, over = {}) => ({
  id, frameCount: 10, fps: 30, width: 108, height: 192, startSeconds: 0, endSeconds: 1,
  outputPath: `/nonexistent/${id}.mkv`, boundary: { allows: () => true }, ...over,
})
const flat = (id) => seg(id)
const stage = (id) => seg(id, { scene3d: true })

/** Runs a render on a fake clock: each job takes `msOf(job)`, advanced inside the fake renderJob. Returns the log lines. */
async function run(segments, msOf, { tickMs = 0, ...config } = {}) {
  let t = 1_000_000
  const lines = []
  const orig = process.stderr.write
  process.stderr.write = (c) => { lines.push(String(c).replace(/\n$/, '').replace(/^.*\[montaj render\]\S* /, '')); return true }
  try {
    await renderAllSegments(segments, {
      workers: 1, chunkSize: 1000, now: () => t, playback: { isPlaying: () => false }, relaunchDelayMs: 0,
      memory: { readAvailable: () => 30 * GB, totalBytes: 36 * GB, pollMs: 1 },
      launchWorker: async () => ({ close: async () => {} }),
      renderJob: async (_w, job, { onFrame }) => {
        for (let f = job.frameStart; f < job.frameEnd; f++) onFrame()
        if (tickMs) await new Promise((r) => setTimeout(r, tickMs)) // lets a second lane's job overlap
        t += msOf(job)
        return { webmPath: job.outputPath }
      },
      ...config,
    })
  } finally { process.stderr.write = orig }
  return lines
}

const left = (lines) => lines.filter((l) => l.startsWith('bake left '))
const at = (lines, pred) => lines.findIndex(pred)

test('a 3D chunk logs its frames, subframes, time and lanes; no bake left until a 2D job has finished too', async () => {
  const segs = [stage('a'), stage('b'), stage('c'), ...Array.from({ length: 10 }, (_, i) => flat(`t${i}`))]
  const lines = await run(segs, (j) => (j.scene3d ? 30000 : 1000))
  assert.ok(lines.includes('3d chunk a: 10 frames x1 in 30000 ms (lanes 1)'))
  assert.ok(lines.includes('3d chunk c: 10 frames x1 in 30000 ms (lanes 1)'))
  const firstLeft = at(lines, (l) => l.startsWith('bake left '))
  const firstTwoD = at(lines, (l) => l.startsWith('encoded t0 '))
  assert.ok(firstLeft > firstTwoD && firstTwoD > at(lines, (l) => l.startsWith('3d chunk c')), 'nothing before a 2D job has finished')
  // t1 in flight (elapsed 0): 8 queued jobs x 1 s + the 1 s in flight.
  assert.equal(lines[firstLeft], 'bake left 9 s')
  assert.match(lines.filter((l) => l.startsWith('baked ')).at(-1), /^baked 130\/130 frames$/)
})

test('with 3D still queued, bake left counts those jobs at the measured 3D time', async () => {
  const segs = [flat('t0'), stage('a'), stage('b'), stage('c'), ...Array.from({ length: 5 }, (_, i) => flat(`u${i}`))]
  const lines = await run(segs, (j) => (j.scene3d ? 30000 : 1000))
  const lefts = left(lines)
  // First line: after chunk a (30 s) is measured, b in flight (elapsed 0): b 30 + c queued 30 + 5 x 1 s of 2D.
  assert.equal(lefts[0], 'bake left 65 s')
  assert.ok(at(lines, (l) => l === lefts[0]) > at(lines, (l) => l.startsWith('3d chunk a')))
})

test('a 2D-only render logs bake left once a 2D job has finished', async () => {
  const segs = Array.from({ length: 4 }, (_, i) => flat(`t${i}`))
  const lines = await run(segs, () => 2000)
  assert.ok(at(lines, (l) => l.startsWith('bake left ')) > at(lines, (l) => l.startsWith('encoded t0 ')))
  assert.equal(left(lines)[0], 'bake left 6 s')
  assert.equal(lines.filter((l) => l.startsWith('3d chunk')).length, 0)
})

test('two 3D lanes: the chunk line says lanes 2 and bake left divides the queued 3D jobs by the lanes', async () => {
  const segs = Array.from({ length: 6 }, (_, i) => stage(`s${i}`))
  const calm = () => ({ level: 1, swapUsedBytes: 1 * GB, swapTotalBytes: 4 * GB })
  const lines = await run(segs, () => 30000, {
    workers: 2, tickMs: 10, memory: { readAvailable: () => 30 * GB, totalBytes: 36 * GB, pollMs: 1, readMemoryPressure: calm },
  })
  assert.ok(lines.some((l) => /^3d chunk s\d: 10 frames x1 in 30000 ms \(lanes 2\)$/.test(l)))
  assert.ok(left(lines).length > 0)
})

test('a motion-blur 3D chunk names its subframes', async () => {
  const lines = await run([stage('a')], () => 5000, { motionBlur: 4 })
  assert.ok(lines.includes('3d chunk a: 10 frames x4 in 5000 ms (lanes 1)'))
})

// --- seeds, whole-render tally, lane arithmetic (§737) -------------------------

test('with the app\'s seeds, bake left speaks from the first 3D frames, before any caption has been timed', async () => {
  const segs = [stage('a'), stage('b'), stage('c'), ...Array.from({ length: 10 }, (_, i) => flat(`t${i}`))]
  const lines = await run(segs, (j) => (j.scene3d ? 30000 : 1000), { estimateRates: { ms3dPerChunk: 30000, ms2dPerFrame: 100 } })
  const first = at(lines, (l) => l.startsWith('bake left '))
  assert.ok(first >= 0 && first < at(lines, (l) => l.startsWith('encoded t0 ')), 'before the first caption job ends')
  assert.ok(first < at(lines, (l) => l.startsWith('3d chunk b')), 'during the 3D bake')
  // a in flight (30 s) + b, c queued on one lane (60 s) + 100 caption frames x 100 ms.
  assert.equal(lines[first], 'bake left 100 s')
})

test('a seed covers only a kind that has not been measured; a kind with work left and no seed stays silent', async () => {
  const segs = [stage('a'), flat('t0')]
  const lines = await run(segs, (j) => (j.scene3d ? 30000 : 1000), { estimateRates: { ms3dPerChunk: 30000, ms2dPerFrame: 100 } })
  assert.equal(left(lines)[0], 'bake left 31 s')
})

test('two slices share one tally: the first call counts the second call\'s 3D chunks', async () => {
  const first = [stage('a'), stage('b')], second = [stage('c'), stage('d')]
  const cfg = { workers: 1, chunkSize: 1000 }
  const bakeTally = createBakeTally([...chunkJobs(first, cfg).jobs, ...chunkJobs(second, cfg).jobs])
  const bakeProgress = createBakeProgress({ total: 40, log: () => {} })
  const shared = { bakeTally, bakeProgress, estimateRates: { ms3dPerChunk: 30000, ms2dPerFrame: 100 } }
  const l1 = await run(first, () => 30000, shared)
  // a in flight (30 s) + b queued + the second call's two chunks: 4 x 30 s.
  assert.equal(left(l1)[0], 'bake left 120 s')
  const l2 = await run(second, () => 30000, shared)
  assert.equal(bakeTally.left3d, 0)
  assert.ok(left(l2).length > 0)
  // c in flight (30 s) + d queued, both counted from the shared tally.
  assert.equal(left(l2)[0], 'bake left 60 s')
})

test('8 equal caption jobs in flight add one job\'s time left, not eight', async () => {
  const segs = Array.from({ length: 8 }, (_, i) => flat(`t${i}`))
  let started = 0
  let release
  const allStarted = new Promise((r) => { release = r })
  const lines = await run(segs, () => 4000, {
    workers: 8, estimateRates: { ms3dPerChunk: 1, ms2dPerFrame: 400 },
    // Every job waits for all eight to be in flight before its first frame, so the first line sees them side by side.
    renderJob: async (_w, job, { onFrame }) => {
      if (++started === 8) release()
      await allStarted
      for (let f = job.frameStart; f < job.frameEnd; f++) onFrame()
      return { webmPath: job.outputPath }
    },
  })
  // 10 frames x 400 ms seed = 4 s per job; all 8 in flight at elapsed 0 (fake clock), none queued: 4 s, not 32 s.
  assert.equal(left(lines)[0], 'bake left 4 s')
})

test('one queued chunk with two idle lanes counts one chunk, not half', async () => {
  const segs = [stage('a'), stage('b')]
  const calm = () => ({ level: 1, swapUsedBytes: 1 * GB, swapTotalBytes: 4 * GB })
  const lines = await run(segs, () => 30000, {
    workers: 2, tickMs: 10, estimateRates: { ms3dPerChunk: 30000, ms2dPerFrame: 1 },
    memory: { readAvailable: () => 30 * GB, totalBytes: 36 * GB, pollMs: 1, readMemoryPressure: calm },
  })
  // a in flight, b queued, one lane active when the first line is logged: 30 s + 30 s.
  assert.equal(left(lines)[0], 'bake left 60 s')
})

test('a parked second lane stops halving the queued 3D time', async () => {
  const segs = Array.from({ length: 6 }, (_, i) => stage(`s${i}`))
  let reads = 0
  const pressure = () => ({ level: ++reads <= 2 ? 1 : 2, swapUsedBytes: 1 * GB, swapTotalBytes: 4 * GB })
  const lines = await run(segs, () => 30000, {
    workers: 2, tickMs: 10, estimateRates: { ms3dPerChunk: 30000, ms2dPerFrame: 1 },
    memory: { readAvailable: () => 30 * GB, totalBytes: 36 * GB, pollMs: 1, lazySecondLane: true, readMemoryPressure: pressure },
  })
  const waits = at(lines, (l) => l.startsWith('3d lane 2: waits'))
  assert.ok(waits > 0)
  const after = left(lines.slice(waits))
  // Measured mean (30 + 60 + 60) / 3 = 50 s (the fake clock is shared by both lanes); s3 in flight, s4 and s5 queued on ONE lane.
  assert.equal(after[0], 'bake left 150 s')
})
