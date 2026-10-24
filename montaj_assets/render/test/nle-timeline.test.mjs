// render/test/nle-timeline.test.mjs
/**
 * `buildNleTimeline` (render/nle/timeline.js): a Montaj project as the flat,
 * frame-quantised, editor-shaped model the FCP7 XML writer and the graphics
 * renderer read.
 *
 * Two kinds of test live here:
 *
 *   - per-feature tests over hand-written fixtures (test/fixtures/nle/*.json),
 *     pinning the exact frames, source windows, transitions and markers;
 *   - PARITY tests, which never restate a number: for every frame of every
 *     fixture they ask the model what is on screen, track by track, and require
 *     the same answer from timeline-core's `resolveAt` (sampled at the frame's
 *     centre) and from the render's own segment planner (`collectAllItems` +
 *     `collectPuppeteerSegments` + `planSegments`). That is the proof the
 *     flattening never disagrees with the render.
 *
 * The paths in the fixtures are invented: the builder does no I/O.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveAt, seekTime, transitionPairs } from '@bycrux/timeline-core'
import { buildNleTimeline } from '../nle/timeline.js'
import { withEnabledItemTracks, trackItems } from '../project-tracks.js'
import { collectAllItems, collectPuppeteerSegments } from '../render.js'
import { planSegments } from '../segment-plan.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'fixtures', 'nle')
const PROJECT_DIR = resolve('/proj')

const load = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))
const build = (project) => buildNleTimeline(project, { projectDir: PROJECT_DIR })
const clips = (tl) => tl.videoTracks.flatMap((t) => t.clips)
const clip = (tl, id) => {
  const c = clips(tl).find((x) => x.id === id)
  assert.ok(c, `no clip ${id}`)
  return c
}
const audioClips = (tl) => tl.audioTracks.flatMap((t) => t.clips)
const audioClip = (tl, id) => {
  const c = audioClips(tl).find((x) => x.id === id)
  assert.ok(c, `no audio clip ${id}`)
  return c
}
const near = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ''} expected ${expected}, got ${actual}`)

describe('shape', () => {
  test('requires projectDir', () => {
    assert.throws(() => buildNleTimeline(load('cut-list')), /projectDir/)
  })

  test('a simple cut list: frames, original-source windows, linked audio', () => {
    const project = load('cut-list')
    const before = structuredClone(project)
    const tl = build(project)
    assert.deepEqual(project, before, 'the input project is not mutated')

    assert.equal(tl.fps, 30)
    assert.equal(tl.width, 1080)
    assert.equal(tl.height, 1920)
    assert.equal(tl.colorSpace, 'sdr_bt709')
    assert.equal(tl.durationFrames, 195)
    assert.deepEqual(tl.warnings, [])

    assert.equal(tl.videoTracks.length, 1)
    const [vt] = tl.videoTracks
    assert.equal(vt.index, 0)
    assert.equal(vt.role, 'footage')
    assert.equal(vt.trackIndex, 0)
    assert.equal(vt.lane, 0)
    assert.deepEqual(vt.transitions, [])
    assert.deepEqual(vt.clips.map((c) => c.id), ['a', 'b', 'c'])

    const a = clip(tl, 'a')
    assert.equal(a.kind, 'video')
    assert.equal(a.trackIndex, 0)
    assert.equal(a.itemIndex, 0)
    assert.equal(a.startFrame, 0)
    assert.equal(a.endFrame, 60)
    near(a.sourceIn, 1)
    near(a.sourceOut, 3)
    assert.equal(a.speed, 1)
    assert.equal(a.volume, 1)
    assert.equal(a.muted, false)
    assert.equal(a.opacity, 1)
    assert.deepEqual(a.transform, { scale: 1, scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, rotation: 0, fit: 'contain' })
    assert.equal(a.crop, null)
    assert.deepEqual(a.unsupported, [])

    const b = clip(tl, 'b')
    assert.equal(b.startFrame, 60)
    assert.equal(b.endFrame, 150)
    near(b.sourceIn, 10)
    near(b.sourceOut, 13)

    // `c` carries a normalized cache. The editor gets the ORIGINAL file, in the
    // original file's own coordinates: no rebase by normalizedInPoint.
    const c = clip(tl, 'c')
    assert.equal(c.src, '/abs/footage/c.mp4')
    assert.equal(c.startFrame, 150)
    assert.equal(c.endFrame, 195)
    near(c.sourceIn, 2)
    near(c.sourceOut, 3.5)

    // Each video clip's own sound, linked, with the same window.
    assert.equal(tl.audioTracks.length, 1)
    const [at] = tl.audioTracks
    assert.equal(at.index, 0)
    assert.equal(at.source, 'video')
    assert.equal(at.trackIndex, 0)
    assert.equal(at.lane, 0)
    assert.deepEqual(at.transitions, [])
    for (const v of [a, b, c]) {
      const ac = audioClip(tl, `${v.id}:audio`)
      assert.equal(ac.linkedClipId, v.id)
      assert.equal(ac.src, v.src)
      assert.equal(ac.startFrame, v.startFrame)
      assert.equal(ac.endFrame, v.endFrame)
      near(ac.sourceIn, v.sourceIn)
      near(ac.sourceOut, v.sourceOut)
      assert.equal(ac.fadeInFrames, 0)
      assert.equal(ac.fadeOutFrames, 0)
      assert.deepEqual(ac.unsupported, [])
    }

    // Every distinct media file, for the writer's probe. Never the cache.
    assert.deepEqual(Object.keys(tl.sources).sort(), [a.src, b.src, c.src].sort())
    assert.equal(tl.sources[a.src].firstSeenItem, 'a')
    assert.ok(!('/abs/cache/c_norm.mp4' in tl.sources))
  })

  test('relative src resolves against projectDir; absolute src is kept', () => {
    const tl = build(load('cut-list'))
    assert.equal(clip(tl, 'a').src, resolve(PROJECT_DIR, 'footage/a.mp4'))
    assert.equal(clip(tl, 'b').src, resolve(PROJECT_DIR, './footage/b.mp4'))
    assert.equal(clip(tl, 'c').src, '/abs/footage/c.mp4')

    const layers = build(load('layers'))
    assert.equal(clip(layers, 'logo').src, resolve(PROJECT_DIR, 'assets/logo.png'))
    assert.equal(clip(layers, 'title').src, resolve(PROJECT_DIR, 'overlays/title.jsx'))

    const audio = build(load('audio'))
    assert.equal(audioClip(audio, 'music').src, resolve(PROJECT_DIR, 'audio/music.mp3'))
    assert.equal(audioClip(audio, 'vo').src, '/abs/vo.wav')

    for (const tl2 of [tl, layers, audio]) {
      for (const c of [...clips(tl2), ...audioClips(tl2)]) assert.ok(isAbsolute(c.src), c.src)
    }
  })
})

describe('timing', () => {
  test('a speed change scales the source window, not the timeline', () => {
    const tl = build(load('speed'))
    const fast = clip(tl, 'fast')
    assert.equal(fast.startFrame, 0)
    assert.equal(fast.endFrame, 60)
    assert.equal(fast.speed, 2)
    near(fast.sourceIn, 4)
    near(fast.sourceOut, 8)
    const slow = clip(tl, 'slow')
    assert.equal(slow.startFrame, 60)
    assert.equal(slow.endFrame, 180)
    assert.equal(slow.speed, 0.5)
    near(slow.sourceIn, 0)
    near(slow.sourceOut, 2)
    assert.equal(audioClip(tl, 'fast:audio').speed, 2)
    assert.equal(audioClip(tl, 'slow:audio').speed, 0.5)
  })

  test('a negative start is floored at frame 0 and advances the source in point', () => {
    const tl = build({
      settings: { resolution: [1080, 1920], fps: 30 },
      tracks: [
        [{ id: 'v', type: 'video', src: '/abs/v.mp4', start: -1, end: 2, inPoint: 5, outPoint: 8 }],
        [{ id: 'o', type: 'overlay', src: '/abs/o.jsx', start: -0.5, end: 1 }],
      ],
    })
    const v = clip(tl, 'v')
    assert.equal(v.startFrame, 0)
    assert.equal(v.endFrame, 60)
    near(v.sourceIn, 6)
    near(v.sourceOut, 8)
    const o = clip(tl, 'o')
    assert.equal(o.startFrame, 0)
    near(o.sourceIn, 0.5, 'a graphic starts 0.5 s into its own clock')
    near(o.sourceOut, 1.5)
  })

  test('sub-frame times snap with the render rounding (round to nearest frame)', () => {
    const tl = build({
      settings: { resolution: [1080, 1920], fps: 30 },
      tracks: [[
        { id: 'v', type: 'video', src: '/abs/v.mp4', start: 0.02, end: 1.049, inPoint: 0, outPoint: 1.029 },
      ]],
    })
    const v = clip(tl, 'v')
    assert.equal(v.startFrame, 1)   // 0.6 frames rounds up
    assert.equal(v.endFrame, 31)    // 31.47 frames rounds down
    assert.equal(tl.durationFrames, 31)
  })

  test('a non-integer fps is rounded, with a warning', () => {
    const tl = build({ settings: { resolution: [1080, 1920], fps: 29.97 }, tracks: [[]] })
    assert.equal(tl.fps, 30)
    assert.ok(tl.warnings.some((w) => /fps/.test(w)), tl.warnings.join('\n'))
  })
})

describe('transitions', () => {
  test('a crossfade becomes two abutting clips cut at the overlap midpoint, plus a transition', () => {
    const tl = build(load('crossfade'))
    const a = clip(tl, 'a')
    const b = clip(tl, 'b')
    assert.equal(a.startFrame, 0)
    assert.equal(a.endFrame, 135)
    near(a.sourceIn, 0)
    near(a.sourceOut, 4.5)
    assert.equal(b.startFrame, 135)
    assert.equal(b.endFrame, 270)
    near(b.sourceIn, 10.5)
    near(b.sourceOut, 15)

    const [vt] = tl.videoTracks
    assert.deepEqual(vt.transitions, [
      { trackIndex: 0, lane: 0, fromClipId: 'a', toClipId: 'b', startFrame: 120, cutFrame: 135, endFrame: 150, durationFrames: 30 },
    ])

    // The handles come from the overlap itself: A's source runs on to its own
    // out point at the transition's end, B's starts at its own in point at the
    // transition's start. No media is invented beyond the item windows.
    const [x] = vt.transitions
    near(a.sourceOut + a.speed * (x.endFrame - x.cutFrame) / tl.fps, 5, 'A handle end = A outPoint')
    near(b.sourceIn - b.speed * (x.cutFrame - x.startFrame) / tl.fps, 10, 'B handle start = B inPoint')

    // The sound crossfades with the picture, on the linked audio track.
    const [at] = tl.audioTracks
    assert.equal(audioClip(tl, 'a:audio').endFrame, 135)
    assert.equal(audioClip(tl, 'b:audio').startFrame, 135)
    assert.deepEqual(at.transitions, [
      { trackIndex: 0, lane: 0, fromClipId: 'a:audio', toClipId: 'b:audio', startFrame: 120, cutFrame: 135, endFrame: 150, durationFrames: 30 },
    ])
  })

  test('a clip with transitions on both ends is trimmed at both cuts', () => {
    const tl = build(load('crossfade-both-ends'))
    const a = clip(tl, 'a')
    const b = clip(tl, 'b')
    const c = clip(tl, 'c')
    assert.equal(a.endFrame, 135)
    assert.equal(b.startFrame, 135)
    assert.equal(b.endFrame, 292)  // overlap 285..300 is 15 frames; the cut is floor(15/2) = 7 in
    assert.equal(c.startFrame, 292)
    assert.equal(c.endFrame, 420)
    near(b.sourceIn, 20.5)
    near(b.sourceOut, 20.5 + 157 / 30)
    near(c.sourceIn, 30 + (292 / 30 - 9.5))
    near(c.sourceOut, 34.5)
    assert.deepEqual(tl.videoTracks[0].transitions.map((x) => [x.fromClipId, x.toClipId, x.startFrame, x.cutFrame, x.endFrame, x.durationFrames]), [
      ['a', 'b', 120, 135, 150, 30],
      ['b', 'c', 285, 292, 300, 15],
    ])
  })

  test('a hard cut (overlap of 1 ms or less) has no transition', () => {
    const tl = build(load('hard-cut'))
    assert.equal(clip(tl, 'a').endFrame, 150)
    assert.equal(clip(tl, 'b').startFrame, 150)
    for (const vt of tl.videoTracks) assert.deepEqual(vt.transitions, [], `track ${vt.trackIndex}`)
    for (const at of tl.audioTracks) assert.deepEqual(at.transitions, [])
  })

  test('an overlap that rounds to zero frames is a hard cut too, as in the render', () => {
    const project = load('hard-cut')
    const [c, d] = trackItems(project)[1]
    assert.equal(transitionPairs([c, d]).length, 1, 'timeline-core does pair this 2 ms overlap')
    const tl = build(project)
    assert.equal(clip(tl, 'c').endFrame, 90)
    assert.equal(clip(tl, 'd').startFrame, 90)
  })

  test('nested clips on one track spill to a lane above, later item on top', () => {
    const tl = build(load('nested'))
    assert.deepEqual(tl.videoTracks.map((t) => [t.role, t.trackIndex, t.lane, t.clips.map((c) => c.id)]), [
      ['footage', 0, 0, ['outer']],
      ['footage', 0, 1, ['inner']],
    ])
    assert.deepEqual(tl.audioTracks.map((t) => [t.trackIndex, t.lane, t.clips.map((c) => c.id)]), [
      [0, 0, ['outer:audio']],
      [0, 1, ['inner:audio']],
    ])
  })

  test('three clips live at once: no crossfade, each clip on its own lane, a warning', () => {
    const tl = build(load('three-live'))
    assert.deepEqual(tl.videoTracks.map((t) => [t.lane, t.clips.map((c) => [c.id, c.startFrame, c.endFrame]), t.transitions]), [
      [0, [['a', 0, 150]], []],
      [1, [['b', 120, 240]], []],
      [2, [['c', 135, 300]], []],
    ])
    assert.ok(tl.warnings.some((w) => /three or more/.test(w)), tl.warnings.join('\n'))
  })

  test('a crossfade whose sides land on different lanes is undone, with a warning', () => {
    // `z` sits inside `b` and comes first in the document, so `b` must go above
    // it, while `a` stays below: the pair cannot share an editor track.
    const tl = build(load('lane-clash'))
    assert.deepEqual(tl.videoTracks.map((t) => [t.lane, t.clips.map((c) => [c.id, c.startFrame, c.endFrame]), t.transitions]), [
      [0, [['a', 0, 150], ['z', 180, 210]], []],
      [1, [['b', 120, 270]], []],
    ])
    assert.ok(tl.warnings.some((w) => /crossfade from a to b/.test(w)), tl.warnings.join('\n'))
  })
})

describe('layers', () => {
  test('upper-track video and an image keep their static transform, crop and folded volume', () => {
    const tl = build(load('layers'))
    const pip = clip(tl, 'pip')
    assert.equal(pip.kind, 'video')
    assert.equal(pip.trackIndex, 2)
    assert.deepEqual(pip.transform, { scale: 0.4, scaleX: 0.4, scaleY: 0.4, offsetX: 20, offsetY: -10, rotation: 15, fit: 'contain' })
    assert.equal(pip.opacity, 0.8)
    assert.deepEqual(pip.crop, { x: 0.1, y: 0, w: 0.8, h: 1 })
    assert.deepEqual(pip.sourceSize, { width: 1920, height: 1080 })
    assert.equal(pip.volume, 0.25, 'track volume 0.5 x clip volume 0.5')
    assert.equal(audioClip(tl, 'pip:audio').volume, 0.25)

    const logo = clip(tl, 'logo')
    assert.equal(logo.kind, 'image')
    assert.equal(logo.startFrame, 0)
    assert.equal(logo.endFrame, 180)
    assert.equal(logo.sourceIn, null)
    assert.equal(logo.sourceOut, null)
    assert.equal(logo.volume, null)
    assert.equal(logo.muted, null)
    assert.deepEqual(logo.transform, { scale: 0.2, scaleX: 0.2, scaleY: 0.2, offsetX: 40, offsetY: 2, rotation: 0, fit: 'contain' })
    assert.deepEqual(logo.crop, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
    assert.ok(logo.src in tl.sources)
    assert.ok(!audioClips(tl).some((c) => c.linkedClipId === 'logo'))
  })

  test('an overlay is a graphic placeholder, composited above every clip as the render does', () => {
    const tl = build(load('layers'))
    // tracks[1] holds the overlays but the render composites ALL overlays over
    // ALL clips, so the graphics tracks come last whatever their track index.
    assert.deepEqual(tl.videoTracks.map((t) => [t.index, t.role, t.trackIndex, t.lane]), [
      [0, 'footage', 0, 0],
      [1, 'layer', 2, 0],
      [2, 'layer', 3, 0],
      [3, 'graphics', 1, 0],
    ])
    const title = clip(tl, 'title')
    assert.equal(title.kind, 'graphic')
    assert.equal(title.src, resolve(PROJECT_DIR, 'overlays/title.jsx'))
    assert.equal(title.startFrame, 15)
    assert.equal(title.endFrame, 90)
    near(title.sourceIn, 0)
    near(title.sourceOut, 2.5)
    assert.equal(title.opacity, 0.75)
    assert.deepEqual(title.transform, { scale: 0.9, scaleX: 0.9, scaleY: 0.9, offsetX: 5, offsetY: -12, rotation: 4, fit: null })
    assert.equal(title.opaque, false)
    assert.equal(title.volume, null)
    assert.deepEqual(title.unsupported, [])
    assert.equal(clip(tl, 'card').opaque, true)
    assert.ok(!(title.src in tl.sources), 'a JSX component is not media to probe')
  })

  test('a captions placeholder spans the first segment start to the last end, inside the picture', () => {
    const tl = build(load('captions'))
    assert.deepEqual(tl.captionsTrack, {
      clips: [{
        id: 'captions', kind: 'captions', startFrame: 15, endFrame: 300, sourceIn: 0.5, sourceOut: 10,
        segmentCount: 3, style: 'pop', unsupported: [],
      }],
    })
    const none = build({ ...load('captions'), captions: { style: 'pop', segments: [] } })
    assert.equal(none.captionsTrack, null)
    const absent = build(load('cut-list'))
    assert.equal(absent.captionsTrack, null)
  })

  test('a disabled track is skipped, and leaves the duration', () => {
    const tl = build(load('disabled'))
    assert.equal(tl.durationFrames, 150)
    assert.deepEqual(tl.videoTracks.map((t) => t.trackIndex), [0])
    assert.ok(!clips(tl).some((c) => c.trackIndex === 1))
    assert.ok(!('/abs/hidden.png' in tl.sources))
  })

  test('a canvas project (empty tracks[0], legacy array shape) works', () => {
    const tl = build(load('canvas'))
    assert.equal(tl.fps, 60)
    assert.equal(tl.durationFrames, 300)
    assert.deepEqual(tl.videoTracks.map((t) => [t.role, t.trackIndex, t.clips.map((c) => c.id)]), [
      ['layer', 1, ['photo']],
      ['graphics', 1, ['bg']],
    ])
    assert.equal(clip(tl, 'photo').startFrame, 60)
    assert.equal(clip(tl, 'photo').endFrame, 240)
    assert.deepEqual(tl.audioTracks, [])
  })

  test('an unknown item type is skipped with a warning', () => {
    const tl = build({
      settings: { resolution: [1080, 1920], fps: 30 },
      tracks: [[
        { id: 'v', type: 'video', src: '/abs/v.mp4', start: 0, end: 1 },
        { id: 'x', type: 'hologram', src: '/abs/x', start: 0, end: 1 },
      ]],
    })
    assert.deepEqual(clips(tl).map((c) => c.id), ['v'])
    assert.ok(tl.warnings.some((w) => /hologram/.test(w)), tl.warnings.join('\n'))
  })
})

describe('audio', () => {
  test('audio.tracks become their own tracks with volume, mute and fades in frames; ducking is marked', () => {
    const tl = build(load('audio'))
    assert.deepEqual(tl.audioTracks.map((t) => [t.index, t.source, t.trackIndex, t.audioIndex, t.clips.map((c) => c.id)]), [
      [0, 'video', 0, null, ['a:audio']],
      [1, 'audio.tracks', null, 0, ['music']],
      [2, 'audio.tracks', null, 1, ['vo']],
      [3, 'audio.tracks', null, 2, ['sfx']],
      [4, 'audio.tracks', null, 3, ['quiet']],
    ])
    assert.deepEqual(audioClip(tl, 'music'), {
      id: 'music', src: resolve(PROJECT_DIR, 'audio/music.mp3'),
      startFrame: 0, endFrame: 300, sourceIn: 0, sourceOut: 10, speed: 1,
      volume: 0.3, muted: false,
      fadeInFrames: 30, fadeOutFrames: 60, fadeInCurve: 'exp', fadeOutCurve: 'linear',
      linkedClipId: null, unsupported: ['ducking'],
    })
    const vo = audioClip(tl, 'vo')
    assert.equal(vo.startFrame, 45)
    assert.equal(vo.endFrame, 135, 'no end: the out point stops it')
    near(vo.sourceIn, 3)
    near(vo.sourceOut, 6)
    assert.equal(vo.fadeInFrames, 0)
    assert.equal(vo.fadeOutFrames, 0)
    assert.deepEqual(vo.unsupported, [])
    const sfx = audioClip(tl, 'sfx')
    assert.equal(sfx.startFrame, 60)
    assert.equal(sfx.endFrame, null, 'no end and no out point: plays to the end of its file')
    assert.equal(sfx.sourceIn, 0)
    assert.equal(sfx.sourceOut, null)
    assert.equal(audioClip(tl, 'quiet').muted, true)
    assert.ok(resolve(PROJECT_DIR, 'sfx/boom.wav') in tl.sources)
  })

  test('a muted video clip, or one on a muted track, keeps its linked audio, muted', () => {
    const tl = build(load('muted'))
    assert.equal(clip(tl, 'a').muted, true)
    assert.equal(clip(tl, 'pip').muted, true)
    assert.deepEqual(audioClips(tl).map((c) => [c.id, c.muted]).sort(), [
      ['a:audio', true], ['b:audio', false], ['c:audio', true], ['pip:audio', true],
    ])
  })

  test('a crossfade with a muted clip keeps both sound clips and their transition (the writer fades the audible side alone)', () => {
    const tl = build(load('muted'))
    assert.equal(clip(tl, 'b').endFrame, 172)
    assert.equal(clip(tl, 'c').startFrame, 172)
    assert.equal(audioClip(tl, 'b:audio').muted, false)
    assert.equal(audioClip(tl, 'c:audio').muted, true)
    const lane = tl.audioTracks.find((t) => t.clips.some((c) => c.id === 'b:audio'))
    assert.equal(lane.transitions.length, 1)
  })

  test('two audio fades longer than the clip together shrink in proportion to fit it', () => {
    const tl = build({
      id: 'p', status: 'final', settings: { resolution: [1080, 1920], fps: 30 },
      tracks: [], audio: { tracks: [{ id: 'm', src: '/abs/m.wav', start: 0, end: 1, fadeIn: 0.8, fadeOut: 0.8 }] },
    })
    const m = audioClip(tl, 'm')
    assert.equal(m.endFrame - m.startFrame, 30)
    assert.ok(m.fadeInFrames > 0 && m.fadeOutFrames > 0)
    assert.ok(m.fadeInFrames + m.fadeOutFrames <= 30)
    assert.equal(m.fadeInFrames, 15)
    assert.equal(m.fadeOutFrames, 15)
  })
})

describe('left out of the editor', () => {
  test('an old lyric project renders the normal way: the retired renderMode ffmpeg-drawtext changes nothing', () => {
    const project = load('layers')
    project.captions = load('captions').captions
    project.audio = { tracks: [{ id: 'song', src: '/abs/song.mp3', start: 0, end: 2 }] }
    const plain = build(project)
    assert.ok(clips(plain).some((c) => c.kind === 'graphic'), 'the project has graphics')
    assert.ok(plain.captionsTrack, 'the captions are in the plan')
    assert.ok(plain.audioTracks.some((t) => t.clips.some((c) => c.id === 'song')), 'the audio track is in the plan')

    const old = build({ ...project, renderMode: 'ffmpeg-drawtext' })
    assert.deepEqual(old, plain)
    assert.ok(old.warnings.every((w) => !/drawtext/.test(w)), old.warnings.join(' | '))
  })

  test('keyframes, loop, background removal and motion blur are marked; HDR and loudness warn', () => {
    const tl = build(load('keyframes'))
    assert.equal(tl.colorSpace, 'hdr_hlg')
    assert.equal(tl.motionBlur, 4)

    // A clip's opacity curve is ignored by the render itself (the static value
    // ships), so the editor loses nothing there: it is not marked.
    const a = clip(tl, 'a')
    assert.deepEqual(a.unsupported, ['keyframes:offsetX', 'keyframes:cropX', 'loop'])
    assert.equal(a.transform.offsetX, 0, 'static value only')
    assert.equal(a.opacity, 1)

    const b = clip(tl, 'b')
    assert.equal(b.src, '/abs/b_nobg.mov', 'the cutout is the asset')
    assert.deepEqual(b.unsupported, ['remove_bg:nobg_src'])
    assert.ok('/abs/b_nobg.mov' in tl.sources)

    const c = clip(tl, 'c')
    assert.equal(c.src, '/abs/c.mp4')
    assert.deepEqual(c.unsupported, ['remove_bg'])

    const o = clip(tl, 'o')
    assert.deepEqual(o.unsupported, ['keyframes:scale', 'keyframes:opacity', 'motionBlur'])

    assert.equal(tl.warnings.filter((w) => /motion ?blur/i.test(w)).length, 1, 'motion blur warns once')
    assert.equal(tl.warnings.filter((w) => /HDR/.test(w)).length, 1)
    assert.equal(tl.warnings.filter((w) => /loudness/i.test(w)).length, 1)
  })

  test('no marker when nothing is left out', () => {
    const tl = build(load('crossfade'))
    for (const c of [...clips(tl), ...audioClips(tl)]) assert.deepEqual(c.unsupported, [], c.id)
    assert.deepEqual(tl.warnings, [])
  })
})

// ── Parity ──────────────────────────────────────────────────────────────────

const PARITY_FIXTURES = [
  'cut-list', 'speed', 'crossfade', 'crossfade-both-ends', 'hard-cut', 'layers', 'captions',
  'audio', 'muted', 'keyframes', 'disabled', 'canvas', 'nested', 'off-grid', 'three-live', 'lane-clash',
]

/**
 * Fixtures whose item edges fall between frames. The render seeks each segment
 * afresh (`inPoint + speed * max(0, segStart - start)`), so a clip that starts
 * between frames re-seeks by up to half a frame at its second segment; an
 * editor clip plays straight through. There the model is held to half a source
 * frame; everywhere else, exactly.
 */
const OFF_GRID = new Set(['hard-cut', 'off-grid'])

/** `${trackIndex}|clip` or `${trackIndex}|graphic` → sorted ids, for one frame of the model. */
function modelAt(tl, f) {
  const out = {}
  const add = (key, id) => { (out[key] ??= new Set()).add(id) }
  for (const vt of tl.videoTracks) {
    const family = vt.role === 'graphics' ? 'graphic' : 'clip'
    for (const c of vt.clips) if (c.startFrame <= f && f < c.endFrame) add(`${c.trackIndex}|${family}`, c.id)
    for (const x of vt.transitions) {
      if (x.startFrame <= f && f < x.endFrame) {
        add(`${x.trackIndex}|clip`, x.fromClipId)
        add(`${x.trackIndex}|clip`, x.toClipId)
      }
    }
  }
  return normalise(out)
}

function normalise(map) {
  return Object.fromEntries(Object.entries(map).map(([k, s]) => [k, [...s].sort()]).sort(([a], [b]) => (a < b ? -1 : 1)))
}

describe('parity with the render', () => {
  for (const name of PARITY_FIXTURES) {
    test(`${name}: every frame shows what timeline-core's resolveAt shows at the frame centre`, () => {
      const project = load(name)
      const tl = build(project)
      const enabled = withEnabledItemTracks(project)
      for (let f = 0; f < tl.durationFrames; f++) {
        const scene = resolveAt(enabled, (f + 0.5) / tl.fps, { variant: 'render' })
        const expected = {}
        for (const ri of scene.items) {
          ;(expected[`${ri.trackIdx}|${ri.kind === 'overlay' ? 'graphic' : 'clip'}`] ??= new Set()).add(ri.item.id)
        }
        assert.deepEqual(modelAt(tl, f), normalise(expected), `${name} frame ${f}`)
      }
    })

    test(`${name}: every frame shows what the render's segment planner composites`, () => {
      const project = load(name)
      const tl = build(project)
      const { imageItems, videoItems } = collectAllItems(structuredClone(project))
      const specs = collectPuppeteerSegments(structuredClone(project), tl.fps, tl.width, tl.height, '/nonexistent/segments')
      const segments = planSegments([...imageItems, ...videoItems], specs, tl.width, tl.height, tl.fps)
      const covered = new Set()
      for (const seg of segments) {
        const expected = {}
        for (const it of seg.items) (expected[`${it.trackIdx}|clip`] ??= new Set()).add(it.id)
        for (const ov of seg.overlays) {
          if (ov.isCaption) continue
          const m = /^overlay-(\d+)--(.*)$/.exec(ov.id)
          ;(expected[`${m[1]}|graphic`] ??= new Set()).add(m[2])
        }
        const f0 = Math.round(seg.start * tl.fps)
        const f1 = Math.round(seg.end * tl.fps)
        for (let f = f0; f < f1; f++) {
          covered.add(f)
          assert.deepEqual(modelAt(tl, f), normalise(expected), `${name} frame ${f}`)
        }
      }
      for (let f = 0; f < tl.durationFrames; f++) {
        if (!covered.has(f)) assert.deepEqual(modelAt(tl, f), {}, `${name} frame ${f} is a gap in the render`)
      }
    })

    test(`${name}: every editor track is valid (no overlaps; each transition inside the two clips it joins)`, () => {
      const tl = build(load(name))
      for (const t of [...tl.videoTracks, ...tl.audioTracks]) {
        const label = `${name} ${t.source ?? t.role} track ${t.index}`
        for (let i = 1; i < t.clips.length; i++) {
          const end = t.clips[i - 1].endFrame
          assert.ok(end !== null && end <= t.clips[i].startFrame, `${label}: ${t.clips[i - 1].id} overlaps ${t.clips[i].id}`)
        }
        const byId = new Map(t.clips.map((c) => [c.id, c]))
        let lastEnd = -Infinity
        for (const x of t.transitions) {
          const from = byId.get(x.fromClipId)
          const to = byId.get(x.toClipId)
          assert.ok(from && to, `${label}: transition joins clips on its own track`)
          assert.equal(from.endFrame, x.cutFrame, `${label}: ${from.id} ends at the cut`)
          assert.equal(to.startFrame, x.cutFrame, `${label}: ${to.id} starts at the cut`)
          assert.ok(x.startFrame < x.cutFrame || x.durationFrames === 1, `${label}: cut inside the transition`)
          assert.ok(x.cutFrame < x.endFrame, `${label}: cut inside the transition`)
          assert.ok(from.startFrame <= x.startFrame, `${label}: ${from.id} covers the transition's first half`)
          assert.ok(to.endFrame >= x.endFrame, `${label}: ${to.id} covers the transition's second half`)
          assert.ok(x.startFrame >= lastEnd, `${label}: transitions do not overlap`)
          lastEnd = x.endFrame
        }
      }
    })

    test(`${name}: every video and linked audio frame seeks where the render seeks`, (t) => {
      const project = load(name)
      const tl = build(project)
      const items = trackItems(project)
      const original = (c) => {
        // The editor links the ORIGINAL file, so compare in its coordinates.
        const { normalizedSrc, normalizedInPoint, ...rest } = items[c.trackIndex][c.itemIndex]
        return rest
      }
      const byId = new Map(clips(tl).map((c) => [c.id, c]))
      const timed = [
        ...clips(tl).filter((c) => c.kind === 'video'),
        ...audioClips(tl).filter((c) => c.linkedClipId).map((c) => ({ ...c, trackIndex: byId.get(c.linkedClipId).trackIndex, itemIndex: byId.get(c.linkedClipId).itemIndex })),
      ]
      if (timed.length === 0) {
        t.skip('no video in this fixture')
        return
      }
      for (const c of timed) {
        const item = original(c)
        const tolerance = OFF_GRID.has(name) ? (c.speed * 0.5) / tl.fps + 1e-9 : 1e-9
        const at = (f) => seekTime(item, f / tl.fps, 'render')
        const check = (actual, f) =>
          assert.ok(Math.abs(actual - at(f)) <= tolerance, `${name} ${c.id} frame ${f}: ${actual} vs render ${at(f)}`)
        for (let f = c.startFrame; f < c.endFrame; f++) check(c.sourceIn + c.speed * (f - c.startFrame) / tl.fps, f)
        check(c.sourceOut, c.endFrame)
      }
    })
  }
})
