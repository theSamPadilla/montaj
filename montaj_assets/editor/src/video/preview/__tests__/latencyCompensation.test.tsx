/**
 * T1 — the clock → painter bridge subtracts the shared AudioContext's
 * `outputLatency + baseLatency` on every emit, so the painted playhead
 * matches what is actually AUDIBLE (not what the frames-consumed clock
 * has counted). Both the engine bridge (`useEnginePlayback.emitTime`)
 * and the `<video>` fallback bridge (`useVideoPlayback`'s playback-advance
 * callsites) go through this compensation.
 *
 * The fake ctx (`stubCtx`) is written straight into `window.__montajSharedCtx`
 * because `getSharedAudioContext()` only rebuilds when the cached entry is
 * missing or closed — a running stub is used exactly like a real one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { EditorProject, VisualItem, VisualTrack } from '../../../schema'
import type { EngineStats, EngineStatus } from '../../../engine'

// jsdom implements neither `play()` nor `pause()`. Installed once, at module
// scope, rather than as a per-test spy: Testing Library's own `afterEach`
// cleanup unmounts the hook — and therefore runs the audio-lane teardown,
// which pauses every element — AFTER a per-test `restoreAllMocks()` would
// have put the unimplemented originals back.
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

// ── Shared: a controllable stub AudioContext ─────────────────────────────────

interface StubCtx {
  state: 'running' | 'suspended'
  outputLatency: number
  baseLatency: number
  resume: () => Promise<void>
  destination: object
  createMediaElementSource: () => { connect: () => void }
  createGain: () => { gain: { value: number }; connect: () => void }
}

function stubCtx(over: Partial<Pick<StubCtx, 'outputLatency' | 'baseLatency' | 'state'>> = {}): StubCtx {
  const ctx: StubCtx = {
    state: over.state ?? 'running',
    outputLatency: over.outputLatency ?? 0,
    baseLatency: over.baseLatency ?? 0,
    resume: () => Promise.resolve(),
    destination: {},
    createMediaElementSource: () => ({ connect: () => {} }),
    createGain: () => ({ gain: { value: 1 }, connect: () => {} }),
  }
  ;(window as unknown as { __montajSharedCtx?: StubCtx }).__montajSharedCtx = ctx
  return ctx
}

function clearCtx() {
  delete (window as unknown as { __montajSharedCtx?: unknown }).__montajSharedCtx
}

// jsdom has no `AudioContext` at all — a default is needed so anything that
// hits `new AudioContext()` on a cold path doesn't ReferenceError. The tests
// below always seed `__montajSharedCtx` directly, so this default is only a
// safety net.
;(window as unknown as { AudioContext: unknown }).AudioContext = class {
  state = 'running'
  outputLatency = 0
  baseLatency = 0
  destination = {}
  resume() { return Promise.resolve() }
  createMediaElementSource() { return { connect() {} } }
  createGain() { return { gain: { value: 1 }, connect() {} } }
}

// ── latencySeconds() — the pure helper ───────────────────────────────────────

import { latencySeconds } from '../audio-context'

describe('latencySeconds', () => {
  it('sums outputLatency and baseLatency', () => {
    expect(latencySeconds({ outputLatency: 0.03, baseLatency: 0.005 })).toBeCloseTo(0.035, 10)
  })

  it('returns 0.03 for the plan spec case (outputLatency=0.03, baseLatency=0)', () => {
    expect(latencySeconds({ outputLatency: 0.03, baseLatency: 0 })).toBeCloseTo(0.03, 10)
  })

  it('clamps a negative sum to zero', () => {
    // Not observed in the wild, but a malformed stub or a broken driver could
    // report a negative — the bridge must never emit a time greater than the
    // clock's own now(), which is what a negative would produce.
    expect(latencySeconds({ outputLatency: -0.5, baseLatency: 0 })).toBe(0)
  })

  it('tolerates missing / NaN latency fields (non-Chromium contexts)', () => {
    expect(latencySeconds({ outputLatency: NaN, baseLatency: 0.005 })).toBeCloseTo(0.005, 10)
    expect(latencySeconds({ outputLatency: 0.03, baseLatency: NaN })).toBeCloseTo(0.03, 10)
    expect(latencySeconds({ outputLatency: NaN, baseLatency: NaN })).toBe(0)
  })
})

// ── The <video> fallback bridge — useVideoPlayback ───────────────────────────

import { useVideoPlayback } from '../useVideoPlayback'

function videoClip(over: Partial<VisualItem> = {}): VisualItem {
  return { id: 'a', type: 'video', src: '/a.mp4', start: 0, end: 5, inPoint: 0, outPoint: 5, ...over } as VisualItem
}

function videoProject(items: VisualItem[], track: Partial<VisualTrack> = {}): EditorProject {
  return {
    id: 'lat-video',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: [{ id: 'trk-0', items, ...track }],
  } as EditorProject
}

/** A `<video>` element whose `currentTime` is a real read/write property. */
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

function mountVideo(project: EditorProject, onTimeUpdate: (t: number) => void) {
  const harness = renderHook(
    ({ p }: { p: EditorProject }) => useVideoPlayback(p, 0, onTimeUpdate, (path) => path),
    { initialProps: { p: project } },
  )
  const v0 = fakeVideo()
  const v1 = fakeVideo()
  harness.result.current.video0Ref.current = v0
  harness.result.current.video1Ref.current = v1
  harness.rerender({ p: { ...project } })
  return { ...harness, v0, v1 }
}

describe('<video> fallback bridge — useVideoPlayback', () => {
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
    clearCtx()
  })

  it('emits now() - outputLatency on handleTimeUpdate (spec: 0.03 → t-0.03)', () => {
    stubCtx({ outputLatency: 0.03, baseLatency: 0 })
    const onTimeUpdate = vi.fn<(t: number) => void>()
    const { result, v0 } = mountVideo(videoProject([videoClip()]), onTimeUpdate)
    onTimeUpdate.mockClear()

    v0.currentTime = 2  // → project time = clip.start + (2 - inPoint) = 2
    act(() => { result.current.handleTimeUpdate() })

    // The last emit is the main handleTimeUpdate emit at the tail of the
    // handler; earlier writes on the pre-cut path fold into it.
    const emitted = onTimeUpdate.mock.calls[onTimeUpdate.mock.calls.length - 1]?.[0]
    expect(emitted).toBeCloseTo(2 - 0.03, 6)
  })

  it('re-reads latency LIVE across ticks (device switch)', () => {
    const ctx = stubCtx({ outputLatency: 0.03, baseLatency: 0 })
    const onTimeUpdate = vi.fn<(t: number) => void>()
    const { result, v0 } = mountVideo(videoProject([videoClip()]), onTimeUpdate)

    v0.currentTime = 1
    onTimeUpdate.mockClear()
    act(() => { result.current.handleTimeUpdate() })
    expect(onTimeUpdate.mock.calls[onTimeUpdate.mock.calls.length - 1]?.[0]).toBeCloseTo(1 - 0.03, 6)

    // Device switch mid-session — a bluetooth output arrives with a higher
    // buffer. Same ctx object, new field value: the bridge picks it up on the
    // very next tick, no re-mount required.
    ctx.outputLatency = 0.2
    v0.currentTime = 2
    onTimeUpdate.mockClear()
    act(() => { result.current.handleTimeUpdate() })
    expect(onTimeUpdate.mock.calls[onTimeUpdate.mock.calls.length - 1]?.[0]).toBeCloseTo(2 - 0.2, 6)
  })

  it('clamps the emitted time at zero when latency exceeds the current time', () => {
    stubCtx({ outputLatency: 0.5, baseLatency: 0 })
    const onTimeUpdate = vi.fn<(t: number) => void>()
    const { result, v0 } = mountVideo(videoProject([videoClip()]), onTimeUpdate)

    v0.currentTime = 0.1  // project time ≈ 0.1, latency 0.5 → would go negative
    onTimeUpdate.mockClear()
    act(() => { result.current.handleTimeUpdate() })
    expect(onTimeUpdate.mock.calls[onTimeUpdate.mock.calls.length - 1]?.[0]).toBe(0)
  })
})

// ── The engine bridge — useEnginePlayback ────────────────────────────────────

// The engine module owns three WebCodecs paths jsdom cannot execute; the fake
// used here reproduces the seam this hook actually observes (emit, transport
// transitions, seek/pause/play counters) — the same pattern as the neighboring
// `useEnginePlayback.test.tsx`.
interface FakeEngine {
  deps: {
    onTime?: (t: number) => void
    onStatusChange?: (s: EngineStatus) => void
    onError?: (m: string) => void
    startProjectS?: number
    fileUrl: (p: string) => string
  }
  transport: EngineStatus['transport']
  now: number
  seeks: number[]
  emit(t: number): void
  setTransport(t: EngineStatus['transport']): void
}

const engines = vi.hoisted(() => [] as unknown[])

vi.mock('../../../engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../engine')>()
  return {
    ...actual,
    createEngine: (project: EditorProject, deps: FakeEngine['deps']) => {
      const status = (): EngineStatus => ({
        transport: engine.transport,
        picture: 'video',
        clipId: null,
        seeking: false,
        clock: 'fallback',
      })
      const engine: FakeEngine & {
        attach: (c: HTMLCanvasElement | null) => void
        play: () => void
        pause: () => void
        seek: (t: number) => void
        setRate: (r: number) => void
        updateProject: (p: EditorProject) => void
        status: () => EngineStatus
        clock: { now: () => number; playing: boolean; kind: 'audio' | 'fallback' }
        stats: () => EngineStats
        dispose: () => void
      } = {
        deps,
        transport: 'paused',
        now: deps.startProjectS ?? 0,
        seeks: [],
        emit(t: number) { engine.now = t; deps.onTime?.(t) },
        setTransport(t) { engine.transport = t; deps.onStatusChange?.(status()) },
        attach: () => {},
        play: () => { engine.transport = 'playing'; deps.onStatusChange?.(status()) },
        pause: () => { engine.transport = 'paused'; deps.onStatusChange?.(status()) },
        seek: (t: number) => { engine.seeks.push(t); engine.now = t },
        setRate: () => {},
        updateProject: () => {},
        status,
        clock: {
          get now() { return () => engine.now },
          get playing() { return engine.transport === 'playing' },
          kind: 'fallback' as const,
        } as unknown as { now: () => number; playing: boolean; kind: 'audio' | 'fallback' },
        stats: () => ({ fps: 24, dropped: 0, buffered: 0, clock: 'fallback' }),
        dispose: () => {},
      }
      engines.push(engine)
      return engine
    },
  }
})

// Import AFTER the mock declaration for readability — vi.mock is hoisted.
import { useEnginePlayback } from '../useEnginePlayback'

function engineProject(): EditorProject {
  return {
    id: 'lat-engine',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [{ id: 'trk-0', items: [{ id: 'c0', type: 'video', src: 'a.mp4', proxySrc: 'a_proxy.mp4', start: 0, end: 10 }] }],
  } as EditorProject
}

function setupEngine() {
  const onTimeUpdate = vi.fn<(t: number) => void>()
  const view = renderHook(
    ({ t }: { t: number }) => useEnginePlayback(engineProject(), t, onTimeUpdate, (p) => p),
    { initialProps: { t: 0 } },
  )
  const engine = engines[engines.length - 1] as FakeEngine
  return { view, engine, onTimeUpdate }
}

describe('engine bridge — useEnginePlayback.emitTime', () => {
  beforeEach(() => { engines.length = 0 })
  afterEach(() => { clearCtx() })

  it('emits now() - outputLatency during playback (spec: 0.03 → t-0.03)', () => {
    stubCtx({ outputLatency: 0.03, baseLatency: 0 })
    const { engine, onTimeUpdate } = setupEngine()

    act(() => { engine.setTransport('playing') })
    onTimeUpdate.mockClear()
    act(() => { engine.emit(1.5) })

    expect(onTimeUpdate).toHaveBeenCalledWith(expect.closeTo(1.5 - 0.03, 6))
  })

  it('sums outputLatency and baseLatency during playback', () => {
    stubCtx({ outputLatency: 0.03, baseLatency: 0.005 })
    const { engine, onTimeUpdate } = setupEngine()

    act(() => { engine.setTransport('playing') })
    onTimeUpdate.mockClear()
    act(() => { engine.emit(1.5) })

    expect(onTimeUpdate).toHaveBeenCalledWith(expect.closeTo(1.5 - 0.035, 6))
  })

  it('re-reads latency LIVE across ticks (device switch)', () => {
    const ctx = stubCtx({ outputLatency: 0.03, baseLatency: 0 })
    const { engine, onTimeUpdate } = setupEngine()

    act(() => { engine.setTransport('playing') })
    onTimeUpdate.mockClear()
    act(() => { engine.emit(1.0) })
    expect(onTimeUpdate).toHaveBeenLastCalledWith(expect.closeTo(1.0 - 0.03, 6))

    ctx.outputLatency = 0.2
    act(() => { engine.emit(2.0) })
    expect(onTimeUpdate).toHaveBeenLastCalledWith(expect.closeTo(2.0 - 0.2, 6))
  })

  it('does NOT compensate when the transport is paused (no seek/scrub-display regression)', () => {
    // The paused path emits via `scheduler.apply` on seek-land with the exact
    // seek target. Compensating that would show the user 4.97 after they
    // scrubbed to 5.00 — precisely the "seek/scrub display regression" the
    // task tells us to avoid.
    stubCtx({ outputLatency: 0.03, baseLatency: 0 })
    const { engine, onTimeUpdate } = setupEngine()
    // Transport stays 'paused' (its default).
    onTimeUpdate.mockClear()

    act(() => { engine.emit(5.0) })
    expect(onTimeUpdate).toHaveBeenLastCalledWith(5.0)
  })

  it('clamps the emitted time at zero when latency exceeds the current time', () => {
    stubCtx({ outputLatency: 0.5, baseLatency: 0 })
    const { engine, onTimeUpdate } = setupEngine()

    act(() => { engine.setTransport('playing') })
    onTimeUpdate.mockClear()
    act(() => { engine.emit(0.1) })

    expect(onTimeUpdate).toHaveBeenLastCalledWith(0)
  })
})

// ── syncAudioTracks callsites OUTSIDE emitTime get RAW time, not painted ─────
//
// `emitTime`'s own direct `syncAudioTracks(t, playing)` call was never broken
// — it already hands the raw `t` parameter through. The regression these
// guard is the OTHER two callsites (the "audio lane added mid-session" effect
// and the "transport transition" effect), which used to reuse
// `lastEmittedRef.current` — the PAINTED, latency-compensated mirror — and
// would double-lag a newly added lane, or a play/pause re-sync, by
// `latencySeconds`.

describe('engine bridge — syncAudioTracks callsites outside emitTime', () => {
  let RealAudio: typeof Audio
  const audioEls: HTMLAudioElement[] = []

  beforeEach(() => {
    engines.length = 0
    audioEls.length = 0
    RealAudio = window.Audio
    ;(window as unknown as { Audio: unknown }).Audio = class extends RealAudio {
      constructor(src?: string) { super(src); audioEls.push(this as unknown as HTMLAudioElement) }
    }
  })
  afterEach(() => {
    ;(window as unknown as { Audio: unknown }).Audio = RealAudio
    clearCtx()
  })

  function projectWithAudio(includeAudio: boolean): EditorProject {
    return {
      ...engineProject(),
      audio: {
        tracks: includeAudio
          ? [{ id: 'a0', src: 'music.mp3', start: 0, end: 100, inPoint: 0, volume: 1 } as never]
          : [],
      },
    } as EditorProject
  }

  it('a lane added mid-session is placed at the RAW playhead, not the latency-painted one', () => {
    stubCtx({ outputLatency: 1, baseLatency: 0 })
    const onTimeUpdate = vi.fn<(t: number) => void>()
    const view = renderHook(
      ({ p }: { p: EditorProject }) => useEnginePlayback(p, 0, onTimeUpdate, (path) => path),
      { initialProps: { p: projectWithAudio(false) } },
    )
    const engine = engines[engines.length - 1] as FakeEngine

    act(() => { engine.setTransport('playing') })
    act(() => { engine.emit(10) }) // raw=10, painted=9 (1s latency) — mirrors diverge here

    // Add the audio track mid-session, WITHOUT another emit: the effect must
    // read the mirrored RAW time, not the painted one.
    act(() => { view.rerender({ p: projectWithAudio(true) }) })

    expect(audioEls).toHaveLength(1)
    // trackTime = playhead - start(0) + inPoint(0): 10 if fixed, 9 if the
    // painted mirror regresses back in.
    expect(audioEls[0].currentTime).toBeCloseTo(10, 6)
  })

  it('a transport transition re-syncs lanes to the RAW playhead, not the latency-painted one', () => {
    stubCtx({ outputLatency: 1, baseLatency: 0 })
    const onTimeUpdate = vi.fn<(t: number) => void>()
    const view = renderHook(
      ({ p }: { p: EditorProject }) => useEnginePlayback(p, 0, onTimeUpdate, (path) => path),
      { initialProps: { p: projectWithAudio(true) } },
    )
    const engine = engines[engines.length - 1] as FakeEngine

    act(() => { engine.setTransport('playing') })
    act(() => { engine.emit(10) }) // raw=10, painted=9; the direct emitTime call already seeks correctly

    // Knock the element off both candidate targets so the NEXT resync — from
    // the transport-transition effect alone, no intervening emit — is the
    // only thing that can put it back.
    audioEls[0].currentTime = 50
    act(() => { engine.setTransport('paused') })

    expect(audioEls[0].currentTime).toBeCloseTo(10, 6)
  })
})
