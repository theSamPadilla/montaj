/**
 * SP4 T6 — the clock bridge, the gesture anchors and the audio-lane slaving.
 *
 * The engine itself is mocked: everything under `src/engine/` is decode,
 * WebCodecs and rAF, none of which exist in jsdom, and none of which this file
 * is about. What IS under test is the seam — who seeks whom, when, and exactly
 * once — so the fake engine records calls and lets each test drive `onTime` /
 * `onStatusChange` by hand at the moment the real engine would.
 *
 * `currentTime` is the prop `PreviewPlayer` feeds from `usePlaybackTime(clock)`;
 * a `rerender` with a new value is exactly what a Scrubber/Timeline/track-row
 * `clock.set(t)` looks like from inside this hook.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
// jsdom implements neither `play()` nor `pause()`. Installed once, at module
// scope, rather than as a per-test spy: Testing Library's own `afterEach`
// cleanup unmounts the hook — and therefore runs the audio-lane teardown, which
// pauses every element — AFTER a `restoreAllMocks()` in this file would have
// put the unimplemented originals back.
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
// jsdom has no `AudioContext` at all. Fix 5 makes `togglePlay` call
// `getSharedAudioContext()` unconditionally (every real browser has one), so
// without a stub ANY `togglePlay()`/Space call in this file would throw a
// `ReferenceError` the moment it tries `new AudioContext()` — including tests
// that have nothing to do with audio and never call `stubSuspendedContext()`.
// A minimal, harmless default at module scope; tests that care about
// suspend/resume behavior still control `state`/`resume` themselves (see
// `stubSuspendedContext` and the 'audio lanes' describe block's own richer
// stub, both of which override this per-test).
;(window as unknown as { AudioContext: unknown }).AudioContext = class {
  state = 'running'
  destination = {}
  resume() {
    return Promise.resolve()
  }
  createMediaElementSource() {
    return { connect() {} }
  }
  createGain() {
    return { gain: { value: 1 }, connect() {} }
  }
}
import type { EditorProject as Project } from '../../../schema'
import type { EngineStats, EngineStatus } from '../../../engine'

interface FakeEngine {
  deps: {
    onTime?: (t: number) => void
    onStatusChange?: (s: EngineStatus) => void
    onError?: (m: string) => void
    startProjectS?: number
    fileUrl: (p: string) => string
  }
  project: Project
  transport: EngineStatus['transport']
  now: number
  seeks: number[]
  plays: number
  pauses: number
  disposes: number
  updates: Project[]
  attaches: Array<HTMLCanvasElement | null>
  statsCalls: number
  /** Emit a playhead the way a real tick would. */
  emit(t: number): void
  /** Move the transport and publish, the way `play()`/`pause()` do. */
  setTransport(t: EngineStatus['transport']): void
}

const engines = vi.hoisted(() => [] as unknown[])

vi.mock('../../../engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../engine')>()
  return {
    ...actual,
    createEngine: (project: Project, deps: FakeEngine['deps']) => {
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
        updateProject: (p: Project) => void
        status: () => EngineStatus
        clock: { now: () => number; playing: boolean; kind: 'audio' | 'fallback' }
        stats: () => EngineStats
        dispose: () => void
      } = {
        deps,
        project,
        transport: 'paused',
        now: deps.startProjectS ?? 0,
        seeks: [],
        plays: 0,
        pauses: 0,
        disposes: 0,
        updates: [],
        attaches: [],
        statsCalls: 0,
        emit(t: number) {
          engine.now = t
          deps.onTime?.(t)
        },
        setTransport(t) {
          engine.transport = t
          deps.onStatusChange?.(status())
        },
        attach: (c) => { engine.attaches.push(c) },
        play: () => { engine.plays++; engine.transport = 'playing'; deps.onStatusChange?.(status()) },
        pause: () => { engine.pauses++; engine.transport = 'paused'; deps.onStatusChange?.(status()) },
        seek: (t: number) => { engine.seeks.push(t); engine.now = t },
        updateProject: (p: Project) => { engine.updates.push(p) },
        status,
        clock: {
          get now() { return () => engine.now },
          get playing() { return engine.transport === 'playing' },
          kind: 'fallback' as const,
        } as unknown as { now: () => number; playing: boolean; kind: 'audio' | 'fallback' },
        stats: () => {
          engine.statsCalls++
          return { fps: 24, dropped: 1, buffered: 2, clock: 'fallback' }
        },
        dispose: () => { engine.disposes++ },
      }
      engines.push(engine)
      return engine
    },
  }
})

// Spy-wrapped, not replaced: `togglePlay` must reach the REAL
// `resumeAudioContextFromGesture` (its own suspended-context behavior is
// exercised via `window.__montajSharedCtx` below, unchanged), but Fix 5
// needs to assert `getSharedAudioContext` is actually called — it is the
// call that CREATES the context, which `resumeAudioContextFromGesture`
// deliberately never does (see that function's own doc).
vi.mock('../audio-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audio-context')>()
  return {
    ...actual,
    getSharedAudioContext: vi.fn(actual.getSharedAudioContext),
    resumeAudioContextFromGesture: vi.fn(actual.resumeAudioContextFromGesture),
  }
})

// Imported AFTER the mock declaration for readability only — vi.mock is hoisted.
import { useEnginePlayback, SCRUB_DEAD_ZONE_S } from '../useEnginePlayback'
import { getSharedAudioContext, resumeAudioContextFromGesture } from '../audio-context'

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'engine-project',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [{ id: 'trk-0', items: [{ id: 'c0', type: 'video', src: 'a.mp4', proxySrc: 'a_proxy.mp4', start: 0, end: 10 }] }],
    ...overrides,
  } as Project
}

function setup(project: Project = makeProject(), initialTime = 0) {
  const onTimeUpdate = vi.fn<(t: number) => void>()
  const view = renderHook(
    ({ t }: { t: number }) => useEnginePlayback(project, t, onTimeUpdate, (p) => p),
    { initialProps: { t: initialTime } },
  )
  const engine = engines[engines.length - 1] as FakeEngine
  return { view, engine, onTimeUpdate }
}

beforeEach(() => {
  engines.length = 0
  vi.mocked(getSharedAudioContext).mockClear()
  vi.mocked(resumeAudioContextFromGesture).mockClear()
})

// ── The clock bridge ─────────────────────────────────────────────────────────

describe('useEnginePlayback clock bridge', () => {
  it('engine echo → no seek', () => {
    const { view, engine, onTimeUpdate } = setup()

    act(() => { engine.emit(1.234) })
    // Mirror-then-forward: the editor clock got the value…
    expect(onTimeUpdate).toHaveBeenCalledWith(1.234)

    // …and the store coming back around as a new `currentTime` is recognized
    // as this hook's own echo, not as somebody asking to go to 1.234.
    act(() => { view.rerender({ t: 1.234 }) })
    expect(engine.seeks).toEqual([])
  })

  it('engine echo → no seek even when React commits a STALE snapshot', () => {
    // The dead zone alone cannot cover this: by the time the render carrying
    // 1.0 commits, the engine has ticked on to 1.30, which is 0.30s away — six
    // times the dead zone. Answering it with a seek would rewind the picture to
    // a frame it had already left (and restart the decode stream doing it).
    const { view, engine } = setup()
    act(() => { engine.setTransport('playing') })
    act(() => { for (const t of [1.0, 1.1, 1.2, 1.3]) engine.emit(t) })

    act(() => { view.rerender({ t: 1.0 }) })
    expect(engine.seeks).toEqual([])
  })

  it('external set → exactly one seek', () => {
    const { view, engine } = setup()
    act(() => { engine.emit(0.5) })

    act(() => { view.rerender({ t: 4 }) })
    expect(engine.seeks).toEqual([4])

    // The engine answers a seek by emitting the position it landed on. That
    // echo must not produce a SECOND seek for the same gesture.
    act(() => { engine.emit(4) })
    act(() => { view.rerender({ t: 4 }) })
    expect(engine.seeks).toEqual([4])
  })

  it('ignores a store nudge inside the legacy dead zone', () => {
    const { view, engine } = setup()
    act(() => { engine.emit(2) })
    act(() => { view.rerender({ t: 2 + SCRUB_DEAD_ZONE_S / 2 }) })
    expect(engine.seeks).toEqual([])
  })

  it('scrub during playback → seek + playback continues from the target', () => {
    const { view, engine } = setup()
    act(() => { engine.setTransport('playing') })
    act(() => { for (const t of [0.1, 0.2, 0.3]) engine.emit(t) })
    expect(engine.transport).toBe('playing')

    act(() => { view.rerender({ t: 7 }) })

    expect(engine.seeks).toEqual([7])
    // The bridge never pauses to scrub — `engine.seek` keeps the transport, and
    // the very next tick reports project time from the new position.
    expect(engine.pauses).toBe(0)
    expect(engine.transport).toBe('playing')

    act(() => { engine.emit(7.05) })
    expect(view.result.current.isPlaying).toBe(true)
    act(() => { view.rerender({ t: 7.05 }) })
    expect(engine.seeks).toEqual([7])
  })

  it('never seeks a disposed engine', () => {
    // Between project identities (and on unmount) the engine is torn down. The
    // bridge holds the store as its mirror while there is nothing to drive, so
    // a scrub arriving in that window is never replayed as a stale seek.
    const { view, engine } = setup()
    act(() => { view.unmount() })
    expect(engine.disposes).toBe(1)
    expect(engine.seeks).toEqual([])
  })
})

// ── Engine lifecycle ─────────────────────────────────────────────────────────

describe('useEnginePlayback engine lifecycle', () => {
  it('builds one engine per project identity and forwards edits, not rebuilds', () => {
    const project = makeProject()
    const onTimeUpdate = vi.fn()
    const view = renderHook(
      ({ p }: { p: Project }) => useEnginePlayback(p, 0, onTimeUpdate, (x) => x),
      { initialProps: { p: project } },
    )
    const engine = engines[0] as FakeEngine
    expect(engines).toHaveLength(1)
    // The project the engine was constructed with is already applied.
    expect(engine.updates).toEqual([])

    const edited = { ...project, tracks: [{ id: 'trk-0', items: [...project.tracks![0].items, { id: 'c1', type: 'video', src: 'b.mp4', start: 10, end: 12 }] }] } as Project
    act(() => { view.rerender({ p: edited }) })
    expect(engines).toHaveLength(1)
    expect(engine.updates).toEqual([edited])

    // A different project id IS a teardown.
    act(() => { view.rerender({ p: makeProject({ id: 'other' }) }) })
    expect(engines).toHaveLength(2)
    expect(engine.disposes).toBe(1)
  })

  it('exposes the legacy-shaped derived collections', () => {
    const project = makeProject({
      tracks: [
        {
          id: 'trk-0',
          items: [
            { id: 'later', type: 'video', src: 'b.mp4', start: 5, end: 8 },
            { id: 'first', type: 'video', src: 'a.mp4', start: 0, end: 5 },
            { id: 'img', type: 'image', src: 'i.png', start: 0, end: 2 },
          ],
        },
        { id: 'trk-1', items: [{ id: 'ov', type: 'overlay', src: 'o.jsx', start: 0, end: 3 }] },
      ],
    } as Partial<Project>)
    const { view } = setup(project)
    expect(view.result.current.clips.map((c) => c.id)).toEqual(['first', 'later'])
    expect(view.result.current.tracks0NonVideo.map((c) => c.id)).toEqual(['img'])
    expect(view.result.current.overlayTracks.map((tr) => tr.map((i) => i.id))).toEqual([['ov']])
    expect(view.result.current.isCanvasProject).toBe(false)
  })

  it('reports a canvas project the way the legacy hook does', () => {
    const { view } = setup(makeProject({ tracks: [{ id: 'trk-0', items: [{ id: 'img', type: 'image', src: 'i.png', start: 0, end: 2 }] }] } as Partial<Project>))
    expect(view.result.current.isCanvasProject).toBe(true)
  })

  it('getStats reads through to the live engine, and is null once there is none', () => {
    const { view, engine } = setup()
    expect(engine.statsCalls).toBe(0)

    expect(view.result.current.getStats()).toEqual({ fps: 24, dropped: 1, buffered: 2, clock: 'fallback' })
    expect(engine.statsCalls).toBe(1)

    act(() => { view.unmount() })
    expect(view.result.current.getStats()).toBeNull()
  })

  it('mirrors the picture state into the showVideo analog', () => {
    const { view, engine } = setup()
    expect(view.result.current.showVideo).toBe(false)
    act(() => {
      engine.deps.onStatusChange?.({ transport: 'paused', picture: 'video', clipId: 'c0', seeking: false, clock: 'audio' })
    })
    expect(view.result.current.showVideo).toBe(true)
    act(() => {
      engine.deps.onStatusChange?.({ transport: 'paused', picture: 'preparing', clipId: 'c0', reason: 'no editing proxy yet', seeking: false, clock: 'fallback' })
    })
    expect(view.result.current.showVideo).toBe(false)
    expect(view.result.current.status.reason).toBe('no editing proxy yet')
  })
})

// ── Gesture ownership ────────────────────────────────────────────────────────

describe('useEnginePlayback gesture anchors', () => {
  function stubSuspendedContext() {
    const resume = vi.fn(() => Promise.resolve())
    ;(window as unknown as { __montajSharedCtx?: unknown }).__montajSharedCtx = { state: 'suspended', resume }
    return resume
  }

  afterEach(() => {
    delete (window as unknown as { __montajSharedCtx?: unknown }).__montajSharedCtx
  })

  it('togglePlay resumes the shared AudioContext from the gesture, then plays', () => {
    const resume = stubSuspendedContext()
    const { view, engine } = setup()
    act(() => { view.result.current.togglePlay() })
    expect(resume).toHaveBeenCalledTimes(1)
    expect(engine.plays).toBe(1)
  })

  it('togglePlay creates the shared AudioContext BEFORE resuming it from the gesture', () => {
    // `resumeAudioContextFromGesture` deliberately never creates the context
    // (see its own doc) — on a project with no audio tracks and a video clip
    // whose context is built inside `createMasterClock`, off the gesture
    // stack entirely, nothing upstream of `togglePlay` has created it yet.
    // Without `getSharedAudioContext()` running first, inside the gesture,
    // the very first play on such a project would resume nothing.
    stubSuspendedContext()
    const { view } = setup()
    act(() => { view.result.current.togglePlay() })
    expect(getSharedAudioContext).toHaveBeenCalledTimes(1)
    expect(resumeAudioContextFromGesture).toHaveBeenCalledTimes(1)
    const getOrder = vi.mocked(getSharedAudioContext).mock.invocationCallOrder[0]
    const resumeOrder = vi.mocked(resumeAudioContextFromGesture).mock.invocationCallOrder[0]
    expect(getOrder).toBeLessThan(resumeOrder)
  })

  it('togglePlay pauses a playing transport and pushes the stop position to the clock', () => {
    const { view, engine, onTimeUpdate } = setup()
    act(() => { engine.setTransport('playing') })
    act(() => { engine.emit(3.5) })
    onTimeUpdate.mockClear()

    act(() => { view.result.current.togglePlay() })
    expect(engine.pauses).toBe(1)
    // `pause()` never ticks, so nothing but this would settle the playhead.
    expect(onTimeUpdate).toHaveBeenCalledWith(3.5)
  })

  it('Space toggles playback, with the legacy typing-surface guards', () => {
    const resume = stubSuspendedContext()
    setup()
    const engine = engines[0] as FakeEngine

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true })) })
    expect(engine.plays).toBe(1)
    expect(resume).toHaveBeenCalledTimes(1)

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true })) })
    expect(engine.pauses).toBe(1)

    // Typing a space in a text field must not toggle playback. (The guard's
    // third arm, `isContentEditable`, is not testable here — jsdom does not
    // implement the property and reports `false` for every element.)
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    document.body.append(input, textarea)
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true })) })
    act(() => { textarea.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true })) })
    expect(engine.plays).toBe(1)

    // Any other key is none of this hook's business.
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', bubbles: true })) })
    expect(engine.plays).toBe(1)
    expect(engine.pauses).toBe(1)

    input.remove()
    textarea.remove()
  })

  it('drops the keydown listener on unmount', () => {
    const { view } = setup()
    const engine = engines[0] as FakeEngine
    act(() => { view.unmount() })
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true })) })
    expect(engine.plays).toBe(0)
  })
})

// ── Audio lanes over timeline-core's audioWindow ─────────────────────────────

describe('useEnginePlayback audio lanes', () => {
  const gains: Array<{ gain: { value: number } }> = []

  beforeEach(() => {
    gains.length = 0
    ;(window as unknown as { AudioContext: unknown }).AudioContext = class {
      destination = {}
      createMediaElementSource() { return { connect() {} } }
      createGain() { const g = { gain: { value: 1 }, connect() {} }; gains.push(g); return g }
    }
  })

  afterEach(() => {
    delete (window as unknown as { __montajSharedCtx?: unknown }).__montajSharedCtx
  })

  const withAudio = () =>
    makeProject({
      audio: {
        tracks: [
          { id: 'music', src: 'music.mp3', start: 2, end: 8, inPoint: 1, volume: 0.5, fadeIn: 2 } as never,
        ],
      },
    } as Partial<Project>)

  it('places, gains and starts a lane from the engine tick', () => {
    const { view, engine } = setup(withAudio())
    const el = document.querySelector('audio') ?? null
    // The lane element is created programmatically (never mounted in the tree),
    // so reach it through the effect's own behavior instead: the gain node it
    // wired is the observable.
    expect(gains).toHaveLength(1)
    expect(el).toBeNull()

    act(() => { engine.setTransport('playing') })
    // t = 3 → 1s into the track, halfway through a 2s fade-in, at volume 0.5.
    act(() => { engine.emit(3) })
    expect(gains[0].gain.value).toBeCloseTo(0.25, 6)
    expect(view.result.current.isPlaying).toBe(true)
  })

  it('leaves the gain alone outside the track window', () => {
    const { engine } = setup(withAudio())
    act(() => { engine.emit(3) })
    const inside = gains[0].gain.value
    act(() => { engine.emit(9) })
    // Outside the window the lane is paused and the envelope is not applied —
    // exactly the legacy `continue`.
    expect(gains[0].gain.value).toBe(inside)
  })
})
