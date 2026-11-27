// render/test/segment-filter.test.mjs
//
// A cinematic segment's host filter (scene3d-host.js segmentFilter, renderer.js assemble): the host contract (optional,
// only for cinematic jobs, a string or nothing, never throws), the filter running on the segment's joined 3D layer so it
// sees across chunk seams, each shot between camera cuts on its own (cuts from a fresh chunk or from a reused chunk's
// cache entry), a failing filter leaving the segment as it was, and a segment that is not cinematic never filtered.
// The browsers and chunk renders are fakes (config.launchWorker/renderJob, as renderer-segment-cache.test.mjs); each
// fake chunk is real FFV1 from the bundled ffmpeg, so the concat and the filter run for real. No Chrome.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { FFMPEG } from '../ffmpeg-bin.js'
import { renderAllSegments, chunkJobs, chunkLabel, shotRanges, shotFilterGraph, filterSegment, captureOptionsFor } from '../renderer.js'
import { openSegmentCache } from '../segment-cache.js'
import { segmentFilterOf, look3dDenoiseOf, SCENE3D_NATIVE_ENV } from '../scene3d-host.js'

const GB = 1e9
const ENGINE = Object.freeze({ source: 'engine-under-test', ffmpeg: 'ffmpeg-under-test', chrome: null, software3d: false })
// Deterministic and temporal: each output frame is the mean of its neighbours, so a seam or a cut shows.
const VF = 'tmix=frames=3:weights=1 1 1'
const MKV = ['-c:v', 'ffv1', '-g', '1', '-pix_fmt', 'yuv420p', '-f', 'matroska', '-cluster_size_limit', '2000000', '-reserve_index_space', '1000000']

let root, source, componentPath, htmlPath

function ff(args) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })
  assert.equal(r.status, 0, r.stderr)
  return r
}

/** Frames [a, b) of the source, as their own FFV1 file (in `pixFmt`: a chunk's is its capture format). */
function part(a, b, out, pixFmt = 'yuv420p') {
  ff(['-i', source, '-vf', `trim=start_frame=${a}:end_frame=${b},setpts=PTS-STARTPTS`, ...MKV, '-pix_fmt', pixFmt, out])
  return out
}

/** A file's frames as raw rgb24 buffers. */
function framesOf(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 })
  assert.equal(r.status, 0, String(r.stderr))
  const size = 32 * 18 * 3
  const out = []
  for (let i = 0; i + size <= r.stdout.length; i += size) out.push(r.stdout.subarray(i, i + size))
  return out
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'montaj-segment-filter-'))
  source = join(root, 'source.mkv')
  // Six frames of noise that changes every frame: any temporal filter's output depends on its neighbours.
  ff(['-f', 'lavfi', '-i', 'color=c=gray:s=32x18:r=30,noise=alls=60:allf=t', '-frames:v', '6', ...MKV, source])
  componentPath = join(root, 'stage.jsx')
  writeFileSync(componentPath, 'export default () => null')
  mkdirSync(join(root, 'page'))
  htmlPath = join(root, 'page', 'index.html')
  writeFileSync(htmlPath, '<html>stage</html>')
  writeFileSync(join(root, 'page', 'bundle.js'), 'console.log("stage")')
})

after(() => { rmSync(root, { recursive: true, force: true }) })

/** A bundled 3D segment spec of 6 frames (render.js's shape); cinematic unless `over` says otherwise. */
function shot(segDir, id, over = {}) {
  return {
    id, componentPath, htmlPath, props: { sceneJson: JSON.stringify({ shot: id }) }, scene3d: true,
    cinematic: true, cinematicKey: 'host-under-test|samples=64', look3dQuality: 'standard', opaque: true,
    frameCount: 6, fps: 30, width: 32, height: 18, captureScale: 1, sdrMaster: true,
    startSeconds: 0, endSeconds: 6 / 30, outputPath: join(segDir, `${id}.mkv`),
    boundary: { allows: () => true }, propsCache: new Map(), ...over,
  }
}

const baseConfig = {
  workers: 1, chunkSize: 3, userConfig: {}, check3dGraphics: null, relaunchDelayMs: 0,
  launchWorker: async () => ({ close: async () => {} }),
  memory: { readAvailable: () => 30 * GB, totalBytes: 36 * GB, pollMs: 1 },
  playback: { isPlaying: () => false },
}

/** A fake chunk render: the chunk's frames of the source, as renderChunk's FFV1; a cinematic chunk reports `cuts`. */
function fakeRender(calls, cuts = []) {
  return async (_worker, job, { onFrame } = {}) => {
    calls.push(chunkLabel(job))
    const out = job.outputPath.replace(/\.\w+$/, '') + `-chunk-${job.chunkIndex}.mkv`
    mkdirSync(dirname(out), { recursive: true })
    part(job.frameStart, job.frameEnd, out, captureOptionsFor(job).pixFmt)
    for (let f = job.frameStart; f < job.frameEnd; f++) onFrame?.()
    return { webmPath: out, ...(job.cinematic === true ? { cuts } : {}) }
  }
}

/** Runs fn with the render's stderr log captured: its lines, without the '[montaj render] ' prefix, go to `lines`. */
async function quiet(fn, lines) {
  const orig = process.stderr.write
  process.stderr.write = (c) => { for (const l of String(c).split('\n')) if (l) lines.push(l.replace(/^.*\[montaj render\]\S* /, '')); return true }
  try { return await fn() } finally { process.stderr.write = orig }
}

/** One export as render.js runs it, with the segment cache in `dir`. */
async function exportOnce(dir, specs, config = {}) {
  const lines = []
  const cache = openSegmentCache({ dir: join(dir, 'cache'), engine: ENGINE, env: {}, context: { colorSpace: 'sdr_bt709' }, log: (l) => lines.push(l) })
  const cfg = { ...baseConfig, segmentFilterOf: async () => VF, ...config, segmentCache: cache }
  cache.begin(chunkJobs(specs, cfg).jobs)
  let out
  try { out = await quiet(() => renderAllSegments(specs, cfg), lines) } finally { cache.end() }
  return { out, lines }
}

const scratch = () => mkdtempSync(join(root, 'export-'))

test('the host contract: segmentFilter is optional, only for cinematic jobs, a string or nothing, never throws', async () => {
  const dir = mkdtempSync(join(root, 'hosts-'))
  const host = (name, body) => {
    const p = join(dir, `${name}.mjs`)
    writeFileSync(p, `export const version = '1'\nexport function cacheKey() { return 'k' }\nexport async function captureChunk() {}\n${body}`)
    return { [SCENE3D_NATIVE_ENV]: p }
  }
  const cine = { id: 'a', cinematic: true }
  const withFilter = host('with', `export function segmentFilter(job) { return job.look3dDenoise === false ? null : 'atadenoise' }`)
  assert.equal(await segmentFilterOf(cine, withFilter), 'atadenoise')
  assert.equal(await segmentFilterOf({ ...cine, look3dDenoise: false }, withFilter), null)
  assert.equal(await segmentFilterOf({ id: 'b', scene3d: true }, withFilter), null, 'a job that is not cinematic gets no filter')
  assert.equal(await segmentFilterOf(cine, host('without', '')), null, 'the export is optional')
  assert.equal(await segmentFilterOf(cine, host('throws', `export function segmentFilter() { throw new Error('x') }`)), null)
  assert.equal(await segmentFilterOf(cine, host('blank', `export function segmentFilter() { return '  ' }`)), null)
  assert.equal(await segmentFilterOf(cine, {}), null, 'no host is no filter')
  assert.equal(look3dDenoiseOf({}), true)
  assert.equal(look3dDenoiseOf(undefined), true)
  assert.equal(look3dDenoiseOf({ look3dDenoise: false }), false)
  assert.equal(look3dDenoiseOf({ look3dDenoise: 'no' }), true)
})

test('shots: cut at whole frames inside the file, a mid-frame cut starts its shot at the next frame', () => {
  assert.deepEqual(shotRanges(6, []), [[0, 6]])
  assert.deepEqual(shotRanges(6, [4]), [[0, 4], [4, 6]])
  assert.deepEqual(shotRanges(6, [3.5, 0, 6, 9, -1, 3.5]), [[0, 4], [4, 6]])
  assert.deepEqual(shotRanges(6, [1.0000001]), [[0, 1], [1, 6]])
  assert.equal(shotFilterGraph(VF, [[0, 6]]), `[0:v]${VF}[v]`)
  assert.equal(shotFilterGraph('x', [[0, 4], [4, 6]]),
    '[0:v]split=2[s0][s1];[s0]trim=start_frame=0:end_frame=4,setpts=PTS-STARTPTS,x[f0];'
    + '[s1]trim=start_frame=4:end_frame=6,setpts=PTS-STARTPTS,x[f1];[f0][f1]concat=n=2:v=1:a=0[v]')
})

test('the filter runs on the joined segment: frames at the chunk seam see the other chunk', async () => {
  const dir = scratch()
  const calls = []
  let pixFmt = null
  const filterSpy = async (input, output, opts) => { pixFmt = opts.pixFmt; return filterSegment(input, output, opts) }
  const { out, lines } = await exportOnce(dir, [shot(join(dir, 'segs'), 'cine')], { renderJob: fakeRender(calls), filterSegment: filterSpy })
  assert.equal(calls.length, 2, 'two chunks of 3 frames')
  assert.match(out[0].webmPath, /-filtered\.mkv$/)
  assert.ok(lines.some((l) => l === 'segment filter: cine, 1 shot(s)'), lines.join('\n'))
  // The same filter over the six frames in one piece: identical, so the seam frames used both chunks.
  const whole = join(dir, 'whole.mkv')
  await filterSegment(source, whole, { vf: VF, ranges: [[0, 6]], pixFmt })
  const got = framesOf(out[0].webmPath), want = framesOf(whole)
  assert.equal(got.length, 6)
  got.forEach((f, i) => assert.ok(f.equals(want[i]), `frame ${i}`))
  // Filtering each chunk on its own would differ at the seam (tmix mixes a frame with the two before it, so the second
  // chunk's first frame): the check above can fail.
  const second = join(dir, 'second.mkv')
  await filterSegment(part(3, 6, join(dir, 'p1.mkv')), second, { vf: VF, ranges: [[0, 3]], pixFmt })
  assert.ok(!framesOf(second)[0].equals(want[3]), 'per-chunk filtering differs at the seam')
  assert.ok(!existsSync(join(dir, 'segs', 'cine.mkv')), 'the joined, unfiltered file is removed')
})

test('each shot is filtered on its own: nothing blends across a camera cut, from a fresh or a reused chunk', async () => {
  const dir = scratch()
  const specs = [shot(join(dir, 'segs'), 'cut')]
  const ranges = []
  let pixFmt = null
  const filterSpy = async (input, output, opts) => { ranges.push(opts.ranges); pixFmt = opts.pixFmt; return filterSegment(input, output, opts) }
  const calls = []
  const first = await exportOnce(dir, specs, { renderJob: fakeRender(calls, [4]), filterSegment: filterSpy })
  assert.deepEqual(ranges[0], [[0, 4], [4, 6]])
  const got = framesOf(first.out[0].webmPath)
  for (const [a, b] of [[0, 4], [4, 6]]) {
    const alone = join(dir, `alone-${a}.mkv`)
    await filterSegment(part(a, b, join(dir, `src-${a}.mkv`)), alone, { vf: VF, ranges: [[0, b - a]], pixFmt })
    framesOf(alone).forEach((f, i) => assert.ok(f.equals(got[a + i]), `shot ${a}-${b}, frame ${a + i}`))
  }
  // The next export reuses both chunks (no render) and still has the shots, from the cache entries.
  const again = await exportOnce(dir, specs, { renderJob: fakeRender(calls, [99]), filterSegment: filterSpy })
  assert.equal(calls.length, 2, 'nothing rendered the second time')
  assert.deepEqual(ranges[1], [[0, 4], [4, 6]])
  framesOf(again.out[0].webmPath).forEach((f, i) => assert.ok(f.equals(got[i]), `reused export, frame ${i}`))
})

test('a filter that fails leaves the segment as it was, with one log line', async () => {
  const dir = scratch()
  const { out, lines } = await exportOnce(dir, [shot(join(dir, 'segs'), 'cine')], {
    renderJob: fakeRender([]), filterSegment: async () => { throw new Error('No such filter: atadenoise\nmore') },
  })
  assert.match(out[0].webmPath, /cine\.mkv$/)
  assert.equal(framesOf(out[0].webmPath).length, 6)
  assert.ok(lines.includes('segment filter: cine left unfiltered (No such filter: atadenoise)'), lines.join('\n'))
})

test('a 3D segment that is not cinematic (Standard) is never filtered', async () => {
  const dir = scratch()
  let asked = 0, ran = 0
  const { out } = await exportOnce(dir, [shot(join(dir, 'segs'), 'std', { cinematic: undefined, cinematicKey: undefined })], {
    renderJob: fakeRender([]),
    segmentFilterOf: async () => { asked++; return VF },
    filterSegment: async () => { ran++ },
  })
  assert.equal(asked, 0)
  assert.equal(ran, 0)
  assert.match(out[0].webmPath, /std\.mkv$/)
  const want = framesOf(source)
  framesOf(out[0].webmPath).forEach((f, i) => assert.ok(f.equals(want[i]), `frame ${i} untouched`))
})
