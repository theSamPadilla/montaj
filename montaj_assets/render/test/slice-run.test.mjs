// montaj_assets/render/test/slice-run.test.mjs
//
// The sliced render's loop (§434): capture a slice, encode its groups, delete
// it, next slice; then finish each compose. Every side effect is a fake, so no
// browser, no ffmpeg and no disk.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  runSlices, sliceSpecs, groupsInSlice, commonEdges, overlayDescriptor, plannedDescriptors,
  hdrCardCandidates, sliceDiskTerms, slicingLine, previewGroups, sliceDirName,
} from '../slice-run.js'
import { planSlices } from '../slice-plan.js'
import { FFV1_DENSE_BYTES_PER_PIXEL, FFV1_CAPTION_BYTES_PER_PIXEL, FFV1_SPARSE_BYTES_PER_PIXEL } from '../disk-space.js'

const FPS = 30
const SEG = '/proj/render/segments'

const spec = (id, startSeconds, endSeconds, extra = {}) => ({
  id, startSeconds, endSeconds, frameCount: Math.round((endSeconds - startSeconds) * FPS), fps: FPS,
  outputPath: join(SEG, `${id}.mkv`), ...extra,
})
const groupsOf = (edges) => edges.slice(0, -1).map((start, i) => ({ start, end: edges[i + 1], parts: [] }))
const planOf = (name, edges) => ({ outputPath: `/proj/render/${name}.mp4`, groups: groupsOf(edges) })

/** A fake world: records every call in order. */
function world({ failCaptureAt = null } = {}) {
  const calls = []
  let captureN = 0
  const capture = async (specs, config) => {
    captureN++
    calls.push({ op: 'capture', specs, config })
    if (captureN === failCaptureAt) throw new Error('capture failed')
    return specs.map((s) => ({
      id: s.id, webmPath: s.outputPath,
      startSeconds: s.startSeconds + s.frameFrom / FPS, endSeconds: s.startSeconds + s.frameTo / FPS, opaque: false,
    }))
  }
  const encode = async (plan, indices, { overlaysFor }) => {
    calls.push({ op: 'encode', plan: plan.outputPath, indices, overlaysFor })
    return indices.map((index) => ({ index, path: `${plan.outputPath}.segments/seg-${index}`, start: plan.groups[index].start, end: plan.groups[index].end }))
  }
  const finish = async (plan, encoded, i) => {
    calls.push({ op: 'finish', plan: plan.outputPath, encoded, i })
    return { outputPath: plan.outputPath }
  }
  const fsOps = {
    mkdir: (dir) => calls.push({ op: 'mkdir', dir }),
    rm: (dir) => calls.push({ op: 'rm', dir }),
  }
  return { calls, capture, encode, finish, fsOps }
}

test('order: capture(k) -> encode(k) -> delete(k) -> capture(k+1), then finish', async () => {
  const w = world()
  const plan = planOf('main', [0, 4, 8, 12])
  const slices = [{ start: 0, end: 4 }, { start: 4, end: 12 }]
  await runSlices({ plans: [plan], slices, specs: [spec('a', 0, 12)], segDir: SEG, fps: FPS, ...w })
  assert.deepEqual(w.calls.map((c) => c.op), ['mkdir', 'capture', 'encode', 'rm', 'mkdir', 'capture', 'encode', 'rm', 'finish'])
  assert.equal(w.calls[0].dir, join(SEG, 'slice-01'))
  assert.equal(w.calls[3].dir, join(SEG, 'slice-01'))
  assert.equal(w.calls[7].dir, join(SEG, 'slice-02'))
  assert.deepEqual(w.calls[2].indices, [0])
  assert.deepEqual(w.calls[6].indices, [1, 2])
  assert.deepEqual(w.calls[8].encoded.map((e) => e.index), [0, 1, 2])
})

test('only overlapping overlays are captured, with frames relative to their own start, under slice-NN', async () => {
  const w = world()
  const plan = planOf('main', [0, 5, 10])
  const specs = [spec('a', 2, 7), spec('b', 0, 3), spec('cap', 0, 10, { isCaption: true })]
  await runSlices({ plans: [plan], slices: [{ start: 0, end: 5 }, { start: 5, end: 10 }], specs, segDir: SEG, fps: FPS, ...w })
  const [c1, c2] = w.calls.filter((c) => c.op === 'capture')
  assert.deepEqual(c1.specs.map((s) => [s.id, s.frameFrom, s.frameTo, s.outputPath]), [
    ['a', 0, 90, join(SEG, 'slice-01', 'a.mkv')],
    ['b', 0, 90, join(SEG, 'slice-01', 'b.mkv')],
    ['cap', 0, 150, join(SEG, 'slice-01', 'cap.mkv')],
  ])
  assert.deepEqual(c2.specs.map((s) => [s.id, s.frameFrom, s.frameTo, s.outputPath]), [
    ['a', 90, 150, join(SEG, 'slice-02', 'a.mkv')],
    ['cap', 150, 300, join(SEG, 'slice-02', 'cap.mkv')],
  ])
})

test('the specs are never mutated; overlaysFor gives a copy at the slice file and the window start', async () => {
  const w = world()
  const plan = planOf('main', [0, 5, 10])
  const specs = [spec('a', 2, 7)]
  const before = structuredClone(specs)
  const ov = overlayDescriptor(specs[0], { id: 'a', startSeconds: 2, endSeconds: 7, webmPath: undefined })
  const ovBefore = structuredClone(ov)
  await runSlices({ plans: [plan], slices: [{ start: 0, end: 5 }, { start: 5, end: 10 }], specs, segDir: SEG, fps: FPS, ...w })
  assert.deepEqual(specs, before)
  const [e1, e2] = w.calls.filter((c) => c.op === 'encode')
  const m1 = e1.overlaysFor(ov)
  assert.equal(m1.webmPath, join(SEG, 'slice-01', 'a.mkv'))
  assert.equal(m1.startSeconds, 2)
  const m2 = e2.overlaysFor(ov)
  assert.equal(m2.webmPath, join(SEG, 'slice-02', 'a.mkv'))
  assert.equal(m2.startSeconds, 5)
  assert.notEqual(m2, ov)
  assert.deepEqual(ov, ovBefore)
  // An overlay the slice did not capture is a bug, said plainly.
  assert.throws(() => e1.overlaysFor({ id: 'zzz' }), /zzz/)
})

test('--export both: both passes encode their groups in each slice before it is deleted, then each finishes', async () => {
  const w = world()
  const main = planOf('main', [0, 2, 5, 10])
  const sdr = planOf('main-sdr', [0, 5, 7, 10])
  assert.deepEqual(commonEdges([main, sdr]), [5, 10])
  await runSlices({ plans: [main, sdr], slices: [{ start: 0, end: 5 }, { start: 5, end: 10 }], specs: [spec('a', 0, 10)], segDir: SEG, fps: FPS, ...w })
  assert.deepEqual(w.calls.map((c) => c.op + (c.plan ? `:${c.plan.split('/').pop()}` : '')), [
    'mkdir', 'capture', 'encode:main.mp4', 'encode:main-sdr.mp4', 'rm',
    'mkdir', 'capture', 'encode:main.mp4', 'encode:main-sdr.mp4', 'rm',
    'finish:main.mp4', 'finish:main-sdr.mp4',
  ])
  const enc = w.calls.filter((c) => c.op === 'encode').map((c) => c.indices)
  assert.deepEqual(enc, [[0, 1], [0], [2], [1, 2]])
  assert.deepEqual(w.calls.filter((c) => c.op === 'finish').map((c) => c.i), [0, 1])
})

test('one bake counter, sized over every slice, is passed to every capture', async () => {
  const w = world()
  let created = null
  const createBakeProgress = ({ total }) => { created = { total }; return () => {} }
  const bakeTotal = (specs) => specs.reduce((n, s) => n + (s.frameTo - s.frameFrom), 0)
  await runSlices({
    plans: [planOf('main', [0, 5, 10])], slices: [{ start: 0, end: 5 }, { start: 5, end: 10 }],
    specs: [spec('a', 0, 10), spec('b', 6, 8)], segDir: SEG, fps: FPS, ...w,
    captureConfig: { workers: 3, motionBlur: 2 }, bakeTotal, createBakeProgress,
  })
  assert.equal(created.total, 300 + 60)
  const caps = w.calls.filter((c) => c.op === 'capture')
  assert.equal(caps[0].config.bakeProgress, caps[1].config.bakeProgress)
  assert.equal(typeof caps[0].config.bakeProgress, 'function')
  assert.equal(caps[0].config.workers, 3)
  assert.equal(caps[0].config.motionBlur, 2)
})

test('a failure in slice 2 stops the loop: nothing after it runs, nothing finishes', async () => {
  const w = world({ failCaptureAt: 2 })
  await assert.rejects(
    runSlices({ plans: [planOf('main', [0, 4, 8, 12])], slices: [{ start: 0, end: 4 }, { start: 4, end: 8 }, { start: 8, end: 12 }], specs: [spec('a', 0, 12)], segDir: SEG, fps: FPS, ...w }),
    /capture failed/,
  )
  assert.deepEqual(w.calls.map((c) => c.op), ['mkdir', 'capture', 'encode', 'rm', 'mkdir', 'capture'])
})

test('MONTAJ_KEEP_SEGMENTS: keep leaves every slice folder', async () => {
  const w = world()
  await runSlices({ plans: [planOf('main', [0, 5, 10])], slices: [{ start: 0, end: 5 }, { start: 5, end: 10 }], specs: [spec('a', 0, 10)], segDir: SEG, fps: FPS, keep: true, ...w })
  assert.equal(w.calls.filter((c) => c.op === 'rm').length, 0)
})

test('a slice with no overlay is not captured, and its groups still encode', async () => {
  const w = world()
  await runSlices({ plans: [planOf('main', [0, 5, 10])], slices: [{ start: 0, end: 5 }, { start: 5, end: 10 }], specs: [spec('a', 0, 4)], segDir: SEG, fps: FPS, ...w })
  assert.deepEqual(w.calls.map((c) => c.op), ['mkdir', 'capture', 'encode', 'rm', 'mkdir', 'encode', 'rm', 'finish'])
})

test('a group no slice covers fails before finishing', async () => {
  const w = world()
  await assert.rejects(
    runSlices({ plans: [planOf('main', [0, 5, 10])], slices: [{ start: 0, end: 5 }], specs: [], segDir: SEG, fps: FPS, ...w }),
    /encoded 1 of 2/,
  )
  assert.equal(w.calls.some((c) => c.op === 'finish'), false)
})

test('sliceSpecs uses the frame grid compose uses (quantised starts)', () => {
  // An overlay from 1.0 s to 3.0 s, a slice from 2.0166 s (frame 60.5 rounds to 61 at 30 fps) to 3.
  const out = sliceSpecs([spec('a', 1, 3)], { start: 60.5 / FPS, end: 3 }, FPS, '/d')
  assert.deepEqual([out[0].frameFrom, out[0].frameTo], [31, 60])
  assert.equal(sliceDirName(0), 'slice-01')
  assert.equal(sliceDirName(11), 'slice-12')
})

test('groupsInSlice: the groups whose [start, end) lie inside the window', () => {
  const p = planOf('m', [0, 1, 2.5, 4, 6])
  assert.deepEqual(groupsInSlice(p, { start: 0, end: 2.5 }), [0, 1])
  assert.deepEqual(groupsInSlice(p, { start: 2.5, end: 6 }), [2, 3])
})

test('overlayDescriptor: the fields compose reads, keyframes and layerTrack only when present', () => {
  const plain = overlayDescriptor({ id: 'x' }, { id: 'x' })
  assert.deepEqual(plain, { id: 'x', offsetX: 0, offsetY: 0, scale: 1, scaleX: undefined, scaleY: undefined, rotation: 0, opacity: 1, opaque: false, isCaption: false })
  assert.equal('keyframes' in plain, false)
  assert.equal('layerTrack' in plain, false)
  const kf = [{ prop: 'x', keys: [] }]
  const full = overlayDescriptor({ offsetX: 3, scaleX: 2, opaque: true, layerTrack: 1, keyframes: kf, isCaption: true }, {})
  assert.equal(full.offsetX, 3)
  assert.equal(full.scaleX, 2)
  assert.equal(full.opaque, true)
  assert.equal(full.layerTrack, 1)
  assert.equal(full.keyframes, kf)
  const base = { id: 'y' }
  assert.equal(overlayDescriptor({}, base), base, 'mutates and returns its base')
  const [d] = plannedDescriptors([spec('a', 1, 2, { opaque: true })])
  assert.deepEqual([d.id, d.startSeconds, d.endSeconds, d.opaque, 'webmPath' in d], ['a', 1, 2, true, false])
})

test('hdrCardCandidates: full-canvas, not opaque, not a caption, no keyframes, full opacity', () => {
  const specs = [
    spec('card', 0, 2),
    spec('flagged', 0, 2, { opaque: true }),
    spec('cap', 0, 2, { isCaption: true }),
    spec('small', 0, 2, { scale: 0.5 }),
    spec('moved', 0, 2, { offsetX: 10 }),
    spec('faded', 0, 2, { opacity: 0.5 }),
    spec('keyed', 0, 2, { keyframes: [{ prop: 'opacity', keys: [] }] }),
  ]
  assert.deepEqual(hdrCardCandidates(specs).map((s) => s.id), ['card'])
  assert.deepEqual(hdrCardCandidates([]), [])
})

test('sliceDiskTerms: the peak slice, its largest joined file, its frames at the sparse rate', () => {
  const px = 1080 * 1920
  const overlays = [
    { startSeconds: 0, endSeconds: 20, sparse: false },
    { startSeconds: 0, endSeconds: 20, sparse: true },
    { startSeconds: 15, endSeconds: 16, sparse: false },
  ]
  const groups = groupsOf([0, 5, 10, 15, 20])
  const plan = planSlices({ groups, overlays, fps: FPS, px, budgetBytes: 1e8, minSliceFrames: 1 })
  assert.equal(plan.sliced, true)
  const t = sliceDiskTerms({ plan, overlays, fps: FPS, px, chunkFrames: 100 })
  assert.equal(t.peakCaptureBytes, plan.peakBytes)
  // The peak slice holds the short overlay too; the dense full-length window is the largest joined file.
  const peak = plan.slices.find((s) => s.bytes === plan.peakBytes)
  const frames = Math.round((peak.end - peak.start) * FPS)
  assert.equal(t.peakJoinBytes, frames * px * FFV1_DENSE_BYTES_PER_PIXEL)
  const sparseFrames = 2 * frames + Math.max(0, Math.min(16 * FPS, Math.round(peak.end * FPS)) - Math.max(15 * FPS, Math.round(peak.start * FPS)))
  assert.equal(t.lowerCaptureBytes, sparseFrames * px * FFV1_SPARSE_BYTES_PER_PIXEL)
  assert.ok(FFV1_CAPTION_BYTES_PER_PIXEL < FFV1_DENSE_BYTES_PER_PIXEL)
  // No window over the chunk size: nothing is joined.
  assert.equal(sliceDiskTerms({ plan, overlays, fps: FPS, px }).peakJoinBytes, 0)
})

test('slicingLine: the sliced and unsliced lines, never a phase marker', () => {
  const on = slicingLine({ sliced: true, slices: 10, budgetBytes: 1.5e9, peakBytes: 1.42e9, wantedBytes: 2e9, freeBytes: 9e9 })
  assert.equal(on, 'slicing: 10 slice(s) of <=1420 MB (budget used 1500 MB, wanted 2000 MB, free 9000 MB)')
  const off = slicingLine({ sliced: false, budgetBytes: 2e9, captureBytes: 3.4e8 })
  assert.equal(off, 'slicing: off (captures 340 MB fit the 2000 MB budget)')
  const card = slicingLine({ reason: 'an HDR card candidate needs its whole capture probed' })
  assert.equal(card, 'slicing: off (an HDR card candidate needs its whole capture probed)')
  for (const line of [on, off, card]) assert.doesNotMatch(line, /bundling segment|with Puppeteer|composing final video|concatenating|deriving SDR rendition/)
})

test('previewGroups: planCompose\'s groups, the leading gap included', () => {
  const items = [{ id: 'a', type: 'image', start: 1, end: 4, src: '/a.jpg', trackIdx: 0 }]
  const g = previewGroups(items, [{ id: 'o', startSeconds: 2, endSeconds: 6, opaque: false, isCaption: false }], 1080, 1920, FPS)
  assert.equal(g[0].start, 0)
  assert.equal(g.at(-1).end, 6)
  assert.deepEqual(previewGroups([], [], 1080, 1920, FPS), [])
})

test('render.js renderInSlices: no phase marker in the loop, one of each before its finish', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../render.js', import.meta.url), 'utf8')
  const at = src.indexOf('async function renderInSlices(')
  assert.ok(at > 0)
  const body = src.slice(at, src.indexOf('\n}\n', at))
  assert.doesNotMatch(body, /with Puppeteer|bundling segment|concatenating/)
  const finish = body.slice(body.indexOf('finish: ('), body.indexOf('keep:'))
  assert.match(finish, /log\('composing final video\.\.\.'\)/)
  assert.match(finish, /deriving SDR rendition/)
  assert.equal(body.split("log('composing final video...')").length - 1, 1)
  assert.equal(body.split('log(`deriving SDR rendition').length - 1, 1)
  // main() takes the unsliced path, today's compose(), whenever slicing is off.
  const main = src.slice(src.indexOf('async function main('), at)
  assert.match(main, /if \(slicing\.sliced\) \{\n\s+await renderInSlices\(/)
  assert.match(main, /\} else \{\n\s+log\(slicingLine\(slicing\)\)\n[\s\S]*renderAllSegments\(segmentSpecs, \{ workers, motionBlur \}\)[\s\S]*await compose\(/)
})
