// render/test/hdr-layering.test.mjs (§308 P3, task 14)
//
// HDR graphics white with images and overlays interleaved by track: every
// layer maps white to 800 nits wherever it sits in the one bottom-to-top list,
// over footage, over a full-screen card or over nothing (the product owner,
// 2026-10-26: one white). Before, a full-screen card and everything stacked
// above it mapped to 300 and the layer list decided which; the plan itself
// (layer order, culled footage) is unchanged and is held by layering.test.mjs
// and layering-identity.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GRAPHICS_WHITE_NITS, graphicsLutPath } from '../hdr-graphics.js'
import { encodeSegment } from '../encode-segment.js'
import { planSegments } from '../segment-plan.js'

const FPS = 30
const video = (extra = {}) => ({ id: 'v', type: 'video', start: 0, end: 4, src: '/v.mp4', inPoint: 0, outPoint: 4, trackIdx: 0, layerTrack: 0, ...extra })
const image = (id, layerTrack) => ({ id, type: 'image', start: 0, end: 4, src: `/${id}.png`, trackIdx: layerTrack, layerTrack, scale: 0.5, offsetX: 0, offsetY: 0, opacity: 1 })
const overlay = (id, layerTrack, extra = {}) => ({ id, startSeconds: 0, endSeconds: 4, webmPath: `/${id}.mkv`, isCaption: false, opaque: false, layerTrack, scale: 1, offsetX: 0, offsetY: 0, rotation: 0, opacity: 1, ...extra })
const lut = nits => graphicsLutPath('hdr_hlg', { write: false, whiteNits: nits })
/** Which white each input's graphics chain maps to, by the input file it reads. */
async function whites(seg) {
  const { filterParts } = await encodeSegment({ ...seg, colorSpace: 'hdr_hlg' }, '/tmp/h.mp4', { _dryRun: true })
  // An image's chain starts at its input ([k:v]); a capture's continues from
  // [ovfmtk]. Footage maps no graphics white and is left out.
  const at = {}
  for (const f of filterParts) {
    const m = /^\[(?:(\d+):v|ovfmt(\d+))\]/.exec(f)
    if (!m) continue
    const nits = f.includes(lut(300)) ? 300 : f.includes(lut(GRAPHICS_WHITE_NITS)) ? 800 : null
    if (nits) at[m[1] ?? m[2]] = nits
  }
  return at
}

test('an HDR segment with an image above a full-screen card: the card and both images map at 800', async () => {
  const [seg] = planSegments([video(), image('below', 1), image('above', 3)], [overlay('card', 2)], 1080, 1920, FPS)
  assert.deepEqual(seg.layers.map(x => x.id), ['v', 'below', 'card', 'above'])
  // Inputs: 1 footage, 2 image below, 3 card capture, 4 image above.
  assert.deepEqual(await whites(seg), { 2: 800, 3: 800, 4: 800 })
})

test('footage culled under an opaque overlay, with an image above it, still maps every graphic at 800', async () => {
  const [seg] = planSegments([video(), image('top', 2)], [overlay('cover', 1, { opaque: true })], 1080, 1920, FPS)
  assert.equal(seg.opaqueVideo, true)
  assert.deepEqual(await whites(seg), { 2: 800, 3: 800 }, 'the cover capture and the image above it')
})

test('with every item below every overlay, every graphic is at 800', async () => {
  const [seg] = planSegments([video(), image('i', 1)], [overlay('card', 2), overlay('top', 3)], 1080, 1920, FPS)
  assert.equal('layers' in seg, false)
  assert.deepEqual(await whites(seg), { 2: 800, 3: 800, 4: 800 })
})
