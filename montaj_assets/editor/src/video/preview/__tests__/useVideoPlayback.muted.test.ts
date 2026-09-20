/**
 * Task 4c — the `muted` master override on `PreviewPlayer` (threaded through
 * as `useVideoPlayback`'s 5th argument). See that prop's doc in
 * `PreviewPlayer.tsx` for the full "why": moving the pointer across a grid of
 * project-card hover previews must not play each project's audio in turn.
 *
 * Two DISTINCT audio paths this hook owns a GainNode for, both asserted here:
 *
 *   1. The video-slot GainNodes (`videoGainRef`, via `applyClipVolume` and the
 *      three transition sites) — same harness as
 *      `useVideoPlayback.trackAudio.test.ts` (seeded `__montajGain`, no real
 *      AudioContext needed).
 *   2. The background audio-TRACK GainNodes (`gainNodesMap` — music/VO beds,
 *      `project.audio.tracks`) — a wholly separate `<audio>` element family
 *      the video-slot mute does nothing for. jsdom has no Web Audio at all, so
 *      this half stubs `window.__montajSharedCtx` directly (same technique as
 *      `latencyCompensation.test.tsx`) rather than seeding a cached node.
 *
 * Both must go to 0 when `muted` is true, REGARDLESS of what the clip/track's
 * own volume/mute settings say — this is a master override on top of the
 * existing fold, not a replacement for it. And the default (`muted` absent)
 * must be byte-identical to every gain value `trackAudio.test.ts` already
 * pins — that suite is untouched by this change and stays the proof.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useVideoPlayback } from '../useVideoPlayback'
import type { EditorProject, VisualItem } from '../../../schema'

// jsdom implements neither `play()` nor `pause()`. Installed once, at module
// scope, rather than as a per-test spy: Testing Library's own `afterEach`
// cleanup unmounts the hook — which, once a test populates
// `project.audio.tracks`, runs the audio-lane teardown that calls
// `el.pause()` on every lane element — AFTER a per-test `restoreAllMocks()`
// would have put the unimplemented originals back (same hazard documented in
// `latencyCompensation.test.tsx`).
Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
  configurable: true,
  get(this: HTMLMediaElement & { __paused?: boolean }) { return this.__paused !== false },
})
HTMLMediaElement.prototype.play = function (this: HTMLMediaElement & { __paused?: boolean }) {
  this.__paused = false
  return Promise.resolve()
}
HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement & { __paused?: boolean }) {
  this.__paused = true
}

// ── Path 1: video-slot GainNodes ────────────────────────────────────────────

interface FakeGain {
  gain: { value: number }
  writes: number[]
}

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

function projectWith(items: VisualItem[]): EditorProject {
  return {
    id: 'muted-video',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: [{ id: 'trk-0', items }],
  } as EditorProject
}

/** Same mount dance as `trackAudio.test.ts`, with `muted` threaded through. */
function mount(project: EditorProject, muted = false) {
  const harness = renderHook(
    ({ p, m }: { p: EditorProject; m: boolean }) => useVideoPlayback(p, 0, () => {}, (path) => path, m),
    { initialProps: { p: project, m: muted } },
  )
  const v0 = fakeVideo()
  const v1 = fakeVideo()
  const g0 = attachGain(v0)
  const g1 = attachGain(v1)
  harness.result.current.video0Ref.current = v0
  harness.result.current.video1Ref.current = v1
  harness.rerender({ p: { ...project }, m: muted })
  return { ...harness, v0, v1, g0, g1 }
}

describe('useVideoPlayback — muted overrides the video-slot GainNodes', () => {
  it('unset — the default path — is byte-identical to the clip volume', () => {
    const { g0 } = mount(projectWith([clip({ volume: 0.8 })]))
    expect(g0.gain.value).toBeCloseTo(0.8, 10)
  })

  it('false — explicitly — is also byte-identical to the clip volume', () => {
    const { g0 } = mount(projectWith([clip({ volume: 0.8 })]), false)
    expect(g0.gain.value).toBeCloseTo(0.8, 10)
  })

  it('zeroes the active slot even though the clip is loud and unmuted', () => {
    const { g0 } = mount(projectWith([clip({ volume: 2 })]), true)
    expect(g0.gain.value).toBe(0)
  })

  it('reaches the live gain node immediately on an external toggle, not just at load', () => {
    const items = [clip({ volume: 1 })]
    const { rerender, g0 } = mount(projectWith(items), false)
    expect(g0.gain.value).toBeCloseTo(1, 10)

    act(() => { rerender({ p: projectWith(items), m: true }) })
    expect(g0.gain.value).toBe(0)

    // And un-muting brings the clip's own volume straight back — this is an
    // override on TOP of the fold, not a one-way latch.
    act(() => { rerender({ p: projectWith(items), m: false }) })
    expect(g0.gain.value).toBeCloseTo(1, 10)
  })

  it('zeroes the incoming clip at a contiguous cut too, not just the clip already on screen', () => {
    // If muted only held for the active slot, every clip switch would un-mute
    // the preview for one frame.
    const a = clip({ id: 'a', volume: 1, start: 0, end: 5, outPoint: 5 })
    const b = clip({ id: 'b', src: '/b.mp4', volume: 1, start: 5, end: 10 })
    const { result, v0, g1 } = mount(projectWith([a, b]), true)

    v0.currentTime = 5 // at a's outPoint, b starts exactly where a ends
    act(() => { result.current.handleTimeUpdate() })

    expect(g1.gain.value).toBe(0)
  })
})

// ── Path 2: background audio-track (music/VO bed) GainNodes ────────────────
//
// A wholly separate `<audio>` element family — `project.audio.tracks` — with
// its own GainNode lifecycle (`gainNodesMap`, "Multi-track audio management"
// in useVideoPlayback.ts). The video-slot fixes above do nothing for this
// path; it has to be muted independently, which is exactly what a caller
// mounting a project with a music bed over its clips would otherwise miss.

interface FakeLaneGain {
  gain: { value: number }
  connect: () => void
}

interface StubCtx {
  state: 'running'
  outputLatency: number
  baseLatency: number
  resume: () => Promise<void>
  destination: object
  createMediaElementSource: () => { connect: () => void }
  createGain: () => FakeLaneGain
}

function stubSharedCtx(): { gains: FakeLaneGain[] } {
  const gains: FakeLaneGain[] = []
  const ctx: StubCtx = {
    state: 'running',
    outputLatency: 0,
    baseLatency: 0,
    resume: () => Promise.resolve(),
    destination: {},
    createMediaElementSource: () => ({ connect: () => {} }),
    createGain: () => {
      const node: FakeLaneGain = { gain: { value: 1 }, connect: () => {} }
      gains.push(node)
      return node
    },
  }
  ;(window as unknown as { __montajSharedCtx?: StubCtx }).__montajSharedCtx = ctx
  return { gains }
}

function clearSharedCtx() {
  delete (window as unknown as { __montajSharedCtx?: unknown }).__montajSharedCtx
}

function projectWithMusicBed(): EditorProject {
  return {
    id: 'muted-lane',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: [],
    audio: { tracks: [{ id: 'music', src: '/music.mp3', start: 0, end: 5, volume: 1 }] },
  } as EditorProject
}

describe('useVideoPlayback — muted overrides background audio-track GainNodes', () => {
  afterEach(() => {
    clearSharedCtx()
  })

  it('unset — the default path — leaves the lane at its own volume', () => {
    const { gains } = stubSharedCtx()
    renderHook(() => useVideoPlayback(projectWithMusicBed(), 1, () => {}, (p) => p))
    expect(gains).toHaveLength(1)
    expect(gains[0].gain.value).toBe(1)
  })

  it('zeroes the lane on mount, though the track itself is unmuted at volume 1', () => {
    const { gains } = stubSharedCtx()
    renderHook(() => useVideoPlayback(projectWithMusicBed(), 1, () => {}, (p) => p, true))
    expect(gains).toHaveLength(1)
    expect(gains[0].gain.value).toBe(0)
  })

  it('reaches the lane immediately on an external toggle', () => {
    const { gains } = stubSharedCtx()
    const { rerender } = renderHook(
      ({ m }: { m: boolean }) => useVideoPlayback(projectWithMusicBed(), 1, () => {}, (p) => p, m),
      { initialProps: { m: false } },
    )
    expect(gains[0].gain.value).toBe(1)

    act(() => { rerender({ m: true }) })
    expect(gains[0].gain.value).toBe(0)
  })
})
