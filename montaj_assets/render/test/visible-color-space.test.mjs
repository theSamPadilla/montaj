// §378: only video that is on screen decides the colour space the picture needs.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { visibleVideoItems, effectiveColorSpace } from '../visible-video.js'
import { resolvePictureColorSpace, collectAllItems, stampSourceProbes, fillsFrameOpaquely } from '../render.js'
import { isHdr, detectFromTransfer } from '../color-space.js'
import { FFMPEG } from '../ffmpeg-bin.js'

const WORK = mkdtempSync(join(tmpdir(), 'montaj-visible-'))
after(() => rmSync(WORK, { recursive: true, force: true }))

const video = (id, start, end, over = {}) => ({ id, type: 'video', src: `/x/${id}.mp4`, start, end, ...over })
const overlay = (id, start, end, over = {}) => ({ id, type: 'overlay', src: 'engine:scene3d', start, end, opaque: true, ...over })
const ids = (items) => items.map((i) => i.id)

// ---- the pure helper ----

test('an HDR clip used only as the voiceover is not on screen: no video item, no visible video', () => {
  // The voiceover is audio (project.voiceover or an audio track), never a video item.
  assert.deepEqual(visibleVideoItems([[]]), [])
  const eff = effectiveColorSpace({ stored: 'hdr_hlg', visible: [], isHdrItem: () => true, isHdrKey: isHdr })
  assert.deepEqual(eff, { colorSpace: 'sdr_bt709', hdrVisible: false, downgraded: true })
})

test('a clip an opaque 3D overlay covers for its whole span is not visible; partly covered still is', () => {
  const tracks = [[video('a', 0, 5), video('b', 5, 10)], [overlay('s', 0, 5), overlay('t', 5, 8)]]
  assert.deepEqual(ids(visibleVideoItems(tracks)), ['b'])
  // two covers that together span the clip hide it
  assert.deepEqual(ids(visibleVideoItems([[video('a', 0, 6)], [overlay('s', 0, 3), overlay('t', 3, 6)]])), [])
  // a fade (opacity below 1) is not a cover
  const fading = overlay('s', 0, 5, { keyframes: [{ prop: 'opacity', points: [{ t: 0, value: 0 }, { t: 1, value: 1 }] }] })
  assert.deepEqual(ids(visibleVideoItems([[video('a', 0, 5)], [fading]])), ['a'])
  // not opaque, or not over the whole canvas
  assert.deepEqual(ids(visibleVideoItems([[video('a', 0, 5)], [overlay('s', 0, 5, { opaque: false })]])), ['a'])
  assert.deepEqual(ids(visibleVideoItems([[video('a', 0, 5)], [overlay('s', 0, 5, { scale: 0.5 })]])), ['a'])
})

test('a keyed stretch at full opacity shorter than the planner\'s one second is not a cover; a steady cover of any length is', () => {
  const keyed = (to) => overlay('s', 0, 5, { keyframes: [{ prop: 'opacity', points: [{ t: 0, value: 0 }, { t: 1, value: 1 }, { t: to, value: 1 }, { t: to + 1, value: 0 }] }] })
  // 0.5 s at full opacity inside a fade in and out: not a cover (segment-plan MIN_FULL_OPACITY_S)
  assert.deepEqual(ids(visibleVideoItems([[video('a', 1, 1.5)], [keyed(1.5)]])), ['a'])
  // 2 s at full opacity covers a clip lying inside it
  assert.deepEqual(ids(visibleVideoItems([[video('a', 1, 3)], [keyed(3)]])), [])
  assert.deepEqual(ids(visibleVideoItems([[video('a', 1, 1.5)], [overlay('s', 0, 5)]])), [])
})

test('a clip that starts after the export ends is not visible; one that straddles it is', () => {
  const tracks = [[video('a', 0, 4), video('b', 4, 8)], [overlay('s', 0, 4)]]
  assert.deepEqual(ids(visibleVideoItems(tracks, { end: 4 })), [])
  assert.deepEqual(ids(visibleVideoItems(tracks, { end: 6 })), ['b'])
})

test('a full-frame image with no alpha hides the video below it; the caller reads the file', () => {
  const card = { id: 'card', type: 'image', src: '/x/black.png', start: 0, end: 10 }
  const tracks = [[video('a', 0, 10)], [card]]
  assert.deepEqual(ids(visibleVideoItems(tracks, { coversPicture: (i) => i.id === 'card' })), [])
  assert.deepEqual(ids(visibleVideoItems(tracks, { coversPicture: () => false })), ['a'])
  // an image that is not at full opacity or not full-canvas never covers
  assert.deepEqual(ids(visibleVideoItems([[video('a', 0, 10)], [{ ...card, opacity: 0.5 }]], { coversPicture: () => true })), ['a'])
  assert.deepEqual(ids(visibleVideoItems([[video('a', 0, 10)], [{ ...card, scale: 0.5 }]], { coversPicture: () => true })), ['a'])
})

test('a full-canvas opaque video covers only the videos on tracks before its own, and never remove_bg ones', () => {
  const top = video('top', 0, 10)
  assert.deepEqual(ids(visibleVideoItems([[video('under', 0, 10)], [top]], { coversPicture: (i) => i.id === 'top' })), ['top'])
  assert.deepEqual(ids(visibleVideoItems([[video('under', 0, 10)], [{ ...top, remove_bg: true }]], { coversPicture: () => true })), ['under', 'top'])
})

test('an explicit HDR choice is kept; an auto-picked or unmarked one falls back only when no visible video is HDR', () => {
  const hdrItem = { colorTransfer: 'arib-std-b67' }
  const isHdrItem = (i) => isHdr(detectFromTransfer(i.colorTransfer))
  const a = (source, visible) => effectiveColorSpace({ stored: 'hdr_hlg', source, visible, isHdrItem, isHdrKey: isHdr })
  assert.equal(a('explicit', []).colorSpace, 'hdr_hlg')
  assert.equal(a('auto', []).colorSpace, 'sdr_bt709')
  assert.equal(a(null, []).colorSpace, 'sdr_bt709')
  assert.equal(a('auto', [hdrItem]).colorSpace, 'hdr_hlg')
  assert.equal(a(null, [{ colorTransfer: 'bt709' }]).colorSpace, 'sdr_bt709')
  assert.equal(effectiveColorSpace({ stored: 'sdr_bt709', source: 'auto', visible: [hdrItem], isHdrItem, isHdrKey: isHdr }).colorSpace, 'sdr_bt709')
})

// ---- the render's decision, over a real project with real files ----

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
}
const HLG = ['-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-x265-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error']

test('render decision: an HDR file covered by a full-frame black card exports SDR; uncovered it stays HDR; explicit stays HDR', () => {
  const hdr = join(WORK, 'talk.mp4')
  const black = join(WORK, 'black.png')
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30', '-t', '2', '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', ...HLG, '-tag:v', 'hvc1', hdr])
  ff(['-f', 'lavfi', '-i', 'color=black:size=1080x1920', '-frames:v', '1', '-pix_fmt', 'rgb24', black])
  const settings = (over = {}) => ({ resolution: [1080, 1920], fps: 30, colorSpace: 'hdr_hlg', ...over })
  const project = (tracks, st) => ({ id: 'p', settings: st, tracks })
  const clip = { id: 'c1', type: 'video', src: hdr, start: 0, end: 2, inPoint: 0, outPoint: 2 }
  const card = { id: 'card', type: 'image', src: black, start: 0, end: 2 }
  const decide = (tracks, st) => {
    const pj = project(tracks, st)
    const { videoItems } = collectAllItems(pj)
    stampSourceProbes(videoItems, new Map())
    return resolvePictureColorSpace(pj, st, videoItems)
  }
  const covered = decide([{ id: 't0', items: [clip] }, { id: 't1', items: [card] }], settings())
  assert.equal(covered.colorSpace, 'sdr_bt709')
  assert.equal(covered.downgraded, true)
  const shown = decide([{ id: 't0', items: [clip] }], settings())
  assert.equal(shown.colorSpace, 'hdr_hlg')
  assert.equal(shown.hdrVisible, true)
  const explicit = decide([{ id: 't0', items: [clip] }, { id: 't1', items: [card] }], settings({ colorSpaceSource: 'explicit' }))
  assert.equal(explicit.colorSpace, 'hdr_hlg')
})

test('HDR is judged by the source file\'s origin: an SDR clip decoded from an HDR cache is SDR', () => {
  const sdr = join(WORK, 'plain.mp4')
  const cache = join(WORK, 'plain_hdr_cache.mp4')
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', sdr])
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30', '-t', '2', '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', ...HLG, '-tag:v', 'hvc1', cache])
  const st = { resolution: [1080, 1920], fps: 30, colorSpace: 'hdr_hlg' }
  const pj = { id: 'p', settings: st, tracks: [{ id: 't0', items: [{ id: 'c1', type: 'video', src: sdr, normalizedSrc: cache, start: 0, end: 2, inPoint: 0, outPoint: 2 }] }] }
  const { videoItems } = collectAllItems(pj)
  stampSourceProbes(videoItems, new Map())
  const r = resolvePictureColorSpace(pj, st, videoItems)
  assert.equal(r.colorSpace, 'sdr_bt709')
  assert.equal(r.hdrVisible, false)
})

// ---- §616: a composited clip is never a cover ----

test('a masked, blended or opacity-keyed full-frame clip leaves the footage below visible', () => {
  const top = video('top', 0, 10)
  const fade = { prop: 'opacity', points: [{ t: 0, value: 0.5 }, { t: 1, value: 1 }] }
  const all = () => true
  // the control: a plain full-frame clip above covers the one below
  assert.deepEqual(ids(visibleVideoItems([[video('under', 0, 10)], [top]], { coversPicture: all })), ['top'])
  const composited = [
    { mask: { shape: 'ellipse', w: 0.5, h: 0.5 } },
    { blendMode: 'screen' },
    { keyframes: [fade] },
  ]
  for (const c of composited) {
    assert.deepEqual(ids(visibleVideoItems([[video('under', 0, 10)], [{ ...top, ...c }]], { coversPicture: all })), ['under', 'top'], JSON.stringify(c))
    const img = { id: 'img', type: 'image', src: '/x/i.png', start: 0, end: 10, ...c }
    assert.deepEqual(ids(visibleVideoItems([[video('under', 0, 10)], [img]], { coversPicture: all })), ['under'], JSON.stringify(c))
  }
})

test('fillsFrameOpaquely: a plain full-frame card is a cover, a masked, blended or fading one is not', () => {
  const png = join(WORK, 'card-616.png')
  ff(['-f', 'lavfi', '-i', 'color=black:size=108x192', '-frames:v', '1', '-pix_fmt', 'rgb24', png])
  const item = { id: 'c', type: 'image', src: png, start: 0, end: 2 }
  const res = [1080, 1920]
  assert.equal(fillsFrameOpaquely(item, res), true)
  assert.equal(fillsFrameOpaquely({ ...item, mask: { shape: 'rect' } }, res), false)
  assert.equal(fillsFrameOpaquely({ ...item, blendMode: 'multiply' }, res), false)
  assert.equal(fillsFrameOpaquely({ ...item, keyframes: [{ prop: 'opacity', points: [{ t: 0, value: 0 }, { t: 1, value: 1 }] }] }, res), false)
})
