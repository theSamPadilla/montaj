/**
 * SP4 T5 — `EngineSourceHost.retain`/`build`'s session lifecycle.
 *
 * `engine.test.ts` deliberately never reaches this surface — its own header
 * explains why: a canvas project has no track-0 video, so nothing there ever
 * touches `demux`/`frame-server`/WebCodecs, and the whole suite runs against a
 * real `EngineSourceHost` for exactly that reason. This file is the one place
 * that DOES reach it, over a real `createEngine` + `updateProject` (the class
 * itself is not exported — there is no other way in), with `demux`,
 * `frame-server` and `audio-clock`'s `createMasterClock` module-mocked in the
 * `useEnginePlayback.test.tsx` style: spy-wrapped fakes reached via
 * `importOriginal`, hoisted with `vi.hoisted` so the mock factories (which run
 * before the rest of this file's top-level code) can close over them.
 *
 * Regression coverage for two bugs the final SP4 review caught in `retain()`:
 *   - a mid-session TRIM (start or inPoint change, same src) left the master
 *     clock on its pre-trim timebase, because `retain` only rebuilt a session
 *     when `src` itself changed;
 *   - `volume`/`muted` edits on a live clip never reached the session at all
 *     (`MasterClock.setVolume` had zero call sites anywhere in the engine).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorProject as Project, VisualItem } from '../../schema'

interface FakeServerState {
  disposed: boolean
}
interface FakeClockState {
  volume: number
  /** What `createMasterClock` was asked for — a muted clip gets a wall clock, not an audio one. */
  muted: boolean
  disposed: boolean
  setVolume: ReturnType<typeof vi.fn>
}

const demuxCalls = vi.hoisted(() => [] as string[])
const demuxSignals = vi.hoisted(() => [] as AbortSignal[])
const serverInstances = vi.hoisted(() => [] as FakeServerState[])
const clockInstances = vi.hoisted(() => [] as FakeClockState[])
const chunkSourceStub = vi.hoisted(() => () => ({
  kind: 'video' as const,
  codec: 'av01.0.05M.08',
  fps: 30,
  durationS: 10,
  coded: { width: 1280, height: 720 },
  samples: [] as unknown[],
  presIndex: [] as number[],
  firstPresentationTsUs: 0,
}))

vi.mock('../demux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../demux')>()
  return {
    ...actual,
    demux: vi.fn(async (src: string, _fileUrl: unknown, opts?: { signal?: AbortSignal }) => {
      demuxCalls.push(src)
      if (opts?.signal) demuxSignals.push(opts.signal)
      return { src, video: chunkSourceStub(), audio: null }
    }),
  }
})

vi.mock('../frame-server', () => ({
  createFrameServer: vi.fn((options: { source: { src: string } }) => {
    const state: FakeServerState = { disposed: false }
    serverInstances.push(state)
    return {
      src: options.source.src,
      video: chunkSourceStub(),
      decodeAheadFrames: 8,
      seek: () => ({ reqId: 1, frame: Promise.resolve(null) }),
      startStream: () => 1,
      stopStream: () => {},
      nextFrameFor: () => ({ frame: null, dropped: 0 }),
      stats: () => ({
        buffered: 0,
        inFlightFrames: 0,
        inFlightBatches: 0,
        received: 0,
        dropped: 0,
        atEndOfSource: false,
        drained: false,
        lastError: null,
      }),
      dispose: () => {
        state.disposed = true
      },
    }
  }),
}))

vi.mock('../audio-clock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audio-clock')>()
  return {
    ...actual,
    createMasterClock: vi.fn(async (opts: { volume?: number; muted?: boolean; startProjectS: number }) => {
      const state: FakeClockState = {
        volume: opts.muted ? 0 : (opts.volume ?? 1),
        muted: !!opts.muted,
        disposed: false,
        setVolume: vi.fn((v: number) => {
          state.volume = v
        }),
      }
      clockInstances.push(state)
      let playing = false
      let t = opts.startProjectS
      return {
        kind: 'fallback' as const,
        get playing() {
          return playing
        },
        now: () => t,
        play: () => {
          playing = true
        },
        pause: () => {
          playing = false
        },
        seek: (next: number) => {
          t = next
        },
        setVolume: state.setVolume,
        setTransportRate: () => {},
        stats: () => ({
          kind: 'fallback' as const,
          playing,
          samplesConsumed: 0,
          underrunFrames: 0,
          queuedFrames: 0,
          queuedSeconds: 0,
        }),
        dispose: () => {
          state.disposed = true
        },
      }
    }),
  }
})

// Imported AFTER the mock declarations for readability only — vi.mock is hoisted.
import { createEngine } from '../index'
import { createMasterClock } from '../audio-clock'

function videoItem(overrides: Partial<VisualItem> = {}): VisualItem {
  return {
    id: 'a',
    type: 'video',
    src: '/media/a.mov',
    proxySrc: '/proxies/a_proxy.mp4',
    start: 0,
    end: 5,
    inPoint: 0,
    outPoint: 5,
    ...overrides,
  } as VisualItem
}

/** `track` carries the TRACK's own settings — absent on every project nobody has touched. */
function videoProject(item: VisualItem, track: { volume?: number; muted?: boolean } = {}): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [{ id: 'trk-0', items: [item], ...track }],
  } as Project
}

/** Drain the microtask queue past `build()`'s two sequential awaits (demux, then createMasterClock). */
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

beforeEach(() => {
  demuxCalls.length = 0
  demuxSignals.length = 0
  serverInstances.length = 0
  clockInstances.length = 0
})

describe('EngineSourceHost.retain — trim, mute and volume edits', () => {
  it('rebuilds the session when inPoint changes on the same src (a trim)', async () => {
    const item = videoItem()
    const engine = createEngine(videoProject(item), { fileUrl: (p) => p, nowMs: () => 0 })
    engine.seek(0) // kicks off the first retain/build — the constructor alone does not
    await flush()
    expect(clockInstances).toHaveLength(1)
    expect(serverInstances).toHaveLength(1)

    engine.updateProject(videoProject({ ...item, inPoint: 1 }))
    await flush()

    // The old session's clock and worker are torn down, and a fresh pair is
    // built — proof the stale pre-trim timebase was not just left running.
    expect(clockInstances).toHaveLength(2)
    expect(clockInstances[0].disposed).toBe(true)
    expect(serverInstances).toHaveLength(2)
    expect(serverInstances[0].disposed).toBe(true)
    // The demux cache is keyed by src, not by the trim — the parsed bytes are
    // shared across the rebuild rather than re-fetched.
    expect(demuxCalls).toEqual(['/proxies/a_proxy.mp4'])

    engine.dispose()
  })

  it('pushes a volume-only change to the live clock instead of rebuilding', async () => {
    const item = videoItem({ volume: 1 })
    const engine = createEngine(videoProject(item), { fileUrl: (p) => p, nowMs: () => 0 })
    engine.seek(0)
    await flush()
    expect(clockInstances).toHaveLength(1)

    engine.updateProject(videoProject({ ...item, volume: 0.4 }))
    await flush()

    expect(clockInstances).toHaveLength(1) // no rebuild
    expect(clockInstances[0].disposed).toBe(false)
    expect(clockInstances[0].setVolume).toHaveBeenCalledWith(0.4)
    expect(clockInstances[0].volume).toBe(0.4)

    engine.dispose()
  })

  it('rebuilds the session when muted toggles (the clock kind depends on it)', async () => {
    const item = videoItem({ muted: false })
    const engine = createEngine(videoProject(item), { fileUrl: (p) => p, nowMs: () => 0 })
    engine.seek(0)
    await flush()
    expect(clockInstances).toHaveLength(1)

    engine.updateProject(videoProject({ ...item, muted: true }))
    await flush()

    expect(clockInstances).toHaveLength(2)
    expect(clockInstances[0].disposed).toBe(true)

    engine.dispose()
  })
})

describe('EngineSourceHost.retain — the TRACK\'s volume and mute', () => {
  // The host never learns that tracks exist: the scheduler folds each clip's
  // track into the request before it is built, so everything below is the
  // SAME two branches the clip-level cases above exercise — a live `setVolume`
  // for a volume change, a respawn for a mute change.

  it('builds the clock at the PRODUCT of the track and clip volumes', async () => {
    // Multiplying, not replacing: a clip mixed down to 0.8 under a track at
    // half stays at 0.4, not at 0.5.
    const engine = createEngine(videoProject(videoItem({ volume: 0.8 }), { volume: 0.5 }), {
      fileUrl: (p) => p,
      nowMs: () => 0,
    })
    engine.seek(0)
    await flush()
    expect(clockInstances[0].volume).toBeCloseTo(0.4, 10)
    engine.dispose()
  })

  it('keeps the mix between two clips when the track is pulled down', async () => {
    // The property that makes the product rule right: both clips move by the
    // same factor, so the 2:1 balance the editor set survives the track fader.
    const a = videoItem({ id: 'a', start: 0, end: 3, outPoint: 3, volume: 0.8 })
    const b = videoItem({ id: 'b', src: '/media/b.mov', proxySrc: '/proxies/b_proxy.mp4', start: 3, end: 6, inPoint: 0, outPoint: 3, volume: 0.4 })
    const project: Project = {
      id: 'p1',
      status: 'draft',
      settings: { resolution: [1080, 1920], fps: 30 },
      tracks: [{ id: 'trk-0', items: [a, b], volume: 0.5 }],
    } as Project
    const engine = createEngine(project, { fileUrl: (p) => p, nowMs: () => 0 })

    engine.seek(2) // 'a' active, 'b' inside the prewarm lead — both sessions build
    await flush()

    expect(clockInstances).toHaveLength(2)
    expect(clockInstances[0].volume).toBeCloseTo(0.4, 10)
    expect(clockInstances[1].volume).toBeCloseTo(0.2, 10)
    expect(clockInstances[0].volume / clockInstances[1].volume).toBeCloseTo(2, 10)

    engine.dispose()
  })

  it('leaves the clip volume alone when the track carries no settings', async () => {
    const engine = createEngine(videoProject(videoItem({ volume: 0.8 })), { fileUrl: (p) => p, nowMs: () => 0 })
    engine.seek(0)
    await flush()
    expect(clockInstances[0].volume).toBeCloseTo(0.8, 10)
    engine.dispose()
  })

  it('mutes a clip on a muted track whatever its own volume says', async () => {
    // `muted` is a construction-time decision (a muted clip runs on a wall
    // clock, not an audio one), so this has to reach `createMasterClock`
    // itself — a volume of 0 would not be the same thing.
    const engine = createEngine(videoProject(videoItem({ volume: 2 }), { muted: true }), {
      fileUrl: (p) => p,
      nowMs: () => 0,
    })
    engine.seek(0)
    await flush()
    expect(clockInstances[0].muted).toBe(true)
    expect(clockInstances[0].volume).toBe(0)
    engine.dispose()
  })

  it('keeps a muted clip muted on an unmuted track', async () => {
    const engine = createEngine(videoProject(videoItem({ muted: true }), { volume: 1 }), {
      fileUrl: (p) => p,
      nowMs: () => 0,
    })
    engine.seek(0)
    await flush()
    expect(clockInstances[0].muted).toBe(true)
    engine.dispose()
  })

  it('rebuilds the session when the TRACK mute toggles, exactly as a clip mute does', async () => {
    const item = videoItem({ muted: false })
    const engine = createEngine(videoProject(item), { fileUrl: (p) => p, nowMs: () => 0 })
    engine.seek(0)
    await flush()
    expect(clockInstances).toHaveLength(1)
    expect(clockInstances[0].muted).toBe(false)

    // Same clip, muted track. Compare with 'rebuilds the session when muted
    // toggles' above: identical outcome, which is the whole point of folding
    // before the request is built rather than teaching `retain` about tracks.
    engine.updateProject(videoProject(item, { muted: true }))
    await flush()

    expect(clockInstances).toHaveLength(2)
    expect(clockInstances[0].disposed).toBe(true)
    expect(clockInstances[1].muted).toBe(true)

    engine.dispose()
  })

  it('pushes a TRACK volume change to the live clock instead of rebuilding', async () => {
    const item = videoItem({ volume: 0.8 })
    const engine = createEngine(videoProject(item, { volume: 1 }), { fileUrl: (p) => p, nowMs: () => 0 })
    engine.seek(0)
    await flush()
    expect(clockInstances).toHaveLength(1)

    engine.updateProject(videoProject(item, { volume: 0.5 }))
    await flush()

    expect(clockInstances).toHaveLength(1) // no rebuild — a fader move must not restart the decoder
    expect(clockInstances[0].setVolume).toHaveBeenCalledWith(0.4)
    expect(clockInstances[0].volume).toBeCloseTo(0.4, 10)

    engine.dispose()
  })
})

describe('EngineSourceHost.abandonDemux — every waiter must abandon before the fetch aborts', () => {
  it('aborts only once the SECOND of two clips sharing an in-flight demux drops (not the first)', () => {
    // Two clips cut from the SAME proxy — the doc's own "fifty clips off one
    // proxy" case — both prewarmed together (b.start - t <= PREWARM_LEAD_S)
    // so a single `retain()` starts both sessions against the SAME in-flight
    // demux fetch. Everything below runs with NO `await` in between: the
    // mocked `demux()` resolves on the microtask queue, so as long as nothing
    // yields, `waiters` stays exactly what both `startSession` calls left it
    // at when both clips are dropped.
    const a = videoItem({ id: 'a', start: 0, end: 3, outPoint: 3 })
    const b = videoItem({ id: 'b', start: 3, end: 6, inPoint: 0, outPoint: 3 })
    const project: Project = {
      id: 'p1',
      status: 'draft',
      settings: { resolution: [1080, 1920], fps: 30 },
      tracks: [{ id: 'trk-0', items: [a, b] }],
    } as Project
    const engine = createEngine(project, { fileUrl: (p) => p, nowMs: () => 0 })

    engine.seek(2) // clip 'a' active, clip 'b' one second out — inside PREWARM_LEAD_S
    expect(demuxSignals).toHaveLength(1) // one shared in-flight fetch, not two

    // Drop both clips before the shared demux ever resolves.
    engine.updateProject({ ...project, tracks: [{ id: 'trk-0', items: [] }] } as Project)

    expect(demuxSignals[0].aborted).toBe(true)

    engine.dispose()
  })
})

describe('EngineSourceHost.build — server-ref release on a throw after acquireServer', () => {
  it('releases the frame server when createMasterClock throws, instead of leaking the ref', async () => {
    vi.mocked(createMasterClock).mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    const item = videoItem()
    const engine = createEngine(videoProject(item), { fileUrl: (p) => p, nowMs: () => 0 })
    engine.seek(0)
    await flush()

    // The server was acquired (a worker was actually spun up) before the
    // clock construction failed, and the catch path must release that ref
    // itself — nothing else in the failure path ever gets a chance to,
    // because `session.source` was never assigned.
    expect(serverInstances).toHaveLength(1)
    expect(serverInstances[0].disposed).toBe(true)

    engine.dispose()
  })
})

// ── T4: shared demux LRU / pinned acquireDemux ──────────────────────────────
describe('EngineSourceHost.acquirePinnedDemux — shared demux LRU', () => {
  it('coalesces concurrent acquires on the same src (one demux call, one dispose per pin)', async () => {
    const engine = createEngine(videoProject(videoItem()), { fileUrl: (p) => p, nowMs: () => 0 })
    const [a, b] = await Promise.all([
      engine.acquireDemux('/proxies/z.mp4'),
      engine.acquireDemux('/proxies/z.mp4'),
    ])
    // Both pins reference the SAME cached source — the whole point of sharing.
    expect(a.source).toBe(b.source)
    expect(demuxCalls.filter((s) => s === '/proxies/z.mp4')).toHaveLength(1)

    a.release()
    // Second release is idempotent; the counter drops to zero here.
    b.release()
    b.release()

    engine.dispose()
  })

  it('keeps a pinned src warm across a re-acquire even after the pin is released', async () => {
    const engine = createEngine(videoProject(videoItem()), { fileUrl: (p) => p, nowMs: () => 0 })
    const a = await engine.acquireDemux('/proxies/z.mp4')
    a.release()
    // Cache hit on the second acquire — no additional demux.
    const b = await engine.acquireDemux('/proxies/z.mp4')
    expect(demuxCalls.filter((s) => s === '/proxies/z.mp4')).toHaveLength(1)
    b.release()

    engine.dispose()
  })

  it('a scheduler session pins the src too — the scrubber releasing does not evict a live server', async () => {
    const item = videoItem()
    const engine = createEngine(videoProject(item), { fileUrl: (p) => p, nowMs: () => 0 })
    engine.seek(0)
    await flush()
    // Take a pin ON TOP of the scheduler's own use.
    const pin = await engine.acquireDemux('/proxies/a_proxy.mp4')
    pin.release()
    // Scheduler session still holds the server, so nothing torn down.
    expect(serverInstances).toHaveLength(1)
    expect(serverInstances[0].disposed).toBe(false)

    engine.dispose()
  })
})
