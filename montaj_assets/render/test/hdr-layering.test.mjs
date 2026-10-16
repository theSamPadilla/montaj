// render/test/hdr-layering.test.mjs (§308 P3, task 14)
//
// HDR graphics white follows each layer's place in the one bottom-to-top list,
// now that images and overlays interleave by track. The two rules (POSTLAUNCH
// §47) are unchanged in kind:
//   - the segment's level: 800 nits over visible footage, 300 with none. Footage
//     culled under an opaque overlay is not visible; footage stacked ABOVE the
//     overlay that replaces the picture is.
//   - a full-screen card (coversFrame) and every graphic stacked above it take
//     300, since they sit on the card. Before, only overlays could be above a
//     card; now an image on a higher track can, and it takes the card's white.
// A segment where every item is below every overlay answers exactly as before:
// hdr-cards.test.mjs and hdr-graphics-no-footage.test.mjs pass unedited, and
// layering-identity.test.mjs holds the encoder args to 5.33.3's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GRAPHICS_WHITE_NITS, GRAPHICS_WHITE_NITS_NO_FOOTAGE, graphicsLutPath } from '../hdr-graphics.js'
import { encodeSegment, graphicsWhiteNitsFor, overlayWhiteNits } from '../encode-segment.js'
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
    const nits = f.includes(lut(GRAPHICS_WHITE_NITS_NO_FOOTAGE)) ? 300 : f.includes(lut(GRAPHICS_WHITE_NITS)) ? 800 : null
    if (nits) at[m[1] ?? m[2]] = nits
  }
  return at
}

test('overlayWhiteNits over the layer list: an image above a card takes the card\'s white, one below the segment\'s', () => {
  const layers = [video(), image('below', 1), overlay('card', 2, { coversFrame: true }), image('above', 3)]
  assert.deepEqual(layers.map((_, k) => overlayWhiteNits(layers, k, GRAPHICS_WHITE_NITS)), [800, 800, 300, 300])
})

test('an HDR segment with an image above a probed card: footage drawn, the card and the image on it at 300, the image under it at 800', async () => {
  // A probed card (coversFrame, not opaque) replaces nothing, so the footage
  // stays visible and the segment's level is 800.
  const [seg] = planSegments([video(), image('below', 1), image('above', 3)], [overlay('card', 2, { coversFrame: true })], 1080, 1920, FPS)
  assert.deepEqual(seg.layers.map(x => x.id), ['v', 'below', 'card', 'above'])
  assert.equal(graphicsWhiteNitsFor(seg), GRAPHICS_WHITE_NITS)
  // Inputs: 1 footage, 2 image below, 3 card capture, 4 image above.
  assert.deepEqual(await whites(seg), { 2: 800, 3: 300, 4: 300 })
})

test('the segment\'s level counts only footage that is drawn: culled under an opaque overlay is none, stacked above it is', () => {
  // Footage under an opaque full-screen overlay, an image above it: no footage shows.
  const [culled] = planSegments([video(), image('top', 2)], [overlay('cover', 1, { opaque: true })], 1080, 1920, FPS)
  assert.equal(culled.opaqueVideo, true)
  assert.equal(graphicsWhiteNitsFor(culled), GRAPHICS_WHITE_NITS_NO_FOOTAGE)
  // An overlay on the bottom video track and footage on a video track above it
  // (only an agent writes this): the opaque overlay culls nothing above it, so
  // the upper footage shows.
  const low = video({ id: 'low', trackIdx: 0, layerTrack: 0 })
  const high = video({ id: 'high', src: '/h.mp4', trackIdx: 1, layerTrack: 1 })
  const [shown] = planSegments([low, high], [overlay('cover', 0, { opaque: true })], 1080, 1920, FPS)
  assert.deepEqual(shown.layers.map(x => x.id), ['low', 'cover', 'high'])
  assert.equal(graphicsWhiteNitsFor(shown), GRAPHICS_WHITE_NITS)
})

test('with every item below every overlay the whites are what they were', async () => {
  const [seg] = planSegments([video(), image('i', 1)], [overlay('card', 2, { coversFrame: true }), overlay('top', 3)], 1080, 1920, FPS)
  assert.equal('layers' in seg, false)
  assert.deepEqual(await whites(seg), { 2: 800, 3: 300, 4: 300 }, 'image at the segment\'s level, the card and the overlay on it at 300')
})
