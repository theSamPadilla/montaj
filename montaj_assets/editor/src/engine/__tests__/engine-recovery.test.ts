/**
 * Phase 2 of the preview-performance work: the two ways a clip used to get
 * stuck on "Preparing preview…" forever, and the retain window that stops a
 * scrub across a cut rebuilding what it just left.
 *
 * Both stuck states came from the same design gap. `SourceState` reports
 * `loading` and `failed` into the SAME placeholder as a proxy that has not been
 * encoded yet — deliberately, because from the user's side they are the same
 * sentence — but that meant nothing distinguished "still coming" from "never
 * coming":
 *
 *  1. A fetch that never settles left the session `loading` for the lifetime of
 *     the tab. `BUILD_TIMEOUT_MS` turns it into a `failed` session with a real
 *     reason.
 *  2. A `failed` session was kept in the map precisely so `retain` would not
 *     rebuild it, which made every failure permanent — including the transient
 *     ones. `MAX_SESSION_RETRIES` with a doubling backoff rebuilds it a bounded
 *     number of times.
 *
 * `demux` is mocked because the point here is session bookkeeping, not
 * container parsing, and because these tests need to hold a build open
 * indefinitely — which no real fetch will do on request.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { EditorProject as Project, VisualItem } from '../../schema'

const demuxMock = vi.fn()
vi.mock('../demux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../demux')>()
  return { ...actual, demux: (...args: unknown[]) => demuxMock(...args) }
})

// The frame server and master clock both want WebCodecs/WebAudio, neither of
// which jsdom has. Stubbed to the smallest thing `build()` can finish against.
vi.mock('../frame-server', () => ({
  createFrameServer: vi.fn(() => ({
    src: 'stub',
    video: { samples: [], presIndex: [], firstPresentationTsUs: 0 },
    decodeAheadFrames: 30,
    seek: () => ({ reqId: 0, frame: Promise.resolve(null) }),
    startStream: () => 0,
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
    dispose: () => {},
  })),
}))

function clip(id: string, start: number, end: number, extra: Partial<VisualItem> = {}): VisualItem {
  return {
    id,
    type: 'video',
    src: `/media/${id}.mov`,
    proxySrc: `/proxies/${id}_proxy.mp4`,
    start,
    end,
    inPoint: 0,
    outPoint: end - start,
    ...extra,
  }
}

function project(items: VisualItem[]): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [{ id: 'trk-0', items }],
  } as unknown as Project
}

/** A demuxed source shaped just enough for `build()` to reach `ready`. */
function fakeDemuxed(src: string) {
  return {
    src,
    video: { kind: 'video', samples: [{ tsUs: 0 }], presIndex: [0], firstPresentationTsUs: 0 },
    audio: null,
  }
}

/** Drain the microtask queue so an in-flight `build()` settles. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0))

let clock = 0
const nowMs = () => clock

beforeEach(() => {
  clock = 0
  demuxMock.mockReset()
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

async function engineFor(items: VisualItem[]) {
  const { createEngine } = await import('../index')
  const errors: string[] = []
  const engine = createEngine(project(items), {
    fileUrl: (p) => p,
    nowMs,
    onError: (m) => errors.push(m),
    requestFrame: () => 1,
    cancelFrame: () => {},
  })
  return { engine, errors }
}

describe('build timeout', () => {
  it('aborts a build that never settles and reports why', async () => {
    vi.useFakeTimers()
    const { BUILD_TIMEOUT_MS } = await import('../index')
    // A fetch that hangs: the abort signal is the ONLY thing that can end it,
    // which is why the timeout aborts rather than racing a timer against the
    // promise (a race would resolve the build while the request stayed open).
    demuxMock.mockImplementation(
      (_src: string, _url: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          )
        }),
    )
    const { engine } = await engineFor([clip('a', 0, 4)])

    engine.seek(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(engine.status()).toMatchObject({ picture: 'preparing' })

    await vi.advanceTimersByTimeAsync(BUILD_TIMEOUT_MS + 10)

    expect(engine.status().reason).toMatch(/timed out after 20000 ms/)
    engine.dispose()
  })

  it('does not fire for a build that finishes normally', async () => {
    vi.useFakeTimers()
    const { BUILD_TIMEOUT_MS } = await import('../index')
    demuxMock.mockImplementation(async (src: string) => fakeDemuxed(src))
    const { engine, errors } = await engineFor([clip('a', 0, 4)])

    engine.seek(1)
    await vi.advanceTimersByTimeAsync(1)
    // Past the deadline: a timer left armed would abort a source that is
    // already in use.
    await vi.advanceTimersByTimeAsync(BUILD_TIMEOUT_MS * 2)

    expect(errors).toEqual([])
    expect(engine.status().reason).toBeUndefined()
    engine.dispose()
  })
})

describe('failed-session retry', () => {
  it('rebuilds a failed clip after the backoff, and succeeds when the cause clears', async () => {
    demuxMock
      .mockRejectedValueOnce(new Error('read: /proxies/a_proxy.mp4 → 503 Service Unavailable'))
      .mockImplementation(async (src: string) => fakeDemuxed(src))
    const { engine } = await engineFor([clip('a', 0, 4)])

    engine.seek(1)
    await settle()
    expect(engine.status()).toMatchObject({ picture: 'preparing' })
    expect(engine.status().reason).toMatch(/503 Service Unavailable/)
    expect(demuxMock).toHaveBeenCalledTimes(1)

    // Inside the backoff: a tick must NOT retry, or the three attempts would be
    // spent inside a few frames of the rAF loop.
    engine.seek(1.1)
    await settle()
    expect(demuxMock).toHaveBeenCalledTimes(1)

    clock = 1000
    engine.seek(1.2)
    await settle()

    expect(demuxMock).toHaveBeenCalledTimes(2)
    expect(engine.status()).toMatchObject({ picture: 'video' })
    engine.dispose()
  })

  it('gives up after MAX_SESSION_RETRIES rather than rebuilding forever', async () => {
    const { MAX_SESSION_RETRIES } = await import('../index')
    demuxMock.mockRejectedValue(new Error('corrupt proxy'))
    const { engine } = await engineFor([clip('a', 0, 4)])

    engine.seek(1)
    await settle()

    // Walk the clock far past every backoff and keep ticking.
    for (let i = 0; i < MAX_SESSION_RETRIES + 5; i++) {
      clock += 60_000
      engine.seek(1 + i * 0.01)
      await settle()
    }

    // One initial build plus exactly MAX_SESSION_RETRIES rebuilds.
    expect(demuxMock).toHaveBeenCalledTimes(MAX_SESSION_RETRIES + 1)
    expect(engine.status()).toMatchObject({ picture: 'preparing' })
    expect(engine.status().reason).toMatch(/corrupt proxy/)
    engine.dispose()
  })

  it('a src change resets the retry budget — a new proxy is a new problem', async () => {
    // A proxy arriving over SSE replaces `proxySrc`; `retain`'s drop loop tears
    // the session down for the src change, so the new one starts fresh rather
    // than inheriting an exhausted budget from the file it replaced.
    const { MAX_SESSION_RETRIES } = await import('../index')
    demuxMock.mockRejectedValue(new Error('corrupt proxy'))
    const { engine } = await engineFor([clip('a', 0, 4)])

    engine.seek(1)
    await settle()
    for (let i = 0; i < MAX_SESSION_RETRIES + 2; i++) {
      clock += 60_000
      engine.seek(1 + i * 0.01)
      await settle()
    }
    const exhausted = demuxMock.mock.calls.length

    demuxMock.mockImplementation(async (src: string) => fakeDemuxed(src))
    engine.updateProject(project([clip('a', 0, 4, { proxySrc: '/proxies/a_proxy_v2.mp4' })]))
    engine.seek(1.5)
    await settle()

    expect(demuxMock.mock.calls.length).toBe(exhausted + 1)
    expect(engine.status()).toMatchObject({ picture: 'video' })
    engine.dispose()
  })
})

describe('retain window', () => {
  it('holds the previous clip so a scrub back over a cut does not rebuild it', async () => {
    demuxMock.mockImplementation(async (src: string) => fakeDemuxed(src))
    const { engine } = await engineFor([clip('a', 0, 2), clip('b', 2, 4), clip('c', 4, 6)])

    engine.seek(1)
    await settle()
    engine.seek(3)
    await settle()
    const afterForward = demuxMock.mock.calls.length

    // Back over the cut. 'a' was retained as the clip behind the playhead, so
    // there is nothing to rebuild — no new demux, and the picture is live
    // immediately rather than passing through `preparing`.
    engine.seek(1)
    await settle()

    expect(demuxMock.mock.calls.length).toBe(afterForward)
    expect(engine.status()).toMatchObject({ picture: 'video', clipId: 'a' })
    engine.dispose()
  })
})
