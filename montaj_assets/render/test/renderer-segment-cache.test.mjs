// render/test/renderer-segment-cache.test.mjs
//
// renderAllSegments with the export's segment cache (segment-cache.js): a 3D chunk the cache holds is not rendered,
// its frames reach the bake counter at once and it takes no browser; every 3D chunk that encodes is kept, a failed
// render keeps the chunks it finished, and 2D jobs never touch the cache. The browsers and chunk renders are fakes
// (`config.launchWorker`, `config.renderJob`, as renderer-memory.test.mjs); each fake chunk is a real 3-frame FFV1
// file from the bundled ffmpeg, so the chunk concat and the cache's ffprobe checks run for real. No Chrome.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { FFMPEG } from '../ffmpeg-bin.js'
import { renderAllSegments, chunkJobs, chunkLabel, createBakeProgress } from '../renderer.js'
import { openSegmentCache } from '../segment-cache.js'
import { createReadRecorder } from '../read-set.js'
import { probeSegmentStreams } from '../segment-check.js'
import { sliceSpecs } from '../slice-run.js'
import { toFileHref } from '../file-url.js'

const GB = 1e9
const ENGINE = Object.freeze({ source: 'engine-under-test', ffmpeg: 'ffmpeg-under-test', chrome: null, software3d: false })

let root
let fixture3
let componentPath
let htmlPath

before(() => {
  root = mkdtempSync(join(tmpdir(), 'montaj-renderer-segcache-'))
  fixture3 = join(root, 'fixture3.mkv')
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=216x384:r=30', '-frames:v', '3',
    '-c:v', 'ffv1', '-g', '1', '-pix_fmt', 'yuva420p', '-f', 'matroska',
    '-cluster_size_limit', '2000000', '-reserve_index_space', '1000000', fixture3], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  componentPath = join(root, 'stage.jsx')
  writeFileSync(componentPath, 'export default () => null')
  mkdirSync(join(root, 'page'))
  htmlPath = join(root, 'page', 'index.html')
  writeFileSync(htmlPath, '<html>stage</html>')
  writeFileSync(join(root, 'page', 'bundle.js'), 'console.log("stage")')
})

after(() => { rmSync(root, { recursive: true, force: true }) })

/** A bundled 3D segment spec (render.js's shape) of `frameCount` frames, written under `segDir`. */
function shot(segDir, id, frameCount, over = {}) {
  return {
    id, componentPath, htmlPath, props: { sceneJson: JSON.stringify({ shot: id }) }, scene3d: true,
    frameCount, fps: 30, width: 108, height: 192, captureScale: 2, sdrMaster: true,
    startSeconds: 0, endSeconds: frameCount / 30, outputPath: join(segDir, `${id}.mkv`),
    boundary: { allows: () => true }, propsCache: new Map(), ...over,
  }
}

/** A 2D segment spec (a title, captions). */
function flat(segDir, id, over = {}) {
  return { ...shot(segDir, id, 3), scene3d: undefined, props: { text: id }, ...over }
}

const baseConfig = {
  workers: 1, chunkSize: 3, userConfig: {}, check3dGraphics: null, relaunchDelayMs: 0,
  memory: { readAvailable: () => 30 * GB, totalBytes: 36 * GB, pollMs: 1 },
  playback: { isPlaying: () => false },
}

/** A fake chunk render: a 3-frame FFV1 chunk where renderChunk writes one, a frame reported per frame. */
function fakeRender(calls, { failOn = () => false, reads = () => undefined } = {}) {
  return async (_worker, job, { onFrame } = {}) => {
    calls.push(chunkLabel(job))
    if (failOn(job)) throw new Error(`${chunkLabel(job)} failed`)
    const out = job.outputPath.replace(/\.\w+$/, '') + `-chunk-${job.chunkIndex}.mkv`
    mkdirSync(dirname(out), { recursive: true })
    copyFileSync(fixture3, out)
    for (let f = job.frameStart; f < job.frameEnd; f++) onFrame?.()
    return { webmPath: out, reads: reads(job) }
  }
}

function openCache(dir, lines = []) {
  return openSegmentCache({ dir, engine: ENGINE, env: {}, context: { colorSpace: 'sdr_bt709' }, log: (l) => lines.push(l) })
}

async function quietStderr(fn) {
  const orig = process.stderr.write
  let text = ''
  process.stderr.write = (c) => { text += String(c); return true }
  try { return [await fn(), text] } finally { process.stderr.write = orig }
}

/**
 * One export as render.js runs it: the cache opened, begin() with every chunk the export plans, renderAllSegments with
 * the cache (once per slice for a sliced one), end() whether it finished or failed.
 */
async function exportOnce(dir, specLists, config = {}) {
  const lines = []
  const cache = openCache(dir, lines)
  const cfg = { ...baseConfig, ...config, segmentCache: config.segmentCache?.(cache) ?? cache }
  cache.begin(specLists.flatMap((specs) => chunkJobs(specs, cfg).jobs))
  const outs = []
  let error = null
  const [, stderr] = await quietStderr(async () => {
    try {
      for (const specs of specLists) outs.push(await renderAllSegments(specs, cfg))
    } catch (err) {
      error = err
    } finally {
      cache.end()
    }
  })
  return { outs, error, lines, stderr, cache }
}

const scratch = () => {
  const dir = mkdtempSync(join(root, 'export-'))
  return { cacheDir: join(dir, 'render', 'segment-cache'), segDir: join(dir, 'render', 'segments') }
}
const files = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : [])
const entryFiles = (cache, jobs) => jobs.flatMap((j) => [`${cache.keyOf(j)}.json`, `${cache.keyOf(j)}.mkv`]).sort()

test('a 3-chunk 3D segment with chunks 1 and 2 cached renders only chunk 3, and its bake counter reaches the total', async () => {
  const { cacheDir, segDir } = scratch()
  const segs = [shot(segDir, 'shot', 9)]
  const jobs = chunkJobs(segs, baseConfig).jobs
  assert.equal(jobs.length, 3)
  const pre = openCache(cacheDir)
  assert.ok(pre.store(jobs[0], fixture3) && pre.store(jobs[1], fixture3))

  const calls = []
  const bake = []
  const { outs, error, stderr, cache } = await exportOnce(cacheDir, [segs], {
    renderJob: fakeRender(calls),
    launchWorker: async () => ({ close: async () => {} }),
    bakeProgress: createBakeProgress({ total: 9, log: (l) => bake.push(l) }),
  })
  assert.equal(error, null)
  assert.deepEqual(calls, ['shot chunk 3/3'])
  assert.equal(bake.at(-1), 'baked 9/9 frames')
  assert.match(stderr, /reused shot chunk 1\/3 \(1\/3 done\)/)
  assert.match(stderr, /reused shot chunk 2\/3 \(2\/3 done\)/)
  assert.match(stderr, /encoded shot chunk 3\/3 \(3\/3 done\)/)
  assert.doesNotMatch(stderr, /3d chunk shot chunk [12]\/3:/, 'a reused chunk logs no timing (§737)')
  assert.match(stderr, /3d chunk shot chunk 3\/3: 3 frames x1 in \d+ ms \(lanes 1\)/)
  assert.doesNotMatch(stderr, /bake left/, 'no time left is said with no 2D work')
  // The joined segment holds all nine frames, and the concat left the two cached chunks in place.
  const video = probeSegmentStreams(outs[0][0].webmPath).find((s) => s.codec_type === 'video')
  assert.equal(Number(video.nb_read_packets), 9)
  assert.deepEqual(files(cacheDir), entryFiles(cache, jobs), 'chunks 1 and 2 kept, chunk 3 written')
})

test('a render that fails on chunk 3 keeps chunks 1 and 2, and the next render reuses them', async () => {
  const { cacheDir, segDir } = scratch()
  const segs = [shot(segDir, 'shot', 9)]
  const launchWorker = async () => ({ close: async () => {} })
  const first = []
  const failed = await exportOnce(cacheDir, [segs], { renderJob: fakeRender(first, { failOn: (j) => j.chunkIndex === 2 }), launchWorker })
  assert.match(String(failed.error?.message), /shot chunk 3\/3 failed/)
  assert.deepEqual(first, ['shot chunk 1/3', 'shot chunk 2/3', 'shot chunk 3/3'])
  const jobs = chunkJobs(segs, baseConfig).jobs
  assert.deepEqual(files(cacheDir), entryFiles(failed.cache, jobs.slice(0, 2)))

  const second = []
  const again = await exportOnce(cacheDir, [segs], { renderJob: fakeRender(second), launchWorker })
  assert.equal(again.error, null)
  assert.deepEqual(second, ['shot chunk 3/3'])
  assert.equal((again.stderr.match(/reused shot chunk/g) ?? []).length, 2)
  assert.deepEqual(files(cacheDir), entryFiles(again.cache, jobs))
})

test('2D jobs never touch the cache', async () => {
  const { cacheDir, segDir } = scratch()
  const segs = [shot(segDir, 'shot', 3), flat(segDir, 'title'), flat(segDir, 'captions', { isCaption: true })]
  const touched = []
  const spy = (cache) => ({
    ...cache,
    lookup: (job) => { touched.push(`lookup ${job.id}`); return cache.lookup(job) },
    store: (job, file, reads) => { touched.push(`store ${job.id}`); return cache.store(job, file, reads) },
  })
  const calls = []
  const { error, cache } = await exportOnce(cacheDir, [segs], {
    workers: 2, renderJob: fakeRender(calls), launchWorker: async () => ({ close: async () => {} }), segmentCache: spy,
  })
  assert.equal(error, null)
  assert.deepEqual(calls.sort(), ['captions', 'shot', 'title'])
  assert.deepEqual(touched, ['lookup shot', 'store shot'])
  assert.deepEqual(files(cacheDir), entryFiles(cache, chunkJobs([segs[0]], baseConfig).jobs))

  const only2d = scratch()
  touched.length = 0
  const flatOnly = await exportOnce(only2d.cacheDir, [[flat(only2d.segDir, 'title'), flat(only2d.segDir, 'captions', { isCaption: true })]], {
    workers: 2, renderJob: fakeRender([]), launchWorker: async () => ({ close: async () => {} }), segmentCache: spy,
  })
  assert.equal(flatOnly.error, null)
  assert.deepEqual(touched, [])
  assert.deepEqual(files(only2d.cacheDir), [])
})

test('a fully cached render launches no browser; with 2D jobs left it launches only what they need', async () => {
  const { cacheDir, segDir } = scratch()
  const segs = [shot(segDir, 'a', 6), shot(segDir, 'b', 3)]
  const jobs = chunkJobs(segs, baseConfig).jobs
  const pre = openCache(cacheDir)
  for (const j of jobs) assert.ok(pre.store(j, fixture3))

  let launches = 0
  const launchWorker = async () => { launches++; return { close: async () => {} } }
  const calls = []
  const bake = []
  const { outs, error, stderr } = await exportOnce(cacheDir, [segs], {
    workers: 2, renderJob: fakeRender(calls), launchWorker, bakeProgress: createBakeProgress({ total: 9, log: (l) => bake.push(l) }),
  })
  assert.equal(error, null)
  assert.equal(launches, 0)
  assert.deepEqual(calls, [])
  assert.equal(bake.at(-1), 'baked 9/9 frames')
  assert.doesNotMatch(stderr, /launching/)
  const [a, b] = outs[0]
  assert.equal(a.webmPath, join(segDir, 'a.mkv'), 'two chunks joined into the segment')
  assert.equal(dirname(b.webmPath), cacheDir, 'one chunk: the cached file itself')
  assert.equal(files(cacheDir).length, 6, 'nothing of the cache consumed')

  launches = 0
  const mixed = await exportOnce(cacheDir, [[...segs, flat(segDir, 'title')]], { workers: 2, renderJob: fakeRender(calls), launchWorker })
  assert.equal(mixed.error, null)
  assert.equal(launches, 1, 'one browser, for the one 2D job')
  assert.deepEqual(calls, ['title'])
})

test('after an export that reused 2 entries and wrote 1, exactly those 3 remain; an older export\'s entry is gone', async () => {
  const { cacheDir, segDir } = scratch()
  const segs = [shot(segDir, 's0', 3), shot(segDir, 's1', 3), shot(segDir, 's2', 3)]
  const jobs = chunkJobs(segs, baseConfig).jobs
  const older = chunkJobs([shot(segDir, 'cut-shot', 3)], baseConfig).jobs
  const pre = openCache(cacheDir)
  for (const j of [jobs[0], jobs[1], older[0]]) assert.ok(pre.store(j, fixture3))

  const calls = []
  const { error, cache } = await exportOnce(cacheDir, [segs], { renderJob: fakeRender(calls), launchWorker: async () => ({ close: async () => {} }) })
  assert.equal(error, null)
  assert.deepEqual(calls, ['s2'])
  assert.deepEqual(files(cacheDir), entryFiles(cache, jobs))
  assert.ok(!files(cacheDir).some((f) => f.startsWith(cache.keyOf(older[0]))))
})

test('a sliced render: one begin for every slice, each window its own key, and the next export reuses every window', async () => {
  const { cacheDir, segDir } = scratch()
  const spec = shot(segDir, 'long', 6)
  const slices = [{ start: 0, end: 0.1 }, { start: 0.1, end: 0.2 }]
  const windows = () => slices.map((s, k) => sliceSpecs([spec], s, 30, join(segDir, `slice-0${k + 1}`)))
  assert.deepEqual(windows().map(([w]) => [w.frameFrom, w.frameTo]), [[0, 3], [3, 6]])
  const launchWorker = async () => ({ close: async () => {} })

  const first = []
  const one = await exportOnce(cacheDir, windows(), { renderJob: fakeRender(first), launchWorker })
  assert.equal(one.error, null)
  assert.deepEqual(first, ['long', 'long'])
  assert.equal(files(cacheDir).length, 4, 'two windows, two keys')

  const second = []
  const two = await exportOnce(cacheDir, windows(), { renderJob: fakeRender(second), launchWorker })
  assert.equal(two.error, null)
  assert.deepEqual(second, [])
  assert.equal((two.stderr.match(/reused long/g) ?? []).length, 2)
  assert.equal(files(cacheDir).length, 4)
})

test('a re-export sliced at a different budget (other windows) reuses the interior chunks', async () => {
  const { cacheDir, segDir } = scratch()
  const spec = shot(segDir, 'long', 9)
  const windowsFor = (slices) => slices.map((s, k) => sliceSpecs([spec], s, 30, join(segDir, `slice-0${k + 1}`)))
  const launchWorker = async () => ({ close: async () => {} })
  const first = []
  const one = await exportOnce(cacheDir, windowsFor([{ start: 0, end: 0.1 }, { start: 0.1, end: 0.3 }]), { renderJob: fakeRender(first), launchWorker })
  assert.equal(one.error, null)
  assert.equal(first.length, 3, 'three chunks on the 3-frame grid')
  const second = []
  const two = await exportOnce(cacheDir, windowsFor([{ start: 0, end: 0.2 }, { start: 0.2, end: 0.3 }]), { renderJob: fakeRender(second), launchWorker })
  assert.equal(two.error, null)
  assert.deepEqual(second, [], 'other edges, the same chunks')
  assert.equal(files(cacheDir).length, 6)
})

test('what a chunk\'s page read rides from renderJob to the cache: a changed read renders that chunk again', async () => {
  const { cacheDir, segDir } = scratch()
  const texture = join(root, 'texture.png')
  writeFileSync(texture, 'pixels')
  const segs = [shot(segDir, 'a', 3), shot(segDir, 'b', 3)]
  const reads = (job) => {
    const rec = createReadRecorder()
    if (job.id === 'a') rec.allowed(toFileHref(texture))
    return rec.reads()
  }
  const launchWorker = async () => ({ close: async () => {} })
  await exportOnce(cacheDir, [segs], { renderJob: fakeRender([], { reads }), launchWorker })
  appendFileSync(texture, ' edited')
  const calls = []
  const again = await exportOnce(cacheDir, [segs], { renderJob: fakeRender(calls, { reads }), launchWorker })
  assert.equal(again.error, null)
  assert.deepEqual(calls, ['a'])
  assert.match(again.lines.join('\n'), /segment cache: a not reused \(.*texture\.png changed\)/)
})
