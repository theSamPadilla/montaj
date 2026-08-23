import { describe, it, expect } from 'vitest'
import {
  targetClips,
  sourceToTimeline,
  timelineToSource,
  mapRemovals,
  captionWordsInSourceTime,
  flagRemovals,
  loudnessGainDb,
  itemVolumeFor,
  volumeCeilingClamps,
  voiceTrackFor,
  pieceSupported,
  buildDraft,
} from '../audioPolish'
import type { PolishPlan, PolishPiece } from '../audioPolish'
import type { EditorProject as Project, VisualItem, VisualTrack } from '../../schema'

/** Object-shape visual tracks carrying the ids `normalizeTracks` hands out —
 *  same fixture helper `cuts.test.ts` uses, so expectations read the same. */
function vtracks(...items: VisualItem[][]): VisualTrack[] {
  return items.map((its, i) => ({ id: `trk-${i}`, items: its }))
}

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: vtracks([]),
    ...over,
  }
}

/** A whole-source clip: timeline == source, speed 1. */
function clip(over: Partial<VisualItem> = {}): VisualItem {
  return { id: 'a', type: 'video', src: '/f/a.mov', start: 0, end: 20, inPoint: 0, outPoint: 20, ...over }
}

// ── Scope ────────────────────────────────────────────────────────────────────

describe('targetClips', () => {
  const p = makeProject({
    tracks: vtracks(
      [
        clip({ id: 'a', start: 0, end: 5 }),
        { id: 'img', type: 'image', start: 5, end: 7 },
        clip({ id: 'b', start: 7, end: 12 }),
      ],
      [{ id: 'o', type: 'overlay', start: 1, end: 2 }],
    ),
  })

  it('returns every video clip on tracks[0] when the selection is empty', () => {
    expect(targetClips(p, []).map(c => c.id)).toEqual(['a', 'b'])
  })

  it('defaults to the whole track when no selection argument is given at all', () => {
    expect(targetClips(p).map(c => c.id)).toEqual(['a', 'b'])
  })

  it('narrows to the selection when one exists', () => {
    expect(targetClips(p, ['b']).map(c => c.id)).toEqual(['b'])
  })

  it('ignores selected ids that are not video clips on tracks[0]', () => {
    expect(targetClips(p, ['img', 'o', 'nope']).map(c => c.id)).toEqual([])
  })

  it('returns nothing for a project with no tracks', () => {
    expect(targetClips(makeProject({ tracks: [] }))).toEqual([])
  })
})

// ── Coordinate mapping ───────────────────────────────────────────────────────

describe('sourceToTimeline / timelineToSource', () => {
  it('maps through start and inPoint at speed 1', () => {
    const c = clip({ start: 10, end: 20, inPoint: 100, outPoint: 110 })
    expect(sourceToTimeline(c, 100)).toBe(10)
    expect(sourceToTimeline(c, 105)).toBe(15)
    expect(timelineToSource(c, 15)).toBe(105)
  })

  it('carries the clip speed in both directions', () => {
    // 10s of source (100→110) plays in 5 timeline seconds at S=2.
    const c = clip({ start: 10, end: 15, inPoint: 100, outPoint: 110, speed: 2 })
    expect(sourceToTimeline(c, 110)).toBe(15)
    expect(sourceToTimeline(c, 104)).toBe(12)
    expect(timelineToSource(c, 12)).toBe(104)
  })

  it('treats an absent inPoint and an absent speed as 0 and 1', () => {
    const c: VisualItem = { id: 'a', type: 'video', src: '/f/a.mov', start: 4, end: 9 }
    expect(sourceToTimeline(c, 3)).toBe(7)
    expect(timelineToSource(c, 7)).toBe(3)
  })

  it('round-trips at a fractional speed', () => {
    const c = clip({ start: 3, end: 23, inPoint: 7, outPoint: 17, speed: 0.5 })
    for (const t of [7, 9.25, 17]) expect(timelineToSource(c, sourceToTimeline(c, t))).toBeCloseTo(t, 9)
  })
})

describe('mapRemovals', () => {
  it('maps source removals onto the timeline and keeps their text', () => {
    const c = clip({ start: 10, end: 20, inPoint: 100, outPoint: 110 })
    expect(mapRemovals(c, [{ start: 102, end: 103, text: 'um' }])).toEqual([
      { start: 12, end: 13, text: 'um' },
    ])
  })

  it('carries speed into the mapping', () => {
    const c = clip({ start: 0, end: 5, inPoint: 100, outPoint: 110, speed: 2 })
    expect(mapRemovals(c, [{ start: 102, end: 106 }])).toEqual([{ start: 1, end: 3 }])
  })

  it('clips a removal straddling the clip start to the clip span', () => {
    const c = clip({ start: 10, end: 20, inPoint: 100, outPoint: 110 })
    expect(mapRemovals(c, [{ start: 95, end: 102 }])).toEqual([{ start: 10, end: 12 }])
  })

  it('clips a removal straddling the clip end to the clip span', () => {
    const c = clip({ start: 10, end: 20, inPoint: 100, outPoint: 110 })
    expect(mapRemovals(c, [{ start: 108, end: 130 }])).toEqual([{ start: 18, end: 20 }])
  })

  it('drops removals that fall entirely outside the clip', () => {
    const c = clip({ start: 10, end: 20, inPoint: 100, outPoint: 110 })
    expect(mapRemovals(c, [{ start: 80, end: 90 }, { start: 120, end: 130 }])).toEqual([])
  })

  it('drops a removal that clips down to nothing at an edge', () => {
    const c = clip({ start: 10, end: 20, inPoint: 100, outPoint: 110 })
    expect(mapRemovals(c, [{ start: 90, end: 100 }, { start: 110, end: 120 }])).toEqual([])
  })

  it('works on a clip with no inPoint', () => {
    const c: VisualItem = { id: 'a', type: 'video', src: '/f/a.mov', start: 4, end: 9 }
    expect(mapRemovals(c, [{ start: 1, end: 2 }])).toEqual([{ start: 5, end: 6 }])
  })
})

// ── Guard inputs ─────────────────────────────────────────────────────────────

describe('captionWordsInSourceTime', () => {
  const c = clip({ start: 10, end: 20, inPoint: 100, outPoint: 110 })

  it('inverse-maps the words overlapping the clip into its source time', () => {
    const p = makeProject({
      tracks: vtracks([c]),
      captions: {
        style: 'subtitle',
        segments: [
          { text: 'hello there', start: 11, end: 13, words: [
            { word: 'hello', start: 11, end: 12 },
            { word: 'there', start: 12, end: 13 },
          ] },
        ],
      },
    })
    expect(captionWordsInSourceTime(p, c)).toEqual([
      { word: 'hello', start: 101, end: 102, precision: 'word' },
      { word: 'there', start: 102, end: 103, precision: 'word' },
    ])
  })

  it('carries speed into the inverse mapping', () => {
    const fast = clip({ start: 0, end: 5, inPoint: 100, outPoint: 110, speed: 2 })
    const p = makeProject({
      tracks: vtracks([fast]),
      captions: {
        style: 'subtitle',
        segments: [{ text: 'x', start: 1, end: 3, words: [{ word: 'x', start: 1, end: 3 }] }],
      },
    })
    expect(captionWordsInSourceTime(p, fast)).toEqual([
      { word: 'x', start: 102, end: 106, precision: 'word' },
    ])
  })

  it('excludes words that do not overlap the clip span', () => {
    const p = makeProject({
      tracks: vtracks([c]),
      captions: {
        style: 'subtitle',
        segments: [
          { text: 'before', start: 1, end: 2, words: [{ word: 'before', start: 1, end: 2 }] },
          { text: 'after', start: 30, end: 31, words: [{ word: 'after', start: 30, end: 31 }] },
        ],
      },
    })
    expect(captionWordsInSourceTime(p, c)).toEqual([])
  })

  it('returns nothing when the project has no captions', () => {
    expect(captionWordsInSourceTime(makeProject({ tracks: vtracks([c]) }), c)).toEqual([])
  })

  it('falls back to the segment span for a segment carrying no word timings', () => {
    const p = makeProject({
      tracks: vtracks([c]),
      captions: { style: 'subtitle', segments: [{ text: 'no words here', start: 12, end: 14 }] },
    })
    expect(captionWordsInSourceTime(p, c)).toEqual([
      { word: 'no words here', start: 102, end: 104, precision: 'segment' },
    ])
  })

  it('marks each entry with the precision it was derived at, segment by segment', () => {
    const p = makeProject({
      tracks: vtracks([c]),
      captions: {
        style: 'subtitle',
        segments: [
          { text: 'timed', start: 11, end: 12, words: [{ word: 'timed', start: 11, end: 12 }] },
          { text: 'untimed', start: 13, end: 14 },
          // An empty `words` array is as useless as an absent one.
          { text: 'empty', start: 15, end: 16, words: [] },
        ],
      },
    })
    expect(captionWordsInSourceTime(p, c).map(w => [w.word, w.precision])).toEqual([
      ['timed', 'word'],
      ['untimed', 'segment'],
      ['empty', 'segment'],
    ])
  })
})

// ── The two guards ───────────────────────────────────────────────────────────

describe('flagRemovals', () => {
  /** A word-level caption word in source time. */
  const w = (word: string, start: number, end: number) =>
    ({ word, start, end, precision: 'word' }) as const
  /** The whole-segment fallback, for a segment with no word timings. */
  const seg = (word: string, start: number, end: number) =>
    ({ word, start, end, precision: 'segment' }) as const

  it('flags a removal overlapping a caption word', () => {
    const out = flagRemovals([{ start: 100, end: 101 }], { captionWords: [w('hi', 100.5, 101.5)] })
    expect(out[0].flagged).toBe(true)
    expect(out[0].reason).toBe('Overlaps a caption word.')
  })

  it('says the check was less precise when the hit is a whole-segment fallback', () => {
    const out = flagRemovals([{ start: 100, end: 101 }], { captionWords: [seg('hi', 100.5, 104)] })
    expect(out[0].flagged).toBe(true)
    expect(out[0].reason).toBe(
      'Overlaps a caption segment. This clip has no word timings, so the check is less precise.',
    )
  })

  it('reports the tighter word-level reason when a removal hits both kinds', () => {
    const out = flagRemovals([{ start: 100, end: 101 }], {
      captionWords: [seg('loose', 99, 104), w('tight', 100.4, 100.6)],
    })
    expect(out[0].reason).toBe('Overlaps a caption word.')
  })

  it('does not flag a removal that only touches a word edge', () => {
    const out = flagRemovals([{ start: 100, end: 101 }], { captionWords: [w('hi', 101, 102)] })
    expect(out[0]).toMatchObject({ flagged: false })
    expect(out[0].reason).toBeUndefined()
  })

  it('does not flag when no word is anywhere near', () => {
    const out = flagRemovals([{ start: 100, end: 101 }], { captionWords: [w('hi', 200, 201)] })
    expect(out[0].flagged).toBe(false)
  })

  it('flags a silence removal that overlaps a waveform_trim keep range', () => {
    const out = flagRemovals([{ start: 10, end: 12 }], { silenceKeeps: [[11, 20]] })
    expect(out[0].flagged).toBe(true)
    expect(out[0].reason).toMatch(/silence/i)
  })

  it('tolerates a hairline overlap with a keep range', () => {
    const out = flagRemovals([{ start: 10, end: 12 }], { silenceKeeps: [[11.98, 20]] })
    expect(out[0].flagged).toBe(false)
  })

  it('does not run the silence cross-check when no keeps are supplied (the filler piece)', () => {
    const out = flagRemovals([{ start: 10, end: 12 }], {})
    expect(out[0].flagged).toBe(false)
  })

  it('reports the caption reason when both guards fire', () => {
    const out = flagRemovals([{ start: 10, end: 12 }], {
      captionWords: [w('hi', 10.5, 11)],
      silenceKeeps: [[11, 20]],
    })
    expect(out[0].flagged).toBe(true)
    expect(out[0].reason).toMatch(/caption/i)
  })

  it('passes through every input field, including the filler word text', () => {
    const out = flagRemovals([{ start: 10, end: 12, text: 'um' }], {})
    expect(out[0]).toEqual({ start: 10, end: 12, text: 'um', flagged: false })
  })

  it('renders no em dash in any reason (UI copy rule)', () => {
    const reasons = [
      ...flagRemovals([{ start: 10, end: 12 }], { captionWords: [w('x', 10, 12)] }),
      ...flagRemovals([{ start: 10, end: 12 }], { captionWords: [seg('x', 10, 12)] }),
      ...flagRemovals([{ start: 10, end: 12 }], { silenceKeeps: [[10, 12]] }),
    ].map(r => r.reason ?? '')
    expect(reasons).toHaveLength(3)
    expect(reasons.every(r => r.length > 0)).toBe(true)
    for (const r of reasons) expect(r).not.toMatch(/[—–]/)
  })
})

// ── Loudness ─────────────────────────────────────────────────────────────────

describe('loudnessGainDb', () => {
  it('returns the plain level change when true peak has headroom', () => {
    // −14 target from −20 measured wants +6 dB; TP at −20 allows +18.5.
    expect(loudnessGainDb({ measuredI: -20, measuredTP: -20 }, -14)).toBeCloseTo(6, 9)
  })

  it('is held back by the true-peak ceiling when the level change would distort', () => {
    // Wants +6 dB, but TP at −3 leaves only 1.5 dB before −1.5 dBTP.
    expect(loudnessGainDb({ measuredI: -20, measuredTP: -3 }, -14)).toBeCloseTo(1.5, 9)
  })

  it('returns a negative gain when the clip is already too loud', () => {
    expect(loudnessGainDb({ measuredI: -8, measuredTP: -6 }, -14)).toBeCloseTo(-6, 9)
  })
})

describe('itemVolumeFor', () => {
  it('converts dB to a linear multiplier', () => {
    expect(itemVolumeFor(0)).toBeCloseTo(1, 9)
    expect(itemVolumeFor(6.0206)).toBeCloseTo(2, 4)
    expect(itemVolumeFor(-6.0206)).toBeCloseTo(0.5, 4)
  })

  it('divides the track gain back out so the folded result is the requested one', () => {
    // The engine multiplies item.volume by the track volume, so a 0.5 track
    // needs double the item volume to land on the same absolute level.
    expect(itemVolumeFor(0, 0.5)).toBeCloseTo(2, 9)
    expect(itemVolumeFor(-6.0206, 0.5)).toBeCloseTo(1, 4)
  })

  it('treats an absent track volume as unity', () => {
    expect(itemVolumeFor(0, undefined)).toBe(itemVolumeFor(0, 1))
  })

  it('clamps at the schema ceiling of 2.0', () => {
    expect(itemVolumeFor(20)).toBe(2)
    expect(itemVolumeFor(0, 0.1)).toBe(2)
  })

  it('never returns a negative volume', () => {
    expect(itemVolumeFor(-200)).toBeGreaterThanOrEqual(0)
  })
})

describe('volumeCeilingClamps', () => {
  it('is true exactly when the requested gain exceeds what 2.0 can deliver', () => {
    expect(volumeCeilingClamps(20)).toBe(true)
    expect(volumeCeilingClamps(0)).toBe(false)
    expect(volumeCeilingClamps(0, 0.1)).toBe(true)   // folding a quiet track pushes past 2.0
    expect(volumeCeilingClamps(0, 2)).toBe(false)
  })
})

// ── Voice isolation ──────────────────────────────────────────────────────────

describe('voiceTrackFor', () => {
  it('builds a stem track spanning the clip with a stable id', () => {
    const c = clip({ id: 'a', start: 10, end: 20, inPoint: 100, outPoint: 110 })
    expect(voiceTrackFor(c, '/f/a_stems/vocals.wav')).toEqual({
      id: 'polish_voice_a',
      type: 'voiceover',
      src: '/f/a_stems/vocals.wav',
      start: 10,
      end: 20,
      inPoint: 100,
      outPoint: 110,
      label: 'Voice: a.mov',
    })
  })

  it('renders no em dash in the track label (UI copy rule)', () => {
    // `label` is drawn in the timeline gutter (AudioTrackRow, canvas/draw), so
    // it is a user-facing string like any other.
    expect(voiceTrackFor(clip(), '/f/v.wav')!.label).not.toMatch(/[—–]/)
  })

  it('takes an explicit id, so a caller can key a fragment deterministically', () => {
    expect(voiceTrackFor(clip(), '/f/v.wav', 'polish_voice_a__2')!.id).toBe('polish_voice_a__2')
  })

  it('treats an absent inPoint as 0, matching what the clip itself plays', () => {
    const c: VisualItem = { id: 'z', type: 'video', src: '/f/z.mp4', start: 4, end: 9 }
    expect(voiceTrackFor(c, '/f/v.wav')).toMatchObject({ inPoint: 0, outPoint: 5 })
  })

  it('falls back to the clip id when the clip has no src to name', () => {
    const c: VisualItem = { id: 'z', type: 'video', start: 0, end: 1 }
    expect(voiceTrackFor(c, '/f/v.wav')!.label).toBe('Voice: z')
  })

  it('refuses a sped-up clip — audio tracks have no tempo', () => {
    expect(voiceTrackFor(clip({ speed: 2 }), '/f/v.wav')).toBeNull()
    expect(voiceTrackFor(clip({ speed: 0.5 }), '/f/v.wav')).toBeNull()
  })

  it('accepts an explicit speed of 1', () => {
    expect(voiceTrackFor(clip({ speed: 1 }), '/f/v.wav')).not.toBeNull()
  })

  it('refuses a looping clip — a stem plays its window once, the clip does not', () => {
    expect(voiceTrackFor(clip({ loop: true }), '/f/v.wav')).toBeNull()
  })

  it('refuses a clip that is both looping and sped up', () => {
    expect(voiceTrackFor(clip({ loop: true, speed: 2 }), '/f/v.wav')).toBeNull()
  })

  it('accepts an explicit loop of false', () => {
    expect(voiceTrackFor(clip({ loop: false }), '/f/v.wav')).not.toBeNull()
  })
})

// ── Piece eligibility ────────────────────────────────────────────────────────

describe('pieceSupported', () => {
  const PIECES = ['silence', 'silence-check', 'fillers', 'loudness', 'voice'] as const

  it('supports every piece on a plain clip, with no reason attached', () => {
    const c = clip()
    for (const piece of PIECES) expect(pieceSupported(c, piece)).toEqual({ available: true })
  })

  it('excludes silence, silence-check, fillers and voice on a looping clip, but not loudness', () => {
    const c = clip({ loop: true })
    expect(pieceSupported(c, 'silence').available).toBe(false)
    expect(pieceSupported(c, 'silence-check').available).toBe(false)
    expect(pieceSupported(c, 'fillers').available).toBe(false)
    expect(pieceSupported(c, 'voice').available).toBe(false)
    expect(pieceSupported(c, 'loudness')).toEqual({ available: true })
  })

  it('excludes only voice on a sped-up clip', () => {
    const c = clip({ speed: 2 })
    expect(pieceSupported(c, 'silence')).toEqual({ available: true })
    expect(pieceSupported(c, 'silence-check')).toEqual({ available: true })
    expect(pieceSupported(c, 'fillers')).toEqual({ available: true })
    expect(pieceSupported(c, 'voice').available).toBe(false)
    expect(pieceSupported(c, 'loudness')).toEqual({ available: true })
  })

  it('excludes silence, silence-check, fillers and voice on a clip that is both looping and sped up', () => {
    const c = clip({ loop: true, speed: 2 })
    expect(pieceSupported(c, 'silence').available).toBe(false)
    expect(pieceSupported(c, 'silence-check').available).toBe(false)
    expect(pieceSupported(c, 'fillers').available).toBe(false)
    expect(pieceSupported(c, 'voice').available).toBe(false)
    expect(pieceSupported(c, 'loudness')).toEqual({ available: true })
  })

  // ── Reasons: rendered verbatim, so the exact text is pinned ──
  it('gives the exact voice-speed reason on a sped-up clip', () => {
    expect(pieceSupported(clip({ speed: 2 }), 'voice')).toEqual({
      available: false,
      reason: 'Voice isolation unavailable: this clip does not play at normal speed',
    })
  })

  // The rule refuses ANY non-1x speed, not just speeding up, so the reason
  // must not claim a direction. This is the mirror of the case above: a
  // slowed-down clip gets the exact same reason, not a "slowed down" variant.
  it('gives the exact voice-speed reason on a slowed-down clip too', () => {
    expect(pieceSupported(clip({ speed: 0.5 }), 'voice')).toEqual({
      available: false,
      reason: 'Voice isolation unavailable: this clip does not play at normal speed',
    })
  })

  it('gives the exact voice-loop reason', () => {
    expect(pieceSupported(clip({ loop: true }), 'voice')).toEqual({
      available: false,
      reason: 'Voice isolation unavailable: this clip loops, so the isolated audio would drift out of sync',
    })
  })

  it('gives the exact silence-loop reason, and the same one for silence-check', () => {
    const c = clip({ loop: true })
    const expected = {
      available: false,
      reason: 'Silence removal unavailable: this clip loops, so cuts would land in the wrong place',
    }
    expect(pieceSupported(c, 'silence')).toEqual(expected)
    expect(pieceSupported(c, 'silence-check')).toEqual(expected)
  })

  it('gives the exact fillers-loop reason', () => {
    expect(pieceSupported(clip({ loop: true }), 'fillers')).toEqual({
      available: false,
      reason: 'Filler removal unavailable: this clip loops, so cuts would land in the wrong place',
    })
  })

  it('renders no em dash in any reason (UI copy rule)', () => {
    const cases: Array<[VisualItem, PolishPiece]> = [
      [clip({ speed: 2 }), 'voice'],
      [clip({ loop: true }), 'voice'],
      [clip({ loop: true }), 'silence'],
      [clip({ loop: true }), 'silence-check'],
      [clip({ loop: true }), 'fillers'],
    ]
    for (const [c, piece] of cases) {
      const { reason } = pieceSupported(c, piece)
      expect(reason).toBeDefined()
      expect(reason).not.toMatch(/[—–]/)
    }
  })

  // ── Precedence: a clip that is both looping and sped up ──
  //
  // `loop` wins voice's reason over `speed`, decided on the merits (see the
  // doc comment on `pieceSupported`): `loop` alone already excludes silence,
  // fillers AND voice on this clip, so it is the one explanation that
  // actually accounts for everything unavailable here, and the one thing
  // that has to change before voice can come back regardless of speed.
  it('reports the loop reason for voice, not the speed reason, when a clip is both', () => {
    const c = clip({ loop: true, speed: 2 })
    expect(pieceSupported(c, 'voice')).toEqual({
      available: false,
      reason: 'Voice isolation unavailable: this clip loops, so the isolated audio would drift out of sync',
    })
  })
})

// ── buildDraft ───────────────────────────────────────────────────────────────

/** The source frame playing at timeline time `t`, or null when `t` is in a gap.
 *  This is what "the caption still describes the same footage" means. */
function sourceUnder(p: Project, t: number): { src?: string; source: number } | null {
  const items = p.tracks![0].items
  const it = items.find(i => t >= i.start - 1e-9 && t < i.end - 1e-9)
  if (!it) return null
  return { src: it.src, source: (t - it.start) * (it.speed ?? 1) + (it.inPoint ?? 0) }
}

const mid = (s: { start: number; end: number }) => (s.start + s.end) / 2

describe('buildDraft', () => {
  it('returns the baseline untouched for an empty plan', () => {
    const p = makeProject({ tracks: vtracks([clip()]) })
    expect(buildDraft(p, { clips: {} })).toBe(p)
  })

  it('ignores plan entries naming a clip that is not on the primary track', () => {
    const p = makeProject({ tracks: vtracks([clip()]) })
    expect(buildDraft(p, { clips: { ghost: { removals: [{ start: 1, end: 2 }] } } })).toBe(p)
  })

  // ── Assertion 1: the worked example ──
  it('lands the worked example caption at [6,8], NOT [5,7]', () => {
    const p = makeProject({
      tracks: vtracks([clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })]),
      captions: {
        style: 'subtitle',
        segments: [{ text: 'cap', start: 7, end: 9, words: [{ word: 'cap', start: 7, end: 9 }] }],
      },
    })
    const plan: PolishPlan = {
      clips: { a: { removals: [{ start: 5, end: 6 }, { start: 11, end: 12 }] } },
    }
    const out = buildDraft(p, plan)
    const cap = out.captions!.segments[0]
    expect(cap).toMatchObject({ start: 6, end: 8 })
    expect(cap.words![0]).toMatchObject({ start: 6, end: 8 })
    // and the clip gaps ARE closed: 20s of source minus 2s of cuts = 18s.
    const items = out.tracks![0].items
    expect(items.map(i => [i.start, i.end])).toEqual([[0, 5], [5, 10], [10, 18]])
  })

  // ── Assertion 2: captions still describe the footage under them ──
  it('leaves every surviving caption over the same source footage it described', () => {
    const p = makeProject({
      tracks: vtracks([
        clip({ id: 'a', src: '/f/a.mov', start: 0, end: 20, inPoint: 0, outPoint: 20 }),
        clip({ id: 'b', src: '/f/b.mov', start: 20, end: 40, inPoint: 100, outPoint: 120 }),
      ]),
      captions: {
        style: 'subtitle',
        segments: [
          { text: 'a1', start: 1, end: 3 },
          { text: 'a2', start: 7, end: 9 },
          { text: 'a3', start: 14, end: 16 },
          { text: 'b1', start: 21, end: 23 },
          { text: 'b2', start: 30, end: 32 },
          { text: 'b3', start: 37, end: 39 },
        ],
      },
    })
    const plan: PolishPlan = {
      clips: {
        a: { removals: [{ start: 5, end: 6 }, { start: 11, end: 12 }] },
        b: { removals: [{ start: 104, end: 105 }, { start: 115, end: 116 }] },
      },
    }
    const before = Object.fromEntries(
      p.captions!.segments.map(s => [s.text, sourceUnder(p, mid(s))]),
    )
    const out = buildDraft(p, plan)

    expect(out.captions!.segments).toHaveLength(6)   // none of them sat in a cut
    for (const seg of out.captions!.segments) {
      expect(sourceUnder(out, mid(seg))).toEqual(before[seg.text])
    }
  })

  it('pools removals across clips and applies them descending', () => {
    // Two clips, one removal each, and a caption sitting INSIDE the later
    // removal. Back to front, that caption is deleted by its own cut and `tail`
    // ends up 4s earlier. Front to back, the first cut drags the doomed caption
    // clear of the second cut so it wrongly survives, and `tail` gets swept into
    // the second cut and deleted instead. The two orders disagree about which
    // caption exists, not merely about where it sits.
    const p = makeProject({
      tracks: vtracks([
        clip({ id: 'a', start: 0, end: 10, inPoint: 0, outPoint: 10 }),
        clip({ id: 'b', src: '/f/b.mov', start: 10, end: 20, inPoint: 0, outPoint: 10 }),
      ]),
      captions: {
        style: 'subtitle',
        segments: [
          { text: 'inside-b-cut', start: 15.5, end: 16.5 },
          { text: 'tail', start: 18, end: 19 },
        ],
      },
    })
    const out = buildDraft(p, {
      clips: { a: { removals: [{ start: 2, end: 4 }] }, b: { removals: [{ start: 5, end: 7 }] } },
    })
    expect(out.captions!.segments.map(s => s.text)).toEqual(['tail'])
    // 2s removed from a and 2s from b, both before `tail` ⇒ exactly 4s left.
    expect(out.captions!.segments[0]).toMatchObject({ start: 14, end: 15 })
  })

  it('merges overlapping pooled removals so captions are not shifted twice', () => {
    const p = makeProject({
      tracks: vtracks([clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })]),
      captions: { style: 'subtitle', segments: [{ text: 'tail', start: 15, end: 16 }] },
    })
    // Two removals overlapping by 1s. Their UNION is [9,12], so exactly 3s of
    // material goes and the caption must land 3s earlier, at [12,13]. Applying
    // them as two separate cuts gets the CLIPS right (they lift) but ripples the
    // captions by the SUM of the two durations, 4s, putting the caption at
    // [11,12] — a drift of exactly the overlap, and the same bug class this
    // whole task exists to kill, one level down.
    const out = buildDraft(p, {
      clips: { a: { removals: [{ start: 9, end: 11 }, { start: 10, end: 12 }] } },
    })
    expect(out.captions!.segments[0]).toMatchObject({ start: 12, end: 13 })
    expect(out.captions!.segments[0]).not.toMatchObject({ start: 11, end: 12 })
    expect(out.tracks![0].items.map(i => [i.start, i.end])).toEqual([[0, 9], [9, 17]])
  })

  it('deletes a caption that sat entirely inside a removal', () => {
    const p = makeProject({
      tracks: vtracks([clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })]),
      captions: {
        style: 'subtitle',
        segments: [{ text: 'gone', start: 5.2, end: 5.8 }, { text: 'kept', start: 10, end: 11 }],
      },
    })
    const out = buildDraft(p, { clips: { a: { removals: [{ start: 5, end: 6 }] } } })
    expect(out.captions!.segments.map(s => s.text)).toEqual(['kept'])
  })

  it('maps removals through a sped clip before cutting', () => {
    // S=2: source 102→106 is 2 timeline seconds at 1→3.
    const p = makeProject({
      tracks: vtracks([clip({ id: 'a', start: 0, end: 5, inPoint: 100, outPoint: 110, speed: 2 })]),
    })
    const out = buildDraft(p, { clips: { a: { removals: [{ start: 102, end: 106 }] } } })
    const items = out.tracks![0].items
    expect(items.map(i => [i.start, i.end])).toEqual([[0, 1], [1, 3]])
    expect(items[0]).toMatchObject({ inPoint: 100, outPoint: 102 })
    expect(items[1]).toMatchObject({ inPoint: 106, outPoint: 110 })
  })

  it('does not close pre-existing gaps when the plan makes no cuts', () => {
    const p = makeProject({
      tracks: vtracks([
        clip({ id: 'a', start: 0, end: 5, inPoint: 0, outPoint: 5 }),
        clip({ id: 'b', start: 8, end: 12, inPoint: 0, outPoint: 4 }),
      ]),
    })
    const out = buildDraft(p, { clips: { a: { gainDb: 0 }, b: { gainDb: 0 } } })
    expect(out.tracks![0].items.map(i => [i.start, i.end])).toEqual([[0, 5], [8, 12]])
  })

  // ── Loudness ──
  it('assigns item.volume from the gain, folding in the track volume', () => {
    const p = makeProject({
      tracks: [{ id: 'base', volume: 0.5, items: [clip({ id: 'a' }), clip({ id: 'b', start: 20, end: 30 })] }],
    })
    const out = buildDraft(p, { clips: { a: { gainDb: -6.0206 } } })
    expect(out.tracks![0].items[0].volume).toBeCloseTo(1, 4)
    expect(out.tracks![0].items[1].volume).toBeUndefined()   // not in the plan
  })

  it('ASSIGNS the volume rather than multiplying it, so a re-run converges', () => {
    const p = makeProject({ tracks: vtracks([clip({ id: 'a', volume: 1.7 })]) })
    const once = buildDraft(p, { clips: { a: { gainDb: 0 } } })
    const twice = buildDraft(once, { clips: { a: { gainDb: 0 } } })
    expect(once.tracks![0].items[0].volume).toBeCloseTo(1, 9)
    expect(twice.tracks![0].items[0].volume).toBeCloseTo(1, 9)
  })

  it('carries the gain onto every fragment a cut split the clip into', () => {
    const p = makeProject({ tracks: vtracks([clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })]) })
    const out = buildDraft(p, { clips: { a: { removals: [{ start: 5, end: 6 }], gainDb: 0 } } })
    const items = out.tracks![0].items
    expect(items).toHaveLength(2)
    for (const i of items) expect(i.volume).toBeCloseTo(1, 9)
  })

  // ── Voice isolation ──
  it('adds a stem track for the clip and mutes the clip', () => {
    const p = makeProject({ tracks: vtracks([clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })]) })
    const out = buildDraft(p, { clips: { a: { vocalsPath: '/f/a_stems/vocals.wav' } } })
    expect(out.audio!.tracks).toEqual([
      {
        id: 'polish_voice_a',
        type: 'voiceover',
        src: '/f/a_stems/vocals.wav',
        start: 0,
        end: 20,
        inPoint: 0,
        outPoint: 20,
        label: 'Voice: a.mov',
      },
    ])
    expect(out.tracks![0].items[0].muted).toBe(true)
  })

  it('builds the stem track against the POST-cut geometry, one per surviving fragment', () => {
    const p = makeProject({ tracks: vtracks([clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })]) })
    const out = buildDraft(p, {
      clips: { a: { removals: [{ start: 5, end: 6 }], vocalsPath: '/f/v.wav' } },
    })
    const items = out.tracks![0].items
    expect(items.map(i => [i.start, i.end])).toEqual([[0, 5], [5, 19]])
    // Both fragments are muted and both are covered by a stem slice whose
    // source window matches the picture under it.
    expect(items.every(i => i.muted === true)).toBe(true)
    const stems = out.audio!.tracks
    expect(stems).toHaveLength(2)
    expect(stems.map(t => [t.start, t.end, t.inPoint, t.outPoint])).toEqual([
      [0, 5, 0, 5],
      [5, 19, 6, 20],
    ])
    expect(stems.every(t => t.src === '/f/v.wav')).toBe(true)
    // Ids are derived from the BASELINE clip and the fragment's timeline
    // position, never from the fragment's own `Date.now()`-derived id.
    expect(stems.map(t => t.id)).toEqual(['polish_voice_a', 'polish_voice_a__2'])
  })

  it('mints identical fragment stem ids on a rebuild, even though the split ids differ', () => {
    const p = makeProject({ tracks: vtracks([clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })]) })
    const plan: PolishPlan = {
      clips: { a: { removals: [{ start: 5, end: 6 }, { start: 12, end: 13 }], vocalsPath: '/f/v.wav' } },
    }
    const first = buildDraft(p, plan)
    const second = buildDraft(p, plan)
    // The clip fragments themselves get fresh random ids each rebuild...
    expect(first.tracks![0].items.map(i => i.id)).not.toEqual(second.tracks![0].items.map(i => i.id))
    // ...but the stem tracks, which must REPLACE rather than duplicate on a
    // re-run, are byte-identical.
    expect(first.audio).toEqual(second.audio)
    expect(first.audio!.tracks.map(t => t.id)).toEqual([
      'polish_voice_a', 'polish_voice_a__2', 'polish_voice_a__3',
    ])
  })

  it('never leaves a fragment muted without a stem track under it', () => {
    const p = makeProject({
      tracks: vtracks([
        clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 }),
        clip({ id: 'fast', src: '/f/f.mov', start: 20, end: 25, inPoint: 0, outPoint: 10, speed: 2 }),
      ]),
    })
    const out = buildDraft(p, {
      clips: {
        a: { removals: [{ start: 5, end: 6 }], vocalsPath: '/f/a.wav' },
        fast: { vocalsPath: '/f/f.wav' },
      },
    })
    const muted = out.tracks![0].items.filter(i => i.muted)
    const stemSpans = out.audio!.tracks.map(t => `${t.start}-${t.end}`)
    expect(muted).toHaveLength(2)                       // the sped clip is NOT muted
    for (const i of muted) expect(stemSpans).toContain(`${i.start}-${i.end}`)
  })

  it('drops a stale higher-ordinal stem when a re-run leaves fewer fragments', () => {
    // The previous run split `a` in two and left both stems behind. This run
    // makes no cut, so only `polish_voice_a` is minted and `__2` must not
    // survive as an orphan pointing at footage that no longer exists.
    const base = makeProject({
      tracks: vtracks([clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })]),
      audio: { tracks: [
        { id: 'music', src: '/f/bed.mp3', start: 0, end: 20 },
        { id: 'polish_voice_a', type: 'voiceover', src: '/f/v.wav', start: 0, end: 5 },
        { id: 'polish_voice_a__2', type: 'voiceover', src: '/f/v.wav', start: 5, end: 19 },
      ] },
    })
    const out = buildDraft(base, { clips: { a: { vocalsPath: '/f/v.wav' } } })
    expect(out.audio!.tracks.map(t => t.id)).toEqual(['music', 'polish_voice_a'])
  })

  it('leaves stems belonging to clips outside the plan alone', () => {
    const base = makeProject({
      tracks: vtracks([
        clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 }),
        clip({ id: 'b', src: '/f/b.mov', start: 20, end: 30, inPoint: 0, outPoint: 10 }),
      ]),
      audio: { tracks: [
        { id: 'polish_voice_b', type: 'voiceover', src: '/f/b.wav', start: 20, end: 30 },
        { id: 'polish_voice_b__2', type: 'voiceover', src: '/f/b.wav', start: 30, end: 32 },
      ] },
    })
    const out = buildDraft(base, { clips: { a: { vocalsPath: '/f/a.wav' } } })
    expect(out.audio!.tracks.map(t => t.id)).toEqual([
      'polish_voice_b', 'polish_voice_b__2', 'polish_voice_a',
    ])
  })

  it('replaces an existing stem track rather than duplicating it', () => {
    const base = makeProject({
      tracks: vtracks([clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })]),
      audio: { tracks: [
        { id: 'music', src: '/f/bed.mp3', start: 0, end: 20 },
        { id: 'polish_voice_a', type: 'voiceover', src: '/f/OLD.wav', start: 0, end: 20 },
      ] },
    })
    const out = buildDraft(base, { clips: { a: { vocalsPath: '/f/NEW.wav' } } })
    expect(out.audio!.tracks.map(t => t.id)).toEqual(['music', 'polish_voice_a'])
    expect(out.audio!.tracks.find(t => t.id === 'polish_voice_a')!.src).toBe('/f/NEW.wav')
  })

  it('leaves the music bed exactly where it is (cuts never ripple audio tracks)', () => {
    const bed = { id: 'music', src: '/f/bed.mp3', start: 0, end: 40 }
    const p = makeProject({
      tracks: vtracks([clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })]),
      audio: { tracks: [bed] },
    })
    const out = buildDraft(p, { clips: { a: { removals: [{ start: 5, end: 6 }] } } })
    expect(out.audio!.tracks).toEqual([bed])
  })

  it('skips voice isolation on a sped clip and leaves it unmuted', () => {
    const p = makeProject({
      tracks: vtracks([clip({ id: 'a', start: 0, end: 5, inPoint: 100, outPoint: 110, speed: 2 })]),
    })
    const out = buildDraft(p, { clips: { a: { vocalsPath: '/f/v.wav', gainDb: 0 } } })
    expect(out.audio).toBeUndefined()
    expect(out.tracks![0].items[0].muted).toBeUndefined()
    expect(out.tracks![0].items[0].volume).toBeCloseTo(1, 9)   // the other pieces still apply
  })

  // ── Looping clips ──
  //
  // A looping clip replays its `[inPoint, outPoint)` source window repeatedly
  // across the whole clip span, so `sourceToTimeline` no longer picks out one
  // correct timeline position for a source-time removal. See the LOOPING
  // CLIPS note at the top of `audioPolish.ts`.
  describe('excludes looping clips from cuts and voice, but not loudness', () => {
    /** A clip that loops a 5s source window across a 20s timeline span. */
    const loopingClip = (over: Partial<VisualItem> = {}) =>
      clip({ loop: true, start: 0, end: 20, inPoint: 0, outPoint: 5, ...over })

    it('drops silence/filler removals for a looping clip: buildDraft is a no-op', () => {
      const p = makeProject({ tracks: vtracks([loopingClip({ id: 'a' })]) })
      const out = buildDraft(p, { clips: { a: { removals: [{ start: 1, end: 2 }] } } })
      // No other piece was requested either, so the whole draft collapses back
      // to the untouched baseline — the strongest statement that the removal
      // never reached a cut.
      expect(out).toBe(p)
    })

    it('mints no stem and does not mute a looping clip', () => {
      const p = makeProject({ tracks: vtracks([loopingClip({ id: 'a' })]) })
      const out = buildDraft(p, { clips: { a: { vocalsPath: '/f/v.wav' } } })
      expect(out.audio).toBeUndefined()
      expect(out.tracks![0].items[0].muted).toBeUndefined()
    })

    it('still applies loudness to a looping clip: the one exempt piece', () => {
      const p = makeProject({ tracks: vtracks([loopingClip({ id: 'a' })]) })
      const out = buildDraft(p, { clips: { a: { gainDb: -6.0206 } } })
      expect(out.tracks![0].items[0].volume).toBeCloseTo(0.5, 4)
    })

    it('applies loudness while dropping the removal and the stem, all in one draft', () => {
      const p = makeProject({ tracks: vtracks([loopingClip({ id: 'a' })]) })
      const out = buildDraft(p, {
        clips: { a: { removals: [{ start: 1, end: 2 }], gainDb: 0, vocalsPath: '/f/v.wav' } },
      })
      expect(out.tracks![0].items).toHaveLength(1)                // no cut happened
      expect(out.tracks![0].items[0]).toMatchObject({ start: 0, end: 20 })
      expect(out.tracks![0].items[0].volume).toBeCloseTo(1, 9)    // loudness still applied
      expect(out.tracks![0].items[0].muted).toBeUndefined()       // voice still skipped
      expect(out.audio).toBeUndefined()
    })

    it('is per-clip: a looping clip is excluded but a normal clip in the same plan still gets cut', () => {
      const p = makeProject({
        tracks: vtracks([
          loopingClip({ id: 'a' }),
          clip({ id: 'b', src: '/f/b.mov', start: 20, end: 40, inPoint: 0, outPoint: 20 }),
        ]),
      })
      const out = buildDraft(p, {
        clips: {
          a: { removals: [{ start: 1, end: 2 }] },
          b: { removals: [{ start: 5, end: 6 }] },
        },
      })
      const items = out.tracks![0].items
      // 'a' is untouched by its own (dropped) removal: still one whole fragment.
      const aFragments = items.filter(i => i.id === 'a' || i.id.startsWith('a_split_'))
      expect(aFragments).toEqual([expect.objectContaining({ id: 'a', start: 0, end: 20 })])
      // 'b' got its cut: split into two fragments totalling 19s (20 minus the
      // 1s removed), so the exclusion did not leak across clips.
      const bFragments = items.filter(i => i.id === 'b' || i.id.startsWith('b_split_'))
      expect(bFragments).toHaveLength(2)
      const bTotal = bFragments.reduce((s, i) => s + (i.end - i.start), 0)
      expect(bTotal).toBeCloseTo(19, 9)
    })
  })

  // ── Order and idempotence ──
  it('applies the pieces in order: cuts, gap close, loudness, voice', () => {
    // A 6s removal out of the middle. If the stem were minted before the cuts
    // it would span the whole [0,20]; if before the gap close, the tail slice
    // would sit at its pre-collapse [8,20] instead of [2,14].
    const p = makeProject({
      tracks: vtracks([clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })]),
    })
    const out = buildDraft(p, {
      clips: { a: { removals: [{ start: 2, end: 8 }], gainDb: 0, vocalsPath: '/f/v.wav' } },
    })
    expect(out.tracks![0].items.map(i => [i.start, i.end])).toEqual([[0, 2], [2, 14]])
    expect(out.audio!.tracks.map(t => [t.start, t.end, t.inPoint, t.outPoint])).toEqual([
      [0, 2, 0, 2],
      [2, 14, 8, 20],
    ])
  })

  // ── The leading gap ──
  //
  // `collapseGaps` compacts from `sorted[0].start`, so it cannot close a gap at
  // the HEAD of the timeline. Left alone, a removal at the start of the first
  // clip gives the operator black frames there and — because
  // `applyCutToCaptions` has already rippled the captions past that cut —
  // leaves every caption adrift from its footage by the width of the gap.
  // `closeLeadGap` removes exactly the offset the polish introduced.
  describe('closes the leading gap it opened', () => {
    it('moves clips, overlays and audio up, and leaves no gap at the head', () => {
      const p = makeProject({
        tracks: vtracks(
          [clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })],
          [{ id: 'o', type: 'overlay', start: 10, end: 12 }],
        ),
        audio: { tracks: [{ id: 'bed', src: '/f/bed.mp3', start: 8, end: 20 }] },
      })
      const out = buildDraft(p, { clips: { a: { removals: [{ start: 0, end: 6 }] } } })

      expect(out.tracks![0].items.map(i => [i.start, i.end])).toEqual([[0, 14]])
      expect(out.tracks![0].items[0].inPoint).toBe(6)          // source window unchanged
      expect(out.tracks![1].items[0]).toMatchObject({ id: 'o', start: 4, end: 6 })
      expect(out.audio!.tracks[0]).toMatchObject({ id: 'bed', start: 2, end: 14 })
      // The overlay still sits over the same source frames: timeline 4 on a
      // clip starting at 0 with inPoint 6 is source 10, where it began.
      expect(sourceUnder(out, 4)).toEqual({ src: '/f/a.mov', source: 10 })
    })

    // THE MINIMAL REPRODUCTION. One clip, one head cut, one caption after it —
    // the smallest case that shows the whole mechanism, and the first thing to
    // read when this behaviour is ever in question. Step by step:
    //
    //   baseline    clip [0,20] inPoint 0        caption [8,10] over source 8-10
    //   cut [0,6]   clip [6,20] inPoint 6        caption [2,4]   (rippled 6s)
    //   collapse    unchanged — one clip, so it returns early, and it compacts
    //               from sorted[0].start anyway, so it can never close a head gap
    //   lead close  clip [0,14] inPoint 6        caption [2,4]   (NOT moved)
    //
    // The caption's midpoint 3 maps through inPoint 6 to source 9, exactly where
    // it started. Move the caption as well and it lands at [-4,-2].
    //
    // This is "captions must be shifted exactly once" one level up. The delta is
    // what the CLIPS still owe: the cuts already rippled the captions, the clips
    // lifted and stayed put, and this closes the difference.
    it('case A, the minimal repro: clips catch up to the captions, which do not move', () => {
      const p = makeProject({
        tracks: vtracks([clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })]),
        captions: {
          style: 'subtitle',
          segments: [{ text: 'cap', start: 8, end: 10, words: [{ word: 'cap', start: 8, end: 10 }] }],
        },
      })
      const before = sourceUnder(p, mid(p.captions!.segments[0]))
      expect(before).toEqual({ src: '/f/a.mov', source: 9 })

      const out = buildDraft(p, { clips: { a: { removals: [{ start: 0, end: 6 }] } } })

      expect(out.tracks![0].items.map(i => [i.start, i.end])).toEqual([[0, 14]])
      expect(out.tracks![0].items[0].inPoint).toBe(6)
      const cap = out.captions!.segments[0]
      expect(cap).toMatchObject({ start: 2, end: 4 })
      expect(cap.words![0]).toMatchObject({ start: 2, end: 4 })
      expect(sourceUnder(out, mid(cap))).toEqual(before)
    })

    // The Σ counts only cuts with `cut.start < leadAfter`. If it swept in the
    // interior cut too the delta would be 8 rather than 6, and the first clip
    // would land at -2: a negative start, from a rule whose whole job is to
    // remove exactly the offset the polish introduced at the head.
    it('counts the head cut but not an interior cut on the same clip', () => {
      const p = makeProject({
        tracks: vtracks([clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })]),
        captions: {
          style: 'subtitle',
          segments: [
            { text: 'early', start: 8, end: 9 },
            { text: 'late', start: 15, end: 16 },
          ],
        },
      })
      const before = p.captions!.segments.map(s => sourceUnder(p, mid(s)))
      const out = buildDraft(p, {
        clips: { a: { removals: [{ start: 0, end: 6 }, { start: 10, end: 12 }] } },
      })

      // 6s off the head and 2s from the middle: two fragments, head at 0.
      expect(out.tracks![0].items.map(i => [i.start, i.end])).toEqual([[0, 4], [4, 12]])
      expect(out.tracks![0].items.map(i => i.inPoint)).toEqual([6, 12])
      expect(out.captions!.segments.map(s => [s.start, s.end])).toEqual([[2, 3], [7, 8]])
      expect(out.captions!.segments.map(s => sourceUnder(out, mid(s)))).toEqual(before)
    })

    it('preserves a leading offset the operator placed deliberately', () => {
      const p = makeProject({
        tracks: vtracks([clip({ id: 'a', start: 3, end: 20, inPoint: 0, outPoint: 17 })]),
      })
      // Source 0 to 2 is timeline 3 to 5 — the head of the clip, not of the
      // timeline. Only those 2s go; the deliberate 3s offset stays.
      const out = buildDraft(p, { clips: { a: { removals: [{ start: 0, end: 2 }] } } })
      expect(out.tracks![0].items.map(i => [i.start, i.end])).toEqual([[3, 18]])
      expect(out.tracks![0].items[0].inPoint).toBe(2)
    })

    it('does not fire at all when no removal touches the head', () => {
      const p = makeProject({
        tracks: vtracks([clip({ id: 'a', start: 3, end: 20, inPoint: 0, outPoint: 17 })]),
        audio: { tracks: [{ id: 'bed', src: '/f/bed.mp3', start: 0, end: 30 }] },
      })
      const out = buildDraft(p, { clips: { a: { removals: [{ start: 4, end: 5 }] } } })
      // Interior cut only: the 3s head offset survives untouched, and the bed,
      // which `collapseGaps` deliberately never moves, is left alone too.
      expect(out.tracks![0].items.map(i => [i.start, i.end])).toEqual([[3, 7], [7, 19]])
      expect(out.audio!.tracks[0]).toMatchObject({ start: 0, end: 30 })
    })

    // ── The first clip emptied entirely ──

    it('pulls the next clip up when the emptied first clip butted against it', () => {
      const p = makeProject({
        tracks: vtracks([
          clip({ id: 'a', start: 0, end: 10, inPoint: 0, outPoint: 10 }),
          clip({ id: 'b', src: '/f/b.mov', start: 10, end: 20, inPoint: 0, outPoint: 10 }),
        ]),
        captions: { style: 'subtitle', segments: [{ text: 'b-cap', start: 12, end: 14 }] },
      })
      const before = sourceUnder(p, 13)
      const out = buildDraft(p, { clips: { a: { removals: [{ start: 0, end: 10 }] } } })

      expect(out.tracks![0].items.map(i => [i.start, i.end])).toEqual([[0, 10]])
      expect(out.captions!.segments[0]).toMatchObject({ start: 2, end: 4 })
      expect(sourceUnder(out, mid(out.captions!.segments[0]))).toEqual(before)
    })

    // The case that separates "cut material in the head" from the positional
    // `leadAfter - leadBefore`. Here they differ by the 10s gap that sat after
    // the emptied clip: the positional delta would swallow it, overshoot the
    // captions by 10s, and land `b-cap` on clip C instead of clip B.
    it('counts only cut material when a gap followed the emptied first clip', () => {
      const p = makeProject({
        tracks: vtracks([
          clip({ id: 'a', start: 0, end: 10, inPoint: 0, outPoint: 10 }),
          clip({ id: 'b', src: '/f/b.mov', start: 20, end: 30, inPoint: 0, outPoint: 10 }),
          clip({ id: 'c', src: '/f/c.mov', start: 35, end: 40, inPoint: 0, outPoint: 5 }),
        ]),
        captions: { style: 'subtitle', segments: [{ text: 'b-cap', start: 22, end: 24 }] },
      })
      const before = sourceUnder(p, 23)
      expect(before).toEqual({ src: '/f/b.mov', source: 3 })

      const out = buildDraft(p, { clips: { a: { removals: [{ start: 0, end: 10 }] } } })

      // 10s of cut material removed, so everything moves 10s. The operator's
      // own 10s gap survives as the new head offset rather than being eaten.
      expect(out.tracks![0].items.map(i => [i.start, i.end])).toEqual([[10, 20], [20, 25]])
      expect(sourceUnder(out, mid(out.captions!.segments[0]))).toEqual(before)
    })

    it('is a no-op when the plan empties every clip on the primary track', () => {
      const p = makeProject({
        tracks: vtracks(
          [clip({ id: 'a', start: 0, end: 10, inPoint: 0, outPoint: 10 })],
          [{ id: 'o', type: 'overlay', start: 20, end: 22 }],
        ),
        // Placed AFTER the removed region on purpose: without the
        // no-survivors guard this bed is dragged 10s earlier even though no
        // picture is left to stay in sync with. (`Math.min()` of no clips is
        // Infinity, which the `min(cut.end, leadAfter)` clamp quietly tames
        // into a finite delta, so the failure is a silent wrong answer rather
        // than an obvious one.)
        audio: { tracks: [{ id: 'bed', src: '/f/bed.mp3', start: 20, end: 30 }] },
      })
      const out = buildDraft(p, { clips: { a: { removals: [{ start: 0, end: 10 }] } } })
      expect(out.tracks![0].items).toEqual([])
      expect(out.tracks![1].items[0]).toMatchObject({ start: 20, end: 22 })
      expect(out.audio!.tracks[0]).toMatchObject({ start: 20, end: 30 })
    })

    // ── Nothing is ever pushed before time 0 ──

    it('head-trims an audio track that would go negative, keeping it in sync', () => {
      const p = makeProject({
        tracks: vtracks([clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })]),
        audio: { tracks: [{ id: 'bed', src: '/f/bed.mp3', start: 0, end: 20, inPoint: 0, outPoint: 20 }] },
      })
      const out = buildDraft(p, { clips: { a: { removals: [{ start: 0, end: 6 }] } } })
      // Source 6 of the bed now plays at timeline 0, exactly where the clip's
      // own source 6 does: the bed loses its head instead of its sync.
      expect(out.audio!.tracks[0]).toMatchObject({ start: 0, end: 14, inPoint: 6, outPoint: 20 })
      expect(out.tracks![0].items[0]).toMatchObject({ start: 0, end: 14, inPoint: 6 })
    })

    it('leaves content that sat entirely inside the removed head where it is', () => {
      const p = makeProject({
        tracks: vtracks(
          [clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })],
          [{ id: 'o', type: 'overlay', start: 0, end: 2 }],
        ),
        audio: { tracks: [{ id: 'sting', src: '/f/sting.mp3', start: 0, end: 3 }] },
      })
      const out = buildDraft(p, { clips: { a: { removals: [{ start: 0, end: 6 }] } } })
      // Neither has anything left to trim to, and a negative start is not
      // representable downstream, so both stay put rather than being deleted.
      expect(out.tracks![1].items[0]).toMatchObject({ id: 'o', start: 0, end: 2 })
      expect(out.audio!.tracks[0]).toMatchObject({ id: 'sting', start: 0, end: 3 })
    })
  })

  it('is idempotent: two drafts from the same baseline are deep-equal', () => {
    const p = makeProject({
      tracks: [{ id: 'base', volume: 0.8, items: [
        clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 }),
        clip({ id: 'b', src: '/f/b.mov', start: 20, end: 40, inPoint: 0, outPoint: 20 }),
      ] }],
      captions: {
        style: 'subtitle',
        segments: [{ text: 'one', start: 2, end: 3 }, { text: 'two', start: 25, end: 26 }],
      },
      audio: { tracks: [{ id: 'music', src: '/f/bed.mp3', start: 0, end: 40 }] },
    })
    // Edge trims only, so `cuts.ts` mints no `Date.now()`-derived split ids and
    // the two drafts are comparable field for field.
    const plan: PolishPlan = {
      clips: {
        a: { removals: [{ start: 18, end: 20 }], gainDb: -3, vocalsPath: '/f/a.wav' },
        b: { removals: [{ start: 0, end: 1 }], gainDb: 2, vocalsPath: '/f/b.wav' },
      },
    }
    expect(buildDraft(p, plan)).toEqual(buildDraft(p, plan))
  })

  it('never mutates the baseline it was handed', () => {
    const p = makeProject({
      tracks: vtracks([clip({ id: 'a', start: 0, end: 20, inPoint: 0, outPoint: 20 })]),
      captions: { style: 'subtitle', segments: [{ text: 'cap', start: 8, end: 9 }] },
      audio: { tracks: [{ id: 'music', src: '/f/bed.mp3', start: 0, end: 20 }] },
    })
    const snapshot = structuredClone(p)
    buildDraft(p, {
      clips: { a: { removals: [{ start: 5, end: 6 }], gainDb: 1, vocalsPath: '/f/v.wav' } },
    })
    expect(p).toEqual(snapshot)
  })
})
