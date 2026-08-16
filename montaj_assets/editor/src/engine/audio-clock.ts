/**
 * SP4 T4 — the master clock.
 *
 * Everything the engine paints is timed by this module. The clock is derived
 * from how many audio frames an `AudioWorklet` has ACTUALLY rendered
 * (`samplesConsumed / sampleRate + anchor`), not from decode progress and not
 * from wall time — so the canvas painter (T5) tracks what is really coming out
 * of the speakers. SP1 §6 measured that design at ±4ms A/V error (p50 −4.3ms,
 * p95 −0.4ms) over 71-second windows, which is what earns it the job.
 *
 * `spikes/playback-engine/src/audio.ts` is the precedent. Ported patterns and
 * their reasons:
 *
 *  - **postMessage chunks, not `SharedArrayBuffer`.** SAB needs cross-origin
 *    isolation (COOP/COEP). The spike could not get it under Vite dev or a
 *    `file://` Electron load; the product cannot get it either, because Hub
 *    serves the editor and cannot satisfy isolation (plan decision 4). Not the
 *    simpler choice — the only viable one.
 *  - **`normalizeAudioCodec`.** mp4box reports Opus capitalized (`'Opus'`);
 *    WebCodecs requires `'opus'`, and `'Opus'.startsWith('opus')` is false.
 *    SP1 §7.5: without this, EVERY proxy silently falls back to the wall clock
 *    and the audio master clock never runs once.
 *  - **Silence through underruns.** An empty ring renders silence and the frame
 *    counter keeps advancing (see `audio-worklet-source.ts`). A clock that
 *    stalled on starvation would stall the painter with it.
 *  - **Wall-clock extrapolation between ~10Hz reports**, so a 60Hz rAF paint
 *    loop does not read the same clock value five or six times before it steps.
 *  - **`createMasterClock` never throws.** Canvas projects, muted clips,
 *    tracks with no decodable audio, browsers with no `AudioDecoder`, a worklet
 *    that fails to load, a decoder that rejects its config — every one of them
 *    resolves to a wall-clock `MasterClock` with a `reason`, never a rejected
 *    promise. The caller awaits this function; it does not guard it.
 *
 * Deliberate deviations from the spike, each with its reason at the code:
 *  1. the clock reads out in PROJECT SECONDS, not raw container µs (the spike
 *     had one file and no timeline);
 *  2. it has a transport (`play`/`pause`/`seek`) — the spike started once and
 *     ran to the end;
 *  3. it runs on the page's SHARED `AudioContext` and never closes it;
 *  4. PCM is volume-scaled at ring-enqueue time;
 *  5. PCM is resampled when the shared context's rate is not the decoded rate;
 *  6. extrapolation is bounded.
 */
import { sampleAtOrBefore, type ChunkSource } from './demux'
import { audioWorkletSource, RING_PROCESSOR_NAME } from './audio-worklet-source'
import { getSharedAudioContext } from '../video/preview/audio-context'

// ── Tuning constants ────────────────────────────────────────────────────────

/**
 * How much decoded-but-unrendered audio (seconds) the feeder keeps queued in
 * the worklet. PCM is cheap — there is no GPU surface pool to exhaust the way
 * `VideoFrame` has — so this needs none of the careful N-frame budgeting
 * `batch-planner.ts` does for video; it is just enough slack to ride out a slow
 * decode tick without underrunning. Spike value, unchanged.
 */
export const RING_SECONDS = 2

/** Encoded audio packets fed to the decoder per `decode()`+`flush()` batch. Spike value. */
export const AUDIO_BATCH_PACKETS = 50

/** Worklet report cadence (~10Hz). Injected into the worklet via `processorOptions`. */
export const REPORT_INTERVAL_S = 0.1

/**
 * Ceiling on wall-clock extrapolation between reports.
 *
 * Extrapolation assumes nominal playback continues in the gap since the last
 * report — true within one ~100ms interval. It stops being true when the
 * AudioContext is SUSPENDED: `process()` is never called, no report ever
 * arrives, and an unbounded extrapolation would run the playhead away for as
 * long as the page stays suspended and then snap it violently backwards when
 * audio finally resumes. Bounding it makes a suspended context present as the
 * thing it actually is — a stalled clock, hence a stalled painter — which is
 * precisely the hazard `resumeAudioContextFromGesture` exists to cure (T6
 * owns the gesture anchors). 3× the report interval: generous for a late
 * report, decisive for a dead one.
 */
export const MAX_EXTRAPOLATION_MS = REPORT_INTERVAL_S * 1000 * 3

/** Fallback assumptions when a container omits its audio parameters. Opus is 48kHz by codec definition. */
const DEFAULT_SAMPLE_RATE = 48000
const DEFAULT_CHANNELS = 2

// ── Public surface ──────────────────────────────────────────────────────────

export type ClockKind = 'audio' | 'fallback'

/**
 * How one clip's audio maps onto the project timeline.
 *
 * `inPoint` is the in-point **in the loaded file's own timeline**, i.e.
 * `sourceWindow(clip, 'preview').inPoint` — NOT the raw `clip.inPoint`. For the
 * SP3 proxy (and for `nobg_preview_src`) the two are equal because those cover
 * the full source; for a `normalizedSrc` window cache they are not, and using
 * the raw field would land every seek at the wrong place. This is the same
 * value `useVideoPlayback.ts` feeds its `<video>` elements through
 * `effectiveInPoint`, so both paths answer "where in this file does the clip
 * start" identically.
 *
 * `firstPresentationTsUs` is the AUDIO track's origin (`ChunkSource
 * .firstPresentationTsUs`), not the video track's. Media timestamps need not
 * start at 0 and the two tracks need not share an origin; each track maps
 * through its own, which is the same per-track convention the spike used and
 * the same one `frame-server.ts` applies to video.
 */
export interface ClipTimebase {
  /** Project-time seconds at which the clip starts on the timeline (`item.start`). */
  start: number
  /** In-point in the LOADED file's timeline, seconds (`sourceWindow(item, 'preview').inPoint`). */
  inPoint: number
  /** The audio track's t=0 origin, container µs (`ChunkSource.firstPresentationTsUs`). */
  firstPresentationTsUs: number
}

export interface MasterClockStats {
  kind: ClockKind
  /** Set only when `kind === 'fallback'` — why audio isn't driving, for the T7 HUD. */
  reason?: string
  playing: boolean
  /** Output frames rendered since the last reset (audio kind only; 0 on the fallback). */
  samplesConsumed: number
  /** Of those, how many were silence because the ring was empty. A rising number means decode is losing. */
  underrunFrames: number
  /** Decoded frames sitting in the ring, un-rendered. */
  queuedFrames: number
  /** `queuedFrames` in seconds — the real decode-ahead headroom. */
  queuedSeconds: number
}

/**
 * The engine's one clock. T5's scheduler reads `now()` on every rAF tick and
 * drives the transport through `play`/`pause`/`seek`; T6 bridges `now()` to the
 * editor's playhead. Both kinds ('audio' and 'fallback') implement the whole
 * surface identically — a caller never branches on `kind` for behavior, only
 * for display.
 *
 * The clock is bound to ONE clip's audio for its whole life. At a clip
 * boundary the scheduler `dispose()`s it and awaits a new one anchored to the
 * next clip — the same "never reconfigure a live decoder" rule
 * `frame-server.ts` follows for video. Because the readout is PROJECT time and
 * the new clock is seeked to the boundary's project time before it plays, the
 * swap is continuous in the only units anyone reads.
 */
export interface MasterClock {
  readonly kind: ClockKind
  /** Set only when `kind === 'fallback'`. */
  readonly reason?: string
  readonly playing: boolean
  /** Current playhead, in PROJECT SECONDS. */
  now(): number
  /** Start (or resume from wherever `now()` currently reads). Idempotent. */
  play(): void
  /** Freeze the playhead where it reads right now and silence the ring. Idempotent. */
  pause(): void
  /**
   * Jump to a project time. Coherent whether playing or paused; playing
   * survives the jump.
   *
   * `mediaS` is an OPTIONAL override for where in the loaded file's own
   * timeline to restart decoding from, in seconds — the loop-wrap case. A
   * project-time seek alone always maps `projectS` through this clip's
   * timebase (`mediaTsUsForProjectTime`), which is correct for a boundary
   * swap or a scrub but wrong for a wrap: the picture's media position resets
   * to the loop window's start while `projectS` keeps climbing, and those two
   * disagree by exactly one loop's worth of time. Passing the frame server's
   * own wrapped `mediaS` keeps the two tracks anchored to the same instant.
   * Omitted, the target is derived from `projectS` as before.
   */
  seek(projectS: number, mediaS?: number): void
  /**
   * Update the clip's audio level. Takes effect for audio enqueued AFTER the
   * call: up to `RING_SECONDS` of already-scaled PCM is in flight and plays at
   * the old level. No-op on the fallback clock.
   */
  setVolume(volume: number): void
  stats(): MasterClockStats
  /** Stop the decoder and detach the worklet node. NEVER closes the shared AudioContext. */
  dispose(): void
}

export interface MasterClockOptions {
  /** The active clip's demuxed audio track, or `null` (canvas project, video with no audio track). */
  audio: ChunkSource | null
  /** How this clip's audio maps onto the project timeline. */
  timebase: ClipTimebase
  /** Project-time seconds the clock starts at (paused; call `play()` to run). */
  startProjectS: number
  /**
   * The clip's `volume` (0–2; >1 amplifies). Applied by scaling PCM at
   * ring-enqueue time — see `scaleAndInterleavePlanes`.
   */
  volume?: number
  /**
   * The clip's `muted`. Muted clips run on the wall clock: there is nothing to
   * sync to, and building an audio graph to render silence would be waste.
   * Consequence for the caller: `muted` is a CONSTRUCTION-time decision, not a
   * live one — unmuting mid-session means disposing this clock and awaiting a
   * new one (unlike `volume`, which `setVolume` handles in place).
   */
  muted?: boolean
  /** Decoder/worklet failures, for the caller's log. Failures never throw and never stop the clock. */
  onError?: (message: string) => void
  /** Test seam (`frame-server.ts`'s `spawnWorker` is the precedent). Defaults to `performance.now`. */
  nowMs?: () => number
}

// ── Pure logic (unit-tested; everything below the fold builds on it) ─────────

/**
 * mp4box.js does not normalize its codec strings. Notably Opus comes back
 * capitalized (`'Opus'`), and `AudioDecoder.configure()` rejects that outright
 * — as does any straight comparison against `'opus'`. Trust mp4box for the
 * codec family, never for its casing. `'mp4a'` (a bare AAC family string with
 * no profile) is expanded to AAC-LC, the only form `configure()` accepts.
 *
 * SP1 §7.5 is the bug this function is: without it every AV1+Opus proxy fell
 * silently onto the wall clock and the audio master clock never ran.
 */
export function normalizeAudioCodec(codec: string): string {
  const lower = codec.toLowerCase()
  return lower === 'mp4a' ? 'mp4a.40.2' : lower
}

/**
 * Media timestamp (container µs, this track's own axis) → project seconds.
 *
 * `(mediaTsUs - firstPresentationTsUs) / 1e6` is the time in the LOADED FILE's
 * timeline — exactly what a `<video>`'s `currentTime` reads on the legacy path.
 * The rest reproduces `useVideoPlayback.ts`'s mapping verbatim:
 * `projectT = clip.start + (video.currentTime - effectiveInPoint(clip))`.
 *
 * (The legacy site also adds `loopOffsetRef.current`. Loop is transport, not
 * timebase: a looping clip's wrap is a `seek()` on this clock, owned by T5.)
 */
export function projectTimeForMediaTsUs(timebase: ClipTimebase, mediaTsUs: number): number {
  const mediaS = (mediaTsUs - timebase.firstPresentationTsUs) / 1_000_000
  return timebase.start + (mediaS - timebase.inPoint)
}

/** Project seconds → media timestamp (container µs). Exact inverse of `projectTimeForMediaTsUs`. */
export function mediaTsUsForProjectTime(timebase: ClipTimebase, projectS: number): number {
  const mediaS = projectS - timebase.start + timebase.inPoint
  return timebase.firstPresentationTsUs + mediaS * 1_000_000
}

/**
 * Smooth the worklet's ~10Hz sample count into a continuous reading.
 *
 * Assumes nominal playback continued since the last report — true inside one
 * report interval, false when the context is suspended, which is why
 * `elapsedMs` is clamped to `maxElapsedMs` (see `MAX_EXTRAPOLATION_MS`).
 * Negative elapsed (a clock that went backwards) clamps to 0.
 */
export function extrapolateSamples(
  lastSamplesConsumed: number,
  elapsedMs: number,
  sampleRate: number,
  maxElapsedMs: number = MAX_EXTRAPOLATION_MS,
): number {
  const bounded = Math.min(Math.max(elapsedMs, 0), maxElapsedMs)
  return lastSamplesConsumed + (bounded / 1000) * sampleRate
}

/**
 * Rendered output frames → project seconds. `anchorProjectS` is the project
 * time the ring's frame 0 was authored to play at, set on every reset.
 */
export function projectTimeForSamples(
  anchorProjectS: number,
  samples: number,
  sampleRate: number,
): number {
  return anchorProjectS + samples / sampleRate
}

/**
 * Interleave per-channel PCM planes into the single `[L0,R0,L1,R1,…]` buffer
 * the ring speaks, scaling by the clip's `volume` on the way through.
 *
 * **Why scale the PCM rather than hang a `GainNode` off the worklet node.**
 * Not because a GainNode cannot amplify — it can, and that is exactly why the
 * legacy path uses one (`useVideoPlayback.ts`'s `applyClipVolume`). It is
 * because the ring holds up to `RING_SECONDS` of decode-ahead: a node-level
 * gain applies to whatever is *leaving* the node now, so a per-clip level set
 * at a clip boundary would retroactively re-level the tail of the previous
 * clip still sitting in the ring. Scaling at enqueue binds each sample's level
 * to the clip that produced it, which is the only way per-clip volume can be
 * correct in a buffered pipeline.
 *
 * **No clamping, deliberately.** `volume` above 1.0 produces samples outside
 * [-1, 1] and they are left that way — identical to what the legacy GainNode
 * emits for the same clip. `AudioDestinationNode` does the clipping in both
 * paths, so preview loudness stays bit-for-bit comparable across the two
 * players. Clamping here would make the engine quieter than the legacy path on
 * exactly the clips a user amplified on purpose.
 */
export function scaleAndInterleavePlanes(
  planes: readonly Float32Array[],
  frameCount: number,
  volume: number,
): Float32Array {
  const channels = planes.length
  const out = new Float32Array(frameCount * channels)
  for (let ch = 0; ch < channels; ch++) {
    const plane = planes[ch]
    for (let i = 0; i < frameCount; i++) {
      out[i * channels + ch] = plane[i] * volume
    }
  }
  return out
}

/**
 * Linear-interpolating resample of an interleaved buffer, carrying the
 * fractional read position across chunk boundaries via `phase`.
 *
 * **Why this exists at all** — a deviation from the spike, forced by a product
 * constraint the spike did not have. The spike built its own
 * `new AudioContext({ sampleRate: 48000 })` and so could assume decoded rate ==
 * render rate; it only warned when they disagreed. The engine is required to
 * run on the page's SHARED context (plan decision 4), whose rate is whatever
 * the output device reports — 44100 on plenty of Macs. Opus always decodes at
 * 48000 by codec definition, so on such a device an unresampled feed plays
 * 8.8% fast/sharp AND drifts ~0.9s of A/V error per 10 seconds, since the clock
 * counts render frames while the content advances at the decoded rate. Warning
 * and continuing (the spike's choice) would ship that; falling back to the wall
 * clock would silence clip audio outright for those users. Resampling keeps
 * both the pitch and the clock honest.
 *
 * `ratio` is `srcRate / dstRate` — input frames consumed per output frame. The
 * identity case (`ratio === 1`, no carried phase) returns the input untouched,
 * so the overwhelmingly common 48kHz-context path costs nothing.
 *
 * The final output frame of a chunk interpolates against the chunk's own last
 * frame rather than the next chunk's first (which has not been decoded yet):
 * a sub-sample error on one frame per ~10ms packet, inaudible, and the carried
 * `phase` keeps the *timing* exact regardless.
 */
export function resampleInterleaved(
  input: Float32Array,
  channels: number,
  ratio: number,
  phase: number,
): { pcm: Float32Array; phase: number } {
  if (ratio === 1 && phase === 0) return { pcm: input, phase: 0 }
  const inFrames = Math.floor(input.length / channels)
  if (inFrames === 0) return { pcm: new Float32Array(0), phase }

  const outFrames = Math.max(0, Math.ceil((inFrames - phase) / ratio))
  const out = new Float32Array(outFrames * channels)
  for (let i = 0; i < outFrames; i++) {
    const pos = phase + i * ratio
    const i0 = Math.min(Math.floor(pos), inFrames - 1)
    const i1 = Math.min(i0 + 1, inFrames - 1)
    const frac = pos - i0
    for (let ch = 0; ch < channels; ch++) {
      const a = input[i0 * channels + ch]
      const b = input[i1 * channels + ch]
      out[i * channels + ch] = a + (b - a) * frac
    }
  }
  return { pcm: out, phase: phase + outFrames * ratio - inFrames }
}

/**
 * Can this track's audio be handed to `AudioDecoder` at all?
 *
 * A track with no `description` can only be configured if its codec carries
 * its own in-band configuration — Opus does; AAC does not. SP1 §7.1 hit
 * exactly this: mp4box.js cannot parse a QuickTime-v1 `mp4a` sample entry, so
 * the original camera file's AAC has no obtainable `AudioSpecificConfig` and
 * `configure()` can never succeed for it. Detect it up front and never call
 * `configure()` for a config already known to be broken.
 *
 * Compares the NORMALIZED codec: `'Opus'.startsWith('opus')` is false (SP1
 * §7.5).
 */
export function audioTrackIsDecodable(audio: ChunkSource): boolean {
  if (audio.description !== undefined) return true
  return normalizeAudioCodec(audio.codec).startsWith('opus')
}

// ── Wall-clock fallback ─────────────────────────────────────────────────────

/**
 * The clock every non-audio path runs on: canvas projects, muted clips, clips
 * whose audio cannot be decoded, browsers without WebCodecs audio, and any
 * failure while building the real thing. Same transport surface, driven by
 * `performance.now()` instead of rendered frames.
 */
function createFallbackClock(
  startProjectS: number,
  reason: string,
  nowMs: () => number,
): MasterClock {
  let base = startProjectS
  let startedAtMs = nowMs()
  let playing = false

  const read = () => (playing ? base + (nowMs() - startedAtMs) / 1000 : base)

  return {
    kind: 'fallback',
    reason,
    get playing() {
      return playing
    },
    now: read,
    play() {
      if (playing) return
      startedAtMs = nowMs()
      playing = true
    },
    pause() {
      if (!playing) return
      base = read()
      playing = false
    },
    // `mediaS` is unused here: the fallback clock has no media position of its
    // own to reconcile, only project time. Widened to match `MasterClock.seek`
    // so it stays a drop-in implementation of the interface.
    seek(projectS: number, _mediaS?: number) {
      base = projectS
      startedAtMs = nowMs()
    },
    setVolume() {
      /* nothing is being rendered here — no level to set */
    },
    stats() {
      return {
        kind: 'fallback' as const,
        reason,
        playing,
        samplesConsumed: 0,
        underrunFrames: 0,
        queuedFrames: 0,
        queuedSeconds: 0,
      }
    },
    dispose() {
      // Freeze where it reads rather than just un-setting `playing`, so a
      // disposed clock's last reading stays truthful (a caller that reads once
      // more during teardown must not see the playhead snap back to the anchor).
      base = read()
      playing = false
    },
  }
}

/**
 * The wall-clock `MasterClock`, SYNCHRONOUSLY.
 *
 * `createMasterClock` already returns exactly this object for every no-audio
 * case, but it is a `Promise` by contract. T5's scheduler swaps clocks inside a
 * synchronous tick — into a gap, out of a gap, onto a clip whose proxy has not
 * arrived — and cannot await one there. Exported rather than re-implemented in
 * the scheduler so the engine has exactly ONE wall clock: a second copy is the
 * D9-class duplication the divergence registry exists to prevent.
 *
 * `reason` is surfaced in `stats()` and by T7's HUD, so pass something a human
 * can read ('gap', 'canvas project', 'preparing').
 */
export function createWallClock(
  startProjectS: number,
  reason: string,
  nowMs: () => number = () => performance.now(),
): MasterClock {
  return createFallbackClock(startProjectS, reason, nowMs)
}

// ── Audio clock ─────────────────────────────────────────────────────────────

/** Tracks whether this context's AudioWorkletGlobalScope already has the ring module. */
const workletLoaded = new WeakSet<BaseAudioContext>()

/**
 * `addModule` once per AudioContext. The context is page-scoped and outlives
 * every clock built on it, so a naive add-per-clock would re-evaluate the
 * module on every clip boundary; the string's own `registerProcessor` guard
 * makes that survivable, and this cache makes it not happen in the first
 * place. (Both are needed: module state resets on a dev hot reload while
 * `window.__montajSharedCtx` does not.)
 */
async function ensureRingModule(ctx: BaseAudioContext): Promise<void> {
  if (workletLoaded.has(ctx)) return
  const url = URL.createObjectURL(new Blob([audioWorkletSource], { type: 'text/javascript' }))
  try {
    await ctx.audioWorklet.addModule(url)
    workletLoaded.add(ctx)
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function createAudioClock(
  audio: ChunkSource,
  options: Required<Pick<MasterClockOptions, 'timebase' | 'startProjectS'>> & {
    volume: number
    onError?: (message: string) => void
    nowMs: () => number
  },
): Promise<MasterClock> {
  const { timebase, startProjectS, onError, nowMs } = options
  const ctx = getSharedAudioContext()
  await ensureRingModule(ctx)

  // The container's real parameters (T2's deviation from the spike, which had
  // to hardcode 48000/2). The decoded AudioData's own `sampleRate` is what the
  // resampler trusts per chunk; this one only configures the decoder.
  const channels = audio.audio?.channelCount || DEFAULT_CHANNELS
  const decodedRate = audio.audio?.sampleRate || DEFAULT_SAMPLE_RATE
  const renderRate = ctx.sampleRate

  const node = new AudioWorkletNode(ctx, RING_PROCESSOR_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
    processorOptions: { reportIntervalS: REPORT_INTERVAL_S },
  })
  node.connect(ctx.destination)

  if (ctx.state === 'suspended') {
    // Best effort only: a resume outside a user-gesture call stack is not
    // gesture-credited and usually stays suspended. T6 wires the real anchors
    // (`togglePlay`, the Space keydown) through
    // `resumeAudioContextFromGesture`. Until something does, the clock — and
    // therefore the painter — legitimately stalls; see MAX_EXTRAPOLATION_MS.
    void ctx.resume().catch(() => {})
  }

  let volume = options.volume
  let playing = false
  let disposed = false

  // Ring epoch. Bumped on every reset (seek / play-from-frozen); reports
  // carrying an older epoch describe a ring that no longer exists and are
  // discarded — the audio-side twin of the decode worker's `reqId`
  // supersession.
  let epoch = 0
  /** Epoch the in-flight decode batch belongs to; its AudioData is dropped if it went stale. */
  let feedEpoch = 0

  let anchorProjectS = startProjectS
  let frozenProjectS = startProjectS
  let samplesConsumed = 0
  let underrunFrames = 0
  let lastReportMs = nowMs()
  /** Frames posted to the ring since the reset. */
  let postedFrames = 0
  /** Frames the ring has actually drained (rendered MINUS silence) as of the last report. */
  let drainedFrames = 0
  let resamplePhase = 0

  let nextPacketIdx = 0
  let decoding = false
  /**
   * Set when `decoder.decode()` throws synchronously (a dead/misconfigured
   * decoder). Without this, `feedMore` is re-armed at the end of every
   * `output`/report cycle (see `feedMore`'s own tail call and the port
   * `onmessage` handler) and would retry the same broken decoder roughly
   * every report interval forever — a permanent ~10Hz `onError` spam for a
   * session that can never recover. Cleared on `restartAt` (seek re-anchors
   * the decoder's input position, which is the only thing that can make a
   * retry meaningfully different).
   */
  let feedFailed = false

  const queuedFrames = () => Math.max(0, postedFrames - drainedFrames)

  const read = (): number => {
    if (!playing) return frozenProjectS
    const projected = extrapolateSamples(samplesConsumed, nowMs() - lastReportMs, renderRate)
    return projectTimeForSamples(anchorProjectS, projected, renderRate)
  }

  const decoder = new AudioDecoder({
    output: (frame) => {
      try {
        if (disposed || feedEpoch !== epoch) return
        const planeCount = frame.numberOfChannels
        const frames = frame.numberOfFrames
        const planes: Float32Array[] = []
        for (let ch = 0; ch < planeCount; ch++) {
          const plane = new Float32Array(frames)
          // Ask the platform to convert from whatever the decoder's native
          // output format is (s16/f32/planar/interleaved) so nothing here has
          // to special-case it.
          frame.copyTo(plane, { planeIndex: ch, format: 'f32-planar' })
          planes.push(plane)
        }
        const scaled = scaleAndInterleavePlanes(planes, frames, volume)
        const ratio = frame.sampleRate / renderRate
        const resampled = resampleInterleaved(scaled, planeCount, ratio, resamplePhase)
        resamplePhase = resampled.phase
        const outFrames = Math.floor(resampled.pcm.length / planeCount)
        if (outFrames === 0) return
        postedFrames += outFrames
        node.port.postMessage(
          { t: 'chunk', pcm: resampled.pcm, channels: planeCount, frames: outFrames },
          [resampled.pcm.buffer],
        )
      } finally {
        frame.close()
      }
    },
    error: (err) => {
      // A dead decoder starves the ring; the worklet renders silence and the
      // clock keeps advancing (that is the whole point of silence-through-
      // underruns). Report it; never throw at the caller.
      onError?.(`audio decoder: ${err instanceof Error ? err.message : String(err)}`)
    },
  })
  try {
    decoder.configure({
      // `normalizeAudioCodec` both fixes mp4box's casing (Opus → opus, which
      // `configure()` rejects otherwise) and expands a bare `mp4a` — though the
      // latter cannot reach here, `audioTrackIsDecodable` having already
      // rejected description-less non-Opus tracks.
      codec: normalizeAudioCodec(audio.codec),
      description: audio.description,
      sampleRate: decodedRate,
      numberOfChannels: channels,
    })
  } catch (err) {
    // Leave nothing connected to the shared context on the way out; the caller
    // turns this into a wall-clock fallback.
    try {
      decoder.close()
    } catch {
      // never configured — nothing to close.
    }
    node.disconnect()
    throw err
  }

  /**
   * Top the ring up to `RING_SECONDS`. Runs while PAUSED too, so a parked
   * clock is already primed and `play()` starts on real audio instead of an
   * underrun.
   */
  function feedMore(): void {
    if (disposed || decoding || feedFailed) return
    if (nextPacketIdx >= audio.samples.length) return
    if (queuedFrames() / renderRate >= RING_SECONDS) return

    decoding = true
    feedEpoch = epoch
    const end = Math.min(nextPacketIdx + AUDIO_BATCH_PACKETS, audio.samples.length)
    try {
      for (let i = nextPacketIdx; i < end; i++) {
        const s = audio.samples[i]
        // Audio codecs have no delta-frame concept the way video GOPs do —
        // every packet decodes independently, so always 'key' regardless of
        // `SampleRef.isKey` (which demux derives from the container's
        // sync-sample flag, meaningless on an audio track).
        decoder.decode(
          new EncodedAudioChunk({ type: 'key', timestamp: s.tsUs, duration: s.durUs, data: s.data }),
        )
      }
    } catch (err) {
      decoding = false
      feedFailed = true
      onError?.(`audio decode: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    nextPacketIdx = end
    decoder
      .flush()
      .then(() => {
        decoding = false
        // The ring may have been reset mid-batch; `feedMore` always reads the
        // CURRENT position, so a stale batch costs nothing beyond the frames
        // its epoch check already discarded in `output`.
        feedMore()
      })
      .catch((err) => {
        decoding = false
        onError?.(`audio flush: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  /**
   * Reset the ring and re-anchor everything to `projectS`.
   *
   * Decoding starts at the packet at-or-before the target, so the first audio
   * the ring plays can lead the anchor by up to one packet (~20ms for the
   * proxies' libopus encode) while the clock still calls that instant
   * `projectS`. Spike behavior, kept deliberately: SP1 §6 measured the whole
   * pipeline at −4.3ms p50 / −0.4ms p95 A/V error with exactly this anchoring,
   * i.e. well inside the band, and the alternative — anchoring on the fed
   * packet's true media time — would instead make `seek(t)` land the *picture*
   * up to 20ms off the requested frame, which is the more visible error in an
   * editor. Trimming the first packet's leading samples would remove both and
   * is the named follow-up if the checklist ever measures it as audible.
   */
  function restartAt(projectS: number, mediaS?: number): void {
    epoch += 1
    anchorProjectS = projectS
    frozenProjectS = projectS
    samplesConsumed = 0
    underrunFrames = 0
    postedFrames = 0
    drainedFrames = 0
    resamplePhase = 0
    feedFailed = false
    lastReportMs = nowMs()
    // `mediaS`, when given, is the loop-wrapped media position the frame
    // server just restarted its stream at — decode from THAT packet, not from
    // whatever `projectS` maps to through the timebase (which is the pre-wrap
    // mapping and would restart audio a whole loop window ahead of the
    // picture). See `MasterClock.seek`'s doc.
    nextPacketIdx = sampleAtOrBefore(
      audio,
      mediaS === undefined
        ? mediaTsUsForProjectTime(timebase, projectS)
        : timebase.firstPresentationTsUs + mediaS * 1_000_000,
    )
    node.port.postMessage({ t: 'reset', epoch })
    feedMore()
  }

  node.port.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as {
      t?: string
      epoch?: number
      samplesConsumed?: number
      underrunFrames?: number
    }
    if (msg?.t !== 'consumed' || msg.epoch !== epoch) return
    samplesConsumed = msg.samplesConsumed ?? 0
    underrunFrames = msg.underrunFrames ?? 0
    // Frames the ring actually drained = rendered minus the silence it
    // invented. Using `samplesConsumed` alone would undercount the queue after
    // any underrun and make the feeder over-decode.
    drainedFrames = samplesConsumed - underrunFrames
    lastReportMs = nowMs()
    feedMore()
  }

  // Anchor without playing: the caller gets a clock parked at startProjectS.
  restartAt(startProjectS)

  return {
    kind: 'audio',
    get playing() {
      return playing
    },
    now: read,
    play() {
      if (playing || disposed) return
      // Resume from the FROZEN reading. After a real pause the ring is primed
      // for the last position the worklet actually rendered, which trails the
      // frozen (extrapolated) reading by up to one report interval — resuming
      // it as-is would visibly walk the playhead backwards, so the ring is
      // re-anchored instead. One Opus decode batch is far cheaper than real
      // time, so the restart is not felt.
      //
      // The exception is a clock that has rendered nothing since its last
      // anchor (freshly created, or `seek`ed while paused): its ring is already
      // primed for exactly this position, so un-gate it and keep the pre-buffer.
      if (frozenProjectS !== anchorProjectS || samplesConsumed > 0) restartAt(frozenProjectS)
      playing = true
      // Re-base extrapolation on NOW. Without this the first `now()` after a
      // long pause extrapolates from a stale report and jumps the playhead
      // forward by the whole extrapolation ceiling.
      lastReportMs = nowMs()
      node.port.postMessage({ t: 'play' })
    },
    pause() {
      if (!playing) return
      // Freeze at the EXTRAPOLATED reading — the best estimate of what the user
      // just saw and heard — rather than at the last report, which can be up to
      // a full report interval stale and would visibly snap the playhead back.
      frozenProjectS = read()
      playing = false
      node.port.postMessage({ t: 'pause' })
    },
    seek(projectS: number, mediaS?: number) {
      if (disposed) return
      restartAt(projectS, mediaS)
      if (playing) node.port.postMessage({ t: 'play' })
    },
    setVolume(next: number) {
      volume = next
    },
    stats() {
      return {
        kind: 'audio' as const,
        playing,
        samplesConsumed,
        underrunFrames,
        queuedFrames: queuedFrames(),
        queuedSeconds: queuedFrames() / renderRate,
      }
    },
    dispose() {
      if (disposed) return
      // Freeze before un-setting `playing`, so a read during teardown returns
      // the last true position rather than snapping back to the ring anchor.
      frozenProjectS = read()
      disposed = true
      playing = false
      node.port.onmessage = null
      try {
        node.port.postMessage({ t: 'pause' })
      } catch {
        // port already torn down — nothing to stop.
      }
      try {
        decoder.close()
      } catch {
        // already closed or errored — we are tearing down anyway.
      }
      try {
        node.disconnect()
      } catch {
        // already disconnected — fine.
      }
      // The AudioContext is deliberately NOT closed: it is
      // `window.__montajSharedCtx`, shared with the legacy player's video slots
      // and audio lanes and reused by every later clock. Closing it here would
      // silence the whole page. (The spike closed its context because it owned
      // one privately.)
    },
  }
}

/**
 * Build the master clock for one clip. **Never throws and never rejects** —
 * every failure resolves to a wall-clock `MasterClock` carrying a `reason`.
 *
 * The fallback is not an error path so much as the normal mode for a large
 * share of projects: canvas (image-only) projects have no audio at all, muted
 * clips have nothing worth syncing to, and a browser without WebCodecs audio
 * still has to scrub and play. Everything downstream reads the same surface
 * either way.
 */
export async function createMasterClock(options: MasterClockOptions): Promise<MasterClock> {
  const { audio, timebase, startProjectS, muted, onError } = options
  const nowMs = options.nowMs ?? (() => performance.now())
  const volume = muted ? 0 : (options.volume ?? 1)

  // Cheap disqualifications first — none of these should create an AudioContext
  // for a project that will never render a sample through it.
  if (muted) return createFallbackClock(startProjectS, 'clip is muted', nowMs)
  if (!audio || audio.samples.length === 0) {
    return createFallbackClock(startProjectS, 'no audio track', nowMs)
  }
  if (typeof AudioDecoder === 'undefined' || typeof AudioWorkletNode === 'undefined') {
    return createFallbackClock(startProjectS, 'WebCodecs audio / AudioWorklet unavailable', nowMs)
  }
  if (!audioTrackIsDecodable(audio)) {
    return createFallbackClock(
      startProjectS,
      `audio codec "${audio.codec}" has no decoder description (mp4box couldn't parse this file's audio sample entry)`,
      nowMs,
    )
  }

  try {
    return await createAudioClock(audio, { timebase, startProjectS, volume, onError, nowMs })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    onError?.(`audio clock: ${message}`)
    return createFallbackClock(startProjectS, message, nowMs)
  }
}
