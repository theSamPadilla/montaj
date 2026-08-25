/**
 * Audible drag-scrub source, grain-per-move.
 *
 * Dragging the playhead (the yellow hover cursor, tracked in
 * `../video/hover-scrub.ts`) makes sound, the way a tape jog-wheel does. This
 * module composites over the engine's own graph without disturbing it — it
 * never pushes into the worklet ring.
 *
 * ── Why this does NOT drive the engine's worklet ring ───────────────────────
 * The master clock's audible fast-forward (`audio-clock.ts`) posts stretched
 * PCM into an `AudioWorklet` FIFO kept `RING_SECONDS` (=2s) deep, and that ring
 * only drains while the transport is PLAYING. A drag-scrub happens while the
 * transport is PAUSED, and re-using that ring would mean flushing up to 2s of
 * already-buffered audio on every pointer move — the worst possible latency for
 * a gesture that must feel instant. So each grain plays through a throwaway
 * `AudioBufferSourceNode` on the SAME shared `AudioContext`: a `start()`
 * reaches the speakers in `baseLatency + outputLatency`, the tightest the
 * platform allows.
 *
 * ── Grain-per-move, not rate-follow ─────────────────────────────────────────
 * On each new scrub position we fire ONE short Hann-windowed grain of the
 * source audio at that position, played at natural pitch. Fast drags overlap
 * grains (they simply sum on the shared context); a stationary hover fires
 * nothing. This needs no WSOLA time-stretch — grains are natural-rate windows
 * — so it skips the streaming stretcher's ~43ms block-fill latency entirely,
 * which is exactly why it is tighter than driving the variable-rate path.
 *
 * ── Click-free ──────────────────────────────────────────────────────────────
 * Every grain is multiplied by a full Hann window before playback, so it fades
 * in from and out to zero — no edge discontinuity, no click, whatever position
 * it starts at. A per-grain `GainNode` lets stop-on-release ramp to silence.
 *
 * ── Shared demux LRU ────────────────────────────────────────────────────────
 * Demuxing is expensive; the engine already keeps a per-`src` LRU behind
 * `Engine.acquireDemux` (`./index.ts`). The scrubber holds AT MOST ONE pin at
 * a time — the current src — and swaps it via release-then-acquire when the
 * hover crosses a cut. A src the scheduler is also using is a warm cache hit
 * on both sides; a src only the scrubber touches stays pinned until the next
 * cut releases it, then falls out of the LRU on its own.
 */
import { getSharedAudioContext, latencySeconds } from '../video/preview/audio-context'
import { sampleAtOrBefore, type ChunkSource } from './demux'
import { normalizeAudioCodec, audioTrackIsDecodable } from './audio-clock'
import type { AcquiredDemux } from './index'
import type { HoverScrub } from '../video/hover-scrub'

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Grain length in source-audio packets (~20ms each for libopus) → ~80ms grain. */
const GRAIN_PACKETS = 4
/** Don't fire grains faster than this; a fast drag overlaps them instead. Exported for scrub-source.test.ts. */
export const THROTTLE_MS = 32
/** Ignore a scrub move smaller than this (seconds) — a stationary hover is silent. Exported for scrub-source.test.ts. */
export const MOVE_EPSILON_S = 0.004
/** Release fade (seconds) so stop-on-release never clicks. Exported for scrub-source.test.ts. */
export const RELEASE_FADE_S = 0.02
/** Fallbacks when a container omits its audio params (Opus is 48k by definition). */
const DEFAULT_RATE = 48000
const DEFAULT_CHANNELS = 2
/**
 * Bluetooth output commonly reports 100-300ms of combined output+base
 * latency (see `latencySeconds` in `audio-context.ts`) — a physical wall, not
 * something software can close. Past ~80-100ms a grain reaches the ear so
 * long after the pointer moved that "scrub by ear" no longer reads as
 * instant, so auto-disable rather than ship a version of the feature that
 * feels broken over Bluetooth.
 */
const SCRUB_LATENCY_THRESHOLD_S = 0.08
/**
 * Above this drag speed (media-seconds crossed per wall-clock-second),
 * consecutive grains stop sharing source content: the ~80ms grain
 * (GRAIN_PACKETS) fired every THROTTLE_MS only overlaps its predecessor up to
 * GRAIN_MS/THROTTLE_MS ≈ 80/32 = 2.5x; faster than that each grain samples
 * unrelated media, which is what reads as buzz on a fast drag.
 */
const FAST_DRAG_VELOCITY_S_PER_S = 2.5
/** Never widen the gap past this — even the fastest drag should still jog audibly. */
const MAX_THROTTLE_MS = 96

/** Where in the timeline a scrub position lands, resolved by the host wiring. */
export interface ScrubTarget {
  /** The clip's editing proxy — exactly what the engine would decode (`item.proxySrc`). */
  src: string
  /** Position inside that source's own timeline, seconds (the `<video>.currentTime` analog). */
  mediaS: number
}

export interface ScrubSourceOptions {
  /**
   * Acquire a shared, pinned demuxed source from the engine's demux LRU. The
   * scrubber releases the returned handle exactly once (on src change or
   * `dispose`), which lets the LRU evict it. Same shape as the scheduler's
   * own reader: a hover across a cut hits a warm cache instead of re-demuxing.
   */
  acquireDemux: (src: string) => Promise<AcquiredDemux>
  /**
   * Map a project-time scrub position to a decodable source + media position, or
   * `null` when nothing audible is there (a gap, a canvas project, a clip with no
   * engine-decodable proxy — this is where the `<video>` fallback is EXCLUDED).
   * The wiring builds this from timeline-core's `resolveAt`/`sourceWindow`,
   * mirroring `scheduler.ts`'s `planTick` — see `./scrub-resolve.ts`.
   */
  resolve: (projectS: number) => ScrubTarget | null
  /** Advisory errors (decode/fetch). None stop the scrubber. */
  onError?: (message: string) => void
}

export interface ScrubSource {
  /** Turn audible scrubbing on/off. Off by default; caller toggles it. */
  setEnabled(on: boolean): void
  enabled(): boolean
  /** Subscribe to a hover-scrub store; returns an unsubscribe. */
  attach(hover: HoverScrub): () => void
  /** Silence any ringing grains immediately. */
  stop(): void
  dispose(): void
}

/** One demuxed proxy's audio track, plus its shared-demux pin. */
interface CachedAudio {
  src: string
  pin: AcquiredDemux
  audio: ChunkSource
  decoder: AudioDecoder
  rate: number
  channels: number
  /**
   * Mirrors audio-clock's `feedFailed`: set once this src's decoder throws or
   * reports an error, so a wedged decoder can't hang subsequent grains on the
   * same src — cleared implicitly by `ensureAudio` building a fresh entry
   * (and its own decoder) rather than by resetting the flag in place.
   */
  decodeFailed: boolean
}

/** Accumulator for the grain currently being decoded — guarded by `seq`. */
interface PendingGrain {
  seq: number
  planes: Float32Array[][] // per-AudioData: array of channel planes
  frames: number
}

/**
 * Hann window, one full cycle across `n` samples: 0 at the leading edge, 1 at
 * the midpoint. This is the PERIODIC form (`/n`, not `/(n-1)`), so the last
 * sample is NOT zero — it lands wherever `w[1]` does. Module-level and
 * exported so scrub-source.test.ts can assert on it directly without a
 * WebCodecs decode pipeline.
 */
export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n))
  return w
}

/**
 * Ramp `gain` to zero over `RELEASE_FADE_S` from `now` and schedule `src` to
 * stop at the ramp's end. Pulled out of `stop()`'s loop body and exported so
 * scrub-source.test.ts can assert the release-ramp math on spy nodes without
 * needing a real in-flight grain (which requires a WebCodecs decode).
 */
export function releaseGrain(
  src: Pick<AudioBufferSourceNode, 'stop'>,
  gain: Pick<GainNode, 'gain'>,
  now: number,
): void {
  gain.gain.setValueAtTime(gain.gain.value, now)
  gain.gain.linearRampToValueAtTime(0, now + RELEASE_FADE_S)
  src.stop(now + RELEASE_FADE_S)
}

export function createScrubSource(options: ScrubSourceOptions): ScrubSource {
  const { acquireDemux, resolve, onError } = options
  const ctx = getSharedAudioContext()

  let on = false
  let disposed = false
  let lastFireMs = 0
  let lastFiredMediaS = Number.NEGATIVE_INFINITY
  let seq = 0
  /** So the Bluetooth-latency guard emits `onError` once per violation, not once per grain. */
  let latencyWarned = false

  /** The one src whose demux we currently hold. `null` between swaps. */
  let entry: CachedAudio | null = null
  /**
   * An in-flight `acquireDemux` we haven't decided the outcome of yet, plus
   * the src it was for. If a later `ensureAudio(other)` supersedes it, we
   * release the resolved handle rather than swapping it in. Coalesces
   * concurrent grain fires on the same src into one acquire.
   */
  let pendingLoad: Promise<CachedAudio | null> | null = null
  let pendingSrc: string | null = null

  /** Grains currently ringing, so `stop()`/release can fade them. */
  const live = new Set<{ src: AudioBufferSourceNode; gain: GainNode }>()

  function retire(cur: CachedAudio): void {
    try {
      cur.decoder.close()
    } catch {
      /* already closed */
    }
    cur.pin.release()
  }

  async function ensureAudio(src: string): Promise<CachedAudio | null> {
    if (entry && entry.src === src) return entry
    if (pendingLoad && pendingSrc === src) return pendingLoad

    pendingSrc = src
    const build = (async (): Promise<CachedAudio | null> => {
      let acquired: AcquiredDemux | null = null
      try {
        acquired = await acquireDemux(src)
        // Superseded (or torn down) while we awaited: give the pin straight back.
        if (disposed || pendingSrc !== src) {
          acquired.release()
          return null
        }
        const audio = acquired.source.audio
        if (!audio || audio.samples.length === 0 || !audioTrackIsDecodable(audio)) {
          acquired.release()
          return null
        }
        const rate = audio.audio?.sampleRate || DEFAULT_RATE
        const channels = audio.audio?.channelCount || DEFAULT_CHANNELS
        const built: CachedAudio = {
          src,
          pin: acquired,
          audio,
          rate,
          channels,
          decoder: null as unknown as AudioDecoder,
          decodeFailed: false,
        }
        const decoder = new AudioDecoder({
          output: (frame) => onDecoded(built, frame),
          error: (err) => {
            // Same wedge signal as a synchronous decode() throw below — a
            // decoder that reports an error mid-flush can't be trusted for
            // the next grain either.
            built.decodeFailed = true
            onError?.(`scrub-source decode: ${err instanceof Error ? err.message : String(err)}`)
          },
        })
        decoder.configure({
          codec: normalizeAudioCodec(audio.codec),
          description: audio.description,
          sampleRate: rate,
          numberOfChannels: channels,
        })
        built.decoder = decoder
        // Swap in: the old entry's src is no longer the one we want, so its
        // pin has to go before another acquire could evict from the LRU.
        if (entry) retire(entry)
        entry = built
        return built
      } catch (err) {
        if (acquired) acquired.release()
        onError?.(`scrub-source demux: ${err instanceof Error ? err.message : String(err)}`)
        return null
      } finally {
        if (pendingSrc === src) {
          pendingLoad = null
          pendingSrc = null
        }
      }
    })()
    pendingLoad = build
    return build
  }

  /** The grain currently being filled by decoder output, or null between grains. */
  let pending: PendingGrain | null = null

  function onDecoded(cur: CachedAudio, frame: AudioData): void {
    try {
      if (!pending) return
      // A late frame from an already-retired decoder must not land in the
      // grain of a newer src.
      if (cur !== entry) return
      const planeCount = frame.numberOfChannels
      const frames = frame.numberOfFrames
      const planes: Float32Array[] = []
      for (let ch = 0; ch < planeCount; ch++) {
        const plane = new Float32Array(frames)
        frame.copyTo(plane, { planeIndex: ch, format: 'f32-planar' })
        planes.push(plane)
      }
      pending.planes.push(planes)
      pending.frames += frames
    } finally {
      frame.close()
    }
  }

  async function fireGrain(target: ScrubTarget): Promise<void> {
    const cur = await ensureAudio(target.src)
    if (disposed || !on || !cur) return
    // Src may have moved on while we awaited the acquire.
    if (cur !== entry) return
    // Wedged decoder for this src — bail rather than pile another decode/
    // flush cycle onto it (see `CachedAudio.decodeFailed`).
    if (cur.decodeFailed) return

    const { audio, decoder, rate, channels } = cur
    const mediaTsUs = audio.firstPresentationTsUs + target.mediaS * 1_000_000
    const startIdx = sampleAtOrBefore(audio, mediaTsUs)
    const endIdx = Math.min(startIdx + GRAIN_PACKETS, audio.samples.length)
    if (endIdx <= startIdx) return

    // Make the packet bytes resident (no-op on the whole-file path).
    const ready = audio.ensure?.(startIdx, endIdx)
    if (ready) {
      try {
        await ready
      } catch (err) {
        onError?.(`scrub-source fetch: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      if (disposed || !on || cur !== entry) return
    }

    const mySeq = ++seq
    pending = { seq: mySeq, planes: [], frames: 0 }
    try {
      for (let i = startIdx; i < endIdx; i++) {
        const s = audio.samples[i]
        decoder.decode(
          new EncodedAudioChunk({ type: 'key', timestamp: s.tsUs, duration: s.durUs, data: s.data }),
        )
      }
      await decoder.flush()
    } catch (err) {
      cur.decodeFailed = true
      onError?.(`scrub-source decode: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    // Superseded by a newer grain while we awaited flush, or turned off.
    if (disposed || !on || !pending || pending.seq !== mySeq) return
    // Or the src changed under us (decoder we flushed is now retired).
    if (cur !== entry) return
    const grain = pending
    pending = null
    if (grain.frames === 0) return

    play(grain, channels, rate)
  }

  function play(grain: PendingGrain, channels: number, rate: number): void {
    const total = grain.frames
    const buffer = ctx.createBuffer(channels, total, rate)
    for (let ch = 0; ch < channels; ch++) {
      const dst = buffer.getChannelData(ch)
      let at = 0
      for (const planes of grain.planes) {
        const plane = planes[Math.min(ch, planes.length - 1)]
        dst.set(plane, at)
        at += plane.length
      }
    }
    // Hann across the whole grain → fades in and out to zero, click-free.
    const win = hannWindow(total)
    for (let ch = 0; ch < channels; ch++) {
      const d = buffer.getChannelData(ch)
      for (let i = 0; i < total; i++) d[i] *= win[i]
    }

    const src = ctx.createBufferSource()
    src.buffer = buffer
    const gain = ctx.createGain()
    src.connect(gain)
    gain.connect(ctx.destination)
    const handle = { src, gain }
    live.add(handle)
    src.onended = () => {
      try {
        gain.disconnect()
      } catch {
        /* already gone */
      }
      live.delete(handle)
    }
    try {
      src.start()
    } catch {
      live.delete(handle)
    }
  }

  /**
   * Bluetooth/high-latency guard: read live (a device can change mid-session)
   * rather than only at `setEnabled(true)` time, since a per-grain read is
   * cheap. Warns once per violation via `onError` rather than once per grain.
   */
  function latencyOk(): boolean {
    const ok = latencySeconds(ctx) <= SCRUB_LATENCY_THRESHOLD_S
    if (ok) {
      latencyWarned = false
    } else if (!latencyWarned) {
      latencyWarned = true
      onError?.('scrub-source: output latency too high, scrub audio disabled (Bluetooth?)')
    }
    return ok
  }

  function onScrub(t: number | null): void {
    if (!on || disposed) return
    if (t === null) {
      stop()
      return
    }
    if (!latencyOk()) return
    const nowMs = performance.now()
    const dtMs = nowMs - lastFireMs
    if (dtMs < THROTTLE_MS) return
    const moveS = Math.abs(t - lastFiredMediaS)
    if (moveS < MOVE_EPSILON_S) return
    // Velocity-scale the throttle: a fast drag crossing many media-seconds
    // per wall-clock-second widens the gap so fewer, better-spaced grains
    // fire instead of stacking decorrelated ones into buzz (derivation on
    // `FAST_DRAG_VELOCITY_S_PER_S` above).
    const velocity = moveS / (dtMs / 1000)
    if (velocity > FAST_DRAG_VELOCITY_S_PER_S) {
      const scaledThrottle = Math.min(
        MAX_THROTTLE_MS,
        THROTTLE_MS * (velocity / FAST_DRAG_VELOCITY_S_PER_S),
      )
      if (dtMs < scaledThrottle) return
    }
    const target = resolve(t)
    if (!target) return
    lastFireMs = nowMs
    lastFiredMediaS = t
    void fireGrain(target)
  }

  function stop(): void {
    const now = ctx.currentTime
    for (const { src, gain } of live) {
      try {
        releaseGrain(src, gain, now)
      } catch {
        /* already stopped */
      }
    }
    lastFiredMediaS = Number.NEGATIVE_INFINITY
  }

  return {
    setEnabled(next: boolean) {
      on = next
      if (!next) {
        stop()
        return
      }
      // Surface the Bluetooth/high-latency hint immediately on enable rather
      // than waiting for the first scrub move to discover it.
      latencyOk()
    },
    enabled: () => on,
    attach(hover: HoverScrub) {
      return hover.subscribe(() => onScrub(hover.get()))
    },
    stop,
    dispose() {
      if (disposed) return
      disposed = true
      on = false
      stop()
      if (entry) {
        retire(entry)
        entry = null
      }
      // A load in flight will land in `build`'s superseded branch and
      // release its own pin; nothing else to do here.
      pendingLoad = null
      pendingSrc = null
    },
  }
}

/**
 * Devtools bootstrap. Once the wiring has called this, the user can toggle
 * audible scrubbing live from the console:
 *
 *   window.__montajScrubSource.setEnabled(true)
 *   window.__montajScrubSource.setEnabled(false)
 *
 * Kept separate from `createScrubSource` so the factory stays testable without
 * a global.
 */
export function installScrubSource(source: ScrubSource): void {
  ;(window as unknown as { __montajScrubSource?: ScrubSource }).__montajScrubSource = source
}
