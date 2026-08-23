/**
 * SP4 T5 — the engine facade.
 *
 * `scheduler.ts` decides; this module makes those decisions possible. It owns
 * the three things a pure state machine cannot:
 *
 *   1. **Resources.** `demux → createFrameServer → createMasterClock` for one
 *      clip, behind the scheduler's `SourceHost` interface. The scheduler
 *      declares which clips it needs; this reconciles. `demux` is ranged — it
 *      returns once the header is read and pulls media bytes as the playhead
 *      reaches them — so a build finishing is no longer the same event as the
 *      whole proxy having arrived.
 *   2. **The rAF loop.** Injected (`requestFrame`/`cancelFrame`) so tests drive
 *      it by hand, and running ONLY while the transport is playing — a paused
 *      editor burns no frames, exactly like the legacy hook's boundary rAF.
 *   3. **The canvas.** `attach(canvas)` builds the `Painter` the scheduler
 *      paints through.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS SHARED, AND WHAT IS TERMINATED (the boundary-swap rule)
 * ─────────────────────────────────────────────────────────────────────────
 * The spike's rule is per-SOURCE: "switching source is terminate + respawn -
 * never `decoder.reset()` on a live worker" (`player.ts`'s `load`). That is
 * exactly what happens here, and it is deliberately NOT per-clip:
 *
 *   - **`FrameServer` — one per `src`, refcounted by clip.** A silence-trimmed
 *     timeline is fifty clips off ONE proxy; giving each its own decoder would
 *     re-fetch and re-demux the same file fifty times. The legacy hook has the
 *     same shape for the same reason (its comment notes same-source cuts were
 *     the fast path because the moov was already cached). Two clips never
 *     stream from one server at once — the scheduler stops the outgoing
 *     session before starting the incoming one — and when the last clip
 *     referencing a src is dropped, the worker really is terminated.
 *   - **`MasterClock` — one per CLIP**, because it is anchored to that clip's
 *     `start`/`inPoint`/`volume`/`muted` and T4 is explicit that a live clock is
 *     never reconfigured.
 *   - **`DemuxedSource` — cached by `src` in a small LRU** beyond the live refs.
 *     Demuxing used to be the expensive half (a WHOLE-FILE fetch plus a
 *     sample-table walk) and scrubbing back and forth across a cut is the
 *     single most common thing anyone does in an editor. Ranged loading made
 *     the fetch half cheap, but the cache earns its place either way: it holds
 *     the parsed sample index and whatever bytes have already been pulled, so a
 *     re-entered source starts warm. What lingers is now bounded by
 *     `demux.ts`'s resident-byte budgets rather than by the file's size.
 */
import { designCanvas, sourceWindow } from '@bycrux/timeline-core'
import type { EditorProject as Project, VisualItem } from '../schema'
import { createMasterClock, createWallClock, type ClipTimebase } from './audio-clock'
import { demux, type DemuxedSource } from './demux'
import { createFrameServer, type FrameServer, type HardwarePref } from './frame-server'
import type { FileUrlResolver } from './media-loader'
import {
  createScheduler,
  type ClipSource,
  type EngineStatus,
  type Painter,
  type Scheduler,
  type SourceHost,
  type SourceRequest,
  type SourceState,
} from './scheduler'

export * from './scheduler'

/**
 * Parsed sources kept alive past their last reference.
 *
 * Was 3 — "the clip you are on, the one before it, the one after it" — because
 * a cached source used to pin a WHOLE PROXY in memory and three of those was
 * already hundreds of megabytes. Ranged loading changed what a cached source
 * costs: it is now a sample index plus a bounded byte cache (`demux.ts`'s
 * `MAX_RESIDENT_*_BYTES` and `media-loader.ts`'s `MAX_CACHED_BYTES`, ~26 MB
 * between them at the ceiling), so the same memory buys more of them. Five
 * covers the retain window plus the two clips either side of it, which is the
 * span a fast back-and-forth scrub across two cuts touches.
 */
export const DEMUX_CACHE_MAX = 5

/**
 * How long a source build may run before it is aborted.
 *
 * The failure this exists for: a fetch that never settles left the session in
 * `loading` forever, and `state()` reports `loading` as the same
 * "Preparing preview…" a not-yet-encoded proxy produces — so a hung request was
 * indistinguishable from a proxy that simply had not arrived, and stayed on
 * screen until the tab was reloaded. Aborting turns it into a `failed` session
 * with a reason, which the retry below can then act on.
 *
 * Generous on purpose. A ranged build is a header fetch and at most one or two
 * follow-ups; twenty seconds is not a latency budget, it is the point past
 * which the request is not coming back.
 */
export const BUILD_TIMEOUT_MS = 20_000

/**
 * How many times a failed session may be rebuilt before the clip is left alone.
 *
 * Bounded because the failure might be permanent (a corrupt proxy, a codec the
 * browser will not configure) and `retain` runs every tick — an unbounded retry
 * would be an infinite rebuild loop burning a decode worker per attempt.
 */
export const MAX_SESSION_RETRIES = 3

/**
 * Backoff before the first retry, doubling per attempt (≈0.75s, 1.5s, 3s).
 *
 * Without it the three attempts would all be spent inside a few frames of the
 * rAF loop, which retries nothing useful: the transient cases worth retrying —
 * a proxy still being written, a request that lost its connection — need wall
 * time to resolve, not another immediate attempt.
 */
export const SESSION_RETRY_BASE_MS = 750

// ── Public surface ──────────────────────────────────────────────────────────

export interface EngineDeps {
  /** Host path → fetchable URL. `EditorAdapter.fileUrl`, threaded through unchanged. */
  fileUrl: FileUrlResolver
  /**
   * The playhead, every tick.
   *
   * T6's bridge contract: mirror each emitted value into a `lastEmittedRef`
   * BEFORE forwarding it to `clock.set`, and treat an incoming `currentTime`
   * that differs from it by more than the legacy dead-zone as an external
   * scrub. Pass a stable function that reads a ref — the engine captures this
   * once at construction and is not rebuilt when a React callback identity
   * changes.
   */
  onTime?: (projectS: number) => void
  /** Fires only when the status actually changes, never per tick. Same stability note as `onTime`. */
  onStatusChange?: (status: EngineStatus) => void
  /** Decoder, loader and paint failures. Advisory: none of them stop the transport. */
  onError?: (message: string) => void
  hardwareAcceleration?: HardwarePref
  decodeAheadFrames?: number
  /** Boundary−N seconds for prewarm. Defaults to the scheduler's `PREWARM_LEAD_S`. */
  prewarmLeadS?: number
  startProjectS?: number
  /** rAF seam. Defaults to `requestAnimationFrame`; tests pump by hand. */
  requestFrame?: (cb: () => void) => number
  cancelFrame?: (handle: number) => void
  /** Wall-clock seam, forwarded to every fallback clock. Defaults to `performance.now`. */
  nowMs?: () => number
}

/** A read-only view of whatever clock is currently driving the transport. */
export interface EngineClock {
  /** Playhead in project seconds. */
  now(): number
  readonly playing: boolean
  /** `'audio'` when the active clip's Opus is driving, `'fallback'` on the wall clock. */
  readonly kind: 'audio' | 'fallback'
}

/**
 * T7's debug HUD reads this. A deliberately small, read-only aggregate — NOT
 * the frame server's full `FrameServerStats` (buffered/inFlightFrames/
 * inFlightBatches/received/dropped/atEndOfSource/drained/lastError) and NOT
 * the spike's per-(source, hardwareAcceleration) bucket matrix
 * (`spikes/playback-engine/src/hud.ts`). The HUD needs four numbers — is
 * playback keeping up right now — not the frame server's internals or a
 * benchmarking history, so this is the smallest surface that answers that
 * from React without reaching past `Engine` into `EngineSourceHost` /
 * `FrameServer`.
 */
export interface EngineStats {
  /** Painted frames per second over a trailing {@link STATS_FPS_WINDOW_MS} window. 0 when nothing has painted recently. */
  fps: number
  /** Frames dropped by the active clip's frame server (superseded or overtaken), lifetime. 0 with no active session. */
  dropped: number
  /** Frames buffered ahead in the active clip's decode-ahead pipeline. 0 with no active session. */
  buffered: number
  /** Which clock is driving the transport right now — same value as `EngineStatus.clock`. */
  clock: 'audio' | 'fallback'
}

export interface Engine {
  /**
   * Bind the canvas the engine paints into, or `null` to unbind.
   *
   * Sizes the backing store to the project's design canvas as a default. The
   * host may resize it at any time (a `ResizeObserver` on the frame box, say) —
   * the painter re-reads `canvas.width`/`height` on every paint, so the crop
   * and contain-fit math follows automatically.
   */
  attach(canvas: HTMLCanvasElement | null): void
  play(): void
  pause(): void
  /** External scrub. Playback survives it; scrubbing past the end stops it. */
  seek(projectS: number): void
  /**
   * Set the live transport rate R (default 1): project time advances R× wall
   * time, applied to the active clock immediately and to every session built
   * afterward. This is the J/K/L shuttle's knob. A per-clip `speed` change is
   * NOT this — it arrives through {@link updateProject} as a session rebuild,
   * like any other timeline edit.
   */
  setRate(rate: number): void
  /**
   * Adopt an edited project.
   *
   * Beyond the obvious (new clips, moved boundaries), this is the path a
   * `preparing` clip resolves through: when SSE delivers a `proxySrc` the
   * affected clip's session is rebuilt and that clip alone leaves the Preparing
   * state. Engine ELIGIBILITY is NOT re-evaluated here — plan decision 2 pins it
   * to project-load, and the "initially-ineligible stays legacy" policy is T6's.
   */
  updateProject(project: Project): void
  status(): EngineStatus
  readonly clock: EngineClock
  /** T7's debug HUD aggregate. See {@link EngineStats}. Cheap — safe to call on a polling timer. */
  stats(): EngineStats
  dispose(): void
}

// ── Painter ─────────────────────────────────────────────────────────────────

/**
 * Canvas 2D painter (plan decision 3: `drawImage(VideoFrame)`, not WebGL, for
 * v1 — one video layer is all the engine composites, and `drawImage` of a
 * `VideoFrame` is GPU-backed in Chromium).
 *
 * Every paint fills black first. Without it a letterboxed frame leaves the
 * previous, differently-shaped frame's edges around its bars — the same reason
 * the legacy surface sits on a `bg-black` container.
 */
export function createCanvasPainter(canvas: HTMLCanvasElement): Painter {
  const ctx = canvas.getContext('2d', { alpha: false })
  const fill = () => {
    if (!ctx) return
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  return {
    size: () => ({ width: canvas.width, height: canvas.height }),
    paint(frame, plan) {
      if (!ctx) return
      fill()
      if (plan.sw <= 0 || plan.sh <= 0 || plan.dw <= 0 || plan.dh <= 0) return
      ctx.drawImage(
        frame,
        plan.sx,
        plan.sy,
        plan.sw,
        plan.sh,
        plan.dx,
        plan.dy,
        plan.dw,
        plan.dh,
      )
    },
    clear: fill,
  }
}

// ── The source host ─────────────────────────────────────────────────────────

interface Session {
  clipId: string
  src: string
  status: 'loading' | 'ready' | 'failed'
  reason?: string
  source?: ClipSource
  /** Set when the session is dropped mid-build; every await point checks it. */
  cancelled: boolean
  /**
   * `request.item.start` as of the last (re)build. `retain` compares this
   * against the wanted request to detect a mid-session trim on the SAME src —
   * `src` alone is not enough, since the master clock's timebase is captured
   * at build time and a trim otherwise leaves audio on the pre-trim mapping.
   */
  start: number
  /** `sourceWindow(item, 'preview').inPoint` as of the last (re)build. Same trim-detection role as `start`. */
  inPoint: number
  /**
   * `!!item.muted` as of the last (re)build. A mute toggle respawns the
   * session — the clock's KIND depends on it. EFFECTIVE mute: the scheduler
   * folds the clip's track in before the request is built, so muting the
   * TRACK respawns here exactly as muting the clip does.
   */
  muted: boolean
  /**
   * `item.volume ?? 1` as of the last (re)build — the effective volume, track
   * gain already multiplied in (see `SourceRequest.item`). Unlike `muted`, a
   * change here is pushed live via `setVolume`, not a respawn trigger.
   */
  volume: number
  /**
   * `item.speed ?? 1` as of the last (re)build. Speed re-maps source↔timeline
   * and the master clock's timebase captures it at build time, so — like a trim
   * or a mute toggle, and UNLIKE `volume` — a change respawns the session rather
   * than pushing live. The transport rate R is the live axis; per-clip speed is
   * not.
   */
  speed: number
  /** Rebuild attempts already spent on this clip — see {@link MAX_SESSION_RETRIES}. */
  retries: number
  /**
   * Wall-clock milliseconds before which a `failed` session must not be
   * retried. 0 on a session that has not failed.
   */
  retryAfterMs: number
}

interface ServerEntry {
  server: FrameServer
  refs: Set<string>
}

interface DemuxEntry {
  promise: Promise<DemuxedSource>
  controller: AbortController
  /** Clears the build timeout. Idempotent; called on settle and on abandon. */
  clearTimeout: () => void
  waiters: number
  /** How many `abandonDemux` calls this entry has absorbed — see `abandonDemux`. */
  abandoned: number
}

class EngineSourceHost implements SourceHost {
  private readonly sessions = new Map<string, Session>()
  private readonly servers = new Map<string, ServerEntry>()
  /** Insertion-ordered, oldest first — the LRU. */
  private readonly demuxCache = new Map<string, DemuxedSource>()
  private readonly demuxing = new Map<string, DemuxEntry>()
  private scheduler: Scheduler | null = null
  private disposed = false

  constructor(private readonly deps: EngineDeps) {}

  bind(scheduler: Scheduler): void {
    this.scheduler = scheduler
  }

  retain(requests: readonly SourceRequest[]): void {
    if (this.disposed) return
    const wanted = new Map(requests.map((r) => [r.clipId, r]))
    // Drop first: a clip whose src changed under it (a proxy arriving via SSE),
    // or whose trim or mute state changed, must lose its old session before the
    // new one is built, so the rebuild is a genuine respawn rather than two
    // sessions on one clip.
    for (const [clipId, session] of [...this.sessions]) {
      const want = wanted.get(clipId)
      const changed =
        !want ||
        want.src !== session.src ||
        want.item.start !== session.start ||
        sourceWindow(want.item, 'preview').inPoint !== session.inPoint ||
        !!want.item.muted !== session.muted ||
        (want.item.speed ?? 1) !== session.speed
      if (changed) this.dropSession(clipId)
    }
    // A clip's volume can change without a rebuild: push it straight to the
    // live clock (`MasterClock.setVolume`) rather than tearing the session
    // down. Only sessions that survived the drop loop above and already have a
    // built `source` are eligible — a still-loading session picks up the
    // request's volume when `build()` finishes.
    for (const request of requests) {
      const session = this.sessions.get(request.clipId)
      if (!session?.source) continue
      const vol = request.item.volume ?? 1
      if (vol !== session.volume) {
        session.volume = vol
        session.source.clock.setVolume(vol)
      }
    }
    for (const request of requests) {
      const existing = this.sessions.get(request.clipId)
      if (existing) {
        // A `failed` session is KEPT in the map so `state()` can answer
        // `'failed'` and this loop does not immediately rebuild it. That was
        // unconditional, which made every failure permanent for as long as the
        // clip stayed retained — including the transient ones (a proxy still
        // being written, a request that lost its connection, a build that hit
        // the timeout above). Retry is bounded and backed off so the "leave it
        // alone" property still holds for a genuinely broken clip.
        if (existing.status !== 'failed') continue
        if (existing.retries >= MAX_SESSION_RETRIES) continue
        if (this.now() < existing.retryAfterMs) continue
        const retries = existing.retries + 1
        this.dropSession(request.clipId)
        this.startSession(request, retries)
        continue
      }
      this.startSession(request)
    }
  }

  /** Wall clock, through the injected seam so tests drive the backoff by hand. */
  private now(): number {
    return this.deps.nowMs?.() ?? performance.now()
  }

  state(clipId: string): SourceState {
    const session = this.sessions.get(clipId)
    if (!session) return { status: 'idle' }
    if (session.status === 'ready' && session.source) {
      return { status: 'ready', source: session.source }
    }
    if (session.status === 'failed') {
      return { status: 'failed', reason: session.reason ?? 'preview unavailable' }
    }
    return { status: 'loading' }
  }

  fallbackClock(startProjectS: number) {
    return createWallClock(startProjectS, 'no clip audio', this.deps.nowMs)
  }

  disposeAll(): void {
    this.disposed = true
    for (const clipId of [...this.sessions.keys()]) this.dropSession(clipId)
    for (const [, entry] of this.servers) entry.server.dispose()
    this.servers.clear()
    // Ranged sources hold cached file bytes and can have reads in flight;
    // dropping the map reference alone would leave both to the collector.
    // Only done here, never on LRU eviction: `evictDemux` skips any src with a
    // live server, so an evicted source has nothing reading it and nothing to
    // abort, whereas closing one out from under an in-flight `build()` would
    // strand the clip it was building.
    for (const [, source] of this.demuxCache) source.dispose?.()
    this.demuxCache.clear()
    for (const [, entry] of this.demuxing) {
      entry.clearTimeout()
      entry.controller.abort()
    }
    this.demuxing.clear()
    this.scheduler = null
  }

  // ── session lifecycle ─────────────────────────────────────────────────────

  private startSession(request: SourceRequest, retries = 0): void {
    const session: Session = {
      clipId: request.clipId,
      src: request.src,
      status: 'loading',
      cancelled: false,
      start: request.item.start,
      inPoint: sourceWindow(request.item, 'preview').inPoint,
      muted: !!request.item.muted,
      volume: request.item.volume ?? 1,
      speed: request.item.speed ?? 1,
      retries,
      retryAfterMs: 0,
    }
    this.sessions.set(request.clipId, session)
    void this.build(session, request)
  }

  private async build(session: Session, request: SourceRequest): Promise<void> {
    // Set once `acquireServer` actually adds a ref, so the `catch` below knows
    // whether it has to release one — a throw between `acquireServer` and the
    // `session.source` assignment would otherwise leak the ref forever.
    let acquired = false
    try {
      const demuxed = await this.acquireDemux(session.src)
      if (session.cancelled) return
      const server = this.acquireServer(session.src, demuxed, session.clipId)
      acquired = true

      const window = sourceWindow(request.item, 'preview')
      // Re-stamp the trim/mute/volume fields `retain`'s drop test reads, in
      // case this build was triggered by something other than `startSession`
      // (e.g. a respawn) and the session object predates this request.
      session.start = request.item.start
      session.inPoint = window.inPoint
      session.muted = !!request.item.muted
      session.volume = request.item.volume ?? 1
      session.speed = request.item.speed ?? 1
      const timebase: ClipTimebase = {
        start: request.item.start,
        // `sourceWindow(...).inPoint`, NOT the raw `item.inPoint` — for a
        // `normalizedSrc` window cache the two differ by the cache origin and
        // every seek would land in the wrong place. Same value the legacy hook
        // feeds its <video> elements through `effectiveInPoint`.
        inPoint: window.inPoint,
        // The AUDIO track's origin, per `ClipTimebase`. The video track has its
        // own and the scheduler reads it straight off the frame server.
        firstPresentationTsUs: demuxed.audio?.firstPresentationTsUs ?? 0,
        // Per-clip speed is captured at build time (the clock is never
        // reconfigured live); a speed edit respawns the session — see `Session
        // .speed`. Absent ⇒ 1, the strict no-op mapping.
        speed: request.item.speed ?? 1,
      }
      // Never rejects: a muted clip, a track with no decodable audio, a browser
      // without WebCodecs audio — all resolve to a wall clock with a reason.
      const clock = await createMasterClock({
        audio: demuxed.audio,
        timebase,
        startProjectS: request.anchorProjectS,
        volume: request.item.volume,
        muted: request.item.muted,
        onError: this.deps.onError,
        nowMs: this.deps.nowMs,
      })
      if (session.cancelled) {
        clock.dispose()
        this.releaseServer(session.src, session.clipId)
        return
      }
      session.source = {
        clipId: session.clipId,
        src: session.src,
        frameServer: server,
        clock,
        timebase,
      }
      session.status = 'ready'
    } catch (err) {
      if (acquired) this.releaseServer(session.src, session.clipId)
      if (session.cancelled) return
      const message = err instanceof Error ? err.message : String(err)
      this.markFailed(session, message)
      this.deps.onError?.(`engine: ${session.src} — ${message}`)
    }
    this.scheduler?.sourceChanged(session.clipId)
  }

  /**
   * Move a session to `failed` and arm its retry window.
   *
   * The backoff doubles per attempt already spent, so the three attempts land
   * roughly 0.75s, 1.5s and 3s after their respective failures rather than all
   * inside the same handful of rAF ticks.
   */
  private markFailed(session: Session, reason: string): void {
    session.status = 'failed'
    session.reason = reason
    session.retryAfterMs = this.now() + SESSION_RETRY_BASE_MS * 2 ** session.retries
  }

  private dropSession(clipId: string): void {
    const session = this.sessions.get(clipId)
    if (!session) return
    this.sessions.delete(clipId)
    session.cancelled = true
    session.source?.clock.dispose()
    if (session.source) this.releaseServer(session.src, clipId)
    else this.abandonDemux(session.src)
  }

  /**
   * A decoder error on a shared src fails every clip using it.
   *
   * `frame-server.ts` surfaces decode errors and deliberately does not
   * self-heal, so the session really is dead: its clock is disposed and its
   * worker released, and the scheduler puts those clips' ranges into the SAME
   * `preparing` state a not-yet-encoded proxy produces. The failed session is
   * KEPT in the map (rather than deleted) so `state()` answers `'failed'` and
   * `retain` does not immediately loop into a rebuild; it clears when the clip
   * leaves the retained set or its `src` changes.
   */
  private onDecodeError(src: string, message: string): void {
    this.deps.onError?.(`engine: decode failed for ${src} — ${message}`)
    for (const session of this.sessions.values()) {
      if (session.src !== src || session.status === 'failed') continue
      this.markFailed(session, message)
      session.source?.clock.dispose()
      if (session.source) {
        session.source = undefined
        this.releaseServer(src, session.clipId)
      }
      this.scheduler?.sourceChanged(session.clipId)
    }
  }

  // ── per-src resources ─────────────────────────────────────────────────────

  private acquireServer(src: string, source: DemuxedSource, clipId: string): FrameServer {
    let entry = this.servers.get(src)
    if (!entry) {
      entry = {
        server: createFrameServer({
          source,
          hardwareAcceleration: this.deps.hardwareAcceleration,
          decodeAheadFrames: this.deps.decodeAheadFrames,
          onError: (message) => this.onDecodeError(src, message),
        }),
        refs: new Set(),
      }
      this.servers.set(src, entry)
    }
    entry.refs.add(clipId)
    return entry.server
  }

  /** Last clip off this src leaves ⇒ the worker is terminated. The spike's `load` rule. */
  private releaseServer(src: string, clipId: string): void {
    const entry = this.servers.get(src)
    if (!entry) return
    entry.refs.delete(clipId)
    if (entry.refs.size > 0) return
    entry.server.dispose()
    this.servers.delete(src)
  }

  private async acquireDemux(src: string): Promise<DemuxedSource> {
    const cached = this.demuxCache.get(src)
    if (cached) {
      // Touch: re-insert so Map iteration order stays oldest-first.
      this.demuxCache.delete(src)
      this.demuxCache.set(src, cached)
      return cached
    }
    let entry = this.demuxing.get(src)
    if (!entry) {
      const controller = new AbortController()
      // The AbortController was already here for `abandonDemux`; the timer just
      // gives it a second trigger. Aborting is the only thing that CAN end a
      // hung fetch — a `Promise.race` would resolve the build's promise while
      // the request stayed open, which is how you leak a connection per stalled
      // clip on a timeline that keeps scrubbing past them.
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, BUILD_TIMEOUT_MS)
      const clear = () => {
        if (timer === undefined) return
        clearTimeout(timer)
        timer = undefined
      }
      const promise = demux(src, this.deps.fileUrl, { signal: controller.signal }).then(
        (source) => {
          clear()
          return source
        },
        (err: unknown) => {
          clear()
          // The abort surfaces as a generic `AbortError`, which reads as "the
          // caller cancelled" and would be shown to the user as such. Name the
          // real cause instead: the session's `reason` is what reaches the
          // Preparing placeholder.
          if (timedOut) {
            throw new Error(`preview build timed out after ${BUILD_TIMEOUT_MS} ms`)
          }
          throw err
        },
      )
      entry = { promise, controller, clearTimeout: clear, waiters: 0, abandoned: 0 }
      this.demuxing.set(src, entry)
    }
    entry.waiters++
    try {
      const source = await entry.promise
      this.demuxCache.set(src, source)
      this.evictDemux()
      return source
    } finally {
      entry.waiters--
      this.demuxing.delete(src)
    }
  }

  /**
   * A session dropped before its bytes landed; abort the fetch once EVERY
   * waiter has abandoned it, not just the first.
   *
   * `waiters` never shrinks when a session is dropped (only when its
   * `acquireDemux` await settles), so comparing against a fixed `waiters > 1`
   * threshold only ever protects the FIRST drop on a shared src — a second
   * clip dropped moments later would see the same stale `waiters` count and
   * never abort, leaking the fetch for good. Counting how many times this has
   * been called instead, and comparing against `waiters`, aborts exactly when
   * every current waiter has actually abandoned it.
   */
  private abandonDemux(src: string): void {
    const entry = this.demuxing.get(src)
    if (!entry) return
    entry.abandoned++
    if (entry.abandoned < entry.waiters) return
    entry.clearTimeout()
    entry.controller.abort()
    this.demuxing.delete(src)
  }

  private evictDemux(): void {
    while (this.demuxCache.size > DEMUX_CACHE_MAX) {
      let victim: string | null = null
      for (const src of this.demuxCache.keys()) {
        // Never evict a source a live decode session is reading from.
        if (this.servers.has(src)) continue
        victim = src
        break
      }
      if (victim === null) return
      this.demuxCache.delete(victim)
    }
  }
}

// ── createEngine ────────────────────────────────────────────────────────────

/**
 * Build the playback engine for one project.
 *
 * Nothing happens until something drives it: `attach` a canvas to see the
 * current frame, `seek` to move, `play` to run. The engine starts paused at
 * `startProjectS` (default 0).
 *
 * ── Surface notes for T6 ──
 * `attach/play/pause/seek/dispose/clock` are the plan's table. Three additions,
 * each because the hook genuinely needs it:
 *   - `updateProject(project)` — the editor mutates the project constantly, and
 *     without it a proxy arriving mid-session could never resolve a Preparing
 *     clip.
 *   - `status()` + the `onStatusChange` dep — the hook has to render
 *     `isPlaying`, the Preparing placeholder and (T7) the HUD; polling a
 *     getter every render is the alternative and it is worse.
 *   - `onTime` as a dep rather than a `subscribe()` method — the clock bridge
 *     needs the value BEFORE it reaches React state (see the dep's own note),
 *     and one construction-time callback reading a ref is the stable-identity
 *     shape React wants.
 */
/** Rolling window for `stats().fps` — matches the spike HUD's `FPS_WINDOW_MS`. */
const STATS_FPS_WINDOW_MS = 2000

/**
 * Drop every timestamp in `timesMs` older than `windowMs` before `nowMs`
 * (mutates in place; the array must be ascending, oldest first — the order
 * paints naturally arrive in). Exported, and split from `fpsFromPaintTimes`
 * below, so `stats()`'s rolling-window math is unit-testable without a
 * canvas, an rAF loop or a live decode session — the same reason
 * `scheduler.ts` splits `containFitPlan`/`sourceCropDrawPlan` out of the
 * class that owns the mutable state they serve.
 *
 * Called on every recorded paint (not just on `stats()` reads): a session
 * where `debugHud` is never turned on still paints for the whole session, and
 * pruning only on read would otherwise grow this array without bound for as
 * long as nobody asks for `stats()`.
 */
export function pruneOlderThan(timesMs: number[], nowMs: number, windowMs: number): void {
  const cutoff = nowMs - windowMs
  let i = 0
  while (i < timesMs.length && timesMs[i] < cutoff) i++
  if (i > 0) timesMs.splice(0, i)
}

/** Instantaneous fps from an already-pruned, ascending list of paint timestamps. */
export function fpsFromPaintTimes(prunedTimesMs: readonly number[], nowMs: number, windowMs: number): number {
  if (prunedTimesMs.length === 0) return 0
  const span = Math.min(windowMs, nowMs - prunedTimesMs[0])
  return span > 0 ? (prunedTimesMs.length / span) * 1000 : 0
}

export function createEngine(project: Project, deps: EngineDeps): Engine {
  const host = new EngineSourceHost(deps)
  const scheduler = createScheduler({
    project,
    host,
    onTime: deps.onTime,
    onStatusChange: deps.onStatusChange,
    onError: deps.onError,
    prewarmLeadS: deps.prewarmLeadS,
    startProjectS: deps.startProjectS,
  })
  host.bind(scheduler)

  const requestFrame = deps.requestFrame ?? ((cb: () => void) => requestAnimationFrame(cb))
  const cancelFrame = deps.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle))

  let raf: number | null = null
  let currentProject = project
  let canvas: HTMLCanvasElement | null = null
  let disposed = false

  const nowMs = deps.nowMs ?? (() => performance.now())
  /** Painted-frame timestamps within the trailing window, oldest first. `stats()`'s fps source. */
  let paintTimesMs: number[] = []
  const recordPaint = () => {
    const t = nowMs()
    paintTimesMs.push(t)
    pruneOlderThan(paintTimesMs, t, STATS_FPS_WINDOW_MS)
  }

  const pump = () => {
    raf = null
    if (disposed) return
    scheduler.tick()
    // The transport can end inside the tick (project end, or a looping clip's
    // mid-loop stop); re-reading it here is what stops the loop without a
    // separate "should I still be running" flag to keep in sync.
    if (scheduler.status().transport === 'playing') raf = requestFrame(pump)
  }

  const start = () => {
    if (raf !== null || disposed) return
    if (scheduler.status().transport !== 'playing') return
    raf = requestFrame(pump)
  }

  const stop = () => {
    if (raf === null) return
    cancelFrame(raf)
    raf = null
  }

  const sizeCanvas = () => {
    if (!canvas) return
    const [w, h] = designCanvas(currentProject.settings?.resolution)
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
  }

  return {
    attach(next: HTMLCanvasElement | null) {
      canvas = next
      if (!next) {
        scheduler.attach(null)
        return
      }
      sizeCanvas()
      const painter = createCanvasPainter(next)
      // Wrapped only to feed `stats().fps` — every other call is `painter`'s own.
      scheduler.attach({
        ...painter,
        paint: (frame, plan) => {
          recordPaint()
          painter.paint(frame, plan)
        },
      })
    },
    play() {
      scheduler.play()
      start()
    },
    pause() {
      scheduler.pause()
      stop()
    },
    seek(projectS: number) {
      scheduler.seek(projectS)
      if (scheduler.status().transport !== 'playing') stop()
    },
    setRate(rate: number) {
      scheduler.setRate(rate)
    },
    updateProject(next: Project) {
      currentProject = next
      sizeCanvas()
      scheduler.setProject(next)
    },
    status: () => scheduler.status(),
    stats(): EngineStats {
      // Prune on read too — a paused engine (no rAF, no paints) would otherwise
      // report a stale fps from before it stopped rather than decaying to 0.
      const t = nowMs()
      pruneOlderThan(paintTimesMs, t, STATS_FPS_WINDOW_MS)
      const fps = fpsFromPaintTimes(paintTimesMs, t, STATS_FPS_WINDOW_MS)

      const st = scheduler.status()
      const state = st.clipId ? host.state(st.clipId) : { status: 'idle' as const }
      const frameStats = state.status === 'ready' ? state.source.frameServer.stats() : null

      return {
        fps,
        dropped: frameStats?.dropped ?? 0,
        buffered: frameStats?.buffered ?? 0,
        clock: st.clock,
      }
    },
    clock: {
      now: () => scheduler.now(),
      get playing() {
        return scheduler.status().transport === 'playing'
      },
      get kind() {
        return scheduler.status().clock
      },
    },
    dispose() {
      if (disposed) return
      disposed = true
      stop()
      scheduler.dispose()
      host.disposeAll()
      paintTimesMs = []
    },
  }
}

/** Re-exported so T6 can type its own item lists without reaching into the schema. */
export type { VisualItem }
