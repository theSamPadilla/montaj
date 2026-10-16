// render/test/layering-identity.test.mjs (§308 P3)
//
// THE BYTE-IDENTITY GATE for one stacking rule. A project whose tracks are
// already in the editor's order (every track holding video first) and where no
// clip sits on a higher layer than an overlay must plan and encode exactly as
// montaj 5.33.3 did. That is most projects: footage at the bottom, overlays
// above. Seeded random projects go through the real collectors, then through
// today's planner and encoder and through FROZEN 5.33.3 copies of both
// (test/frozen/), and the plans and the dry-run ffmpeg arguments must be equal.
//
// The second half fuzzes the projects that DO interleave (an image above an
// overlay), with §309 opacity-keyed opaque covers among them, and checks the
// rules hold instead: the layer list is by track, the cull reaches only below
// the topmost cover, and that cover is at full opacity on every frame of the
// segment and every motion-blur sub-frame (x1 to x8) the capture samples.
//
// RETIREMENT RULE for the args half. The frozen encoder is the 5.34.0 release
// proof, and encode-segment.js moves often. When a later change LEGITIMATELY
// moves the dry-run args, delete test/frozen/encode-segment.5.33.3.js and the
// `encodeSegment533` comparison below in that same commit. Keep the frozen
// planner comparison and the builder-independent asserts beside it (no
// `layers` key on a covered project's segments; its inputs are the canvas,
// then the items minus culled images, then the overlays in order), which say
// the same thing about the stack without depending on any builder's strings.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trackLayerPositions, opacityAt, isOpaqueCover } from '@bycrux/timeline-core'
import { planSegments, replacesPicture } from '../segment-plan.js'
import { trackItems, enabledTrackItems } from '../project-tracks.js'
import { encodeSegment, culledClips } from '../encode-segment.js'
import { planSegments as planSegments533 } from './frozen/segment-plan.5.33.3.js'
import { encodeSegment as encodeSegment533 } from './frozen/encode-segment.5.33.3.js'
import { collectAllItems, collectPuppeteerSegments } from '../render.js'

function rng(seed) {
  let s = seed >>> 0
  const next = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296
  return { next, pick: a => a[Math.floor(next() * a.length)], int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)) }
}

/** A random project: tracks of footage, images and overlays, some crossfades, opaque covers with or without §309 keys. */
function randomProject(r, { fps, colorSpace }) {
  const span = () => {
    const start = r.pick([0, 0, 0.5, 1, 1 / fps, 1.37])
    return [start, start + r.pick([1, 2, 3.25, 4, 2 + 1 / fps])]
  }
  let n = 0
  const id = k => `${k}${n++}`
  const opacityKeys = () => r.pick([
    undefined, undefined,
    [{ prop: 'opacity', points: [{ t: 0, value: 0 }, { t: 1, value: 1 }] }],
    [{ prop: 'opacity', points: [{ t: 0.5, value: 1, easing: 'hold' }, { t: 2.25, value: 0 }] }],
    [{ prop: 'opacity', points: [{ t: 1, value: 1 }, { t: 1.5, value: 0.4 }, { t: 2.6, value: 1 }] }],
  ])
  const clipPair = (type, extra) => {
    // Two clips crossfading on one track, or one clip.
    const [a0, a1] = span()
    const one = { id: id(type[0]), type, start: a0, end: a1, src: `/fz/${type}${n}.${type === 'video' ? 'mp4' : 'png'}`, ...extra() }
    if (r.next() < 0.5) return [one]
    return [one, { ...one, id: id(type[0]), src: `/fz/${type}${n}b`, start: a1 - 0.5, end: a1 + 1.5 }]
  }
  const videoExtra = () => ({ inPoint: 0, ...(r.next() < 0.3 ? { scale: 0.4, offsetX: 20 } : {}), ...(r.next() < 0.2 ? { speed: 2 } : {}) })
  const imageExtra = () => ({ scale: r.pick([1, 0.5]), ...(r.next() < 0.2 ? { opacity: 0.6 } : {}) })
  const overlayItem = () => {
    const [s0, s1] = span()
    const opaque = r.next() < 0.5
    const kf = opaque ? opacityKeys() : undefined
    return {
      id: id('o'), type: 'overlay', src: `/abs/fz-${n}.jsx`, start: s0, end: s1, props: {},
      ...(opaque ? { opaque: true } : {}), ...(r.next() < 0.2 ? { scale: 0.6 } : {}), ...(kf ? { keyframes: kf } : {}),
    }
  }
  const kinds = []
  for (let k = r.int(0, 2); k > 0; k--) kinds.push('video')
  for (let k = r.int(0, 2); k > 0; k--) kinds.push(r.pick(['image', 'image', 'mixed']))
  for (let k = r.int(0, 2); k > 0; k--) kinds.push(r.pick(['overlay', 'overlay', 'videoOverlay']))
  if (kinds.length === 0) kinds.push('video')
  const tracks = kinds.map((kind) => {
    if (kind === 'video') return clipPair('video', videoExtra)
    if (kind === 'image') return clipPair('image', imageExtra)
    if (kind === 'mixed') return [...clipPair('image', imageExtra), overlayItem()]
    if (kind === 'videoOverlay') return [...clipPair('video', videoExtra), overlayItem()]
    return r.next() < 0.3 ? [overlayItem(), overlayItem()] : [overlayItem()]
  })
  // Shuffle a third of them, so non-canonical orders reach the interleaved half.
  if (r.next() < 0.33) tracks.sort(() => r.next() - 0.5)
  // Some projects in the object form, with a track skipped now and then: a
  // skipped track draws nothing but still counts in the editor's order.
  const shaped = r.next() < 0.4
    ? tracks.map((items, k) => ({ id: `trk-${k}`, items, ...(r.next() < 0.2 ? { enabled: false } : {}) }))
    : tracks
  return {
    settings: { resolution: r.pick([[1080, 1920], [1920, 1080]]), fps, colorSpace },
    tracks: shaped,
    ...(r.next() < 0.3 ? { captions: { style: 'pop', segments: [{ start: 0, end: 3, text: 'hi' }] } } : {}),
  }
}

/** Whether the project is one the gate covers: canonical order, and no clip on a higher layer than an overlay. */
function coveredByGate(project) {
  const positions = trackLayerPositions(trackItems(project))
  if (positions.some((p, i) => p !== i)) return false
  let topClip = -1
  let lowOverlay = Infinity
  enabledTrackItems(project).forEach((items, i) => {
    if (items.some(it => it.type !== 'overlay')) topClip = Math.max(topClip, i)
    if (items.some(it => it.type === 'overlay')) lowOverlay = Math.min(lowOverlay, i)
  })
  // Same track: its clips come before its overlays, as they always did.
  return topClip <= lowOverlay
}

/** Planner inputs exactly as compose.js builds them; overlays as render.js's rendered descriptors. */
function inputs(project, fps) {
  const [vw, vh] = project.settings.resolution
  const { imageItems, videoItems } = collectAllItems(project)
  const specs = collectPuppeteerSegments(project, fps, vw, vh, '/fz/seg')
  const hdr = project.settings.colorSpace !== 'sdr_bt709'
  const segs = specs.map((spec, k) => ({ ...spec, webmPath: spec.outputPath, ...(hdr && spec.opaque && k % 2 === 0 ? { coversFrame: true } : {}) }))
  return { allItems: [...imageItems, ...videoItems], segs, vw, vh }
}

const CASES = 400

test('byte-identity: canonical projects with no clip above an overlay plan and encode exactly as 5.33.3', async () => {
  const r = rng(308)
  let covered = 0, segments = 0, withOverlay = 0, withCover = 0, withPair = 0, objectForm = 0, skipped = 0
  for (let c = 0; c < CASES * 3 && covered < CASES; c++) {
    const fps = r.pick([24, 25, 30, 60, 29.97])
    const project = randomProject(r, { fps, colorSpace: r.pick(['sdr_bt709', 'sdr_bt709', 'hdr_hlg']) })
    if (!coveredByGate(project)) continue
    covered++
    if (!Array.isArray(project.tracks[0])) objectForm++
    if (project.tracks.some(t => t.enabled === false)) skipped++
    const now = inputs(project, fps)
    const then = inputs(project, fps)
    const planNow = planSegments(now.allItems, now.segs, now.vw, now.vh, fps)
    const planThen = planSegments533(then.allItems, then.segs, then.vw, then.vh, fps)
    assert.equal(JSON.stringify(planNow), JSON.stringify(planThen), `case ${c}: plan`)
    for (let k = 0; k < planNow.length; k++) {
      const segNow = { ...planNow[k], colorSpace: project.settings.colorSpace }
      const segThen = { ...planThen[k], colorSpace: project.settings.colorSpace }
      const a = await encodeSegment(segNow, `/fz/out-${k}.mp4`, { _dryRun: true })
      const b = await encodeSegment533(segThen, `/fz/out-${k}.mp4`, { _dryRun: true })
      assert.deepStrictEqual(a.args, b.args, `case ${c} segment ${k}: ffmpeg args`)
      // Builder-independent (outlives the frozen encoder, see the retirement
      // rule): no layer list, and the inputs are the canvas, then every item
      // the picture or the audio needs (an image culled under a cover adds
      // none; its order inside one track may follow the crossfade pairing),
      // then every overlay, in order.
      assert.equal('layers' in planNow[k], false, `case ${c} segment ${k}: no layers on a covered project`)
      const files = a.inputs.filter((_, q) => a.inputs[q - 1] === '-i')
      assert.match(files[0], /^color=black/, `case ${c} segment ${k}: the canvas first`)
      const culled = culledClips(segNow)
      const items = segNow.items.filter(x => !(culled.has(x) && x.type === 'image')).map(x => x.src)
      const overlays = segNow.overlays.map(o => o.webmPath)
      assert.deepEqual([...files.slice(1, 1 + items.length)].sort(), [...items].sort(), `case ${c} segment ${k}: the items next`)
      assert.deepEqual(files.slice(1 + items.length, 1 + items.length + overlays.length), overlays, `case ${c} segment ${k}: then the overlays, in order`)
      segments++
      if (segNow.overlays.some(o => !o.isCaption)) withOverlay++
      if (segNow.opaqueVideo) withCover++
      if (segNow.items.some(it => it.crossfade)) withPair++
    }
  }
  // Not vacuous: the corpus reached every path the gate is about.
  assert.equal(covered, CASES, 'enough covered projects')
  assert.ok(segments > 1500 && withOverlay > 300 && withCover > 50 && withPair > 50 && objectForm > 50 && skipped > 10,
    JSON.stringify({ segments, withOverlay, withCover, withPair, objectForm, skipped }))
})

test('interleaved projects: by track, the cull only below the topmost cover, and that cover at 1 on every frame and blur sub-frame', async () => {
  const r = rng(309)
  let interleaved = 0, culledAny = 0, drawnAbove = 0, objectForm = 0
  for (let c = 0; c < 1500; c++) {
    const fps = r.pick([24, 30, 60, 29.97])
    const project = randomProject(r, { fps, colorSpace: 'sdr_bt709' })
    if (coveredByGate(project)) continue
    const { allItems, segs, vw, vh } = inputs(project, fps)
    if (!Array.isArray(project.tracks[0])) objectForm++
    for (const seg of planSegments(allItems, segs, vw, vh, fps)) {
      if (!seg.layers) continue
      interleaved++
      const layerOf = x => (seg.items.includes(x) ? x.layerTrack : (x.isCaption ? Infinity : x.layerTrack))
      const kindOf = x => (seg.items.includes(x) ? 0 : x.isCaption ? 2 : 1)
      for (let k = 1; k < seg.layers.length; k++) {
        const [a, b] = [seg.layers[k - 1], seg.layers[k]]
        assert.ok(layerOf(a) < layerOf(b) || (layerOf(a) === layerOf(b) && kindOf(a) <= kindOf(b)), `case ${c}: layers by track, clips first, captions last`)
      }
      const culled = culledClips(seg)
      const coverAt = seg.cullBelow ? seg.layers.indexOf(seg.cullBelow) : -1
      if (seg.cullBelow) {
        // The cover is an opaque overlay over the whole canvas, and the topmost
        // overlay that replaces the picture: none above it does.
        assert.equal(isOpaqueCover(seg.cullBelow), true, `case ${c}: the cover is opaque over the whole canvas`)
        for (const x of seg.layers.slice(coverAt + 1)) {
          if (seg.overlays.includes(x)) assert.equal(replacesPicture(x, seg.start, seg.end, fps), false, `case ${c}: no replacing overlay above the cover`)
        }
      } else {
        for (const x of seg.overlays) assert.equal(replacesPicture(x, seg.start, seg.end, fps), false, `case ${c}: no cover, so none replaces`)
      }
      seg.layers.forEach((x, k) => {
        if (!seg.items.includes(x)) return
        assert.equal(culled.has(x), k < coverAt, `case ${c}: cull exactly below the cover`)
        if (k > coverAt && coverAt >= 0) drawnAbove++
      })
      if (culled.size) {
        culledAny++
        // The cover replaces the picture on every frame the segment draws, and on
        // every motion-blur sub-frame the capture samples for it.
        const cover = seg.cullBelow
        const S = Math.round(cover.startSeconds * fps)
        for (let f = Math.round(seg.start * fps); f < Math.round(seg.end * fps); f++) {
          const i = Math.max(0, f - S)
          for (let N = 1; N <= 8; N++) {
            for (let q = 0; q < N; q++) assert.equal(opacityAt(cover, (i + q / N) / fps), 1, `case ${c}: frame ${f} sub-frame ${q}/${N} under a cull`)
          }
        }
      }
      // The encoder takes the same list: one input per layer it draws, in order.
      const { inputs: argv } = await encodeSegment({ ...seg, colorSpace: 'sdr_bt709' }, '/fz/x.mp4', { _dryRun: true })
      const files = argv.filter((_, k) => argv[k - 1] === '-i' && argv[k].startsWith('/fz'))
      const expected = seg.layers.filter(x => !(culled.has(x) && x.type === 'image')).map(x => (seg.items.includes(x) ? x.src : x.webmPath))
      const pairs = seg.items.filter(x => x.crossfade).length
      if (!pairs) assert.deepEqual(files, expected, `case ${c}: inputs in layer order`)
    }
  }
  assert.ok(interleaved > 200 && culledAny > 20 && drawnAbove > 20 && objectForm > 50, JSON.stringify({ interleaved, culledAny, drawnAbove, objectForm }))
})
