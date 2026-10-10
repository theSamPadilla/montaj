/**
 * §190 T3: the audio plan builder's own rules: what becomes a segment, what is
 * left out and where it is reported, and the ids. What each mapping must EQUAL
 * is held to the export's code in audio-plan-parity.test.ts.
 */
import { describe, it, expect } from 'vitest'
import type { AudioTrack, EditorProject, VisualItem, VisualTrack } from '../../../schema'
import {
  audioSourcePaths,
  buildMixPlan,
  clipSegmentId,
  laneSegmentId,
  type ConformedSource,
  type ConformLookup,
} from '../audio-plan'

const SR = 48000

function conform(src: string, seconds = 60, over: Partial<ConformedSource> = {}): ConformedSource {
  return {
    url: `/api/files?path=${encodeURIComponent(src)}.pcm`,
    format: 'pcm_s16le',
    sampleRate: SR,
    channels: 2,
    frames: Math.round(seconds * SR),
    ...over,
  }
}

/** Every source conformed (60 s), except those named in `missing` and `silent`. */
function lookupAll(opts: { missing?: string[]; silent?: string[]; seconds?: Record<string, number> } = {}): ConformLookup {
  return (src) => {
    if (opts.missing?.includes(src)) return null
    if (opts.silent?.includes(src)) return { ...conform(src, 0), silent: true }
    return conform(src, opts.seconds?.[src] ?? 60)
  }
}

const video = (id: string, start: number, end: number, over: Partial<VisualItem> = {}): VisualItem => ({
  id,
  type: 'video',
  src: `/m/${id}.mp4`,
  start,
  end,
  ...over,
})

const image = (id: string, start: number, end: number): VisualItem => ({ id, type: 'image', src: `/m/${id}.png`, start, end })

const lane = (id: string, over: Partial<AudioTrack> = {}): AudioTrack => ({ id, src: `/a/${id}.m4a`, start: 0, end: 10, ...over })

function project(tracks: Array<VisualItem[] | VisualTrack>, lanes: AudioTrack[] = []): EditorProject {
  return {
    id: 'p',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: tracks.map((t, i) => (Array.isArray(t) ? { id: `trk-${i}`, items: t } : t)),
    audio: { tracks: lanes },
  }
}

const segOf = (p: ReturnType<typeof buildMixPlan>, id: string) => p.plan.segments.find((s) => s.id === id)

describe('main-track clips', () => {
  it('a clip becomes one segment: its conform, its span, its source mapping and its level', () => {
    const p = buildMixPlan(project([[video('A', 2, 7, { inPoint: 3.5, speed: 1.5, volume: 0.6 })]]), lookupAll())
    expect(p.plan.segments).toEqual([
      {
        id: 'clip:A',
        url: '/api/files?path=%2Fm%2FA.mp4.pcm',
        format: 'pcm_s16le',
        sampleRate: SR,
        channels: 2,
        frames: 60 * SR,
        tlStart: 2,
        tlEnd: 7,
        srcIn: 3.5,
        speed: 1.5,
        gain: 0.6,
        stage: 0,
      },
    ])
    expect(p.unconformedMain).toEqual([])
  })

  it('folds the track\'s volume in by multiplying, as the export does', () => {
    const p = buildMixPlan(project([{ id: 't0', items: [video('A', 0, 5, { volume: 0.5 })], volume: 0.8 }]), lookupAll())
    expect(segOf(p, 'clip:A')!.gain).toBeCloseTo(0.4, 12)
  })

  it('a clip that starts past the end of its audio has no segment', () => {
    const p = buildMixPlan(project([[video('A', 0, 5, { inPoint: 20 })]]), lookupAll({ seconds: { '/m/A.mp4': 10 } }))
    expect(p.plan.segments).toEqual([])
  })
})

describe('crossfades', () => {
  it('the outgoing clip fades out and the incoming one fades in, linearly, over the overlap', () => {
    const p = buildMixPlan(project([[video('A', 0, 5), video('B', 4, 9)]]), lookupAll())
    expect(segOf(p, 'clip:A')).toMatchObject({ tlEnd: 5, fadeOut: 1, curveOut: 'linear' })
    expect(segOf(p, 'clip:A')!.fadeIn).toBeUndefined()
    expect(segOf(p, 'clip:B')).toMatchObject({ tlStart: 4, fadeIn: 1, curveIn: 'linear' })
    expect(segOf(p, 'clip:B')!.fadeOut).toBeUndefined()
  })

  it('a butt cut is no crossfade', () => {
    const p = buildMixPlan(project([[video('A', 0, 5), video('B', 5, 9)]]), lookupAll())
    for (const s of p.plan.segments) expect(s.fadeIn ?? 0).toBe(0)
    for (const s of p.plan.segments) expect(s.fadeOut ?? 0).toBe(0)
  })

  it('pairs with an image too: a video crossfading into a still fades its sound out', () => {
    const p = buildMixPlan(project([[video('A', 0, 5), image('I', 4.5, 8), video('B', 7, 12)]]), lookupAll())
    expect(segOf(p, 'clip:A')).toMatchObject({ fadeOut: 0.5, curveOut: 'linear' })
    expect(segOf(p, 'clip:B')).toMatchObject({ fadeIn: 1, curveIn: 'linear' })
  })

  it('a muted partner still makes the transition', () => {
    const p = buildMixPlan(project([[video('A', 0, 5), video('B', 4, 9, { muted: true })]]), lookupAll())
    expect(segOf(p, 'clip:B')).toBeUndefined()
    expect(segOf(p, 'clip:A')).toMatchObject({ fadeOut: 1 })
  })

  it('a clip in two pairs gets both ramps', () => {
    const p = buildMixPlan(project([[video('A', 0, 5), video('B', 4, 10), video('C', 9.5, 15)]]), lookupAll())
    expect(segOf(p, 'clip:B')).toMatchObject({ fadeIn: 1, curveIn: 'linear', fadeOut: 0.5, curveOut: 'linear' })
  })

  it('stays within a track: clips on different tracks are stacked, not sequenced', () => {
    const p = buildMixPlan(project([[video('A', 0, 5)], [video('O', 4, 9)]]), lookupAll())
    for (const s of p.plan.segments) expect(s.fadeIn ?? 0).toBe(0)
    expect(segOf(p, 'clip:A')!.fadeOut ?? 0).toBe(0)
  })
})

describe('overlay-track videos', () => {
  it('play at their own level, above 1 included, at the clips\' stage', () => {
    const p = buildMixPlan(project([[video('A', 0, 9)], [video('O', 2, 6, { volume: 1.8, speed: 0.5 })]]), lookupAll())
    expect(segOf(p, 'clip:O')).toMatchObject({ tlStart: 2, tlEnd: 6, gain: 1.8, speed: 0.5, stage: 0 })
  })
})

describe('left out', () => {
  it('a muted clip, a muted track and a skipped track: no segment, and not reported as unconformed', () => {
    const p = buildMixPlan(
      project(
        [
          [video('A', 0, 5, { muted: true }), video('B', 5, 9)],
          { id: 't1', items: [video('O', 0, 5)], muted: true },
          { id: 't2', items: [video('S', 0, 5)], enabled: false },
        ],
        [lane('m', { muted: true })],
      ),
      lookupAll({ missing: ['/m/A.mp4', '/m/O.mp4', '/m/S.mp4', '/a/m.m4a'] }),
    )
    expect(p.plan.segments.map((s) => s.id)).toEqual(['clip:B'])
    expect(p.unconformedMain).toEqual([])
    expect(p.unconformedOverlays).toEqual([])
    expect(p.unconformedLanes).toEqual([])
  })

  it('a source with no conform goes in its own list, once; a silent one in none', () => {
    const p = buildMixPlan(
      project(
        [
          [video('A', 0, 3), video('A2', 3, 6, { src: '/m/A.mp4' }), video('B', 6, 9), video('Q', 9, 12)],
          [video('O', 0, 4), video('O2', 4, 8, { src: '/m/O.mp4' })],
        ],
        [lane('vo'), lane('vo2', { src: '/a/vo.m4a' }), lane('music')],
      ),
      lookupAll({ missing: ['/m/A.mp4', '/m/O.mp4', '/a/vo.m4a'], silent: ['/m/Q.mp4', '/a/music.m4a'] }),
    )
    expect(p.unconformedMain).toEqual(['/m/A.mp4'])
    expect(p.unconformedOverlays).toEqual(['/m/O.mp4'])
    expect(p.unconformedLanes).toEqual(['/a/vo.m4a'])
    expect(p.plan.segments.map((s) => s.id)).toEqual(['clip:B'])
  })

  it('images, overlays and items without a usable span or src have no audio', () => {
    const p = buildMixPlan(
      project([
        [
          image('I', 0, 2),
          { id: 'X', type: 'overlay', start: 0, end: 2 },
          video('Z', 3, 3),
          video('N', Number.NaN, 4),
          video('E', 4, 6, { src: '' }),
        ],
      ]),
      lookupAll(),
    )
    expect(p.plan.segments).toEqual([])
    expect(p.unconformedMain).toEqual([])
  })
})

describe('lanes', () => {
  it('carry their window, fades, curves, level and the export\'s mix order', () => {
    const p = buildMixPlan(
      project(
        [[video('A', 0, 30)]],
        [
          lane('vo', { start: 1.5, end: 9, inPoint: 2, volume: 1.4, fadeIn: 0.5, fadeInCurve: 'log' }),
          lane('music', { start: 0, end: 30, fadeOut: 3, fadeOutCurve: 'linear', ducking: { enabled: true, depth: -18 } }),
          lane('sfx', { start: 4, end: 5 }),
        ],
      ),
      lookupAll(),
    )
    expect(segOf(p, 'lane:vo')).toEqual({
      id: 'lane:vo',
      url: '/api/files?path=%2Fa%2Fvo.m4a.pcm',
      format: 'pcm_s16le',
      sampleRate: SR,
      channels: 2,
      frames: Math.round(9.5 * SR),
      tlStart: 1.5,
      tlEnd: 9,
      srcIn: 2,
      speed: 1,
      gain: 1.4,
      stage: 1,
      fadeIn: 0.5,
      curveIn: 'log',
    })
    expect(segOf(p, 'lane:music')).toMatchObject({
      tlEnd: 30,
      fadeOut: 3,
      curveOut: 'linear',
      stage: 2,
      duck: { threshold: 0.02, ratio: 8, attackMs: 300, releaseMs: 500 },
    })
    expect(segOf(p, 'lane:sfx')!.stage).toBe(3)
    expect(segOf(p, 'clip:A')!.stage).toBe(0)
    expect(segOf(p, 'lane:sfx')!.duck).toBeUndefined()
  })

  it('an unset fade curve is exp, the export\'s default', () => {
    const p = buildMixPlan(project([], [lane('m', { fadeIn: 1, fadeOut: 1 })]), lookupAll())
    expect(segOf(p, 'lane:m')).toMatchObject({ curveIn: 'exp', curveOut: 'exp' })
  })

  it('no end and no outPoint: plays to the end of its file, with no fade-out to anchor', () => {
    const p = buildMixPlan(
      project([], [lane('m', { start: 4, end: undefined, inPoint: 2, fadeOut: 2 })]),
      lookupAll({ seconds: { '/a/m.m4a': 12.5 } }),
    )
    expect(segOf(p, 'lane:m')).toMatchObject({ tlStart: 4, tlEnd: 14.5, srcIn: 2, frames: 12.5 * SR })
    expect(segOf(p, 'lane:m')!.fadeOut).toBeUndefined()
  })

  it('an outPoint short of the span with a fade-out: runs to end, and frames stop the source at the outPoint', () => {
    // Plays source 5..12 at timeline 10..17; the fade-out ends at the declared end, 20.
    const p = buildMixPlan(project([], [lane('m', { start: 10, end: 20, inPoint: 5, outPoint: 12, fadeOut: 5 })]), lookupAll())
    expect(segOf(p, 'lane:m')).toMatchObject({ tlStart: 10, tlEnd: 20, srcIn: 5, frames: 12 * SR, fadeOut: 5 })
    // Without a fade-out it simply ends where the source stops.
    const q = buildMixPlan(project([], [lane('m', { start: 10, end: 20, inPoint: 5, outPoint: 12 })]), lookupAll())
    expect(segOf(q, 'lane:m')).toMatchObject({ tlStart: 10, tlEnd: 17, frames: 12 * SR })
  })

  it('a lane whose window starts past its file has no segment', () => {
    const p = buildMixPlan(project([], [lane('m', { inPoint: 30 })]), lookupAll({ seconds: { '/a/m.m4a': 20 } }))
    expect(p.plan.segments).toEqual([])
  })
})

describe('every segment', () => {
  it('has a finite end and its conform\'s frames, never open-ended', () => {
    const p = buildMixPlan(
      project(
        [[video('A', 0, 5), video('B', 4, 9, { speed: 2 })], [video('O', 1, 3)]],
        [lane('a', { end: undefined }), lane('b', { end: undefined, outPoint: 7 }), lane('c', { end: Number.NaN }), lane('d')],
      ),
      lookupAll(),
    )
    expect(p.plan.segments).toHaveLength(7)
    for (const s of p.plan.segments) {
      expect(Number.isFinite(s.tlEnd), s.id).toBe(true)
      expect(s.tlEnd! > s.tlStart, s.id).toBe(true)
      expect(s.frames! > 0, s.id).toBe(true)
    }
  })
})

describe('ids', () => {
  it('are stable across rebuilds and edits, clips and lanes never collide, a duplicate takes a suffix', () => {
    const build = (vol: number) =>
      buildMixPlan(
        project([[video('x', 0, 5, { volume: vol }), video('x', 5, 9)]], [lane('x'), lane('y')]),
        lookupAll(),
      ).plan.segments.map((s) => s.id)
    expect(build(1)).toEqual(['clip:x', 'clip:x#2', 'lane:x', 'lane:y'])
    expect(build(0.3)).toEqual(build(1))
    expect(clipSegmentId('x')).toBe('clip:x')
    expect(laneSegmentId('x')).toBe('lane:x')
  })
})

describe('audioSourcePaths', () => {
  it('every video and lane source once, muted and skipped ones included; no images or overlays', () => {
    const p = project(
      [
        [video('A', 0, 5, { muted: true }), image('I', 5, 6), video('B', 6, 9), video('B2', 9, 12, { src: '/m/B.mp4' })],
        { id: 't1', items: [video('S', 0, 3), { id: 'X', type: 'overlay', start: 0, end: 1 }], enabled: false },
      ],
      [lane('vo', { muted: true }), lane('m'), lane('m2', { src: '/a/m.m4a' })],
    )
    expect(audioSourcePaths(p)).toEqual(['/m/A.mp4', '/m/B.mp4', '/m/S.mp4', '/a/vo.m4a', '/a/m.m4a'])
  })

  it('reads a project still in the legacy track shape', () => {
    const p = { ...project([]), tracks: [[video('A', 0, 5)]] } as unknown as EditorProject
    expect(audioSourcePaths(p)).toEqual(['/m/A.mp4'])
    expect(buildMixPlan(p, lookupAll()).plan.segments.map((s) => s.id)).toEqual(['clip:A'])
  })
})
