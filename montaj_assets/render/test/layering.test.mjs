// render/test/layering.test.mjs (§308 P3)
//
// One stacking rule for the editor preview, sample_frame and the export: by
// track, in the editor's order (timeline-core `trackLayerPositions`). The
// export used to draw every image and clip under every overlay, so an image on
// a track above an overlay showed in the editor and was hidden in the export.
//
// Unit level: the plan's layer list, the cull below the overlay that replaces
// the picture, and the encoder's single loop. The pixels are
// layering.integration.test.mjs; the byte-identity gate is
// layering-identity.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planSegments } from '../segment-plan.js'
import { encodeSegment, culledClips } from '../encode-segment.js'
import { collectAllItems, collectPuppeteerSegments } from '../render.js'

const FPS = 30
const video = (extra = {}) => ({ id: 'v', type: 'video', start: 0, end: 4, src: '/v.mp4', inPoint: 0, outPoint: 4, trackIdx: 0, layerTrack: 0, ...extra })
const image = (extra = {}) => ({ id: 'i', type: 'image', start: 0, end: 4, src: '/i.png', trackIdx: 2, layerTrack: 2, scale: 0.5, offsetX: 0, offsetY: 0, opacity: 1, ...extra })
const overlay = (extra = {}) => ({ id: 'o', startSeconds: 0, endSeconds: 4, webmPath: '/o.mkv', isCaption: false, opaque: false, layerTrack: 1, scale: 1, offsetX: 0, offsetY: 0, rotation: 0, opacity: 1, ...extra })
const caption = { id: 'captions', startSeconds: 0, endSeconds: 4, webmPath: '/c.mkv', isCaption: true }
const ids = list => list.map(x => x.id)

test('collectors stamp each clip and overlay with its track in the editor\'s order', () => {
  // JSON: an image-only track, the footage, an overlay track. The editor puts
  // the video track first, so the image track stacks over the footage.
  const project = {
    settings: { fps: FPS },
    tracks: [
      [{ id: 'bg', type: 'image', src: '/bg.png', start: 0, end: 4 }],
      [{ id: 'v', type: 'video', src: '/v.mp4', start: 0, end: 4 }],
      [{ id: 'o', type: 'overlay', src: '/abs/o.jsx', start: 0, end: 4 }],
    ],
  }
  const { imageItems, videoItems } = collectAllItems(project)
  assert.deepEqual([imageItems[0].trackIdx, imageItems[0].layerTrack], [0, 1])
  assert.deepEqual([videoItems[0].trackIdx, videoItems[0].layerTrack], [1, 0])
  const [spec] = collectPuppeteerSegments(project, FPS, 1080, 1920, '/tmp/seg')
  assert.equal(spec.layerTrack, 2)
})

test('planSegments: an image on a track above an overlay is stacked over it', () => {
  const [seg] = planSegments([video(), image()], [overlay(), caption], 1080, 1920, FPS)
  assert.deepEqual(ids(seg.layers), ['v', 'o', 'i', 'captions'], 'by track, captions last')
  assert.deepEqual(ids(seg.items), ['v', 'i'], 'items and overlays are still there for audio and counting')
  assert.deepEqual(ids(seg.overlays), ['o', 'captions'])
  assert.equal(seg.cullBelow, null)
  assert.equal(seg.opaqueVideo, false)
})

test('planSegments: no layers when every item is below every overlay (the plan of every 5.33.3 project)', () => {
  const [seg] = planSegments([video(), image({ trackIdx: 1, layerTrack: 1 })], [overlay({ layerTrack: 2 }), caption], 1080, 1920, FPS)
  assert.equal('layers' in seg, false)
  assert.equal('cullBelow' in seg, false)
  // Hand-built descriptors with no layerTrack keep their old place: overlays on top.
  const [old] = planSegments([video({ layerTrack: undefined })], [overlay({ layerTrack: undefined })], 1080, 1920, FPS)
  assert.equal('layers' in old, false)
})

test('planSegments: a track\'s clips come before its overlays (KNOWN-DIVERGENCES D19)', () => {
  const [seg] = planSegments([video(), image({ layerTrack: 1 })], [overlay({ layerTrack: 1 }), overlay({ id: 'top', layerTrack: 2 })], 1080, 1920, FPS)
  assert.equal('layers' in seg, false, 'same track: the image below the overlay, as the export always drew it')
})

test('planSegments: an opaque overlay culls only what is below it', () => {
  // Footage at the bottom, an opaque full-screen overlay over it, an image over that.
  const [seg] = planSegments([video(), image()], [overlay({ opaque: true })], 1080, 1920, FPS)
  assert.deepEqual(ids(seg.layers), ['v', 'o', 'i'])
  assert.equal(seg.cullBelow.id, 'o')
  assert.equal(seg.opaqueVideo, true, 'the footage under it is culled')
  assert.deepEqual(ids([...culledClips(seg)]), ['v'], 'the image over it is drawn')
  // An opaque overlay above both culls both: the old stack, no layers.
  const [both] = planSegments([video(), image()], [overlay({ opaque: true, layerTrack: 3 })], 1080, 1920, FPS)
  assert.equal('layers' in both, false)
  assert.deepEqual(ids([...culledClips(both)]), ['v', 'i'])
  // Two covers: the topmost decides.
  const [two] = planSegments([video(), image()], [overlay({ id: 'low', opaque: true }), overlay({ id: 'high', opaque: true, layerTrack: 3 })], 1080, 1920, FPS)
  assert.equal(two.cullBelow.id, 'high')
  assert.deepEqual(ids([...culledClips(two)]), ['v', 'i'])
})

test('planSegments: the cull below an overlay still follows its opacity (§309), range by range', () => {
  // The cover fades out from 1 s to 2 s: culling the footage only while it is at 1.
  const fading = overlay({ opaque: true, keyframes: [{ prop: 'opacity', points: [{ t: 1, value: 1 }, { t: 2, value: 0 }] }] })
  const segs = planSegments([video(), image()], [fading], 1080, 1920, FPS)
  assert.deepEqual(segs.map(s => [s.start, s.end, s.cullBelow?.id ?? null, ids([...culledClips(s)])]), [[0, 1, 'o', ['v']], [1, 4, null, []]])
})

test('encodeSegment: the layers composite in one loop, inputs and the label chain in layer order', async () => {
  const [seg] = planSegments([video(), image()], [overlay()], 1080, 1920, FPS)
  const { inputs, filterParts } = await encodeSegment(seg, '/tmp/l.mp4', { _dryRun: true })
  const files = inputs.filter((_, k) => inputs[k - 1] === '-i').filter(f => f.startsWith('/'))
  assert.deepEqual(files, ['/v.mp4', '/o.mkv', '/i.png'], 'footage, overlay, image')
  // The image's overlay step reads the overlay's output: it is composited over it.
  const ovOut = filterParts.find(f => f.includes('shortest=0[vov2]'))
  assert.ok(ovOut, 'the overlay is input 2')
  const imageStep = filterParts.findIndex(f => f.startsWith('[vov2]'))
  assert.ok(imageStep > filterParts.indexOf(ovOut), 'the image is drawn onto the overlay\'s output')
})

test('encodeSegment: under an opaque overlay the footage keeps its input (audio) and loses its picture; the image above is drawn', async () => {
  const [seg] = planSegments([video(), image()], [overlay({ opaque: true })], 1080, 1920, FPS)
  const { inputs, filterParts } = await encodeSegment(seg, '/tmp/l.mp4', { _dryRun: true })
  assert.ok(inputs.includes('/v.mp4'), 'the footage input stays, for its audio')
  assert.ok(filterParts.some(f => f.startsWith('[1:a:0]')), 'its audio is mixed')
  assert.ok(!filterParts.some(f => f.startsWith('[1:v') || f.includes('[1:v:0]')), 'its picture is not composited')
  assert.ok(inputs.includes('/i.png'), 'the image over the overlay is drawn')
})

test('encodeSegment: a crossfade pair above an overlay still blends', async () => {
  const xf = { start: 1, end: 3 }
  const a = image({ id: 'a', start: 0, end: 3, crossfade: { role: 'from', ...xf } })
  const b = image({ id: 'b', start: 1, end: 4, crossfade: { role: 'to', ...xf } })
  const segs = planSegments([video(), a, b], [overlay()], 1080, 1920, FPS)
  const inside = segs.find(s => s.start === 1)
  assert.deepEqual(ids(inside.layers), ['v', 'o', 'a', 'b'])
  const { filterParts } = await encodeSegment(inside, '/tmp/l.mp4', { _dryRun: true })
  const split = filterParts.findIndex(f => f.includes('split=2[xfa'))
  const blend = filterParts.findIndex(f => f.includes('blend=all_expr'))
  assert.ok(split >= 0 && blend > split, 'split at the outgoing image, blend at its partner')
  assert.ok(filterParts.findIndex(f => f.includes('shortest=0[vov')) < split, 'the overlay is composited first, under the pair')
})
