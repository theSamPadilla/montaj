/**
 * SP4 T5 — every transport transition, over fakes.
 *
 * The scheduler is a synchronous state machine over three injected surfaces
 * (`SourceHost`, `Painter`, `MasterClock`), so all of it is reachable in jsdom
 * with no WebCodecs, no `Worker` and no canvas. What these tests CAN prove is
 * every transition the plan names — play into a gap, scrub into a gap, scrub
 * past the end, loop wrap, boundary swap, opaque toggle mid-play, decode
 * failure mid-clip — plus the `VideoFrame` ownership contract on each path.
 * What they cannot prove (that a real decoder returns real frames) is what T9's
 * operator parity checklist is for; there are no pretend-integration tests
 * against a mock of the whole browser here.
 *
 * The fakes are deliberately dumb: the clock is a settable number, the frame
 * server records calls, the host is a map. Every test drives time explicitly
 * (`host.setTime(t); scheduler.tick()`) so nothing depends on rAF or timers.
 */
import { describe, expect, it, vi } from 'vitest'
import type { EditorProject as Project, VisualItem } from '../../schema'
import type { MasterClock } from '../audio-clock'
import type { ChunkSource } from '../demux'
import type { FrameServer, FrameServerStats } from '../frame-server'
import {
  createScheduler,
  drawPlanFor,
  endsOnLoopBoundary,
  engineSrcFor,
  placeInSource,
  planTick,
  track0VideoItems,
  transportEndFor,
  type ClipSource,
  type DrawPlan,
  type EngineStatus,
  type Painter,
  type Scheduler,
  type SourceHost,
  type SourceRequest,
  type SourceState,
} from '../scheduler'

/** `Array.prototype.at` is ES2022; this package targets ES2020. */
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1]

// ── Fakes ───────────────────────────────────────────────────────────────────

class FakeClock implements MasterClock {
  playing = false
  disposed = false
  t: number
  readonly seeks: number[] = []
  /** Second arg of every `seek` call, aligned index-for-index with `seeks` — `undefined` when omitted. */
  readonly seekMediaS: Array<number | undefined> = []
  /** Every `setTransportRate` call, in order — the propagation test reads this. */
  readonly rates: number[] = []
  constructor(
    readonly kind: 'audio' | 'fallback',
    start: number,
  ) {
    this.t = start
  }
  now() {
    return this.t
  }
  play() {
    this.playing = true
  }
  pause() {
    this.playing = false
  }
  seek(projectS: number, mediaS?: number) {
    this.seeks.push(projectS)
    this.seekMediaS.push(mediaS)
    this.t = projectS
  }
  setVolume() {}
  setTransportRate(rate: number) {
    this.rates.push(rate)
  }
  stats() {
    return {
      kind: this.kind,
      playing: this.playing,
      samplesConsumed: 0,
      underrunFrames: 0,
      queuedFrames: 0,
      queuedSeconds: 0,
    }
  }
  dispose() {
    this.disposed = true
    this.playing = false
  }
}

interface FakeFrame {
  timestamp: number
  displayWidth: number
  displayHeight: number
  closed: boolean
  close(): void
}

function fakeFrame(timestamp: number, w = 1280, h = 720): FakeFrame {
  return {
    timestamp,
    displayWidth: w,
    displayHeight: h,
    closed: false,
    close() {
      this.closed = true
    },
  }
}

const asFrame = (f: FakeFrame) => f as unknown as VideoFrame

function chunkSource(firstPresentationTsUs = 0): ChunkSource {
  return {
    kind: 'video',
    codec: 'av01.0.05M.08',
    fps: 30,
    durationS: 10,
    coded: { width: 1280, height: 720 },
    samples: [],
    presIndex: [],
    firstPresentationTsUs,
  }
}

class FakeFrameServer implements FrameServer {
  decodeAheadFrames = 8
  readonly video: ChunkSource
  readonly starts: number[] = []
  readonly seekTargets: number[] = []
  readonly pulls: number[] = []
  stops = 0
  disposed = false
  /** What `nextFrameFor` hands back, if anything. */
  supply: ((clockUs: number) => FakeFrame | null) | null = null
  /** Resolvers for outstanding `seek()` promises, newest last. */
  readonly pendingSeeks: Array<(f: VideoFrame | null) => void> = []

  constructor(
    readonly src: string,
    firstPresentationTsUs = 0,
  ) {
    this.video = chunkSource(firstPresentationTsUs)
  }

  seek(targetTsUs: number) {
    this.seekTargets.push(targetTsUs)
    let resolve: (f: VideoFrame | null) => void = () => {}
    const frame = new Promise<VideoFrame | null>((r) => {
      resolve = r
    })
    this.pendingSeeks.push(resolve)
    return { reqId: this.seekTargets.length, frame }
  }
  startStream(targetTsUs: number) {
    this.starts.push(targetTsUs)
    return this.starts.length
  }
  stopStream() {
    this.stops++
  }
  nextFrameFor(clockUs: number) {
    this.pulls.push(clockUs)
    const f = this.supply?.(clockUs) ?? null
    return { frame: f ? asFrame(f) : null, dropped: 0 }
  }
  stats(): FrameServerStats {
    return {
      buffered: 0,
      inFlightFrames: 0,
      inFlightBatches: 0,
      received: 0,
      dropped: 0,
      atEndOfSource: false,
      drained: false,
      lastError: null,
    }
  }
  dispose() {
    this.disposed = true
  }
}

interface FakeSession {
  src: string
  item: VisualItem
  server: FakeFrameServer
  /** The `serverEntries` key this session holds a ref under — see `acquireServer`. */
  key: string
  /** Whether it was BUILT exclusive, which is what the real host stamps on its session. */
  exclusive: boolean
  clock: FakeClock
  ready: boolean
  failed?: string
  /**
   * Cached, exactly as the real host caches it on its `Session`. Handing back a
   * fresh object each call would read as "the session was rebuilt" and make the
   * scheduler respawn the decoder on every tick.
   */
  source?: ClipSource
}

class FakeHost implements SourceHost {
  readonly sessions = new Map<string, FakeSession>()
  readonly retainLog: SourceRequest[][] = []
  readonly droppedClips: string[] = []
  readonly fallbacks: FakeClock[] = []
  /** When false, a retained clip stays `loading` until `ready()` is called. */
  autoReady = true
  /**
   * When false, `exclusiveServer` is ignored and both sides of a blend land on
   * one server — the state `blendSideFor`'s same-server assertion exists for.
   * The real host always honours it; this is the only way to reach that branch.
   */
  honourExclusive = true
  scheduler: Scheduler | null = null
  private time = 0
  private readonly clocks: FakeClock[] = []
  /** Frame servers by server KEY, with the clips referencing each — see `acquireServer`. */
  private readonly serverEntries = new Map<string, { server: FakeFrameServer; refs: Set<string> }>()

  retain(requests: readonly SourceRequest[]): void {
    this.retainLog.push([...requests])
    for (const [clipId, session] of [...this.sessions]) {
      const want = requests.find((r) => r.clipId === clipId && r.src === session.src)
      // A clip that BECOMES exclusive is respawned onto a server of its own,
      // exactly as the real host does it (`index.ts`'s `retain`): a live
      // session cannot change servers, and the incoming side of a blend is
      // usually already built as `next` before the overlap starts. The reverse
      // edge is NOT a respawn there either — the real host re-files the entry
      // under the shared key instead, bookkeeping this fake has no way to show.
      if (want && !(want.exclusiveServer && !session.exclusive)) continue
      this.sessions.delete(clipId)
      this.droppedClips.push(clipId)
      this.releaseServer(session.key, clipId)
      session.clock.dispose()
    }
    for (const request of requests) {
      if (this.sessions.has(request.clipId)) continue
      const clock = new FakeClock('audio', request.anchorProjectS)
      clock.t = this.time
      this.clocks.push(clock)
      const exclusive = !!request.exclusiveServer
      const key =
        exclusive && this.honourExclusive ? `${request.src}#${request.clipId}` : request.src
      this.sessions.set(request.clipId, {
        src: request.src,
        item: request.item,
        server: this.acquireServer(key, request.src, request.clipId),
        key,
        exclusive,
        clock,
        ready: this.autoReady,
      })
    }
  }

  /**
   * One `FakeFrameServer` per KEY, refcounted by clip — the real host's rule
   * (`index.ts`: "FrameServer — one per `src`, refcounted by clip … Two clips
   * never stream from one server at once"), including its one carve-out: an
   * `exclusiveServer` request is filed under `${src}#${clipId}` and gets a
   * server of its own. A fake that handed EVERY clip its own server would let
   * a crossfade between two cuts of ONE take blend in these tests and hard-cut
   * in the browser; a fake that honoured no exclusivity at all would do the
   * reverse, and fail the blend that now works.
   */
  private acquireServer(key: string, src: string, clipId: string): FakeFrameServer {
    let entry = this.serverEntries.get(key)
    if (!entry) {
      entry = { server: new FakeFrameServer(src), refs: new Set() }
      this.serverEntries.set(key, entry)
    }
    entry.refs.add(clipId)
    return entry.server
  }

  private releaseServer(key: string, clipId: string): void {
    const entry = this.serverEntries.get(key)
    if (!entry) return
    entry.refs.delete(clipId)
    if (entry.refs.size > 0) return
    entry.server.dispose()
    this.serverEntries.delete(key)
  }

  state(clipId: string): SourceState {
    const session = this.sessions.get(clipId)
    if (!session) return { status: 'idle' }
    if (session.failed) return { status: 'failed', reason: session.failed }
    if (!session.ready) return { status: 'loading' }
    session.source ??= {
      clipId,
      src: session.src,
      frameServer: session.server,
      clock: session.clock,
      timebase: {
        start: session.item.start,
        inPoint: session.item.inPoint ?? 0,
        // The AUDIO origin. The scheduler must read the VIDEO one off the frame
        // server; a non-zero value here proves it does not use this.
        firstPresentationTsUs: 999_000,
      },
    }
    return { status: 'ready', source: session.source }
  }

  fallbackClock(startProjectS: number): MasterClock {
    const clock = new FakeClock('fallback', startProjectS)
    clock.t = this.time
    this.clocks.push(clock)
    this.fallbacks.push(clock)
    return clock
  }

  // ── test controls ───────────────────────────────────────────────────────

  /** Move every clock the scheduler could be holding to `t`. */
  setTime(t: number): void {
    this.time = t
    for (const clock of this.clocks) clock.t = t
  }
  ready(clipId: string): void {
    const session = this.sessions.get(clipId)
    if (!session) throw new Error(`no session for ${clipId}`)
    session.ready = true
    session.failed = undefined
    this.scheduler?.sourceChanged(clipId)
  }
  fail(clipId: string, reason: string): void {
    const session = this.sessions.get(clipId)
    if (!session) throw new Error(`no session for ${clipId}`)
    session.failed = reason
    session.source = undefined
    session.clock.dispose()
    this.scheduler?.sourceChanged(clipId)
  }
  server(clipId: string): FakeFrameServer {
    const session = this.sessions.get(clipId)
    if (!session) throw new Error(`no session for ${clipId}`)
    return session.server
  }
  lastRetain(): SourceRequest[] {
    return this.retainLog[this.retainLog.length - 1] ?? []
  }
}

class FakePainter implements Painter {
  readonly paints: Array<{ frame: FakeFrame; plan: DrawPlan }> = []
  /** Every `paintBlend` call — the crossfade tests read `p` and both frames off this. */
  readonly blends: Array<{
    from: FakeFrame
    to: FakeFrame
    p: number
    fromPlan: DrawPlan
    toPlan: DrawPlan
  }> = []
  clears = 0
  constructor(
    private readonly width = 1080,
    private readonly height = 1920,
  ) {}
  size() {
    return { width: this.width, height: this.height }
  }
  paint(frame: VideoFrame, plan: DrawPlan) {
    this.paints.push({ frame: frame as unknown as FakeFrame, plan })
  }
  paintBlend(from: VideoFrame, to: VideoFrame, p: number, fromPlan: DrawPlan, toPlan: DrawPlan) {
    this.blends.push({
      from: from as unknown as FakeFrame,
      to: to as unknown as FakeFrame,
      p,
      fromPlan,
      toPlan,
    })
  }
  clear() {
    this.clears++
  }
}

// ── Project builders ────────────────────────────────────────────────────────

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

function overlay(id: string, start: number, end: number, opaque = false): VisualItem {
  return { id, type: 'overlay', src: `/overlays/${id}.jsx`, start, end, opaque }
}

function project(
  track0: VisualItem[],
  overlays: VisualItem[] = [],
  extra: Partial<Project> = {},
): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: overlays.length > 0 ? [track0, overlays] : [track0],
    ...extra,
  } as Project
}

/**
 * Two track-0 clips that really are a crossfade pair: they overlap on [3, 4)
 * and `b` outlives `a`, so `transitionPairs` pairs them rather than reading it
 * as containment. `p` is 0.5 at t = 3.5, the midpoint of the overlap.
 */
function crossfade(overlays: VisualItem[] = [], extra: Partial<VisualItem> = {}): Project {
  return project([clip('a', 0, 4, extra), clip('b', 3, 8, extra)], overlays)
}

interface Harness {
  scheduler: Scheduler
  host: FakeHost
  painter: FakePainter
  times: number[]
  statuses: EngineStatus[]
}

function harness(p: Project, opts: { autoReady?: boolean; painter?: FakePainter } = {}): Harness {
  const host = new FakeHost()
  host.autoReady = opts.autoReady ?? true
  const painter = opts.painter ?? new FakePainter()
  const times: number[] = []
  const statuses: EngineStatus[] = []
  const scheduler = createScheduler({
    project: p,
    host,
    painter,
    onTime: (t) => times.push(t),
    onStatusChange: (s) => statuses.push(s),
  })
  host.scheduler = scheduler
  return { scheduler, host, painter, times, statuses }
}

/** Move the clocks and run one tick. */
function step(h: Harness, t: number): void {
  h.host.setTime(t)
  h.scheduler.tick()
}

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('track0VideoItems', () => {
  it('keeps only track-0 video items, sorted by start (the legacy `clips` memo)', () => {
    const p = project(
      [
        { id: 'img', type: 'image', src: '/a.png', start: 0, end: 1 },
        clip('b', 5, 7),
        clip('a', 0, 2),
      ],
      [overlay('o', 0, 9)],
    )
    expect(track0VideoItems(p).map((c) => c.id)).toEqual(['a', 'b'])
  })
})

describe('transportEndFor', () => {
  it('uses projectEnd for a video project — audio tail included', () => {
    const p = project([clip('a', 0, 4)], [overlay('o', 0, 5)], {
      audio: { tracks: [{ id: 'm', src: '/m.mp3', start: 0, end: 8 }] },
    })
    expect(transportEndFor(p)).toBe(8)
  })

  it('counts track 0 in a canvas project — an overlay-only single track is not a zero-length transport', () => {
    // The shape an animations-workflow project actually has: ONE track, holding
    // nothing but overlays, and no captions. Reading the ceiling off
    // `tracks.slice(1)` made this 0, so play/space started the transport and
    // stopped it in the same tick — the picture never moved.
    const p = project([overlay('o1', 0, 5), overlay('o2', 5, 12)])
    expect(p.tracks).toHaveLength(1)
    expect(transportEndFor(p)).toBe(12)
  })

  it('counts track 0 images in a canvas project, even past the overlay tracks', () => {
    // Same defect, other content kind: a background image outlasting every
    // overlay used to be invisible to the ceiling.
    const p = project(
      [{ id: 'img', type: 'image', src: '/a.png', start: 0, end: 9 }],
      [overlay('o', 0, 4)],
    )
    expect(transportEndFor(p)).toBe(9)
  })

  it('uses max(visualEnd, captionEnd) for a canvas project — audio EXCLUDED', () => {
    // The legacy canvas rAF's ceiling is `canvasMaxEndRef`, which really does
    // leave audio out. Faithful, not unified.
    const p = project([{ id: 'img', type: 'image', src: '/a.png', start: 0, end: 3 }], [
      overlay('o', 0, 4),
    ], {
      audio: { tracks: [{ id: 'm', src: '/m.mp3', start: 0, end: 30 }] },
      captions: { style: 'pop', segments: [{ text: 'hi', start: 0, end: 6 }] },
    })
    expect(transportEndFor(p)).toBe(6)
  })
})

describe('engineSrcFor — proxy-only playback is structural', () => {
  it('accepts the proxy when the resolver chose it', () => {
    const c = clip('a', 0, 2)
    expect(engineSrcFor(c, { src: c.proxySrc })).toEqual({ src: c.proxySrc })
  })

  it('blocks a clip with no proxy yet — never opens the master', () => {
    const c = clip('a', 0, 2, { proxySrc: undefined })
    const result = engineSrcFor(c, { src: c.src })
    expect(result.src).toBe('')
    expect(result.blocked).toMatch(/proxy/i)
  })

  it('blocks a clip whose nobg_preview_src outranks the proxy', () => {
    const c = clip('a', 0, 2, { nobg_preview_src: '/nobg/a.webm' })
    const result = engineSrcFor(c, { src: '/nobg/a.webm' })
    expect(result.src).toBe('')
    expect(result.blocked).toMatch(/decode/i)
  })
})

describe('placeInSource — the loopOffset reimplementation', () => {
  const window = { inPoint: 0, outPoint: 2 }

  it('maps project time linearly for a non-looping clip', () => {
    const c = clip('a', 10, 14)
    expect(placeInSource(c, { inPoint: 1.5, outPoint: 5.5 }, 12)).toEqual({
      mediaS: 3.5,
      wraps: 0,
      loopOffset: 0,
      looping: false,
    })
  })

  it('wraps a looping clip and derives loopOffset from t', () => {
    const c = clip('a', 0, 10, { loop: true })
    expect(placeInSource(c, window, 0.5)).toMatchObject({ mediaS: 0.5, wraps: 0, loopOffset: 0 })
    expect(placeInSource(c, window, 2.5)).toMatchObject({ mediaS: 0.5, wraps: 1, loopOffset: 2 })
    expect(placeInSource(c, window, 4.5)).toMatchObject({ mediaS: 0.5, wraps: 2, loopOffset: 4 })
  })

  it('scrubbing into a looped region lands where a wrap would have', () => {
    // The property the legacy hook's two writers of `loopOffsetRef` were trying
    // to keep by hand; here it holds by construction.
    const c = clip('a', 0, 10, { loop: true })
    expect(placeInSource(c, window, 6.75)).toEqual(placeInSource(c, window, 6.75))
    expect(placeInSource(c, window, 6.75).mediaS).toBeCloseTo(0.75, 9)
  })

  it('falls back to the non-loop branch when there is no outPoint', () => {
    const c = clip('a', 0, 10, { loop: true, outPoint: undefined })
    expect(placeInSource(c, { inPoint: 0, outPoint: undefined }, 5)).toMatchObject({
      mediaS: 5,
      looping: false,
    })
  })

  it('falls back to the non-loop branch on a degenerate window', () => {
    const c = clip('a', 0, 10, { loop: true })
    expect(placeInSource(c, { inPoint: 3, outPoint: 3 }, 5)).toMatchObject({
      mediaS: 8,
      looping: false,
    })
  })

  it('clamps to the in-point before the clip starts', () => {
    const c = clip('a', 5, 9)
    expect(placeInSource(c, { inPoint: 2, outPoint: 6 }, 1).mediaS).toBe(2)
  })

  it('scales the source traversal by per-clip speed (non-looping)', () => {
    // speed 2: 2.5s into the clip consumes 5s of source; speed 0.5 consumes 1.25s.
    const fast = clip('a', 10, 14, { speed: 2 })
    expect(placeInSource(fast, { inPoint: 1, outPoint: 9 }, 12.5)).toMatchObject({
      mediaS: 1 + 5,
      wraps: 0,
      looping: false,
    })
    const slow = clip('a', 10, 14, { speed: 0.5 })
    expect(placeInSource(slow, { inPoint: 1, outPoint: 9 }, 12.5).mediaS).toBeCloseTo(1 + 1.25, 9)
  })

  it('speed 1 (and absent speed) is unchanged', () => {
    const plain = clip('a', 10, 14)
    const one = clip('a', 10, 14, { speed: 1 })
    for (const t of [10, 11.3, 13.9]) {
      expect(placeInSource(one, { inPoint: 1.5, outPoint: 5.5 }, t)).toEqual(
        placeInSource(plain, { inPoint: 1.5, outPoint: 5.5 }, t),
      )
    }
  })

  it('wraps a sped-up loop in source terms (loopDur unaffected, traversed faster)', () => {
    // window is a 2s source loop; at speed 2 a loop iteration is exhausted in 1s
    // of project time. loopDur stays 2 (source); wraps/loopOffset stay in source.
    const c = clip('a', 0, 10, { loop: true, speed: 2 })
    const window = { inPoint: 0, outPoint: 2 }
    // 0.25s project → 0.5s source → mediaS 0.5, no wrap yet.
    expect(placeInSource(c, window, 0.25)).toMatchObject({ mediaS: 0.5, wraps: 0, loopOffset: 0 })
    // 1.25s project → 2.5s source → one full loop (2s) + 0.5s → mediaS 0.5, wraps 1.
    expect(placeInSource(c, window, 1.25)).toMatchObject({ mediaS: 0.5, wraps: 1, loopOffset: 2 })
  })
})

describe('endsOnLoopBoundary', () => {
  it('is true when the project span is a whole number of loops', () => {
    expect(endsOnLoopBoundary(clip('a', 0, 6, { loop: true }), { inPoint: 0, outPoint: 2 })).toBe(
      true,
    )
  })
  it('is false mid-loop — the legacy hard-stop case', () => {
    expect(endsOnLoopBoundary(clip('a', 0, 5, { loop: true }), { inPoint: 0, outPoint: 2 })).toBe(
      false,
    )
  })
  it('is false for a non-looping clip', () => {
    expect(endsOnLoopBoundary(clip('a', 0, 6), { inPoint: 0, outPoint: 2 })).toBe(false)
  })
})

describe('planTick', () => {
  it('resolves the active track-0 clip, the opaque flag and the next clip', () => {
    const p = project([clip('a', 0, 2), clip('b', 3, 5)], [overlay('o', 1, 4, true)])
    const clips = track0VideoItems(p)
    const plan = planTick(p, 1.5, clips)
    expect(plan.active?.clipId).toBe('a')
    expect(plan.opaque).toBe(true)
    expect(plan.next).toMatchObject({ clipId: 'b', start: 3 })
    expect(plan.canvas).toBe(false)
  })

  it('returns no active clip inside a gap (resolveAt has no last-clip fallback)', () => {
    const p = project([clip('a', 0, 2), clip('b', 3, 5)])
    const plan = planTick(p, 2.5, track0VideoItems(p))
    expect(plan.active).toBeNull()
    expect(plan.next?.clipId).toBe('b')
  })

  it('picks the earliest-start clip when two track-0 videos overlap', () => {
    // Document order puts 'late' first; the legacy hook start-sorts.
    const p = project([clip('late', 1, 4), clip('early', 0, 4)])
    expect(planTick(p, 2, track0VideoItems(p)).active?.clipId).toBe('early')
  })

  it('plans a blend when two track-0 clips overlap', () => {
    const p = crossfade()
    const plan = planTick(p, 3.5, track0VideoItems(p))
    expect(plan.active?.clipId).toBe('a')
    expect(plan.blend).toEqual({ clipId: 'b', p: 0.5 })
  })

  it('plans no blend outside the overlap', () => {
    const p = crossfade()
    expect(planTick(p, 1, track0VideoItems(p)).blend).toBeNull()
    expect(planTick(p, 6, track0VideoItems(p)).blend).toBeNull()
  })

  it('plans no blend for an overlap that is not a transition pair', () => {
    // Containment — 'late' never outlives 'early', so there is no ordering to
    // blend along and the resolver stamps no crossfade. Something still has to
    // own the picture, which is why the earliest-start tiebreak stays.
    const p = project([clip('late', 1, 4), clip('early', 0, 4)])
    const plan = planTick(p, 2, track0VideoItems(p))
    expect(plan.active?.clipId).toBe('early')
    expect(plan.blend).toBeNull()
  })

  it('flags a canvas project', () => {
    const p = project([{ id: 'img', type: 'image', src: '/a.png', start: 0, end: 4 }])
    const plan = planTick(p, 1, track0VideoItems(p))
    expect(plan.canvas).toBe(true)
    expect(plan.active).toBeNull()
  })
})

describe('track audio folds into the source requests', () => {
  // `project()` above builds the legacy array-of-arrays shape, which has
  // nowhere to put track settings — these cases need the object shape.
  function tracked(items: VisualItem[], track: { volume?: number; muted?: boolean } = {}): Project {
    return {
      id: 'p1',
      status: 'draft',
      settings: { resolution: [1080, 1920], fps: 30 },
      tracks: [{ id: 'trk-0', items, ...track }],
    } as Project
  }

  /** The retained request for `clipId` on the last tick. */
  function requested(h: Harness, clipId: string): SourceRequest {
    const found = h.host.lastRetain().find((r) => r.clipId === clipId)
    if (!found) throw new Error(`no request for ${clipId}`)
    return found
  }

  it('multiplies the track volume into the clip volume, keeping the mix between clips', () => {
    // a and b are a 2:1 mix apart. Pulling the track down must move both by the
    // same factor — replacing rather than multiplying would flatten them onto
    // one level and throw away the per-clip work.
    const h = harness(tracked([clip('a', 0, 2, { volume: 0.8 }), clip('b', 2, 4, { volume: 0.4 })], { volume: 0.5 }))
    h.scheduler.play()
    step(h, 1.5) // inside the prewarm lead, so both clips are retained at once

    expect(requested(h, 'a').item.volume).toBeCloseTo(0.4, 10)
    expect(requested(h, 'b').item.volume).toBeCloseTo(0.2, 10)
  })

  it('mutes every clip on a muted track, whatever their own volume', () => {
    const h = harness(tracked([clip('a', 0, 2, { volume: 2 })], { muted: true }))
    h.scheduler.play()
    step(h, 1)
    expect(requested(h, 'a').item.muted).toBe(true)
  })

  it('keeps a muted clip muted on an unmuted track', () => {
    const h = harness(tracked([clip('a', 0, 2, { muted: true })], { volume: 1 }))
    h.scheduler.play()
    step(h, 1)
    expect(requested(h, 'a').item.muted).toBe(true)
  })

  it('passes the clip through untouched when the track carries no settings', () => {
    const h = harness(tracked([clip('a', 0, 2, { volume: 0.8, muted: false })]))
    h.scheduler.play()
    step(h, 1)
    expect(requested(h, 'a').item.volume).toBeCloseTo(0.8, 10)
    expect(requested(h, 'a').item.muted).toBe(false)
  })

  it('defaults to unity for a clip and track that set nothing', () => {
    const h = harness(tracked([clip('a', 0, 2)]))
    h.scheduler.play()
    step(h, 1)
    expect(requested(h, 'a').item.volume).toBe(1)
    expect(requested(h, 'a').item.muted).toBe(false)
  })

  it('DERIVES the request item — the project\'s own clip is never written to', () => {
    // The accessors share item objects by reference all the way from
    // project.json; `resolveProjectPaths` (renderer) and `_apply_project_edits`
    // (server) both mutate them in place. Folding by assignment would corrupt
    // the stored project with every tick and break nothing visible until export.
    const item = clip('a', 0, 2, { volume: 0.8 })
    const p = tracked([item], { volume: 0.5, muted: true })
    const h = harness(p)
    h.scheduler.play()
    step(h, 1)

    expect(requested(h, 'a').item).not.toBe(item)
    expect(item.volume).toBe(0.8)
    expect(item.muted).toBeUndefined()
    // Everything the fold does not own rides along, or the host would rebuild
    // the session against a clip with no trim and no src.
    expect(requested(h, 'a').item).toMatchObject({ id: 'a', start: 0, inPoint: 0, outPoint: 2 })
  })

  it('re-folds after setProject, so a track edit reaches the next retain', () => {
    const items = [clip('a', 0, 2, { volume: 0.8 })]
    const h = harness(tracked(items, { volume: 0.5 }))
    h.scheduler.play()
    step(h, 1)
    expect(requested(h, 'a').item.volume).toBeCloseTo(0.4, 10)

    // Same clip object, new track settings — the only thing that changed is the
    // track, so nothing but the fold can carry it through.
    h.scheduler.setProject(tracked(items, { volume: 0.25, muted: true }))
    expect(requested(h, 'a').item.volume).toBeCloseTo(0.2, 10)
    expect(requested(h, 'a').item.muted).toBe(true)
  })
})

// ── Transitions ─────────────────────────────────────────────────────────────

describe('transition: play into a gap and out the other side', () => {
  const p = project([clip('a', 0, 2), clip('b', 3, 5)])

  it('hides the picture, keeps time advancing, and picks the next clip up', () => {
    const h = harness(p)
    h.scheduler.play()
    step(h, 1)
    expect(h.scheduler.status()).toMatchObject({
      transport: 'playing',
      picture: 'video',
      clipId: 'a',
      clock: 'audio',
    })

    // Into the gap: black, but still PLAYING and still emitting time — the
    // legacy gap clock's whole job.
    step(h, 2.4)
    expect(h.scheduler.status()).toMatchObject({
      transport: 'playing',
      picture: 'black',
      clipId: null,
      clock: 'fallback',
    })
    step(h, 2.8)
    expect(last(h.times)).toBe(2.8)
    expect(h.scheduler.status().transport).toBe('playing')

    // Out the other side.
    step(h, 3.05)
    expect(h.scheduler.status()).toMatchObject({
      transport: 'playing',
      picture: 'video',
      clipId: 'b',
      clock: 'audio',
    })
    expect(h.times).toEqual([...h.times].sort((x, y) => x - y))
  })

  it('prewarms the next clip at boundary−1s and not before', () => {
    const h = harness(p)
    h.scheduler.play()
    step(h, 1.5) // 1.5s to b.start — outside the lead
    expect(h.host.lastRetain().map((r) => r.clipId)).toEqual(['a'])

    step(h, 2.4) // 0.6s to b.start — inside the lead
    expect(h.host.lastRetain().map((r) => r.clipId)).toContain('b')
    expect(h.host.sessions.has('b')).toBe(true)
  })

  it('keeps the clip it just left retained, and drops it once it is no longer behind', () => {
    // Reverses the original terminate-on-boundary rule. Disposing the outgoing
    // clip made nudging the playhead back over a cut — the commonest gesture in
    // an editor — rebuild it from scratch every single time. It is retained
    // instead: its stream is stopped and its clock paused (asserted below), but
    // the session survives so crossing back is free. Affordable only because
    // ranged loading made a retained source cost a sample index rather than a
    // whole proxy.
    const three = project([clip('a', 0, 2), clip('b', 3, 5), clip('c', 5, 7)])
    const h = harness(three)
    h.scheduler.play()
    step(h, 1)
    const serverA = h.host.server('a')
    const sessionA = h.host.sessions.get('a')!

    step(h, 3.05)
    expect(serverA.stops).toBeGreaterThan(0)
    expect(serverA.disposed).toBe(false)
    expect(sessionA.clock.playing).toBe(false)
    expect(h.host.lastRetain().map((r) => r.clipId)).toContain('a')
    expect(h.host.droppedClips).not.toContain('a')

    // Two cuts later 'a' is neither active nor the clip behind the playhead, so
    // the set difference finally takes it.
    step(h, 5.05)
    expect(h.host.lastRetain().map((r) => r.clipId)).not.toContain('a')
    expect(h.host.droppedClips).toContain('a')
    expect(serverA.disposed).toBe(true)
  })
})

describe('transition: scrub into a gap', () => {
  const p = project([clip('a', 0, 2), clip('b', 3, 5)])

  it('hides the picture while paused and clears the canvas', () => {
    const h = harness(p)
    h.scheduler.seek(1)
    expect(h.scheduler.status()).toMatchObject({ transport: 'paused', picture: 'video' })
    h.scheduler.seek(2.5)
    expect(h.scheduler.status()).toMatchObject({
      transport: 'paused',
      picture: 'black',
      clipId: null,
    })
    expect(h.painter.clears).toBeGreaterThan(0)
  })

  it('keeps playing when scrubbed into a gap mid-playback', () => {
    const h = harness(p)
    h.scheduler.play()
    step(h, 1)
    h.scheduler.seek(2.5)
    expect(h.scheduler.status()).toMatchObject({ transport: 'playing', picture: 'black' })
    // The wall clock it swapped onto really is running.
    expect(last(h.host.fallbacks)?.playing).toBe(true)
  })
})

describe('transition: scrub past the end', () => {
  const p = project([clip('a', 0, 2)], [], {
    audio: { tracks: [{ id: 'm', src: '/m.mp3', start: 0, end: 6 }] },
  })

  it('stops playback outright rather than leaving audio running under a dark frame', () => {
    const h = harness(p)
    h.scheduler.play()
    step(h, 1)
    h.scheduler.seek(9)
    expect(h.scheduler.status()).toMatchObject({ transport: 'ended', picture: 'black' })
  })

  it('re-arms on a scrub back inside the timeline', () => {
    const h = harness(p)
    h.scheduler.seek(9)
    expect(h.scheduler.status().transport).toBe('ended')
    h.scheduler.seek(1)
    expect(h.scheduler.status()).toMatchObject({ transport: 'paused', picture: 'video' })
  })

  it('refuses to start playing from the end (the legacy togglePlay no-op)', () => {
    const h = harness(p)
    h.scheduler.seek(9)
    h.scheduler.play()
    expect(h.scheduler.status().transport).toBe('ended')
  })
})

describe('transition: end of project', () => {
  it('keeps running past the last clip to projectEnd, then stops exactly there', () => {
    // The trailing-tail case: audio to 6s under a last clip that ends at 2s.
    const p = project([clip('a', 0, 2)], [overlay('o', 2, 4)], {
      audio: { tracks: [{ id: 'm', src: '/m.mp3', start: 0, end: 6 }] },
    })
    const h = harness(p)
    h.scheduler.play()
    step(h, 1)
    step(h, 3) // past the last clip, inside the tail
    expect(h.scheduler.status()).toMatchObject({ transport: 'playing', picture: 'black' })
    step(h, 5.5)
    expect(h.scheduler.status().transport).toBe('playing')
    step(h, 6.2)
    expect(h.scheduler.status().transport).toBe('ended')
    // Clamped to the ceiling exactly, never past it.
    expect(last(h.times)).toBe(6)
  })

  it('runs a canvas project on the wall clock and stops at its overlay/caption ceiling', () => {
    const p = project([{ id: 'img', type: 'image', src: '/a.png', start: 0, end: 3 }], [
      overlay('o', 0, 4),
    ])
    const h = harness(p)
    h.scheduler.play()
    step(h, 1)
    expect(h.scheduler.status()).toMatchObject({
      transport: 'playing',
      picture: 'black',
      clock: 'fallback',
    })
    expect(h.host.retainLog.every((r) => r.length === 0)).toBe(true)
    step(h, 4.1)
    expect(h.scheduler.status().transport).toBe('ended')
    expect(last(h.times)).toBe(4)
  })
})

describe('transition: loop wrap', () => {
  it('restarts the decode session at the window start on every wrap', () => {
    const p = project([clip('a', 0, 6, { loop: true, outPoint: 2 })])
    const h = harness(p)
    h.scheduler.play() // opens the session at t=0
    const clock = h.host.sessions.get('a')!.clock
    step(h, 0.5)
    const server = h.host.server('a')
    expect(server.starts).toEqual([0])
    expect(last(server.pulls)).toBe(500_000)

    step(h, 1.5) // same loop — no restart, just a pull
    expect(server.starts).toEqual([0])
    expect(last(server.pulls)).toBe(1_500_000)

    step(h, 2.25) // wrapped
    expect(server.starts).toEqual([0, 250_000])
    expect(last(server.pulls)).toBe(250_000)
    // The audio clock's ring must restart at the SAME wrapped media position
    // as the picture, not at the pre-wrap mapping of project time `t` through
    // the clip's timebase — that would leave audio a whole loop window ahead.
    expect(last(clock.seeks)).toBeCloseTo(2.25, 6)
    expect(last(clock.seekMediaS)).toBeCloseTo(0.25, 6)

    step(h, 4.1) // wrapped again
    expect(last(server.starts)).toBeCloseTo(100_000, 0)
    expect(last(clock.seeks)).toBeCloseTo(4.1, 6)
    expect(last(clock.seekMediaS)).toBeCloseTo(0.1, 6)
  })

  it('does not re-seek the audio clock on a same-loop pull (no wrap, no discontinuity)', () => {
    const p = project([clip('a', 0, 6, { loop: true, outPoint: 2 })])
    const h = harness(p)
    h.scheduler.play()
    const clock = h.host.sessions.get('a')!.clock
    const seeksAfterOpen = clock.seeks.length
    step(h, 0.5)
    step(h, 1.5)
    expect(clock.seeks).toHaveLength(seeksAfterOpen)
  })

  it('advances normally when the clip span ends on a wrap', () => {
    const p = project([clip('a', 0, 6, { loop: true, outPoint: 2 }), clip('b', 6, 8)])
    const h = harness(p)
    h.scheduler.play()
    step(h, 1)
    step(h, 6.05)
    expect(h.scheduler.status()).toMatchObject({ transport: 'playing', clipId: 'b' })
  })

  it('stops at clip.end when the span ends mid-loop (legacy behavior, warts included)', () => {
    const p = project([clip('a', 0, 5, { loop: true, outPoint: 2 }), clip('b', 5, 8)])
    const h = harness(p)
    h.scheduler.play()
    step(h, 1)
    step(h, 5.05)
    expect(h.scheduler.status().transport).toBe('paused')
    expect(last(h.times)).toBe(5)
  })

  it('does not fire the loop stop on a scrub across the clip end', () => {
    const p = project([clip('a', 0, 5, { loop: true, outPoint: 2 }), clip('b', 5, 8)])
    const h = harness(p)
    h.scheduler.play()
    step(h, 1)
    h.scheduler.seek(6)
    expect(h.scheduler.status()).toMatchObject({ transport: 'playing', clipId: 'b' })
  })
})

describe('transition: boundary swap', () => {
  const p = project([clip('a', 0, 2), clip('b', 2, 4)])

  it('stops the outgoing stream, starts the incoming one, and swaps the clock', () => {
    const h = harness(p)
    h.scheduler.play()
    step(h, 1)
    const serverA = h.host.server('a')
    const clockA = h.host.sessions.get('a')!.clock
    expect(serverA.starts).toEqual([0])
    expect(last(serverA.pulls)).toBe(1_000_000)

    step(h, 2.05)
    const serverB = h.host.server('b')
    // The outgoing session is STOPPED, not destroyed: nothing decodes and
    // nothing plays out of it, but it stays retained as the clip behind the
    // playhead so a scrub back over the cut does not rebuild it. What the swap
    // rule was really protecting — no live session is ever reconfigured — is
    // asserted by the next test.
    expect(serverA.stops).toBeGreaterThan(0)
    expect(serverA.disposed).toBe(false)
    expect(clockA.disposed).toBe(false)
    expect(clockA.playing).toBe(false)
    // Anchored at the tick's time, not snapped back to the cut.
    expect(serverB.starts).toHaveLength(1)
    expect(serverB.starts[0]).toBeCloseTo(50_000, 3)
    expect(h.host.sessions.get('b')!.clock.playing).toBe(true)
  })

  it('never reconfigures a live session — a new src means a new server', () => {
    const h = harness(p)
    h.scheduler.play()
    step(h, 1)
    const serverA = h.host.server('a')
    step(h, 2.05)
    expect(h.host.server('b')).not.toBe(serverA)
  })

  it('maps project time through the video track origin, not the audio one', () => {
    const h = harness(project([clip('a', 0, 4, { inPoint: 1.5 })]))
    h.scheduler.play()
    step(h, 0.5)
    const server = h.host.server('a')
    // The clock's timebase carries a 999_000µs AUDIO origin; the video track's
    // is 0, so nothing here may show a 999ms offset.
    // inPoint 1.5 + elapsed 0.5 = 2.0s into the file.
    expect(last(server.pulls)).toBe(2_000_000)
    // …and the VIDEO origin, when it is non-zero, is added exactly once.
    server.video.firstPresentationTsUs = 7_000
    step(h, 1.5)
    expect(last(server.pulls)).toBe(3_007_000)
  })
})

describe('setRate — the live transport rate', () => {
  const p = project([clip('a', 0, 2), clip('b', 2, 4)])

  it('pushes the rate to the active clock and carries it onto clocks built afterward', () => {
    const h = harness(p)
    h.scheduler.play()
    step(h, 0.5)
    const clockA = h.host.sessions.get('a')!.clock
    expect(clockA.kind).toBe('audio')

    h.scheduler.setRate(2)
    expect(clockA.rates).toEqual([2])

    // Cross into clip b: the newly adopted clock inherits the live rate.
    step(h, 2.1)
    const clockB = h.host.sessions.get('b')!.clock
    expect(clockB.rates).toContain(2)
  })

  it('leaves clocks untouched while R stays 1 (strict no-op default path)', () => {
    const h = harness(p)
    h.scheduler.play()
    step(h, 0.5)
    const clockA = h.host.sessions.get('a')!.clock
    step(h, 2.1) // crosses the boundary; a's session is dropped afterward
    const clockB = h.host.sessions.get('b')!.clock
    // Never told a rate — the ownership swap must not re-anchor at the default.
    expect(clockA.rates).toEqual([])
    expect(clockB.rates).toEqual([])
  })

  it('is idempotent — an unchanged rate never touches the active clock', () => {
    const h = harness(p)
    h.scheduler.play()
    step(h, 0.5)
    const clockA = h.host.sessions.get('a')!.clock
    h.scheduler.setRate(1) // already 1× — the shuttle's stop/reverse call
    expect(clockA.rates).toEqual([])
    h.scheduler.setRate(2) // a real change lands
    expect(clockA.rates).toEqual([2])
    h.scheduler.setRate(2) // same again — no-op, no re-anchor
    expect(clockA.rates).toEqual([2])
  })
})

describe('transition: opaque toggle mid-play', () => {
  const p = project([clip('a', 0, 4)], [overlay('o', 1, 2, true)])

  it('skips the paint under an opaque overlay but keeps the pipeline moving', () => {
    const h = harness(p)
    const frames: FakeFrame[] = []
    h.scheduler.play()
    step(h, 0.5)
    h.host.server('a').supply = (us) => {
      const f = fakeFrame(us)
      frames.push(f)
      return f
    }

    step(h, 0.75)
    expect(h.painter.paints).toHaveLength(1)
    expect(h.scheduler.status().picture).toBe('video')

    // Opaque window: the frame is still PULLED (so the decode-ahead buffer
    // keeps draining) and immediately closed unpainted.
    step(h, 1.25)
    expect(h.scheduler.status().picture).toBe('opaque')
    expect(h.painter.paints).toHaveLength(1)
    expect(last(h.host.server('a').pulls)).toBe(1_250_000)
    expect(last(frames)!.closed).toBe(true)

    // Back to video, no session churn.
    step(h, 2.25)
    expect(h.scheduler.status().picture).toBe('video')
    expect(h.painter.paints).toHaveLength(2)
    expect(h.host.server('a').starts).toHaveLength(1)
  })

  it('keeps the clip clock running under the overlay — opaque replaces picture, not audio', () => {
    const h = harness(p)
    h.scheduler.play()
    step(h, 1.25)
    expect(h.scheduler.status().clock).toBe('audio')
    expect(h.host.sessions.get('a')!.clock.playing).toBe(true)
  })
})

describe('transition: decode failure mid-clip', () => {
  const p = project([clip('a', 0, 4), clip('b', 4, 6)])

  it('routes to `preparing` for that clip only and never stops the project', () => {
    const h = harness(p)
    h.scheduler.play()
    step(h, 1)
    expect(h.scheduler.status().picture).toBe('video')

    h.host.fail('a', 'decoder: VideoDecoder error')
    expect(h.scheduler.status()).toMatchObject({
      transport: 'playing',
      picture: 'preparing',
      clipId: 'a',
      reason: 'decoder: VideoDecoder error',
      clock: 'fallback',
    })

    // Gap semantics: time keeps advancing through the failed clip's range.
    step(h, 2)
    expect(last(h.times)).toBe(2)
    expect(h.scheduler.status().transport).toBe('playing')

    // …and the NEXT clip plays normally. No whole-project fallback.
    step(h, 4.05)
    expect(h.scheduler.status()).toMatchObject({ picture: 'video', clipId: 'b' })
  })

  it('reaches the same state when the proxy has not arrived yet', () => {
    const h = harness(project([clip('a', 0, 4, { proxySrc: undefined })]), { autoReady: true })
    h.scheduler.play()
    step(h, 1)
    expect(h.scheduler.status()).toMatchObject({ picture: 'preparing', clipId: 'a' })
    expect(h.scheduler.status().reason).toMatch(/proxy/i)
    // Nothing was ever requested — the engine never opens a master.
    expect(h.host.retainLog.every((r) => r.length === 0)).toBe(true)
  })

  it('reaches the same state while a proxy is still loading', () => {
    const h = harness(p, { autoReady: false })
    h.scheduler.play()
    step(h, 1)
    expect(h.scheduler.status().picture).toBe('preparing')
    h.host.ready('a')
    expect(h.scheduler.status()).toMatchObject({ picture: 'video', clipId: 'a' })
  })

  it('resolves when a project update delivers the proxy', () => {
    const h = harness(project([clip('a', 0, 4, { proxySrc: undefined })]))
    h.scheduler.seek(1)
    expect(h.scheduler.status().picture).toBe('preparing')

    h.scheduler.setProject(project([clip('a', 0, 4)]))
    expect(h.scheduler.status()).toMatchObject({ picture: 'video', clipId: 'a' })
  })

  it('rebuilds the session when a clip swaps to a different proxy', () => {
    const h = harness(project([clip('a', 0, 4)]))
    h.scheduler.seek(1)
    const first = h.host.server('a')
    h.scheduler.setProject(project([clip('a', 0, 4, { proxySrc: '/proxies/a_proxy_v2.mp4' })]))
    expect(first.disposed).toBe(true)
    expect(h.host.server('a')).not.toBe(first)
    expect(h.host.server('a').src).toBe('/proxies/a_proxy_v2.mp4')
  })
})

// ── Painting & frame ownership ──────────────────────────────────────────────

describe('painting', () => {
  it('paints with the crop plan the item asks for and closes every frame', () => {
    const item = clip('a', 0, 4, {
      sourceCrop: { x: 0.25, y: 0, w: 0.5, h: 1 },
      sourceWidth: 1920,
      sourceHeight: 1080,
    })
    const h = harness(project([item]))
    h.scheduler.play()
    step(h, 0.5)
    const frame = fakeFrame(500_000)
    h.host.server('a').supply = () => frame
    step(h, 1)

    expect(h.painter.paints).toHaveLength(1)
    expect(h.painter.paints[0].plan).toEqual(drawPlanFor(item, 1280, 720, 1080, 1920))
    expect(frame.closed).toBe(true)
  })

  it('closes a frame it cannot paint (no canvas attached)', () => {
    const h = harness(project([clip('a', 0, 4)]))
    h.scheduler.attach(null)
    h.scheduler.play()
    const frame = fakeFrame(0)
    step(h, 0.5)
    h.host.server('a').supply = () => frame
    step(h, 1)
    expect(frame.closed).toBe(true)
  })

  it('paints a paused scrub from the seek path, once it lands', async () => {
    const h = harness(project([clip('a', 0, 4)]))
    h.scheduler.seek(1)
    const server = h.host.server('a')
    expect(server.seekTargets).toEqual([1_000_000])
    expect(h.scheduler.status().seeking).toBe(true)

    const frame = fakeFrame(1_000_000)
    server.pendingSeeks[0](asFrame(frame))
    await Promise.resolve()
    expect(h.painter.paints).toHaveLength(1)
    expect(frame.closed).toBe(true)
    expect(h.scheduler.status().seeking).toBe(false)
  })

  it('discards a superseded scrub frame instead of painting it', async () => {
    const h = harness(project([clip('a', 0, 4)]))
    h.scheduler.seek(1)
    h.scheduler.seek(2)
    const server = h.host.server('a')
    const stale = fakeFrame(1_000_000)
    const fresh = fakeFrame(2_000_000)
    server.pendingSeeks[0](asFrame(stale))
    server.pendingSeeks[1](asFrame(fresh))
    await Promise.resolve()
    expect(stale.closed).toBe(true)
    expect(h.painter.paints.map((p) => p.frame)).toEqual([fresh])
  })

  it('does not re-seek a paused picture that has not moved', () => {
    // An overlay drag spreads the project on every pointer event; a decoder
    // seek per pointermove would be both wasteful and visibly unstable.
    const h = harness(project([clip('a', 0, 4)], [overlay('o', 0, 4)]))
    h.scheduler.seek(1)
    const server = h.host.server('a')
    expect(server.seekTargets).toHaveLength(1)
    h.scheduler.setProject(project([clip('a', 0, 4)], [overlay('o', 0, 4)]))
    h.scheduler.setProject(project([clip('a', 0, 4)], [overlay('o', 0, 4)]))
    expect(server.seekTargets).toHaveLength(1)
    // …but a real move does.
    h.scheduler.seek(1.5)
    expect(server.seekTargets).toHaveLength(2)
  })

  it('repaints when a fresh canvas is attached', () => {
    const h = harness(project([clip('a', 0, 4)]))
    h.scheduler.seek(1)
    const server = h.host.server('a')
    expect(server.seekTargets).toHaveLength(1)
    h.scheduler.attach(new FakePainter())
    expect(server.seekTargets).toHaveLength(2)
  })

  it('retries after a seek that produced no frame', async () => {
    const h = harness(project([clip('a', 0, 4)]))
    h.scheduler.seek(1)
    const server = h.host.server('a')
    server.pendingSeeks[0](null)
    await Promise.resolve()
    expect(h.painter.paints).toHaveLength(0)
    h.scheduler.setProject(project([clip('a', 0, 4)]))
    expect(server.seekTargets).toHaveLength(2)
  })

  it('does not restart a live stream just because the project object changed', () => {
    // An overlay drag spreads the project every frame; that must not stutter
    // the picture.
    const p = project([clip('a', 0, 4)], [overlay('o', 0, 4)])
    const h = harness(p)
    h.scheduler.play()
    step(h, 1)
    const server = h.host.server('a')
    expect(server.starts).toHaveLength(1)
    h.scheduler.setProject(project([clip('a', 0, 4)], [overlay('o', 0, 4)]))
    expect(server.starts).toHaveLength(1)
    expect(server.disposed).toBe(false)
  })
})

// ── Clip crossfade ──────────────────────────────────────────────────────────

describe('clip crossfade', () => {
  /** Let a `Promise.all` of two seek promises settle. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  /** Both sides cut from ONE take — what a silence-trimmed timeline is made of. */
  const sameTake = { src: '/media/take.mov', proxySrc: '/proxies/take_proxy.mp4' }

  /**
   * Play to the midpoint of the overlap with both sides supplying frames.
   *
   * The stop at 2.5 is load-bearing: it is inside the prewarm lead, so the
   * incoming clip's session is already live when the blend starts, which is
   * the state a real transport arrives in.
   */
  function intoBlend(
    opts: {
      supplyIncoming?: boolean
      overlays?: VisualItem[]
      extra?: Partial<VisualItem>
    } = {},
  ) {
    const h = harness(crossfade(opts.overlays ?? [], opts.extra ?? {}))
    h.scheduler.play()
    step(h, 2.5)
    const fromFrame = fakeFrame(2_500_000)
    const toFrame = fakeFrame(500_000)
    h.host.server('a').supply = () => fromFrame
    if (opts.supplyIncoming !== false) h.host.server('b').supply = () => toFrame
    step(h, 3.5)
    return { h, fromFrame, toFrame }
  }

  it('retains BOTH sessions through a blend', () => {
    // the incoming clip's source must be live before the blend starts, not
    // requested at the instant it is first painted
    const h = harness(crossfade())
    h.scheduler.play()
    step(h, 3.5)
    const requests = h.host.lastRetain()
    expect(requests.map((r) => r.clipId).sort()).toEqual(['a', 'b'])
    // `prev` names the incoming clip too (it starts before `t`), so the blend
    // must not push a second request for it.
    expect(requests).toHaveLength(2)
  })

  it('paints a blend via paintBlend, not two paint calls', () => {
    const { h, fromFrame, toFrame } = intoBlend()
    expect(h.painter.blends).toHaveLength(1)
    expect(h.painter.blends[0].from).toBe(fromFrame)
    expect(h.painter.blends[0].to).toBe(toFrame)
    expect(h.painter.blends[0].p).toBeCloseTo(0.5, 10)
    expect(h.painter.paints).toHaveLength(0)
  })

  it('closes both frames of a blend', () => {
    const { fromFrame, toFrame } = intoBlend()
    expect(fromFrame.closed).toBe(true)
    expect(toFrame.closed).toBe(true)
  })

  it('gives each side of the blend its own draw plan', () => {
    // `drawPlanFor` folds the item's own sourceCrop, and render composites each
    // item down its own branch before blending them — one shared plan would put
    // the outgoing clip's geometry on both pictures.
    const a = clip('a', 0, 4)
    const b = clip('b', 3, 8, {
      sourceCrop: { x: 0.25, y: 0, w: 0.5, h: 1 },
      sourceWidth: 1920,
      sourceHeight: 1080,
    })
    const h = harness(project([a, b]))
    h.scheduler.play()
    step(h, 2.5)
    h.host.server('a').supply = () => fakeFrame(2_500_000)
    h.host.server('b').supply = () => fakeFrame(500_000)
    step(h, 3.5)

    const blend = h.painter.blends[0]
    expect(blend.fromPlan).toEqual(drawPlanFor(a, 1280, 720, 1080, 1920))
    expect(blend.toPlan).toEqual(drawPlanFor(b, 1280, 720, 1080, 1920))
    expect(blend.toPlan).not.toEqual(blend.fromPlan)
  })

  it('falls back to the outgoing clip alone when the incoming frame is not ready', () => {
    const { h, fromFrame } = intoBlend({ supplyIncoming: false })
    expect(h.painter.blends).toHaveLength(0)
    expect(h.painter.paints.map((paint) => paint.frame)).toEqual([fromFrame])
    expect(fromFrame.closed).toBe(true)
  })

  it('an opaque overlay still suppresses the picture during a blend', () => {
    const { h, fromFrame, toFrame } = intoBlend({ overlays: [overlay('o', 3, 4, true)] })
    expect(h.scheduler.status().picture).toBe('opaque')
    expect(h.painter.blends).toHaveLength(0)
    expect(h.painter.paints).toHaveLength(0)
    expect(h.painter.clears).toBeGreaterThan(0)
    // The outgoing frame is still pulled and closed unpainted; the incoming
    // side is not streaming at all under an opaque overlay.
    expect(fromFrame.closed).toBe(true)
    expect(toFrame.closed).toBe(false)
  })

  it('streams the incoming clip only while the blend is live', () => {
    const h = harness(crossfade())
    h.scheduler.play()
    step(h, 2.5)
    expect(h.host.server('b').starts).toHaveLength(0)
    step(h, 3.5)
    expect(h.host.server('b').starts).toHaveLength(1)

    // Past the outgoing clip's end the blend is over and the incoming clip owns
    // the picture outright. Its blend stream has to be retired BEFORE the
    // active path starts one, or the two fight over the same server.
    step(h, 4.5)
    expect(h.host.server('b').stops).toBeGreaterThan(0)
    expect(h.host.server('b').starts).toHaveLength(2)
  })

  it('reopens the incoming stream after a pause lands inside the blend', () => {
    // Pausing mid-blend sends the picture down the seek path, and `seek` stops
    // whatever was streaming on that server. If the scheduler still believed
    // its blend session were live, the resume would skip `startStream` and the
    // rest of the crossfade would silently play un-blended.
    const h = harness(crossfade())
    h.scheduler.play()
    step(h, 3.4)
    expect(h.host.server('b').starts).toHaveLength(1)

    h.scheduler.pause()
    h.scheduler.seek(3.5)
    h.scheduler.play()
    step(h, 3.6)
    expect(h.host.server('b').starts).toHaveLength(2)
  })

  it('two clips off ONE take blend — the case Task 9 had to skip', () => {
    // Both clips carry the same proxySrc, as a silence-trimmed timeline
    // produces: a dissolve between two adjacent cuts of a single take is the
    // ordinary jump-cut softener, and the commonest crossfade there is. One
    // FrameServer serves one decode intent at a time, so the incoming side
    // asks for a decoder of its own and the pair really does have two read
    // positions.
    const h = harness(crossfade([], sameTake))
    h.scheduler.play()
    step(h, 2.5)
    // Prewarmed as `next` on the SHARED server — this is the state the blend
    // has to upgrade out of, not a state it can assume away.
    expect(h.host.server('a')).toBe(h.host.server('b'))

    const fromFrame = fakeFrame(2_500_000)
    const toFrame = fakeFrame(500_000)
    h.host.server('a').supply = () => fromFrame
    // First tick of the overlap: the host moves `b` onto a decoder of its own,
    // so the blend engages a tick late and this one paints the outgoing clip
    // alone — the same fallback an undecoded incoming frame takes, at a `p`
    // near zero where the two pictures are indistinguishable anyway.
    step(h, 3.5)
    expect(h.host.server('a')).not.toBe(h.host.server('b'))
    expect(h.painter.blends).toHaveLength(0)

    h.host.server('b').supply = () => toFrame
    step(h, 3.5)

    expect(h.painter.blends).toHaveLength(1)
    expect(h.painter.blends[0].from).toBe(fromFrame)
    expect(h.painter.blends[0].to).toBe(toFrame)
    expect(h.painter.blends[0].p).toBeCloseTo(0.5, 10)
  })

  it('the blend request is marked exclusive; the active one is not', () => {
    const h = harness(crossfade([], sameTake))
    h.scheduler.play()
    step(h, 3.5)
    const reqs = h.host.lastRetain()
    expect(reqs.find((r) => r.clipId === 'b')!.exclusiveServer).toBe(true)
    expect(reqs.find((r) => r.clipId === 'a')!.exclusiveServer).toBeFalsy()
  })

  it('leaves a cross-source blend alone — it already has two servers', () => {
    // Asking for exclusivity here would force the host to respawn a session it
    // had already prewarmed, tearing down a decoder at the instant the blend
    // needs frames from it, to reach the state it was in to begin with.
    const h = harness(crossfade())
    h.scheduler.play()
    step(h, 2.5)
    const prewarmed = h.host.server('b')
    step(h, 3.5)
    expect(h.host.lastRetain().find((r) => r.clipId === 'b')!.exclusiveServer).toBeFalsy()
    expect(h.host.droppedClips).not.toContain('b')
    expect(h.host.server('b')).toBe(prewarmed)
  })

  it('keeps the incoming session when the blend ends and it stops being exclusive', () => {
    // The end of a crossfade is NOT a respawn point. By then the incoming clip
    // is the active one and the transport runs on its master clock, so dropping
    // its session to re-file its server would tear down that clock and
    // terminate its decoder mid-playback — an artefact worse than the hard cut
    // this task removed. The exclusive server is released when the clip leaves
    // the retained set, not when the flag does.
    const h = harness(crossfade([], sameTake))
    h.scheduler.play()
    step(h, 3.5)
    const during = h.host.server('b')
    step(h, 4.5)
    expect(h.host.lastRetain().find((r) => r.clipId === 'b')!.exclusiveServer).toBeFalsy()
    expect(h.host.droppedClips).not.toContain('b')
    expect(h.host.server('b')).toBe(during)
    expect(during.disposed).toBe(false)
  })

  it('still paints the outgoing frame alone if the host hands both sides one server', () => {
    // `blendSideFor`'s same-server check, which `exclusiveServer` makes
    // unreachable by construction — the only way in is a host that ignores the
    // flag. Kept as an assertion rather than deleted: two read positions on one
    // decoder would have `nextFrameFor` answer from the wrong place in the
    // file, and a stalled picture reads as a decoder bug, not a transition.
    const h = harness(crossfade([], sameTake))
    h.host.honourExclusive = false
    h.scheduler.play()
    step(h, 2.5)
    const frame = fakeFrame(2_500_000)
    h.host.server('a').supply = () => frame
    step(h, 3.5)

    expect(h.host.server('a')).toBe(h.host.server('b'))
    expect(h.painter.blends).toHaveLength(0)
    expect(h.painter.paints.map((paint) => paint.frame)).toEqual([frame])
  })

  it('blends a paused scrub from both seeks', async () => {
    const h = harness(crossfade())
    h.scheduler.seek(3.5)
    const fromFrame = fakeFrame(3_500_000)
    const toFrame = fakeFrame(500_000)
    h.host.server('a').pendingSeeks[0](asFrame(fromFrame))
    h.host.server('b').pendingSeeks[0](asFrame(toFrame))
    await flush()

    expect(h.painter.blends).toHaveLength(1)
    expect(h.painter.blends[0].from).toBe(fromFrame)
    expect(h.painter.blends[0].to).toBe(toFrame)
    expect(h.painter.blends[0].p).toBeCloseTo(0.5, 10)
  })

  it('paints the outgoing clip alone when a paused scrub lands only one frame', async () => {
    const h = harness(crossfade())
    h.scheduler.seek(3.5)
    const fromFrame = fakeFrame(3_500_000)
    h.host.server('a').pendingSeeks[0](asFrame(fromFrame))
    h.host.server('b').pendingSeeks[0](null)
    await flush()

    expect(h.painter.blends).toHaveLength(0)
    expect(h.painter.paints.map((paint) => paint.frame)).toEqual([fromFrame])
  })
})

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('emits status only when it changes', () => {
    const h = harness(project([clip('a', 0, 4)]))
    h.scheduler.play()
    step(h, 0.5)
    const before = h.statuses.length
    step(h, 0.6)
    step(h, 0.7)
    expect(h.statuses.length).toBe(before)
  })

  it('emits the playhead every tick', () => {
    const h = harness(project([clip('a', 0, 4)]))
    h.scheduler.play()
    step(h, 0.5)
    step(h, 0.6)
    expect(h.times.slice(-2)).toEqual([0.5, 0.6])
  })

  it('pause stops the stream and freezes the clock', () => {
    const h = harness(project([clip('a', 0, 4)]))
    h.scheduler.play()
    step(h, 1)
    const server = h.host.server('a')
    h.scheduler.pause()
    expect(h.scheduler.status().transport).toBe('paused')
    expect(server.stops).toBeGreaterThan(0)
    expect(h.host.sessions.get('a')!.clock.playing).toBe(false)
  })

  it('tick is inert before anything establishes a position', () => {
    const h = harness(project([clip('a', 0, 4)]))
    h.scheduler.tick()
    expect(h.times).toEqual([])
    expect(h.scheduler.status().transport).toBe('idle')
  })

  it('dispose releases every session and stops painting', () => {
    const h = harness(project([clip('a', 0, 4)]))
    h.scheduler.play()
    step(h, 1)
    const server = h.host.server('a')
    h.scheduler.dispose()
    expect(server.disposed).toBe(true)
    expect(h.host.sessions.size).toBe(0)
    const painted = h.painter.paints.length
    step(h, 2)
    expect(h.painter.paints.length).toBe(painted)
  })

  it('surfaces a painter throw without stopping the transport', () => {
    const painter = new FakePainter()
    const errors: string[] = []
    const host = new FakeHost()
    const scheduler = createScheduler({
      project: project([clip('a', 0, 4)]),
      host,
      painter,
      onError: (m) => errors.push(m),
    })
    host.scheduler = scheduler
    const boom = vi.spyOn(painter, 'paint').mockImplementation(() => {
      throw new Error('context lost')
    })
    scheduler.play()
    host.setTime(0.5)
    scheduler.tick()
    const frame = fakeFrame(500_000)
    host.server('a').supply = () => frame
    host.setTime(1)
    scheduler.tick()
    expect(errors.some((e) => e.includes('context lost'))).toBe(true)
    expect(frame.closed).toBe(true)
    expect(scheduler.status().transport).toBe('playing')
    boom.mockRestore()
  })
})
