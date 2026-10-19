// render/test/render-estimate.test.mjs
//
// §213: render.js --estimate plans a render as far as its disk check and
// writes nothing. These are the planning pieces, run against an ffprobe stub
// (audio-strip-atomic.test.mjs's pattern): the stub is the process the OS
// spawned, and it answers each probe from a table of invented source facts, so
// what normalize would do with a source is decided without any real media.
// ffmpeg-bin.js reads MONTAJ_FFPROBE once, at import, so the env is set first
// and render.js is imported dynamically after it.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, utimesSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-render-estimate-')))
after(() => rmSync(WORK, { recursive: true, force: true }))
const PROBE_STUB = join(WORK, 'ffprobe-stub.cjs')
const FACTS = join(WORK, 'facts.json')

// Answers render.js's probes from FACTS[path]: { transfer, pix, width, height,
// fps, duration, gop, audio, comment }. An unknown path fails, as ffprobe does.
writeFileSync(PROBE_STUB, `#!/usr/bin/env node
const fs = require('fs')
const argv = process.argv.slice(2)
const path = argv[argv.length - 1]
const f = JSON.parse(fs.readFileSync(process.env.STUB_FACTS, 'utf8'))[path]
if (!f) process.exit(1)
const entries = argv[argv.indexOf('-show_entries') + 1] || ''
const out = (s) => { process.stdout.write(s); process.exit(0) }
if (entries === 'stream=width,height,pix_fmt,color_transfer,r_frame_rate:format=duration') {
  out(JSON.stringify({ streams: [{ width: f.width, height: f.height, pix_fmt: f.pix,
    color_transfer: f.transfer, r_frame_rate: f.fps + '/1' }], format: { duration: String(f.duration) } }))
}
if (entries === 'packet=pts_time,flags') {
  const lines = []
  for (let t = 0; t <= 10; t += f.gop) lines.push(t.toFixed(6) + ',K__')
  out(lines.join('\\n') + '\\n')
}
if (entries === 'stream=index') out(Array.from({ length: f.audio || 0 }, (_, i) => String(i + 1)).join('\\n') + '\\n')
if (entries === 'stream=codec_type') out(f.audio ? 'audio\\n' : '')
if (entries === 'stream=color_transfer') out((f.transfer || '') + '\\n')
if (entries === 'format_tags=comment') out((f.comment || '') + '\\n')
process.exit(1)
`, { mode: 0o755 })
writeFileSync(FACTS, '{}')
process.env.MONTAJ_FFPROBE = PROBE_STUB
process.env.STUB_FACTS = FACTS

const {
  resolveEstimateOverrides, planVideoItemWrites, isConformant, normalizedMasterCache, estimateMain,
  buildNormalizedOutputPath, UNTAGGED_MASTER_MARKER, planSlicing,
} = await import('../render.js')
const { estimateRenderDisk } = await import('../disk-space.js')
const { MASTER_LOOK } = await import('../look.js')

let n = 0
/** A fresh folder of invented sources: `files` maps a name to its probe facts. */
function sources(files) {
  const dir = join(WORK, `case-${++n}`)
  mkdirSync(dir)
  const facts = JSON.parse(readFileSync(FACTS, 'utf8'))
  const paths = {}
  for (const [name, f] of Object.entries(files)) {
    paths[name] = join(dir, name)
    writeFileSync(paths[name], 'x'.repeat(f.bytes ?? 1000))
    facts[paths[name]] = f
  }
  writeFileSync(FACTS, JSON.stringify(facts))
  return { dir, paths }
}
/** Every path under `dir`, relative and sorted. */
function listing(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name)
    out.push(path.slice(base.length + 1))
    if (e.isDirectory()) listing(path, base, out)
  }
  return out.sort()
}
const age = (path, seconds) => { const t = new Date(Date.now() - seconds * 1000); utimesSync(path, t, t) }

const SDR_OK = { transfer: 'bt709', pix: 'yuv420p', width: 1080, height: 1920, fps: 30, duration: 20, gop: 1, audio: 1 }
const SDR_444 = { ...SDR_OK, pix: 'yuv444p' }           // not a pixel format an SDR project keeps
const SDR_LONG_GOP = { ...SDR_OK, gop: 12 }             // past MAX_KEYFRAME_INTERVAL_S
const HLG = { transfer: 'arib-std-b67', pix: 'yuv420p10le', width: 2160, height: 3840, fps: 30, duration: 61, gop: 1, audio: 2 }

test('--resolution and --fps: absent is null, well formed is parsed, anything else is refused', () => {
  assert.equal(resolveEstimateOverrides({}), null)
  assert.deepEqual(resolveEstimateOverrides({ resolution: '2160x3840' }), { resolution: [2160, 3840] })
  assert.deepEqual(resolveEstimateOverrides({ fps: '23.976' }), { fps: 23.976 })
  assert.deepEqual(resolveEstimateOverrides({ resolution: '1920x1080', fps: '60' }), { resolution: [1920, 1080], fps: 60 })
  // §284: --motion-blur, the setting's own range; 1 (off) is a real override.
  assert.deepEqual(resolveEstimateOverrides({ motionBlur: '1' }), { motionBlur: 1 })
  assert.deepEqual(resolveEstimateOverrides({ motionBlur: '0' }), { motionBlur: 1 }, '0 is off, as in the setting')
  assert.deepEqual(resolveEstimateOverrides({ fps: '30', motionBlur: '3' }), { fps: 30, motionBlur: 3 })
  for (const motionBlur of ['9', '1.5', 'x', '', '-1']) {
    assert.throws(() => resolveEstimateOverrides({ motionBlur }), /--motion-blur must be an integer from 0 to 8 \(0 or 1 is off\)/, motionBlur)
  }
  for (const resolution of ['big', '0x1920', '1080', '1080x', '-1x5', '1080 x 1920']) {
    assert.throws(() => resolveEstimateOverrides({ resolution }), /--resolution/, resolution)
  }
  for (const fps of ['0', '-30', 'fast', 'Infinity']) {
    assert.throws(() => resolveEstimateOverrides({ fps }), /--fps/, fps)
  }
})

test('the conformance test is normalize\'s: transfer, pixel format and keyframe interval for the target', () => {
  const info = (f) => ({ transfer: f.transfer, pixFmt: f.pix, maxKeyframeInterval: f.gop })
  assert.equal(isConformant(info(SDR_OK), 'sdr_bt709'), true)
  assert.equal(isConformant(info({ ...SDR_OK, transfer: 'unknown' }), 'sdr_bt709'), true, 'untagged reads as BT.709')
  assert.equal(isConformant(info(SDR_444), 'sdr_bt709'), false)
  assert.equal(isConformant(info(SDR_LONG_GOP), 'sdr_bt709'), false)
  assert.equal(isConformant(info({ ...SDR_OK, gop: 10 }), 'sdr_bt709'), true, 'the bound itself conforms')
  assert.equal(isConformant(info(HLG), 'hdr_hlg'), true)
  assert.equal(isConformant(info(HLG), 'sdr_bt709'), false)
  assert.equal(isConformant(info(SDR_OK), 'hdr_hlg'), false)
})

test('a built master is reused only when it is as new as its source, and an untagged source\'s only with its marker', () => {
  const { paths } = sources({
    'a.mov': SDR_OK,
    'a_normalized_sdr_bt709.mp4': SDR_OK,
    'u.mov': { ...SDR_OK, transfer: 'unknown' },
    'u_normalized_sdr_bt709.mp4': SDR_OK,
    'm.mov': { ...SDR_OK, transfer: 'unknown' },
    'm_normalized_sdr_bt709.mp4': { ...SDR_OK, comment: UNTAGGED_MASTER_MARKER },
  })
  const master = paths['a_normalized_sdr_bt709.mp4']
  assert.equal(normalizedMasterCache(join(paths['a.mov'], '..', 'gone.mp4'), paths['a.mov'], 'sdr_bt709', false), 'missing')
  assert.equal(normalizedMasterCache(master, paths['a.mov'], 'sdr_bt709', false), 'fresh')
  age(master, 60)
  assert.equal(normalizedMasterCache(master, paths['a.mov'], 'sdr_bt709', false), 'missing', 'older than its source')
  assert.equal(normalizedMasterCache(paths['u_normalized_sdr_bt709.mp4'], paths['u.mov'], 'sdr_bt709', false, { untaggedSource: true }), 'stale')
  assert.equal(normalizedMasterCache(paths['m_normalized_sdr_bt709.mp4'], paths['m.mov'], 'sdr_bt709', false, { untaggedSource: true }), 'fresh')
})

test('a source normalize would re-encode is one master of the whole source; two items cut from it share it', () => {
  const { dir, paths } = sources({ 'a.mov': SDR_444, 'g.mov': SDR_LONG_GOP, 'ok.mov': SDR_OK })
  const before = listing(dir)
  const item = (src) => ({ type: 'video', src, colorTransfer: 'bt709' })
  const w = planVideoItemWrites([item(paths['a.mov']), item(paths['a.mov']), item(paths['g.mov']), item(paths['ok.mov'])],
    () => 'sdr_bt709', { settings: {}, workspaceDir: dir })
  assert.deepEqual(w.masters, [
    { path: join(dir, 'a_normalized_sdr_bt709.mp4'), durationSeconds: 20, width: 1080, height: 1920, fps: 30, colorSpace: 'sdr_bt709' },
    { path: join(dir, 'g_normalized_sdr_bt709.mp4'), durationSeconds: 20, width: 1080, height: 1920, fps: 30, colorSpace: 'sdr_bt709' },
  ])
  assert.deepEqual(w.copies, [])
  assert.deepEqual(w.cutouts, [])
  assert.deepEqual(listing(dir), before, 'nothing written')
})

test('an HDR source into an SDR project is named as the render names its tone-mapped master', () => {
  const { dir, paths } = sources({ 'h.mov': HLG })
  const w = planVideoItemWrites([{ type: 'video', src: paths['h.mov'], colorTransfer: 'arib-std-b67' }],
    () => 'sdr_bt709', { settings: {}, workspaceDir: dir })
  assert.equal(w.masters.length, 1)
  assert.equal(w.masters[0].path, buildNormalizedOutputPath(paths['h.mov'], 'sdr_bt709', true, false))
  assert.ok(w.masters[0].path.endsWith(`_normalized_sdr_bt709_${MASTER_LOOK}.mp4`))
  assert.equal(w.masters[0].colorSpace, 'sdr_bt709')
  // The master has one audio stream: the source's second one is never copied out.
  assert.deepEqual(w.copies, [])
})

test('a source used as is with several audio streams is copied once, unless a fresh copy exists', () => {
  const { dir, paths } = sources({ 'i.mov': { ...HLG, bytes: 5000 }, 'j.mov': { ...HLG, bytes: 7000 } })
  writeFileSync(join(dir, 'j_audioclean.mp4'), 'copy')
  const item = (src) => ({ type: 'video', src, colorTransfer: 'arib-std-b67' })
  const w = planVideoItemWrites([item(paths['i.mov']), item(paths['i.mov']), item(paths['j.mov'])],
    () => 'hdr_hlg', { settings: {}, workspaceDir: dir })
  assert.deepEqual(w.masters, [], 'HLG into an HLG project conforms')
  assert.deepEqual(w.copies, [{ path: join(dir, 'i_audioclean.mp4'), bytes: 5000 }])
})

test('nothing is planned for a reused master, a lazy cache or a cutout already made', () => {
  const { dir, paths } = sources({
    'a.mov': SDR_444,
    'a_normalized_sdr_bt709.mp4': SDR_OK,
    'lazy.mov': SDR_444,
    'lazy_window.mp4': SDR_OK,
    'cut.mov': SDR_444,
    'cut_nobg.mov': SDR_OK,
  })
  const items = [
    { type: 'video', src: paths['a.mov'], colorTransfer: 'bt709' },
    // collectAllItems has already swapped a lazy cache in as src.
    { type: 'video', src: paths['lazy_window.mp4'], normalizedSrc: paths['lazy_window.mp4'], colorTransfer: 'bt709' },
    { type: 'video', src: paths['cut_nobg.mov'], remove_bg: true, nobg_src: paths['cut_nobg.mov'], colorTransfer: 'bt709' },
  ]
  const w = planVideoItemWrites(items, () => 'sdr_bt709', { settings: { normalize: 'lazy' }, workspaceDir: dir })
  assert.deepEqual(w, { masters: [], copies: [], cutouts: [] })
})

test('remove_bg with no cutout yet makes one in render/, of the file it decodes', () => {
  const { dir, paths } = sources({ 'p.mov': SDR_OK, 'q.mov': SDR_444 })
  const before = listing(dir)
  const w = planVideoItemWrites([
    { type: 'video', src: paths['p.mov'], remove_bg: true, colorTransfer: 'bt709' },
    { type: 'video', src: paths['q.mov'], remove_bg: true, colorTransfer: 'bt709' },
  ], () => 'sdr_bt709', { settings: {}, workspaceDir: dir })
  assert.deepEqual(w.cutouts, [
    { path: join(dir, 'render', 'p_nobg.mov'), durationSeconds: 20, width: 1080, height: 1920, fps: 30 },
    // q is normalized first, and remove_bg reads its master.
    { path: join(dir, 'render', 'q_normalized_sdr_bt709_nobg.mov'), durationSeconds: 20, width: 1080, height: 1920, fps: 30 },
  ])
  assert.equal(w.masters.length, 1)
  assert.deepEqual(listing(dir), before, 'nothing written, render/ not made')
})

/** A project in its own folder: one clip, one overlay, captions. */
function project({ settings, clip = SDR_444 } = {}) {
  const { dir, paths } = sources({ 'clip.mov': clip })
  writeFileSync(join(dir, 'title.jsx'), 'export default () => null\n')
  const json = JSON.stringify({
    version: '0.2', id: 'estimate', status: 'draft', name: 'estimate',
    settings,
    tracks: [
      { id: 'trk-0', items: [{ id: 'c', type: 'video', src: 'clip.mov', start: 0, end: 10, inPoint: 0, outPoint: 10 }] },
      { id: 'trk-1', items: [{ id: 'ov', type: 'overlay', src: 'title.jsx', start: 0, end: 4 }] },
    ],
    captions: { style: 'clean', segments: [{ text: 'hello there', start: 0, end: 2, words: [
      { word: 'hello', start: 0, end: 1 }, { word: 'there', start: 1, end: 2 }] }] },
    audio: { tracks: [] },
  }, null, 2)
  writeFileSync(join(dir, 'project.json'), json)
  return { dir, paths, json, projectPath: join(dir, 'project.json') }
}

test('estimateMain: the estimate and the disk it would use, from a draft project, with nothing written', async () => {
  // No colorSpace: a render detects it and writes it back; an estimate must not.
  const p = project({ settings: { resolution: [1080, 1920], fps: 30 } })
  const before = listing(p.dir)
  const r = await estimateMain(p.projectPath, { workers: 2 })
  assert.deepEqual(Object.keys(r).sort(), ['colorSpace', 'estimate', 'hdrVisible', 'memory', 'slicing', 'volumes'])
  // §434: a 10 s project's captures fit the default budget: unsliced.
  assert.deepEqual(r.slicing, { sliced: false, slices: 1, budgetMB: 2000, peakBytes: r.slicing.peakBytes })
  assert.ok(r.slicing.peakBytes > 0)
  // The worker plan: what this machine has available now, so only its shape is fixed here (renderer-memory.test.mjs has the numbers).
  assert.deepEqual(Object.keys(r.memory).sort(), ['asked', 'availableBytes', 'limitedBy', 'perWorkerBytes', 'perWorkerKind', 'reserveBytes', 'workers'])
  assert.equal(r.memory.asked, 2, 'the --workers asked for: 2, over an overlay and the captions')
  assert.ok(r.memory.workers >= 1 && r.memory.workers <= 2)
  assert.equal(r.memory.perWorkerKind, '2d')
  assert.ok(r.memory.reserveBytes >= 4e9 && r.memory.availableBytes >= 0)
  for (const bound of ['lower', 'expected']) {
    assert.deepEqual(Object.keys(r.estimate[bound]).sort(), ['projectBytes', 'tmpBytes'])
    assert.ok(Number.isInteger(r.estimate[bound].projectBytes) && r.estimate[bound].projectBytes > 0)
  }
  assert.ok(r.estimate.expected.projectBytes > r.estimate.lower.projectBytes)
  // TMPDIR and this folder share a disk here: one volume, named by the project's render dir.
  assert.equal(r.volumes.length, 1)
  assert.equal(r.volumes[0].path, join(p.dir, 'render'))
  assert.equal(r.volumes[0].needBytes, r.estimate.expected.tmpBytes + r.estimate.expected.projectBytes)
  assert.ok(r.volumes[0].freeBytes > 0)
  assert.deepEqual(listing(p.dir), before, 'no render/, no master, no output')
  assert.equal(readFileSync(p.projectPath, 'utf8'), p.json, 'project.json untouched')
})

test('estimateMain: the clip\'s master is counted, and a built one is not', async () => {
  const p = project({ settings: { resolution: [1080, 1920], fps: 30, colorSpace: 'sdr_bt709' } })
  const withMaster = await estimateMain(p.projectPath, { workers: 2 })
  writeFileSync(join(p.dir, 'clip_normalized_sdr_bt709.mp4'), 'built')
  const facts = JSON.parse(readFileSync(FACTS, 'utf8'))
  facts[join(p.dir, 'clip_normalized_sdr_bt709.mp4')] = SDR_OK
  writeFileSync(FACTS, JSON.stringify(facts))
  const built = await estimateMain(p.projectPath, { workers: 2 })
  // The whole 20 s source, not the 10 s the timeline uses.
  const master = 0.15 * 1080 * 1920 * 30 * 20 / 8 + 192e3 / 8 * 20
  assert.ok(Math.abs((withMaster.estimate.expected.projectBytes - built.estimate.expected.projectBytes) - master) < 2)
})

test('estimateMain: --resolution and --fps stand in for the saved settings', async () => {
  const p = project({ settings: { resolution: [1080, 1920], fps: 30, colorSpace: 'sdr_bt709' } })
  const saved = await estimateMain(p.projectPath, { workers: 2 })
  const uhd = await estimateMain(p.projectPath, { workers: 2, overrides: { resolution: [2160, 3840] } })
  const fast = await estimateMain(p.projectPath, { workers: 2, overrides: { fps: 60 } })
  // 4K captures overlays at twice the scale (four times the pixels) and
  // exports four times the pixels; the clip's master stays the source's size.
  assert.ok(uhd.estimate.expected.projectBytes > 2.5 * saved.estimate.expected.projectBytes, `${uhd.estimate.expected.projectBytes}`)
  assert.ok(fast.estimate.expected.projectBytes > 1.5 * saved.estimate.expected.projectBytes, `${fast.estimate.expected.projectBytes}`)
  assert.equal(readFileSync(p.projectPath, 'utf8'), p.json, 'never written to project.json')
})

test('estimateMain: earlier segments left in render/ count as free space, since the render deletes them first', async () => {
  const p = project({ settings: { resolution: [1080, 1920], fps: 30, colorSpace: 'sdr_bt709' } })
  // A fixed reading, so the difference is the leftovers alone.
  process.env.MONTAJ_TEST_DISK_FREE_BYTES = String(5e9)
  try {
    const clean = await estimateMain(p.projectPath, { workers: 2 })
    assert.equal(clean.volumes[0].freeBytes, 5e9)
    mkdirSync(join(p.dir, 'render', 'segments'), { recursive: true })
    writeFileSync(join(p.dir, 'render', 'segments', 'overlay-1--ov.mkv'), 'x'.repeat(300))
    mkdirSync(join(p.dir, 'render', 'estimate.mp4.segments'))
    writeFileSync(join(p.dir, 'render', 'estimate.mp4.segments', 'seg-0000.mp4'), 'x'.repeat(45))
    writeFileSync(join(p.dir, 'render', 'unrelated.mp4'), 'x'.repeat(7))
    const left = await estimateMain(p.projectPath, { workers: 2 })
    assert.equal(left.volumes[0].freeBytes, 5e9 + 345, 'render/segments and the export\'s .segments, nothing else')
    assert.equal(left.estimate.expected.projectBytes, clean.estimate.expected.projectBytes)
  } finally {
    delete process.env.MONTAJ_TEST_DISK_FREE_BYTES
  }
})

/** A 30 s project: three 10 s clips, a full-length overlay, captions over the first 2 s. */
function longProject({ settings, overlay = {} } = {}) {
  const { dir, paths } = sources({ 'clip.mov': SDR_444 })
  writeFileSync(join(dir, 'title.jsx'), 'export default () => null\n')
  const clip = (id, start) => ({ id, type: 'video', src: 'clip.mov', start, end: start + 10, inPoint: 0, outPoint: 10 })
  const json = JSON.stringify({
    version: '0.2', id: 'estimate-long', status: 'draft', name: 'estimate long',
    settings,
    tracks: [
      { id: 'trk-0', items: [clip('a', 0), clip('b', 10), clip('c', 20)] },
      { id: 'trk-1', items: [{ id: 'ov', type: 'overlay', src: 'title.jsx', start: 0, end: 30, ...overlay }] },
    ],
    captions: { style: 'clean', segments: [{ text: 'hello there', start: 0, end: 2, words: [
      { word: 'hello', start: 0, end: 1 }, { word: 'there', start: 1, end: 2 }] }] },
    audio: { tracks: [] },
  }, null, 2)
  writeFileSync(join(dir, 'project.json'), json)
  return { dir, paths, json, projectPath: join(dir, 'project.json') }
}

/** Runs `f` with these env vars set, restoring them after. */
async function withEnv(vars, f) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try { return await f() } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}

test('estimateMain §434: MONTAJ_SLICE_BUDGET_MB forces slices, and the estimate counts one slice of captures', async () => {
  const p = longProject({ settings: { resolution: [1080, 1920], fps: 30, colorSpace: 'sdr_bt709' } })
  const whole = await estimateMain(p.projectPath, { workers: 2 })
  assert.equal(whole.slicing.sliced, false)
  const sliced = await withEnv({ MONTAJ_SLICE_BUDGET_MB: '1' }, () => estimateMain(p.projectPath, { workers: 2 }))
  // Groups end at 2, 10, 20, 30; a slice spans at least 240 frames (8 s at 30 fps).
  assert.deepEqual(sliced.slicing, { sliced: true, slices: 3, budgetMB: 1, peakBytes: sliced.slicing.peakBytes })
  // Each slice holds 300 frames of the overlay and of the captions (whose track spans the video).
  const px = 1080 * 1920
  assert.equal(sliced.slicing.peakBytes, Math.round(300 * px * 0.2 + 300 * px * 0.015))
  const captures = 900 * px * 0.2 + 900 * px * 0.015
  assert.equal(whole.slicing.peakBytes, Math.round(captures))
  // Expected need: one slice of captures where it was all of them, and a
  // smaller join (the largest file joined from chunks is a slice's window).
  const saved = (whole.estimate.expected.projectBytes - sliced.estimate.expected.projectBytes)
  assert.ok(saved >= captures - sliced.slicing.peakBytes - 1e6, `saved ${saved}`)
  assert.ok(sliced.estimate.lower.projectBytes < whole.estimate.lower.projectBytes)
  assert.deepEqual(sliced.estimate.expected.tmpBytes, whole.estimate.expected.tmpBytes)
  assert.equal(readFileSync(p.projectPath, 'utf8'), p.json, 'never written to project.json')
})

test('estimateMain §434: an HDR project with a full-canvas card candidate stays unsliced', async () => {
  const p = longProject({ settings: { resolution: [1080, 1920], fps: 30, colorSpace: 'hdr_hlg', colorSpaceSource: 'explicit' } })
  const r = await withEnv({ MONTAJ_SLICE_BUDGET_MB: '1' }, () => estimateMain(p.projectPath, { workers: 2 }))
  assert.equal(r.colorSpace, 'hdr_hlg')
  assert.equal(r.slicing.sliced, false)
  assert.equal(r.slicing.slices, 1)
  // Moved off full canvas, it is no candidate, and the same project slices.
  const q = longProject({ settings: { resolution: [1080, 1920], fps: 30, colorSpace: 'hdr_hlg', colorSpaceSource: 'explicit' }, overlay: { offsetX: 10 } })
  const s = await withEnv({ MONTAJ_SLICE_BUDGET_MB: '1' }, () => estimateMain(q.projectPath, { workers: 2 }))
  assert.equal(s.slicing.sliced, true)
})

// planSlicing on its own: a 30 s timeline cut at 2, 10, 20 and 30 s, one
// dense full-length overlay and full-length captions at 1080x1920, 30 fps.
const PX = 1080 * 1920
function slicingCase() {
  const segmentSpecs = [
    { id: 'overlay-1--ov', startSeconds: 0, endSeconds: 30, frameCount: 900, fps: 30 },
    { id: 'captions', startSeconds: 0, endSeconds: 30, frameCount: 900, fps: 30, isCaption: true },
  ]
  const items = [0, 2, 10, 20].map((start, i, a) => ({ id: `i${i}`, type: 'image', src: '/x.png', start, end: a[i + 1] ?? 30, trackIdx: 0 }))
  const inputs = {
    segments: [{ frames: 900, sparse: false }, { frames: 900, sparse: true }], width: 1080, height: 1920,
    workerCount: 2, chunkFrames: 450, durationSeconds: 30, output: { width: 1080, height: 1920, fps: 30 }, passes: ['sdr_bt709'],
  }
  const unsliced = estimateRenderDisk(inputs)
  const fixed = estimateRenderDisk({ ...inputs, segments: [] }).expected.projectBytes + unsliced.expected.tmpBytes
  const renderDir = join(WORK, `slicing-${++n}`, 'render')
  const args = {
    inputs, unsliced, segmentSpecs, items, fps: 30, renderWidth: 1080, renderHeight: 1920, captureScale: 1,
    chunkFrames: 450, projectColorSpace: 'sdr_bt709', renderDir, reclaimBytes: 0,
  }
  return { args, fixed, slice: 300 * PX * 0.2 + 300 * PX * 0.015, all: 900 * PX * 0.215 }
}

test('planSlicing §434: room for every capture is unsliced at the default budget', async () => {
  const c = slicingCase()
  const r = await withEnv({ MONTAJ_TEST_DISK_FREE_BYTES: String(1e12) }, () => planSlicing(c.args))
  assert.equal(r.sliced, false)
  assert.equal(r.budgetBytes, 2e9)
  assert.equal(r.terms, null)
  assert.ok(Math.abs(r.captureBytes - c.all) < 1)
})

test('planSlicing §434: a short disk shrinks the budget to what fits beside the rest', async () => {
  const c = slicingCase()
  // Room for 150 MB of captures past the 1 GB floor: less than all of them (401 MB), more than a 10 s slice (134 MB).
  const free = Math.round(c.fixed + 1e9 + 150e6)
  const r = await withEnv({ MONTAJ_TEST_DISK_FREE_BYTES: String(free) }, () => planSlicing(c.args))
  assert.equal(r.sliced, true)
  assert.equal(r.slices, 3)
  assert.ok(Math.abs(r.peakBytes - c.slice) < 1)
  // The largest budget whose plan peaks within the room: below two slices' worth.
  assert.ok(r.budgetBytes < 2 * c.slice && r.budgetBytes >= c.slice, `budget ${r.budgetBytes}`)
  assert.equal(r.wantedBytes, 2e9)
  assert.equal(r.freeBytes, free)
  assert.equal(r.refused, false)
  assert.ok(Math.abs(r.terms.peakCaptureBytes - c.slice) < 1)
})

test('planSlicing §434: refused only when even the smallest slice does not fit without the headroom', async () => {
  const c = slicingCase()
  // Short of the floor but holding a slice: runs at the smallest slices.
  const tight = Math.round(c.fixed + c.slice + 100e6)
  const t = await withEnv({ MONTAJ_TEST_DISK_FREE_BYTES: String(tight) }, () => planSlicing(c.args))
  assert.equal(t.refused, false)
  assert.equal(t.sliced, true)
  assert.equal(t.slices, 3)
  // Not even one slice beside the rest: refused, with what it needs and what is free.
  const none = Math.round(c.fixed + c.slice - 10e6)
  const r = await withEnv({ MONTAJ_TEST_DISK_FREE_BYTES: String(none) }, () => planSlicing(c.args))
  assert.equal(r.refused, true)
  assert.equal(r.sliced, false)
  assert.equal(r.freeBytes, none)
  assert.ok(Math.abs(r.needBytes - (c.slice + c.fixed + 1e9)) < 1)
})

test('planSlicing §434: HDR with a card candidate is unsliced and says why; no overlays, nothing to plan', async () => {
  const c = slicingCase()
  const r = await withEnv({ MONTAJ_SLICE_BUDGET_MB: '1' }, () => planSlicing({ ...c.args, projectColorSpace: 'hdr_hlg' }))
  assert.equal(r.sliced, false)
  assert.equal(r.reason, 'an HDR card candidate needs its whole capture probed')
  const sdr = await withEnv({ MONTAJ_SLICE_BUDGET_MB: '1' }, () => planSlicing(c.args))
  assert.equal(sdr.sliced, true)
  assert.equal(sdr.budgetBytes, 1e6)
  const empty = planSlicing({ ...c.args, segmentSpecs: [], inputs: { ...c.args.inputs, segments: [] } })
  assert.deepEqual([empty.sliced, empty.slices, empty.reason], [false, 1, null])
})

test('planSlicing §434: a plan that throws counts the captures unsliced, never fails', () => {
  const c = slicingCase()
  const r = planSlicing({ ...c.args, items: null })
  assert.equal(r.sliced, false)
  assert.equal(r.refused, false)
})
