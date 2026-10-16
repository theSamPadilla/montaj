// render/test/nle-xmeml.test.mjs
/**
 * `writeXmeml` (render/nle/xmeml.js) and `probeSources` (render/nle/probe.js):
 * the editor timeline as Final Cut Pro 7 XML for Premiere Pro and DaVinci
 * Resolve.
 *
 *   - GOLDENS: every Task 1 fixture (test/fixtures/nle/*.json) through
 *     `buildNleTimeline` and `writeXmeml` with a stubbed probe table, compared
 *     byte for byte with test/fixtures/nle/xmeml/<name>.xml and checked
 *     well-formed with xmllint when it is installed. Regenerate deliberately
 *     with UPDATE_NLE_GOLDENS=1, and read the diff.
 *   - targeted tests, each pinning one rule of the format (mixed rates, speed,
 *     transitions, links, fades, images, graphics, markers, escaping).
 *   - one real-media probe: a 2 s 29.97 clip made with ffmpeg.
 *
 * No real media is needed except by the last test: the fixtures' paths are
 * invented and the probe table is written here.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { buildNleTimeline } from '../nle/timeline.js'
import { cleanFileName } from '../nle/file-name.js'
import { writeXmeml, markerLabel, pathUrl, timecodeFrames, PPRO_TICKS_PER_SECOND } from '../nle/xmeml.js'
import { probeSources, parseProbe, isNtsc, chooseFrameRate } from '../nle/probe.js'
import { FFMPEG, FFPROBE } from '../ffmpeg-bin.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'fixtures', 'nle')
const GOLDENS = join(FIXTURES, 'xmeml')
const PROJECT_DIR = resolve('/proj')
const XMLLINT = '/usr/bin/xmllint'
const TICKS = PPRO_TICKS_PER_SECOND

const load = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))
const build = (project) => buildNleTimeline(project, { projectDir: PROJECT_DIR })

// ── stub probes ────────────────────────────────────────────────────────────

const VIDEO = Object.freeze({
  exists: true, hasVideo: true, hasAudio: true, width: 1920, height: 1080, rotation: 0,
  rFrameRate: '30/1', fpsExact: 30, ntsc: false, timebase: 30, durationSeconds: 60, durationFrames: 1800,
  audioChannels: 2, audioSampleRate: 48000, timecode: null, colorTransfer: 'bt709', isStill: false, warnings: [],
})
const IMAGE = Object.freeze({
  ...VIDEO, hasAudio: false, width: 1000, height: 800, rFrameRate: null, fpsExact: null, timebase: null,
  durationSeconds: null, durationFrames: null, audioChannels: null, audioSampleRate: null, isStill: true,
})
const AUDIO = Object.freeze({
  ...VIDEO, hasVideo: false, width: null, height: null, rFrameRate: null, fpsExact: null, timebase: null,
  durationSeconds: 120, durationFrames: null, colorTransfer: null,
})
const NTSC_2997 = Object.freeze({
  ...VIDEO, rFrameRate: '30000/1001', fpsExact: 30000 / 1001, ntsc: true, timebase: 30,
  durationSeconds: 900.9, durationFrames: 27000,
})

/** A probe for every source the timeline names, by kind; `over` replaces some. */
function stubProbes(tl, over = {}) {
  const probes = {}
  for (const [path, s] of Object.entries(tl.sources)) {
    probes[path] = s.kind === 'image' ? IMAGE : s.kind === 'audio' ? AUDIO : VIDEO
  }
  return { ...probes, ...over }
}

/** Every graphic (and the captions) rendered at /proj/graphics/<id>.mov. */
function graphicsMap(tl) {
  const graphics = {}
  for (const t of tl.videoTracks) for (const c of t.clips) if (c.kind === 'graphic') graphics[c.id] = `/proj/graphics/${c.id}.mov`
  return { graphics, captions: tl.captionsTrack ? '/proj/graphics/captions.mov' : null }
}

function write(name, project = load(name), over = {}, opts = {}) {
  const tl = build(project)
  const { graphics, captions } = graphicsMap(tl)
  return { tl, ...writeXmeml(tl, stubProbes(tl, over), { name, graphics, captions, xmlDir: '/proj', ...opts }) }
}

// ── a small XML reader for the assertions ──────────────────────────────────

function decode(s) {
  return s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e])
}

function parseXml(xml) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '').replace(/^<!DOCTYPE[^>]*>\s*/, '')
  const root = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  const re = /<\/([\w:.-]+)>|<([\w:.-]+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g
  let m
  while ((m = re.exec(body))) {
    if (m[1]) {
      const node = stack.pop()
      assert.equal(node.tag, m[1], `mismatched </${m[1]}>`)
    } else if (m[2]) {
      const attrs = {}
      for (const a of m[3].matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2])
      const node = { tag: m[2], attrs, children: [], text: '' }
      stack.at(-1).children.push(node)
      if (!m[4]) stack.push(node)
    } else if (m[5].trim()) {
      stack.at(-1).text += decode(m[5])
    }
  }
  assert.equal(stack.length, 1, 'unclosed elements')
  return root.children[0]
}

const kids = (n, tag) => n.children.filter((c) => c.tag === tag)
const kid = (n, tag) => {
  const c = n.children.find((x) => x.tag === tag)
  assert.ok(c, `<${n.tag}> has no <${tag}>`)
  return c
}
const txt = (n, tag) => kid(n, tag).text
const int = (n, tag) => Number(txt(n, tag))
const all = (n, tag, out = []) => {
  for (const c of n.children) {
    if (c.tag === tag) out.push(c)
    all(c, tag, out)
  }
  return out
}
const seqOf = (xml) => kid(parseXml(xml), 'sequence')
const videoTracks = (xml) => kids(kid(kid(seqOf(xml), 'media'), 'video'), 'track')
const audioTracks = (xml) => kids(kid(kid(seqOf(xml), 'media'), 'audio'), 'track')
const clipitems = (track) => kids(track, 'clipitem')
const effectOf = (clip, id) => all(clip, 'effect').find((e) => txt(e, 'effectid') === id) ?? null
const paramOf = (effect, id) => kids(effect, 'parameter').find((p) => txt(p, 'parameterid') === id)
const rateOf = (n) => ({ timebase: int(kid(n, 'rate'), 'timebase'), ntsc: txt(kid(n, 'rate'), 'ntsc') })
/** The full <file> definition for an id (the first clip that uses it holds it). */
const fileDef = (xml, id) => all(seqOf(xml), 'file').find((f) => f.attrs.id === id && f.children.length > 0)

function wellFormed(xml, label) {
  if (!existsSync(XMLLINT)) return
  const r = spawnSync(XMLLINT, ['--noout', '-'], { input: xml })
  assert.equal(r.status, 0, `${label}: xmllint: ${r.stderr}`)
}

// ── goldens ────────────────────────────────────────────────────────────────

const GOLDEN_FIXTURES = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()

describe('goldens', () => {
  test('every Task 1 fixture has a golden', () => {
    assert.equal(GOLDEN_FIXTURES.length, 16)
  })
  for (const name of GOLDEN_FIXTURES) {
    test(name, () => {
      const { xml } = write(name)
      wellFormed(xml, name)
      const path = join(GOLDENS, `${name}.xml`)
      if (process.env.UPDATE_NLE_GOLDENS === '1') {
        mkdirSync(GOLDENS, { recursive: true })
        writeFileSync(path, xml)
      }
      assert.equal(xml, readFileSync(path, 'utf8'), `${name}: differs from its golden (UPDATE_NLE_GOLDENS=1 regenerates)`)
    })
  }

  test('the writer is deterministic and leaves the timeline alone', () => {
    const tl = build(load('layers'))
    const before = structuredClone(tl)
    const probes = stubProbes(tl)
    const opts = { name: 'x', ...graphicsMap(tl), xmlDir: '/proj' }
    assert.equal(writeXmeml(tl, probes, opts).xml, writeXmeml(tl, probes, opts).xml)
    assert.deepEqual(tl, before)
  })
})

// ── sequence ───────────────────────────────────────────────────────────────

describe('media beside the timeline', () => {
  test('mediaPaths: the file element links the copy, the probe still comes from the original', () => {
    const tl = build(load('hard-cut'))
    const probes = stubProbes(tl)
    const copies = Object.fromEntries(Object.keys(tl.sources).map((p) => [p, `/pkg/media/${cleanFileName(p.split('/').pop())}`]))
    const { xml } = writeXmeml(tl, probes, { name: 'N', xmlDir: '/pkg', mediaPaths: copies })
    for (const [orig, copy] of Object.entries(copies)) {
      assert.ok(xml.includes(pathUrl(copy)), `links ${copy}`)
      assert.ok(!xml.includes(pathUrl(orig)), `does not link ${orig}`)
    }
  })

  test('without mediaPaths the original is linked, as before', () => {
    const tl = build(load('hard-cut'))
    const { xml } = writeXmeml(tl, stubProbes(tl), { name: 'N', xmlDir: '/pkg' })
    for (const orig of Object.keys(tl.sources)) assert.ok(xml.includes(pathUrl(orig)), orig)
  })
})

describe('sequence', () => {
  test('one sequence: name, duration, the integer rate, 00:00:00:00, the frame format', () => {
    const { xml } = write('cut-list', load('cut-list'), {}, { name: 'My edit' })
    const root = parseXml(xml)
    assert.equal(root.tag, 'xmeml')
    assert.equal(root.attrs.version, '5')
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE xmeml>\n/)
    const seqs = kids(root, 'sequence')
    assert.equal(seqs.length, 1)
    const seq = seqs[0]
    assert.equal(txt(seq, 'name'), 'My edit')
    assert.equal(int(seq, 'duration'), 195)
    assert.deepEqual(rateOf(seq), { timebase: 30, ntsc: 'FALSE' })
    const tc = kid(seq, 'timecode')
    assert.equal(txt(tc, 'string'), '00:00:00:00')
    assert.equal(int(tc, 'frame'), 0)
    const sc = kid(kid(kid(kid(seq, 'media'), 'video'), 'format'), 'samplecharacteristics')
    assert.equal(int(sc, 'width'), 1080)
    assert.equal(int(sc, 'height'), 1920)
    assert.deepEqual(rateOf(sc), { timebase: 30, ntsc: 'FALSE' })
  })

  test('video tracks bottom to top in the timeline order, captions on top', () => {
    const { xml, tl } = write('layers')
    const tracks = videoTracks(xml)
    assert.equal(tracks.length, tl.videoTracks.length)
    tl.videoTracks.forEach((t, i) => {
      assert.deepEqual(clipitems(tracks[i]).map((c) => txt(c, 'name')), t.clips.map((c) => (c.kind === 'graphic' ? `${c.id}.mov` : c.src.split('/').pop())))
    })
    const cap = write('captions')
    const capTracks = videoTracks(cap.xml)
    assert.equal(txt(clipitems(capTracks.at(-1))[0], 'name'), 'captions.mov')
  })
})

// ── time ───────────────────────────────────────────────────────────────────

describe('time', () => {
  test('a 30 fps source in a 30 sequence: in/out are its frames, out - in = end - start', () => {
    const { xml } = write('cut-list')
    const [a, b] = clipitems(videoTracks(xml)[0])
    assert.deepEqual(rateOf(a), { timebase: 30, ntsc: 'FALSE' })
    assert.deepEqual([int(a, 'start'), int(a, 'end'), int(a, 'in'), int(a, 'out')], [0, 60, 30, 90])
    assert.deepEqual([int(b, 'start'), int(b, 'end'), int(b, 'in'), int(b, 'out')], [60, 150, 300, 390])
    assert.equal(int(a, 'pproTicksIn'), TICKS)
    assert.equal(int(a, 'pproTicksOut'), 3 * TICKS)
  })

  test('a 29.97 source in a 30 sequence: in/out at the SEQUENCE rate, the file keeps its own', () => {
    // cut-list's `a` plays footage/a.mp4 from 1 s; 10 minutes in is the trap.
    const project = load('cut-list')
    project.tracks[0].items[1].inPoint = 600
    project.tracks[0].items[1].outPoint = 603
    const a = resolve(PROJECT_DIR, 'footage/a.mp4')
    const b = resolve(PROJECT_DIR, 'footage/b.mp4')
    const { xml } = write('cut-list', project, { [a]: NTSC_2997, [b]: NTSC_2997 })
    const [ca, cb] = clipitems(videoTracks(xml)[0])
    // The clipitem counts in the sequence's 30 (not 29.97) frames...
    assert.deepEqual(rateOf(ca), { timebase: 30, ntsc: 'FALSE' })
    assert.equal(int(ca, 'in'), 30)
    assert.equal(int(ca, 'out'), 90)
    // ...so 600 s in is frame 18000, where the source's own count (17982) would be 0.6 s early.
    assert.equal(int(cb, 'in'), 18000)
    assert.equal(int(cb, 'out'), 18090)
    assert.equal(int(cb, 'pproTicksIn'), 600 * TICKS)
    // The media's length in the clipitem's frames: 900.9 s * 30.
    assert.equal(int(ca, 'duration'), 27027)
    // The file is described at its own rate and length.
    const file = fileDef(xml, kid(ca, 'file').attrs.id)
    assert.deepEqual(rateOf(file), { timebase: 30, ntsc: 'TRUE' })
    assert.equal(int(file, 'duration'), 27000)
    const vsc = kid(kid(kid(file, 'media'), 'video'), 'samplecharacteristics')
    assert.deepEqual(rateOf(vsc), { timebase: 30, ntsc: 'TRUE' })
  })

  test('a file defined once, then referenced by id', () => {
    const project = load('cut-list')
    project.tracks[0].items[1].src = 'footage/a.mp4'
    const { xml } = write('cut-list', project)
    const [a, b] = clipitems(videoTracks(xml)[0])
    assert.equal(kid(a, 'file').attrs.id, 'file-1')
    assert.ok(kid(a, 'file').children.length > 0)
    assert.equal(kid(b, 'file').attrs.id, 'file-1')
    assert.equal(kid(b, 'file').children.length, 0)
    assert.equal(all(seqOf(xml), 'file').filter((f) => f.children.length > 0).length, 2, 'a.mp4 and c.mp4')
  })

  test('a timecode is carried on the file, in/out stay counted from the first frame', () => {
    const a = resolve(PROJECT_DIR, 'footage/a.mp4')
    const { xml } = write('cut-list', load('cut-list'), { [a]: { ...NTSC_2997, timecode: '01:00:00;00' } })
    const ca = clipitems(videoTracks(xml)[0])[0]
    const tc = kid(fileDef(xml, kid(ca, 'file').attrs.id), 'timecode')
    assert.equal(txt(tc, 'string'), '01:00:00;00')
    assert.equal(int(tc, 'frame'), 107892)
    assert.equal(txt(tc, 'displayformat'), 'DF')
    assert.equal(int(ca, 'in'), 30)
    assert.equal(timecodeFrames('00:10:00:00', 30, true), 17982)
    assert.equal(timecodeFrames('10:00:00:00', 25, false), 900000)
  })
})

// ── speed ──────────────────────────────────────────────────────────────────

describe('speed', () => {
  test('2x and 0.5x: Time Remap at speed * 100, in/out in the retimed frames', () => {
    const { xml } = write('speed')
    const [fast, slow] = clipitems(videoTracks(xml)[0])

    // fast: 2 s on the timeline from 4 s at 2x, so source 4..8 s.
    assert.deepEqual([int(fast, 'start'), int(fast, 'end'), int(fast, 'in'), int(fast, 'out')], [0, 60, 60, 120])
    assert.equal(int(fast, 'duration'), 900, '60 s of media at 2x')
    assert.equal(int(fast, 'pproTicksIn'), 4 * TICKS)
    assert.equal(int(fast, 'pproTicksOut'), 8 * TICKS)
    const remap = effectOf(fast, 'timeremap')
    assert.ok(remap)
    assert.equal(txt(paramOf(remap, 'speed'), 'value'), '200')
    assert.equal(txt(paramOf(remap, 'variablespeed'), 'value'), '0')
    assert.equal(txt(paramOf(remap, 'reverse'), 'value'), 'FALSE')
    const kfs = kids(paramOf(remap, 'graphdict'), 'keyframe').map((k) => [int(k, 'when'), int(k, 'value'), k.children.at(-1).tag])
    assert.deepEqual(kfs, [[0, 0, 'speedkfstart'], [60, 120, 'speedkfin'], [120, 240, 'speedkfout'], [900, 1800, 'speedkfend']])

    // slow: 4 s on the timeline from 0 at 0.5x, so source 0..2 s.
    assert.deepEqual([int(slow, 'start'), int(slow, 'end'), int(slow, 'in'), int(slow, 'out')], [60, 180, 0, 120])
    assert.equal(int(slow, 'duration'), 3600)
    const slowRemap = effectOf(slow, 'timeremap')
    assert.equal(txt(paramOf(slowRemap, 'speed'), 'value'), '50')
    const slowKfs = kids(paramOf(slowRemap, 'graphdict'), 'keyframe').map((k) => [int(k, 'when'), int(k, 'value')])
    assert.deepEqual(slowKfs, [[0, 0], [120, 60], [3600, 1800]])
  })

  test('a clip at 1x has no Time Remap', () => {
    const { xml } = write('cut-list')
    for (const c of clipitems(videoTracks(xml)[0])) assert.equal(effectOf(c, 'timeremap'), null)
  })

  test('the linked sound of a sped clip is retimed the same way', () => {
    const { xml } = write('speed')
    const fastAudio = clipitems(audioTracks(xml)[0])[0]
    assert.deepEqual([int(fastAudio, 'in'), int(fastAudio, 'out')], [60, 120])
    const remap = effectOf(fastAudio, 'timeremap')
    assert.equal(txt(remap, 'mediatype'), 'audio')
    assert.equal(txt(paramOf(remap, 'speed'), 'value'), '200')
  })
})

// ── transitions ────────────────────────────────────────────────────────────

describe('transitions', () => {
  test('a crossfade: Cross Dissolve centred on the cut, -1 at the cut, handles in in/out', () => {
    // a 0..5 s, b 4..9 s: overlap frames 120..150, cut at 135.
    const { xml } = write('crossfade')
    const track = videoTracks(xml)[0]
    assert.deepEqual(track.children.slice(0, 3).map((c) => c.tag), ['clipitem', 'transitionitem', 'clipitem'])
    const [a, t, b] = track.children
    assert.deepEqual([int(a, 'start'), int(a, 'end'), int(a, 'in'), int(a, 'out')], [0, -1, 0, 150])
    assert.deepEqual([int(t, 'start'), int(t, 'end')], [120, 150])
    assert.equal(txt(t, 'alignment'), 'center')
    assert.equal(int(t, 'cutPointTicks'), 15 * TICKS / 30)
    assert.deepEqual(rateOf(t), { timebase: 30, ntsc: 'FALSE' })
    const fx = kid(t, 'effect')
    assert.equal(txt(fx, 'name'), 'Cross Dissolve')
    assert.equal(txt(fx, 'effectid'), 'Cross Dissolve')
    assert.equal(txt(fx, 'mediatype'), 'video')
    // b plays from 10.5 s at the cut, so from 10 s at the transition's start.
    assert.deepEqual([int(b, 'start'), int(b, 'end'), int(b, 'in'), int(b, 'out')], [-1, 270, 300, 450])
    assert.equal(int(b, 'pproTicksIn'), 10 * TICKS)
  })

  test('the linked sound crossfades on its own track', () => {
    const { xml } = write('crossfade')
    for (const track of audioTracks(xml)) {
      const [a, t, b] = track.children
      assert.equal(t.tag, 'transitionitem')
      assert.equal(txt(kid(t, 'effect'), 'name'), 'Cross Fade (0dB)')
      assert.equal(txt(kid(t, 'effect'), 'mediatype'), 'audio')
      assert.deepEqual([int(t, 'start'), int(t, 'end')], [120, 150])
      assert.deepEqual([int(a, 'end'), int(a, 'out'), int(b, 'start'), int(b, 'in')], [-1, 150, -1, 300])
    }
  })

  test('both ends of a clip in transitions: -1 at both, handles on both sides', () => {
    const { xml } = write('crossfade-both-ends')
    const items = videoTracks(xml)[0].children.filter((c) => c.tag !== 'enabled' && c.tag !== 'locked')
    assert.deepEqual(items.map((c) => c.tag), ['clipitem', 'transitionitem', 'clipitem', 'transitionitem', 'clipitem'])
    const b = items[2]
    assert.equal(int(b, 'start'), -1)
    assert.equal(int(b, 'end'), -1)
    // b spans the first transition's start (120) to the second's end (300): 180 frames.
    assert.equal(int(b, 'out') - int(b, 'in'), 180)
    assert.equal(int(b, 'in'), 600)
  })
})

// ── sound ──────────────────────────────────────────────────────────────────

describe('sound', () => {
  test('linked both ways: the video and both channels carry the same link list', () => {
    const { xml } = write('cut-list')
    const v = clipitems(videoTracks(xml)[0])[0]
    const [left, right] = audioTracks(xml).map((t) => clipitems(t)[0])
    const list = (c) => kids(c, 'link').map((l) => [txt(l, 'linkclipref'), txt(l, 'mediatype'), int(l, 'trackindex'), int(l, 'clipindex'), l.children.some((x) => x.tag === 'groupindex') ? int(l, 'groupindex') : null])
    const expected = [[v.attrs.id, 'video', 1, 1, null], [left.attrs.id, 'audio', 1, 1, 1], [right.attrs.id, 'audio', 2, 1, 1]]
    assert.deepEqual(list(v), expected)
    assert.deepEqual(list(left), expected)
    assert.deepEqual(list(right), expected)
  })

  test('stereo is a channel pair, mono one track', () => {
    const stereo = write('cut-list')
    const tracks = audioTracks(stereo.xml)
    assert.equal(tracks.length, 2)
    assert.deepEqual(tracks.map((t) => [t.attrs.premiereTrackType, txt(t, 'outputchannelindex')]), [['Stereo', '1'], ['Stereo', '2']])
    assert.deepEqual(tracks.map((t) => int(kid(clipitems(t)[0], 'sourcetrack'), 'trackindex')), [1, 2])
    const file = fileDef(stereo.xml, 'file-1')
    assert.equal(int(kid(kid(file, 'media'), 'audio'), 'channelcount'), 2)

    const tl = build(load('cut-list'))
    const mono = Object.fromEntries(Object.keys(tl.sources).map((p) => [p, { ...VIDEO, audioChannels: 1 }]))
    const m = write('cut-list', load('cut-list'), mono)
    const mt = audioTracks(m.xml)
    assert.equal(mt.length, 1)
    assert.equal(mt[0].attrs.premiereTrackType, 'Mono')
    assert.equal(mt[0].children.some((c) => c.tag === 'outputchannelindex'), false)
    assert.equal(int(kid(kid(fileDef(m.xml, 'file-1'), 'media'), 'audio'), 'channelcount'), 1)
  })

  test('a source without audio: no linked clip, no links, no audio on the file', () => {
    const a = resolve(PROJECT_DIR, 'footage/a.mp4')
    const { xml } = write('cut-list', load('cut-list'), { [a]: { ...VIDEO, hasAudio: false, audioChannels: null } })
    const v = clipitems(videoTracks(xml)[0])[0]
    assert.equal(kids(v, 'link').length, 0)
    for (const t of audioTracks(xml)) {
      assert.deepEqual(clipitems(t).map((c) => kid(c, 'file').attrs.id).includes('file-1'), false)
      assert.equal(clipitems(t).length, 2, 'b and c keep their sound')
    }
    assert.equal(kid(fileDef(xml, 'file-1'), 'media').children.some((c) => c.tag === 'audio'), false)
  })

  test('a crossfade into a silent source: the outgoing sound plays on with a linear fade', () => {
    const b = resolve('/abs/b.mp4')
    const { xml } = write('crossfade', load('crossfade'), { [b]: { ...VIDEO, hasAudio: false } })
    const track = audioTracks(xml)[0]
    assert.equal(kids(track, 'transitionitem').length, 0)
    const [a] = clipitems(track)
    assert.deepEqual([int(a, 'start'), int(a, 'end'), int(a, 'in'), int(a, 'out')], [0, 150, 0, 150])
    const kfs = kids(paramOf(effectOf(a, 'audiolevels'), 'level'), 'keyframe').map((k) => [int(k, 'when'), Number(txt(k, 'value'))])
    assert.deepEqual(kfs, [[120, 1], [150, 0]])
    assert.equal(kids(a, 'marker').length, 0, 'a linear fade needs no marker')
  })

  test('volume is the Level gain; fades are Level keyframes; a curved fade gets a marker', () => {
    const { xml } = write('audio')
    const tracks = audioTracks(xml)
    const byName = (n) => tracks.flatMap(clipitems).find((c) => txt(c, 'name') === n)
    const music = byName('music.mp3')
    // 0..10 s, volume 0.3, fadeIn 1 s (default curve), fadeOut 2 s linear.
    assert.deepEqual([int(music, 'start'), int(music, 'end'), int(music, 'in'), int(music, 'out')], [0, 300, 0, 300])
    const level = paramOf(effectOf(music, 'audiolevels'), 'level')
    assert.equal(txt(level, 'value'), '0.3')
    const kfs = kids(level, 'keyframe').map((k) => [int(k, 'when'), Number(txt(k, 'value'))])
    assert.deepEqual(kfs, [[0, 0], [30, 0.3], [240, 0.3], [300, 0]])
    const markers = kids(music, 'marker').map((m) => [txt(m, 'name'), txt(m, 'comment')])
    assert.deepEqual(markers, [['Stays in Montaj: ducking', 'ducking'], ['Stays in Montaj: fade in shape', 'fadeInCurve:exp']])

    // Plays to the end of its 120 s file from 0, starting at 2 s.
    const sfx = byName('boom.wav')
    assert.deepEqual([int(sfx, 'start'), int(sfx, 'end'), int(sfx, 'in'), int(sfx, 'out')], [60, 3660, 0, 3600])

    // vo: 3..6 s of its file at 1.5 s.
    const vo = byName('vo.wav')
    assert.deepEqual([int(vo, 'start'), int(vo, 'end'), int(vo, 'in'), int(vo, 'out')], [45, 135, 90, 180])

    // muted = the clip disabled.
    assert.equal(txt(byName('quiet.wav'), 'enabled'), 'FALSE')
    assert.equal(txt(music, 'enabled'), 'TRUE')
  })

  test('the clip volume (track volume folded in) is the Level; a muted clip has no sound', () => {
    const { xml } = write('layers')
    const pip = audioTracks(xml).flatMap(clipitems).find((c) => txt(c, 'name') === 'pip.mp4')
    assert.equal(txt(paramOf(effectOf(pip, 'audiolevels'), 'level'), 'value'), '0.25')
  })

  test('a muted clip keeps its sound clip, disabled; the crossfade partner fades alone over the whole overlap', () => {
    const muted = write('muted')
    const items = audioTracks(muted.xml).flatMap(clipitems)
    const enabled = Object.fromEntries([...new Set(items.map((c) => txt(c, 'name')))]
      .map((n) => [n, items.filter((c) => txt(c, 'name') === n).map((c) => txt(c, 'enabled'))]))
    assert.deepEqual(enabled, {
      'a.mp4': ['FALSE', 'FALSE'], 'b.mp4': ['TRUE', 'TRUE'], 'c.mp4': ['FALSE', 'FALSE'], 'pip.mp4': ['FALSE', 'FALSE'],
    })
    // No audio transition: b carries a linear fade out to the end of the overlap instead.
    assert.equal(audioTracks(muted.xml).flatMap((t) => kids(t, 'transitionitem')).length, 0)
    const b = items.find((c) => txt(c, 'name') === 'b.mp4')
    const kfs = kids(paramOf(effectOf(b, 'audiolevels'), 'level'), 'keyframe').map((k) => [int(k, 'when'), Number(txt(k, 'value'))])
    assert.equal(kfs.at(-1)[1], 0)
    assert.equal(int(b, 'end'), 180)
  })

  test('fades that meet put one peak between them, keyframes strictly in order', () => {
    const tl = build({
      id: 'p', status: 'final', settings: { resolution: [1080, 1920], fps: 30 },
      tracks: [], audio: { tracks: [{ id: 'm', src: '/abs/m.wav', start: 0, end: 1 }] },
    })
    const m = tl.audioTracks[0].clips[0]
    m.fadeInFrames = 24
    m.fadeOutFrames = 24
    const { xml } = writeXmeml(tl, stubProbes(tl), { name: 'f' })
    const clip = clipitems(audioTracks(xml)[0])[0]
    const kfs = kids(paramOf(effectOf(clip, 'audiolevels'), 'level'), 'keyframe').map((k) => [int(k, 'when'), Number(txt(k, 'value'))])
    const whens = kfs.map((k) => k[0])
    assert.deepEqual(whens, [...whens].sort((x, y) => x - y))
    assert.equal(new Set(whens).size, whens.length, 'no two keyframes at one time')
    assert.equal(kfs.length, 3)
    assert.deepEqual([kfs[0][1], kfs[2][1]], [0, 0])
    assert.ok(kfs[1][1] > 0 && kfs[1][0] === whens[0] + 15)
  })
})

// ── picture ────────────────────────────────────────────────────────────────

/** Where the visible region's centre lands, from the written Basic Motion and Crop. */
function landing(clip, nw, nh) {
  const bm = effectOf(clip, 'basic')
  const s = Number(txt(paramOf(bm, 'scale'), 'value')) / 100
  const rot = (Number(txt(paramOf(bm, 'rotation'), 'value')) * Math.PI) / 180
  const center = kid(paramOf(bm, 'center'), 'value')
  const px = Number(txt(center, 'horiz')) * nw
  const py = Number(txt(center, 'vert')) * nh
  const crop = effectOf(clip, 'crop')
  const pct = (id) => (crop ? Number(txt(paramOf(crop, id), 'value')) / 100 : 0)
  const l = pct('left'); const r = pct('right'); const t = pct('top'); const b = pct('bottom')
  const cx = ((l + (1 - r)) / 2 - 0.5) * nw
  const cy = ((t + (1 - b)) / 2 - 0.5) * nh
  return {
    x: px + s * (cx * Math.cos(rot) - cy * Math.sin(rot)),
    y: py + s * (cx * Math.sin(rot) + cy * Math.cos(rot)),
    w: (1 - l - r) * nw * s,
    h: (1 - t - b) * nh * s,
    s,
  }
}

describe('picture', () => {
  test('a full-frame clip of the frame size has no motion filters at all', () => {
    const tl = build(load('cut-list'))
    const probes = Object.fromEntries(Object.keys(tl.sources).map((p) => [p, { ...VIDEO, width: 1080, height: 1920 }]))
    const { xml } = write('cut-list', load('cut-list'), probes)
    for (const c of clipitems(videoTracks(xml)[0])) assert.equal(kids(c, 'filter').length, 0)
  })

  test('landscape footage in a portrait frame: contained, scale 56.25%, centred', () => {
    const { xml } = write('cut-list')
    const bm = effectOf(clipitems(videoTracks(xml)[0])[0], 'basic')
    assert.equal(txt(paramOf(bm, 'scale'), 'value'), '56.25')
    const center = kid(paramOf(bm, 'center'), 'value')
    assert.deepEqual([txt(center, 'horiz'), txt(center, 'vert')], ['0', '0'])
  })

  test('a scaled, moved, rotated, cropped, faded video: the cropped region lands on its box', () => {
    // pip: 1920x1080, crop x .1 w .8, scale .4 in 1080x1920, offset (20, -10) %, 15 deg, opacity .8.
    const { xml } = write('layers')
    const pip = videoTracks(xml).flatMap(clipitems).find((c) => txt(c, 'name') === 'pip.mp4')
    const bm = effectOf(pip, 'basic')
    assert.equal(txt(paramOf(bm, 'scale'), 'value'), '28.125', 'contain: min(432/1536, 768/1080)')
    assert.equal(txt(paramOf(bm, 'rotation'), 'value'), '15')
    const crop = effectOf(pip, 'crop')
    assert.deepEqual(['left', 'right', 'top', 'bottom'].map((p) => txt(paramOf(crop, p), 'value')), ['10', '10', '0', '0'])
    assert.equal(txt(paramOf(effectOf(pip, 'opacity'), 'opacity'), 'value'), '80')
    const at = landing(pip, 1920, 1080)
    assert.ok(Math.abs(at.x - 216) < 1e-3 && Math.abs(at.y - -192) < 1e-3, JSON.stringify(at))
  })

  test('an off-centre crop with rotation still lands on the box centre', () => {
    const project = load('layers')
    const pip = project.tracks[2].items[0]
    pip.sourceCrop = { x: 0.5, y: 0.1, w: 0.4, h: 0.6 }
    pip.rotation = 37
    const { xml } = write('layers', project)
    const clip = videoTracks(xml).flatMap(clipitems).find((c) => txt(c, 'name') === 'pip.mp4')
    const at = landing(clip, 1920, 1080)
    assert.ok(Math.abs(at.x - 216) < 1e-2 && Math.abs(at.y - -192) < 1e-2, JSON.stringify(at))
    // contained: the region fits the 432x768 box on one axis, inside it on the other.
    assert.ok(Math.abs(at.w - 432) < 1e-2 && at.h <= 768 + 1e-6, JSON.stringify(at))
  })

  test('scaleX != scaleY on a video is a contain into that box: uniform, no marker', () => {
    const project = load('layers')
    const pip = project.tracks[2].items[0]
    pip.scaleX = 0.5
    pip.scaleY = 0.2
    const { xml } = write('layers', project)
    const clip = videoTracks(xml).flatMap(clipitems).find((c) => txt(c, 'name') === 'pip.mp4')
    // box 540x384, region 1536x1080: min(0.3516, 0.3556).
    assert.equal(txt(paramOf(effectOf(clip, 'basic'), 'scale'), 'value'), '35.15625')
    assert.equal(kids(clip, 'marker').length, 0)
  })

  test('an image: a still with a long media, covered, contained or filled into its box', () => {
    // logo: 1000x800 image, contain, scale .2 of 1080x1920 (box 216x384), crop the middle half.
    const { xml } = write('layers')
    const logo = videoTracks(xml).flatMap(clipitems).find((c) => txt(c, 'name') === 'logo.png')
    assert.deepEqual([int(logo, 'start'), int(logo, 'end'), int(logo, 'in'), int(logo, 'out')], [0, 180, 0, 180])
    assert.equal(int(logo, 'duration'), 108000)
    const file = fileDef(xml, kid(logo, 'file').attrs.id)
    assert.equal(int(file, 'duration'), 108000)
    assert.equal(kid(file, 'media').children.some((c) => c.tag === 'audio'), false)
    assert.equal(txt(paramOf(effectOf(logo, 'basic'), 'scale'), 'value'), '43.2', 'contain: min(216/500, 384/400)')

    const cover = load('layers')
    delete cover.tracks[3].items[0].fit
    const cx = write('layers', cover).xml
    const coverLogo = videoTracks(cx).flatMap(clipitems).find((c) => txt(c, 'name') === 'logo.png')
    assert.equal(txt(paramOf(effectOf(coverLogo, 'basic'), 'scale'), 'value'), '96', 'cover: max(216/500, 384/400)')
    const at = landing(coverLogo, 1000, 800)
    assert.ok(Math.abs(at.w - 216) < 1e-6 && Math.abs(at.h - 384) < 1e-6, `cover crops to the box: ${JSON.stringify(at)}`)
    assert.equal(kids(coverLogo, 'marker').length, 0)

    const fill = load('layers')
    fill.tracks[3].items[0].fit = 'fill'
    const fx = write('layers', fill).xml
    const fillLogo = videoTracks(fx).flatMap(clipitems).find((c) => txt(c, 'name') === 'logo.png')
    assert.equal(txt(paramOf(effectOf(fillLogo, 'basic'), 'scale'), 'value'), '96')
    assert.deepEqual(kids(fillLogo, 'marker').map((m) => [txt(m, 'name'), txt(m, 'comment')]), [['Stays in Montaj: non-uniform scale', 'nonUniformScale']])
  })

  test('a graphic: its rendered movie, full frame, untransformed, no keyframe or blur marker', () => {
    const { xml } = write('keyframes')
    const o = videoTracks(xml).flatMap(clipitems).find((c) => txt(c, 'name') === 'o.mov')
    assert.equal(kids(o, 'filter').length, 0)
    assert.equal(kids(o, 'marker').length, 0)
    assert.equal(txt(o, 'alphatype'), 'straight')
    assert.deepEqual([int(o, 'start'), int(o, 'end'), int(o, 'in'), int(o, 'out')], [0, 90, 0, 90])
    const file = fileDef(xml, kid(o, 'file').attrs.id)
    assert.equal(txt(file, 'pathurl'), 'file://localhost/proj/graphics/o.mov')
    const sc = kid(kid(kid(file, 'media'), 'video'), 'samplecharacteristics')
    assert.deepEqual([int(sc, 'width'), int(sc, 'height')], [1080, 1920])

    // A placed, rotated, faded overlay is still written untransformed: the movie carries it.
    const layers = write('layers')
    const title = videoTracks(layers.xml).flatMap(clipitems).find((c) => txt(c, 'name') === 'title.mov')
    assert.equal(kids(title, 'filter').length, 0)
  })

  test('the captions: one full-frame clip on the top track', () => {
    const { xml } = write('captions')
    const top = videoTracks(xml).at(-1)
    const [cap] = clipitems(top)
    assert.deepEqual([int(cap, 'start'), int(cap, 'end'), int(cap, 'in'), int(cap, 'out')], [15, 300, 0, 285])
    assert.equal(kids(cap, 'filter').length, 0)
    assert.equal(txt(fileDef(xml, kid(cap, 'file').attrs.id), 'pathurl'), 'file://localhost/proj/graphics/captions.mov')
  })

  test('a graphic or the captions without a movie yet: linked where the graphics step will put it, with a warning', () => {
    const tl = build(load('captions'))
    const { xml, warnings } = writeXmeml(tl, stubProbes(tl), { name: 'c', xmlDir: '/out/My Export' })
    const cap = clipitems(videoTracks(xml).at(-1))[0]
    assert.equal(txt(fileDef(xml, kid(cap, 'file').attrs.id), 'pathurl'), 'file://localhost/out/My%20Export/captions.mov')
    assert.ok(warnings.some((w) => w.includes('captions captions is not rendered yet')), warnings.join('\n'))
    assert.throws(() => writeXmeml(tl, stubProbes(tl), { name: 'c' }), /xmlDir/)
  })

  test('a graphic without a rendered movie is left out of the XML, with a warning (never a guessed path)', () => {
    const project = load('keyframes')
    const graphic = project.tracks.flatMap((t) => t.items).find((i) => i.type === 'overlay')
    graphic.id = 'a/b:c*'
    const tl = build(project)
    const { xml, warnings } = writeXmeml(tl, stubProbes(tl), { name: 'c', xmlDir: '/out/x' })
    assert.ok(!xml.includes('/graphics/'), 'no guessed movie link')
    assert.ok(!xml.includes('a_b_c_'), 'the clip is not in the XML')
    assert.ok(warnings.some((w) => w.includes('graphic a/b:c* has no rendered movie; left out of the XML')), warnings.join('\n'))
    assert.equal(cleanFileName('a/b:c*'), 'a_b_c_')
  })
})

// ── markers ────────────────────────────────────────────────────────────────

describe('markers', () => {
  test('each unsupported entry is a marker with a plain label and the raw key', () => {
    const { xml } = write('keyframes')
    const footage = clipitems(videoTracks(xml)[0])
    const marks = (c) => kids(c, 'marker').map((m) => [txt(m, 'name'), txt(m, 'comment'), int(m, 'in'), int(m, 'out')])
    assert.deepEqual(marks(footage[0]), [
      ['Stays in Montaj: moving position', 'keyframes:offsetX', 0, -1],
      ['Stays in Montaj: moving crop', 'keyframes:cropX', 0, -1],
      ['Stays in Montaj: loop', 'loop', 0, -1],
    ])
    assert.deepEqual(marks(footage[1]), [['Cutout linked, background removed', 'remove_bg:nobg_src', 0, -1]])
    assert.deepEqual(marks(footage[2]), [['Stays in Montaj: background removal', 'remove_bg', 0, -1]])
  })

  test('labels: plain words, no em dashes, one per family', () => {
    const keys = ['keyframes:offsetX', 'keyframes:offsetY', 'keyframes:scale', 'keyframes:scaleX', 'keyframes:rotation',
      'keyframes:opacity', 'keyframes:cropW', 'keyframes:blur', 'loop', 'remove_bg', 'remove_bg:nobg_src', 'motionBlur',
      'ducking', 'nonUniformScale', 'fadeInCurve:exp', 'fadeOutCurve:log', 'something']
    for (const k of keys) assert.doesNotMatch(markerLabel(k), /\u2014|\u2013/)
    assert.equal(markerLabel('keyframes:scale'), 'Stays in Montaj: moving zoom')
    assert.equal(markerLabel('keyframes:offsetY'), markerLabel('keyframes:offsetX'))
    assert.equal(markerLabel('keyframes:blur'), 'Stays in Montaj: blur animation')
    assert.equal(markerLabel('fadeOutCurve:log'), 'Stays in Montaj: fade out shape')
    assert.equal(markerLabel('something'), 'Stays in Montaj: something')
  })

  test('two keys with one label share a marker', () => {
    const project = load('keyframes')
    project.tracks[0].items[0].keyframes.push({ prop: 'offsetY', points: [{ t: 0, value: 0 }, { t: 1, value: 5 }] })
    const { xml } = write('keyframes', project)
    const m = kids(clipitems(videoTracks(xml)[0])[0], 'marker')
    assert.deepEqual(m.map((x) => [txt(x, 'name'), txt(x, 'comment')])[0], ['Stays in Montaj: moving position', 'keyframes:offsetX, keyframes:offsetY'])
  })
})

// ── escaping and paths ─────────────────────────────────────────────────────

describe('escaping', () => {
  const NASTY = `/abs/R&D <cut> "final" 'v2'/Café ü #1.mp4`
  const project = () => ({
    id: 'esc',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [{ id: 't', items: [{ id: 'a&<b>"\'', type: 'video', src: NASTY, start: 0, end: 2, inPoint: 0, outPoint: 2, loop: true }] }],
  })

  test('names, paths and attributes are escaped; pathurl is percent-encoded', () => {
    const tl = build(project())
    const { xml } = writeXmeml(tl, { [NASTY]: VIDEO }, { name: `Q&A <"edit"> 'one'`, xmlDir: '/x' })
    wellFormed(xml, 'escaping')
    assert.doesNotMatch(xml, /R&D|<cut>|& /)
    const seq = seqOf(xml)
    assert.equal(txt(seq, 'name'), `Q&A <"edit"> 'one'`)
    const clip = clipitems(videoTracks(xml)[0])[0]
    assert.equal(txt(clip, 'name'), `Café ü #1.mp4`)
    const file = fileDef(xml, 'file-1')
    assert.equal(txt(file, 'pathurl'), 'file://localhost/abs/R%26D%20%3Ccut%3E%20%22final%22%20%27v2%27/Caf%C3%A9%20%C3%BC%20%231.mp4')
    assert.equal(decodeURIComponent(txt(file, 'pathurl').slice('file://localhost'.length)), NASTY)
  })

  test('pathUrl: posix, spaces, non-ASCII, a Windows drive', () => {
    assert.equal(pathUrl('/Users/sam/My Clips/a.mov'), 'file://localhost/Users/sam/My%20Clips/a.mov')
    assert.equal(pathUrl('/a/b%c.mov'), 'file://localhost/a/b%25c.mov')
    assert.equal(pathUrl('C:\\Users\\Sam\\Vidéos\\a b.mp4'), 'file://localhost/C%3a/Users/Sam/Vid%C3%A9os/a%20b.mp4')
  })
})

// ── warnings ───────────────────────────────────────────────────────────────

describe('warnings', () => {
  test('a missing file is linked offline with a warning, not dropped', () => {
    const a = resolve(PROJECT_DIR, 'footage/a.mp4')
    const { xml, warnings } = write('cut-list', load('cut-list'), { [a]: { ...VIDEO, exists: false, hasVideo: false, hasAudio: false, warnings: ['media not found'] } })
    assert.ok(warnings.includes(`media not found: ${a}; linked offline`), warnings.join('\n'))
    const v = clipitems(videoTracks(xml)[0])[0]
    assert.deepEqual([int(v, 'in'), int(v, 'out')], [30, 90])
    // Its length is what the edit uses, at the sequence's rate.
    assert.equal(int(fileDef(xml, kid(v, 'file').attrs.id), 'duration'), 90)
    assert.equal(kids(v, 'link').length, 3, 'its sound is assumed and kept')
  })

  test('no probe at all: a warning, and the clip is still written', () => {
    const tl = build(load('crossfade'))
    const { xml, warnings } = writeXmeml(tl, {}, { name: 'n' })
    assert.ok(warnings.some((w) => w.startsWith('no probe result for /abs/a.mp4')))
    assert.equal(clipitems(videoTracks(xml)[0]).length, 2)
    wellFormed(xml, 'no probe')
  })

  test('a volume above +12 dB is written at +12 dB with a warning', () => {
    const project = load('audio')
    project.audio.tracks[1].volume = 6
    const { xml, warnings } = write('audio', project)
    const vo = audioTracks(xml).flatMap(clipitems).find((c) => txt(c, 'name') === 'vo.wav')
    assert.equal(txt(paramOf(effectOf(vo, 'audiolevels'), 'level'), 'value'), '3.981072')
    assert.ok(warnings.includes("audio vo: volume 6 is above the editor's +12 dB; written at +12 dB"), warnings.join('\n'))
  })

  test('a source shorter than the edit uses is a warning', () => {
    const a = resolve(PROJECT_DIR, 'footage/a.mp4')
    const { warnings } = write('cut-list', load('cut-list'), { [a]: { ...VIDEO, durationSeconds: 2, durationFrames: 60 } })
    assert.ok(warnings.some((w) => w.includes('2 s long but the edit uses it to 3 s')), warnings.join('\n'))
  })
})

// ── probe ──────────────────────────────────────────────────────────────────

describe('probe', () => {
  test('parseProbe: an exact NTSC rate, a rotated phone clip, cover art is not video', () => {
    const p = parseProbe({
      streams: [
        { codec_type: 'video', width: 1920, height: 1080, r_frame_rate: '30000/1001', duration: '10.010000',
          side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }], color_transfer: 'arib-std-b67' },
        { codec_type: 'audio', channels: 1, sample_rate: '44100' },
      ],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10.010000', tags: { timecode: '00:59:58;00' } },
    })
    assert.equal(p.rFrameRate, '30000/1001')
    assert.equal(p.fpsExact, 30000 / 1001)
    assert.equal(p.ntsc, true)
    assert.equal(p.timebase, 30)
    assert.deepEqual([p.width, p.height, p.rotation], [1080, 1920, -90])
    assert.equal(p.durationFrames, 300)
    assert.deepEqual([p.audioChannels, p.audioSampleRate], [1, 44100])
    assert.equal(p.timecode, '00:59:58;00')
    assert.equal(p.colorTransfer, 'arib-std-b67')
    assert.equal(p.isStill, false)

    const mp3 = parseProbe({
      streams: [
        { codec_type: 'audio', channels: 2, sample_rate: '48000', duration: '61.5' },
        { codec_type: 'video', width: 600, height: 600, r_frame_rate: '90000/1', disposition: { attached_pic: 1 } },
      ],
      format: { format_name: 'mp3', duration: '61.500000' },
    })
    assert.equal(mp3.hasVideo, false)
    assert.equal(mp3.hasAudio, true)
    assert.equal(mp3.durationSeconds, 61.5)
    assert.equal(mp3.durationFrames, null)

    const png = parseProbe({ streams: [{ codec_type: 'video', width: 64, height: 48, r_frame_rate: '25/1' }], format: { format_name: 'png_pipe' } })
    assert.equal(png.isStill, true)
    assert.equal(png.rFrameRate, null)
    assert.deepEqual([png.width, png.height], [64, 48])

    assert.equal(isNtsc(24000 / 1001), true)
    assert.equal(isNtsc(59.94), true)
    assert.equal(isNtsc(25), false)
    assert.equal(isNtsc(30), false)
  })

  test('a missing file is exists:false with a warning, not a throw', async () => {
    const missing = join(tmpdir(), `montaj-nle-missing-${process.pid}.mov`)
    const out = await probeSources([missing, missing])
    assert.deepEqual(Object.keys(out), [missing])
    assert.equal(out[missing].exists, false)
    assert.match(out[missing].warnings[0], /media not found/)
  })

  test('real media: a 2 s 29.97 clip with stereo sound', async (t) => {
    const ff = spawnSync(FFMPEG, ['-version'])
    if (ff.status !== 0 || spawnSync(FFPROBE, ['-version']).status !== 0) {
      t.skip('ffmpeg/ffprobe not available')
      return
    }
    const dir = mkdtempSync(join(tmpdir(), 'montaj-nle-probe-'))
    try {
      const clip = join(dir, 'clip 29.97.mov')
      const r = spawnSync(FFMPEG, ['-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30000/1001',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', clip])
      assert.equal(r.status, 0, String(r.stderr))
      const p = (await probeSources([clip]))[clip]
      assert.equal(p.exists, true)
      assert.equal(p.hasVideo, true)
      assert.equal(p.hasAudio, true)
      assert.equal(p.rFrameRate, '30000/1001')
      assert.equal(p.ntsc, true)
      assert.equal(p.timebase, 30)
      assert.deepEqual([p.width, p.height], [320, 240])
      assert.equal(p.audioChannels, 2)
      assert.equal(p.audioSampleRate, 48000)
      assert.equal(p.durationFrames, 60)
      assert.equal(p.isStill, false)
      assert.deepEqual(p.warnings, [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── review fixes ───────────────────────────────────────────────────────────

describe('review fixes', () => {
  test('an incoming crossfade clip off the frame grid with inPoint 0 never reads before its source starts', () => {
    const project = {
      id: 'p', status: 'final', settings: { resolution: [1080, 1920], fps: 30 },
      tracks: [{ id: 't', items: [
        { id: 'a', type: 'video', src: '/abs/a.mp4', start: 0, end: 3, inPoint: 0, outPoint: 3 },
        { id: 'b', type: 'video', src: '/abs/b.mp4', start: 2.51, end: 6, inPoint: 0, outPoint: 3.49 },
      ] }],
    }
    const { xml } = write('x', project)
    const clips = videoTracks(xml).flatMap(clipitems)
    assert.equal(clips.length, 2)
    for (const c of clips) {
      assert.ok(Number(txt(c, 'pproTicksIn')) >= 0, `pproTicksIn ${txt(c, 'pproTicksIn')}`)
      assert.ok(int(c, 'in') >= 0)
      assert.ok(Number(txt(c, 'pproTicksOut')) >= 0)
    }
  })

  test('XML-forbidden control characters and lone surrogates are dropped from text and attributes', () => {
    const project = load('crossfade')
    project.name = 'x'
    const { xml } = write('bad\u0001na\u000bme\ud800\uffff', project)
    assert.ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/.test(xml))
    assert.ok(!/[\uD800-\uDFFF]/.test(xml))
    assert.ok(xml.includes('<name>badname</name>'), 'the rest of the name stays')
    wellFormed(xml, 'forbidden chars')
    // A valid surrogate pair (an emoji) is kept.
    assert.ok(write('ok \u{1F600}', project).xml.includes('\u{1F600}'))
  })

  test('leftOut names the timeline clip, so two clips from one file stay two', () => {
    const project = {
      id: 'p', status: 'final', settings: { resolution: [1080, 1920], fps: 30 },
      tracks: [{ id: 't', items: [
        { id: 'one', type: 'video', src: '/abs/same.mp4', start: 0, end: 2, inPoint: 0, outPoint: 2, loop: true },
        { id: 'two', type: 'video', src: '/abs/same.mp4', start: 2, end: 4, inPoint: 2, outPoint: 4, loop: true },
      ] }],
    }
    const { leftOut } = write('x', project)
    const clips = leftOut.map((l) => l.clip)
    assert.ok(clips.includes('one') && clips.includes('two'), JSON.stringify(leftOut))
    assert.ok(leftOut.every((l) => typeof l.label === 'string' && l.label))
  })
})

describe('chooseFrameRate', () => {
  const rate = (r, avg) => chooseFrameRate({ r_frame_rate: r, avg_frame_rate: avg })
  test('a steady stream keeps r_frame_rate', () => {
    assert.deepEqual(rate('30000/1001', '30000/1001'), { text: '30000/1001', value: 30000 / 1001 })
    assert.equal(rate('25/1', '2498/100').text, '25/1')
  })
  test('a base rate above 120 falls back to the average, snapped', () => {
    assert.equal(rate('90000/1', '2997/100').text, '30000/1001')
    assert.equal(rate('240/1', '30/1').text, '30/1')
  })
  test('a base rate more than 1% off the average falls back to the snapped average', () => {
    assert.equal(rate('60/1', '2400/100').text, '24/1')
    assert.equal(rate('120/1', '5994/100').text, '60000/1001')
    assert.equal(rate('60/1', '2398/100').text, '24000/1001')
  })
  test('missing or bad data: whichever rate is usable, else null', () => {
    assert.equal(rate('30/1', undefined).text, '30/1')
    assert.equal(rate('0/0', '30/1').text, '30/1')
    assert.equal(rate('0/0', '0/0'), null)
  })
  test('parseProbe uses it', () => {
    const p = parseProbe({
      streams: [{ codec_type: 'video', width: 10, height: 10, r_frame_rate: '90000/1', avg_frame_rate: '2997/100', duration: '1' }],
      format: { format_name: 'mov,mp4' },
    })
    assert.equal(p.rFrameRate, '30000/1001')
    assert.equal(p.ntsc, true)
  })
})
