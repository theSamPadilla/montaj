/**
 * Track-level volume/mute in the legacy <video> preview.
 *
 * Two layers, deliberately:
 *
 *   1. `clipGain` — the fold itself, at the only place this hook turns audio
 *      settings into a number.
 *   2. The hook, driven through its real effects and handlers, asserting that
 *      each of the four gain-setting sites actually routes through it. A pure
 *      helper that nothing calls would pass layer 1 and leave the preview as
 *      loud as it ever was.
 *
 * The GainNode is faked by pre-seeding `__montajGain` on the <video> elements:
 * production caches the node there (`ensureVideoGain`) precisely so it survives
 * remounts, and `getVideoGain` reads it without touching an AudioContext — so a
 * seeded node is the wiring, not a stub around it. jsdom has no Web Audio at
 * all, which is why the real one can't be used here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { clipGain, useVideoPlayback } from '../useVideoPlayback'
import type { EditorProject, VisualItem, VisualTrack } from '../../../schema'

// ── The fold ─────────────────────────────────────────────────────────────────

describe('clipGain', () => {
  it('multiplies the track fader into the clip volume instead of replacing it', () => {
    // Replacing would silently throw away per-clip work an editor already did.
    expect(clipGain({ volume: 0.5 }, { volume: 0.8 })).toBeCloseTo(0.4, 10)
  })

  it('keeps the RATIO between two differently-set clips on the same track', () => {
    // The property that makes "multiply" the right rule: pulling the track down
    // must move every clip on it by the same factor, not flatten them onto one
    // level. Two clips a 2:1 mix apart stay 2:1 apart.
    const track: Pick<VisualTrack, 'volume'> = { volume: 0.5 }
    const loud = clipGain(track, { volume: 0.8 })
    const quiet = clipGain(track, { volume: 0.4 })
    expect(loud / quiet).toBeCloseTo(2, 10)
    expect(loud).toBeCloseTo(0.4, 10)
    expect(quiet).toBeCloseTo(0.2, 10)
  })

  it('silences a clip on a muted track whatever its own volume says', () => {
    expect(clipGain({ muted: true }, { volume: 2 })).toBe(0)
    expect(clipGain({ muted: true, volume: 1 }, { volume: 1 })).toBe(0)
  })

  it('keeps a muted clip muted on an unmuted track', () => {
    // Mute is either/or — the track cannot un-mute a clip.
    expect(clipGain({ volume: 1 }, { muted: true, volume: 1 })).toBe(0)
    expect(clipGain(undefined, { muted: true })).toBe(0)
  })

  it('leaves the clip untouched when the track carries no settings', () => {
    // The overwhelmingly common case: nothing writes track volume/mute by
    // default, so every project that predates the feature must sound identical.
    expect(clipGain({}, { volume: 0.8 })).toBeCloseTo(0.8, 10)
    expect(clipGain({}, {})).toBe(1)
    expect(clipGain(undefined, { volume: 0.8 })).toBeCloseTo(0.8, 10)
    expect(clipGain(undefined, {})).toBe(1)
  })

  it('carries amplification through both halves (gain above 1.0 is legal)', () => {
    // GainNode, not video.volume — values > 1 amplify, and the fold must not
    // clamp them on the way through.
    expect(clipGain({ volume: 2 }, { volume: 1.5 })).toBeCloseTo(3, 10)
    expect(clipGain({ volume: 0.5 }, { volume: 2 })).toBeCloseTo(1, 10)
  })
})

// ── The four gain-setting sites ──────────────────────────────────────────────

interface FakeGain {
  gain: { value: number }
  /**
   * Every value assigned to `gain.value`, in order.
   *
   * The transition sites (a cut, the gap clock) hand the incoming clip to the
   * OTHER slot and then make that slot active, which re-runs the load-time
   * effect over the same node. Asserting the final value alone would therefore
   * pass even if the transition site itself wrote an unfolded number and the
   * effect quietly corrected it a tick later. Asserting on every write pins the
   * site under test.
   */
  writes: number[]
}

/** Every distinct value written to a node, rounded past float noise. */
function distinct(node: FakeGain): number[] {
  return [...new Set(node.writes.map((v) => Math.round(v * 1e6) / 1e6))]
}

/** A <video> whose `currentTime` is a real read/write property (jsdom's is not). */
function fakeVideo(): HTMLVideoElement {
  const el = document.createElement('video')
  let t = 0
  Object.defineProperty(el, 'currentTime', {
    get: () => t,
    set: (v: number) => { t = v },
    configurable: true,
  })
  return el
}

/** Seed the cached GainNode the hook would otherwise build on first play. */
function attachGain(el: HTMLVideoElement): FakeGain {
  const writes: number[] = []
  let value = Number.NaN
  const node: FakeGain = {
    gain: {
      get value() { return value },
      set value(next: number) { value = next; writes.push(next) },
    },
    writes,
  }
  ;(el as unknown as { __montajGain: FakeGain }).__montajGain = node
  return node
}

const clip = (over: Partial<VisualItem>): VisualItem =>
  ({ id: 'a', type: 'video', src: '/a.mp4', start: 0, end: 5, inPoint: 0, outPoint: 5, ...over }) as VisualItem

function projectWith(items: VisualItem[], track: Partial<VisualTrack> = {}): EditorProject {
  return {
    id: 'track-audio',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: [{ id: 'trk-0', items, ...track }],
  } as EditorProject
}

/**
 * Mount the hook, hand it two wired <video> slots, and let the load effect run.
 *
 * The mount render sees both refs still null (they are assigned after it), so
 * nothing has touched a slot yet; the rerender with a fresh project object is
 * the first pass whose effects can load the active slot and set its gain.
 */
function mount(project: EditorProject) {
  const harness = renderHook(
    ({ p }: { p: EditorProject }) => useVideoPlayback(p, 0, () => {}, (path) => path),
    { initialProps: { p: project } },
  )
  const v0 = fakeVideo()
  const v1 = fakeVideo()
  const g0 = attachGain(v0)
  const g1 = attachGain(v1)
  harness.result.current.video0Ref.current = v0
  harness.result.current.video1Ref.current = v1
  harness.rerender({ p: { ...project } })
  return { ...harness, v0, v1, g0, g1 }
}

describe('useVideoPlayback — the track fold reaches the GainNodes', () => {
  // jsdom implements neither play nor pause; the load, boundary and gap paths
  // all call them. Same stubbing pattern as useVideoPlayback.corpus.test.ts.
  let playSpy: ReturnType<typeof vi.spyOn>
  let pauseSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  })
  afterEach(() => {
    playSpy.mockRestore()
    pauseSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('folds the track fader into the active clip on load', () => {
    const { g0 } = mount(projectWith([clip({ volume: 0.8 })], { volume: 0.5 }))
    expect(g0.gain.value).toBeCloseTo(0.4, 10)
  })

  it('leaves the clip alone when the track carries no settings', () => {
    const { g0 } = mount(projectWith([clip({ volume: 0.8 })]))
    expect(g0.gain.value).toBeCloseTo(0.8, 10)
  })

  it('silences the active clip when the TRACK is muted', () => {
    const { g0 } = mount(projectWith([clip({ volume: 2 })], { muted: true }))
    expect(g0.gain.value).toBe(0)
  })

  it('keeps a clip muted on an unmuted track muted', () => {
    const { g0 } = mount(projectWith([clip({ muted: true, volume: 1 })], { volume: 1 }))
    expect(g0.gain.value).toBe(0)
  })

  it('re-applies the gain when only the TRACK volume changes', () => {
    // Moving the track fader edits no clip, so this is the only thing that can
    // make the change audible on a slot that is already loaded and playing.
    const items = [clip({ volume: 0.8 })]
    const { rerender, g0 } = mount(projectWith(items, { volume: 0.5 }))
    expect(g0.gain.value).toBeCloseTo(0.4, 10)

    // Same item objects, new track volume — the load effect's identity string
    // is unchanged, so nothing reloads; only the gain moves.
    act(() => { rerender({ p: projectWith(items, { volume: 0.25 }) }) })
    expect(g0.gain.value).toBeCloseTo(0.2, 10)
  })

  it('preserves the mix between two clips when the track is pulled down (preload site)', () => {
    // Clip A is the active slot's gain; clip B's is set by the next-clip
    // preload inside handleTimeUpdate. Both go through the fold, so the 2:1
    // ratio the editor set survives the track fader.
    const a = clip({ id: 'a', volume: 0.8, start: 0, end: 5 })
    const b = clip({ id: 'b', src: '/b.mp4', volume: 0.4, start: 5, end: 10 })
    const { result, v0, g0, g1 } = mount(projectWith([a, b], { volume: 0.5 }))

    v0.currentTime = 1 // mid-clip: preload runs, the boundary branch does not
    act(() => { result.current.handleTimeUpdate() })

    expect(distinct(g0)).toEqual([0.4])
    expect(distinct(g1)).toEqual([0.2])
    expect(g0.gain.value / g1.gain.value).toBeCloseTo(2, 10)
  })

  it('folds the track into the incoming clip at a contiguous cut', () => {
    const a = clip({ id: 'a', volume: 0.8, start: 0, end: 5, outPoint: 5 })
    const b = clip({ id: 'b', src: '/b.mp4', volume: 0.4, start: 5, end: 10 })
    const { result, v0, g1 } = mount(projectWith([a, b], { volume: 0.5 }))

    // First pass preloads slot 1 (asserted above); forget those writes so what
    // the switch site itself sets is what this case measures.
    v0.currentTime = 1
    act(() => { result.current.handleTimeUpdate() })
    g1.writes.length = 0

    v0.currentTime = 5 // at outPoint, and b starts exactly where a ends
    act(() => { result.current.handleTimeUpdate() })

    expect(distinct(g1)).toEqual([0.2])
  })

  it('folds the track into the clip the gap clock lands on', () => {
    const a = clip({ id: 'a', volume: 0.8, start: 0, end: 2, outPoint: 2 })
    const b = clip({ id: 'b', src: '/b.mp4', volume: 0.4, start: 3, end: 5 })

    // Drive the gap rAF by hand: collect every scheduled callback, then jump
    // the wall clock past the gap so the first tick lands on b's start. The
    // gap branch also sets isPlaying, which starts the boundary-polling pump —
    // hence a queue rather than a single slot, and `[0]`, which is the gap
    // tick the handler scheduled synchronously.
    const scheduled: FrameRequestCallback[] = []
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      scheduled.push(cb)
      return scheduled.length
    })
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0)

    const { result, v0, g1 } = mount(projectWith([a, b], { volume: 0.5 }))
    scheduled.length = 0
    v0.currentTime = 2 // at a's outPoint, and b starts 1s later — a gap, not a cut
    act(() => { result.current.handleTimeUpdate() })
    expect(scheduled.length).toBeGreaterThan(0)

    g1.writes.length = 0 // forget what the preload wrote; the gap site is under test
    nowSpy.mockReturnValue(10_000)
    act(() => { scheduled[0](10_000) })

    expect(distinct(g1)).toEqual([0.2])
  })

  it('silences the incoming clip too when the track is muted', () => {
    // The transition sites have their own gain assignment; a track mute that
    // only held for the clip already on screen would leak audio at every cut.
    const a = clip({ id: 'a', volume: 1, start: 0, end: 5, outPoint: 5 })
    const b = clip({ id: 'b', src: '/b.mp4', volume: 1, start: 5, end: 10 })
    const { result, v0, g0, g1 } = mount(projectWith([a, b], { muted: true }))

    v0.currentTime = 1
    act(() => { result.current.handleTimeUpdate() })

    expect(distinct(g0)).toEqual([0])
    expect(distinct(g1)).toEqual([0])
  })
})
