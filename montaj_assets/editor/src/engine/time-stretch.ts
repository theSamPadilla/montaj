/**
 * Pitch-preserving audio time-stretch — the shared primitive behind every
 * variable-rate playback path (per-clip speed, and the shuttle's audible
 * fast-forward through the transport rate).
 *
 * Runs on the MAIN thread, NOT in the AudioWorklet: `audio-clock.ts` calls it
 * from the WebCodecs `AudioDecoder`'s `output` callback (which fires on main),
 * so the stretch happens once, inline, as the PCM is produced, and the already-
 * stretched buffer is what gets posted into the ring. The preview mixer's
 * Worker (`mix/mix-worker-source.ts`) runs a line-for-line port of this file;
 * its tests hold the two to bit-identical output. Keeping the DSP here (and out
 * of the worklet, which stays "thin by architecture" — see
 * `audio-worklet-source.ts`) is what lets it be a pure function under vitest.
 *
 * The algorithm is WSOLA (Waveform-Similarity Overlap-Add). Cut the input into
 * overlapping Hann-windowed frames and overlap-add them back at a DIFFERENT
 * hop: advance the read head slower than the write head and the signal grows
 * longer; faster and it shrinks. Because each frame keeps its own local
 * waveform, the pitch is untouched — this is the whole reason it is not a
 * resample (`resampleInterleaved` in `audio-clock.ts`), which changes length by
 * changing pitch. The "waveform-similarity" part is a cross-correlation search
 * that nudges each frame so it continues the previous one in phase across
 * their overlap; that is what stops a voice from beating or going hollow and
 * is the difference between WSOLA and plain OLA.
 *
 * It is natively STREAMING (§450). `createStreamStretch` keeps the WSOLA state
 * — unread input, the read position, the previous frame's continuation and the
 * half-built overlap-add — across `push` calls, and places every frame by its
 * absolute position in the input. So the output does not depend on how the
 * input was chunked: N pushes give exactly what one push of their
 * concatenation gives, and the batch `timeStretch` is one push plus a flush.
 * The wrapper this replaced re-ran a whole-buffer WSOLA on each 2048-frame
 * block and crossfaded the renderings; they were not in phase, so the level
 * dipped once per block, a ~26 Hz warble at speed 1.12 that read as a robotic
 * voice. Its ±128-sample search was also shorter than half the pitch period of
 * any voice below ~190 Hz, so most male voices overlapped out of phase.
 *
 * The tuning follows ffmpeg's `atempo` (what the export renders with): a ~43ms
 * frame at half overlap and a search of up to half a frame, scored by
 * normalized cross-correlation with a mild pull toward the ideal position.
 * Measured against `atempo` on speech at speed 1.12, the log-spectral distance
 * fell to within ~0.5 dB of what two `atempo` renderings differ by. The search
 * runs coarse-to-fine (a 4x-decimated pass, then a full-rate refine), which
 * keeps it to a few milliseconds of main-thread time per second of audio.
 */

// ── Tuning constants ─────────────────────────────────────────────────────────

/**
 * Analysis/synthesis frame length in samples. ~43ms at 48kHz, ~46ms at 44.1kHz,
 * which is `atempo`'s window: long enough to hold several periods of the
 * lowest voice and to keep a frame's spectrum stable, short enough that the
 * local-stationarity assumption OLA rests on holds for speech. Sample-count
 * fixed (the function isn't handed a rate); the 8% span difference between
 * the two target rates is immaterial.
 */
const FRAME = 2048

/**
 * Synthesis hop — the fixed output advance per frame. FRAME/2 (50% overlap) is
 * the COLA sweet spot for a periodic Hann window: two half-overlapped Hann
 * windows sum to exactly 1.0, so the overlap-add has unity gain in the interior.
 * The read head advances `SYNTH_HOP / factor` per frame, kept as a fraction so
 * the realized factor is exact and a long stream never drifts.
 */
const SYNTH_HOP = FRAME / 2

/** Overlap region length (= FRAME − SYNTH_HOP). The span the similarity search matches over. */
const OVERLAP = FRAME - SYNTH_HOP

/**
 * How far, in samples, a frame may be nudged from its ideal read position to
 * continue the previous frame in phase. To always find an in-phase position the
 * search must reach half a pitch period either way; ±512 does that for any
 * fundamental above ~47Hz at 48kHz, the bottom of the speaking range included.
 */
const SEARCH = 512

/**
 * Decimation of the coarse search pass. The full ±SEARCH range is scored on
 * sums of DECIMATE samples (a cheap low-pass that keeps the fundamental and the
 * low harmonics, which decide the phase), then the best coarse offset is refined
 * at full rate within ±DECIMATE. A sixteenth of the brute-force cost; measured,
 * it matched full-rate search on speech.
 */
const DECIMATE = 4

/**
 * Pull toward the ideal read position: a candidate's score is scaled by
 * `1 − CENTER_BIAS·(offset/SEARCH)²`. Several offsets a period apart continue a
 * voiced frame almost equally well; preferring the nearest keeps the timing
 * closest to the source (`atempo` weights its search the same way).
 */
const CENTER_BIAS = 0.3

/**
 * Upper bound on the stretch factor actually applied. Guards against a
 * pathological allocation (a caller passing 1e9 would otherwise ask for a
 * multi-terabyte output); 32× is far beyond any real variable-rate use, where
 * factors live in ~0.25–4.0. The low end needs no clamp — a tiny factor only
 * ever produces a tiny (or empty) output.
 */
const MAX_STRETCH = 32

/** Below this accumulated window weight an output sample got no real coverage → force it to silence. */
const WEIGHT_EPSILON = 1e-6

/** Below this candidate-window energy the correlation is meaningless (silence) → score 0. */
const ENERGY_EPSILON = 1e-9

/** Consumed input is shifted out of the stream's store once at least this many frames of it pile up. */
const COMPACT_FRAMES = 8192

/**
 * Input frames a stream needs beyond a frame's ideal read position before it
 * can place that frame: the search reach plus the frame itself. A stream's
 * output trails its input by about this much (≈53ms at 48kHz); a caller that
 * prefetches source for a stretched stream reads this much further ahead.
 */
export const STRETCH_LOOKAHEAD_FRAMES = SEARCH + FRAME

const COARSE_TARGET = OVERLAP / DECIMATE
const COARSE_REGION = (2 * SEARCH + OVERLAP) / DECIMATE
const COARSE_STEPS = (2 * SEARCH) / DECIMATE
const WINDOW = hann(FRAME)

// ── Public surface ───────────────────────────────────────────────────────────

/**
 * A streaming, stateful time-stretch for one continuous stream of PCM.
 */
export interface StreamStretch {
  /**
   * Stretch a chunk of interleaved PCM, returning every output frame that is
   * now final (interleaved, same channel count) — possibly EMPTY while the
   * look-ahead is still filling. Output depends only on the input, never on how
   * it was split into pushes. At factor 1 it is a zero-copy identity (the input
   * buffer itself is returned, no buffering, no added latency), so it agrees
   * with the caller's own strict bypass.
   */
  push(input: Float32Array): Float32Array
  /**
   * End the stream: treat the input as followed by silence, emit everything
   * still held, and reset. What the batch `timeStretch` is built from.
   */
  flush(): Float32Array
  /**
   * Adopt a new factor from the next frame on. The state carries over, so the
   * change is seamless: no seam, no dropped input.
   */
  setFactor(factor: number): void
  /** Drop all buffered input and carried state — a new stream starts (a seek, a ring reset). */
  reset(): void
}

/**
 * Time-stretch interleaved PCM by `factor` with pitch preserved.
 * factor = output_duration / input_duration:
 *   factor > 1 → longer/slower (e.g. 2.0 doubles length, half speed playback)
 *   factor < 1 → shorter/faster (e.g. 0.5 halves length, double speed playback)
 *   factor === 1 → identity (return input unchanged or a faithful copy)
 * `input` is interleaved (L,R,L,R,... for stereo) Float32 at any sample rate.
 * Returns a new interleaved Float32Array of exactly round(inFrames * factor)
 * frames. Identical to streaming the same input through `createStreamStretch`
 * and flushing, trimmed to that length.
 */
export function timeStretch(input: Float32Array, channels: number, factor: number): Float32Array {
  checkFactor(factor)
  checkChannels(channels)
  if (input.length === 0) return new Float32Array(0)
  if (factor === 1) return input.slice() // faithful copy — never alias the caller's buffer

  const f = Math.min(factor, MAX_STRETCH)
  const inFrames = Math.floor(input.length / channels)
  if (inFrames === 0) return new Float32Array(0)

  const stream = createStreamStretch(channels, f)
  const head = stream.push(input.subarray(0, inFrames * channels))
  const tail = stream.flush()
  const outLen = Math.round(inFrames * f) * channels
  const out = new Float32Array(outLen)
  out.set(head.subarray(0, Math.min(head.length, outLen)))
  if (head.length < outLen) out.set(tail.subarray(0, Math.min(tail.length, outLen - head.length)), head.length)
  return out
}

/**
 * A streaming time-stretch of interleaved PCM by `factor` (as `timeStretch`).
 * One per continuous stream: a seek or a new source is `reset()`.
 */
export function createStreamStretch(channels: number, factor: number): StreamStretch {
  checkFactor(factor)
  checkChannels(channels)
  let f = factor
  /** Input read-head advance per frame, in (fractional) input frames. */
  let advance = SYNTH_HOP / Math.min(f, MAX_STRETCH)

  // Input store: interleaved PCM plus its mono mix (the mono mix drives the ONE
  // similarity decision every channel shares, so L and R are nudged by the same
  // offset and the stereo image is preserved). Frame `i` of the store is input
  // frame `base + i` of the stream.
  let store = new Float32Array(0)
  let mono = store
  let base = 0
  let held = 0

  /** Ideal read position of the next frame, in input frames from the stream start. */
  let pos = 0
  /** Where the previous frame was read, and whether there is one to continue. */
  let prevRead = 0
  let hasPrev = false

  // The overlap-add under construction: output frames [k·SYNTH_HOP, k·SYNTH_HOP + FRAME)
  // for the frame about to be placed. Its first SYNTH_HOP frames hold the
  // previous frame's tail.
  const acc = new Float32Array(FRAME * channels)
  const weight = new Float32Array(FRAME)

  // The previous frame's natural continuation (mono): what the next frame's
  // leading OVERLAP samples should match. Plus search scratch.
  const target = new Float32Array(OVERLAP)
  const region = new Float32Array(2 * SEARCH + OVERLAP)
  const coarseTarget = new Float64Array(COARSE_TARGET)
  const coarseRegion = new Float64Array(COARSE_REGION)

  function append(input: Float32Array): void {
    const n = Math.floor(input.length / channels)
    if (n === 0) return
    if ((held + n) * channels > store.length) {
      let cap = Math.max(16384, store.length / channels)
      while (cap < held + n) cap *= 2
      const next = new Float32Array(cap * channels)
      next.set(store.subarray(0, held * channels))
      if (channels === 1) {
        mono = next
      } else {
        const nextMono = new Float32Array(cap)
        nextMono.set(mono.subarray(0, held))
        mono = nextMono
      }
      store = next
    }
    store.set(input.subarray(0, n * channels), held * channels)
    if (channels > 1) {
      for (let fr = 0; fr < n; fr++) {
        let s = 0
        for (let ch = 0; ch < channels; ch++) s += input[fr * channels + ch]
        mono[held + fr] = s / channels
      }
    }
    held += n
  }

  /** Mono sample at absolute input frame `p`; silence outside what is held. */
  function monoAt(p: number): number {
    const i = p - base
    return i >= 0 && i < held ? mono[i] : 0
  }

  /**
   * Offset within ±SEARCH of `ideal` whose OVERLAP-sample window best continues
   * `target`. Ties (and total silence) resolve to 0, so a silent or aperiodic
   * signal degrades gracefully to plain OLA at the ideal position.
   */
  function bestOffset(ideal: number): number {
    const start = ideal - SEARCH
    for (let i = 0; i < region.length; i++) region[i] = monoAt(start + i)
    for (let j = 0; j < COARSE_TARGET; j++) {
      let s = 0
      for (let q = 0; q < DECIMATE; q++) s += target[j * DECIMATE + q]
      coarseTarget[j] = s
    }
    for (let j = 0; j < COARSE_REGION; j++) {
      let s = 0
      for (let q = 0; q < DECIMATE; q++) s += region[j * DECIMATE + q]
      coarseRegion[j] = s
    }

    // Coarse: every DECIMATE-th offset, on the decimated signals. The window
    // energy slides along with the candidate.
    let energy = 0
    for (let j = 0; j < COARSE_TARGET; j++) energy += coarseRegion[j] * coarseRegion[j]
    const center = SEARCH / DECIMATE
    let bestK = center
    let bestScore = -Infinity
    for (let k = 0; k <= COARSE_STEPS; k++) {
      if (k > 0) {
        const out = coarseRegion[k - 1]
        const inn = coarseRegion[k + COARSE_TARGET - 1]
        energy += inn * inn - out * out
      }
      let dot = 0
      for (let j = 0; j < COARSE_TARGET; j++) dot += coarseRegion[k + j] * coarseTarget[j]
      const score = weigh(energy <= ENERGY_EPSILON ? 0 : dot / Math.sqrt(energy), k * DECIMATE - SEARCH)
      if (score > bestScore || (score === bestScore && k === center)) {
        bestScore = score
        bestK = k
      }
    }

    // Fine: every offset within ±DECIMATE of the coarse winner, at full rate.
    const coarse = bestK * DECIMATE - SEARCH
    const lo = Math.max(-SEARCH, coarse - DECIMATE)
    const hi = Math.min(SEARCH, coarse + DECIMATE)
    let bestOff = coarse
    bestScore = fineScore(coarse)
    for (let off = lo; off <= hi; off++) {
      if (off === coarse) continue
      const score = fineScore(off)
      if (score > bestScore) {
        bestScore = score
        bestOff = off
      }
    }
    return bestOff
  }

  /** Normalized cross-correlation of the full-rate candidate at `off` against `target`, center-weighted. */
  function fineScore(off: number): number {
    const at = off + SEARCH
    let dot = 0
    let energy = 0
    for (let i = 0; i < OVERLAP; i++) {
      const c = region[at + i]
      dot += c * target[i]
      energy += c * c
    }
    return weigh(energy <= ENERGY_EPSILON ? 0 : dot / Math.sqrt(energy), off)
  }

  /**
   * Place the next frame and write the SYNTH_HOP output frames it completes
   * into `out` at frame `at`.
   */
  function step(out: Float32Array, at: number): void {
    const ideal = Math.round(pos)
    // The first frame of a stream is placed as-is; each later one is nudged to
    // continue the previous frame's tail in phase across the overlap.
    const readPos = hasPrev ? ideal + bestOffset(ideal) : ideal

    for (let i = 0; i < FRAME; i++) {
      const w = WINDOW[i]
      // Window weights are identical for every channel; accumulate once.
      // Out-of-input samples still count (their signal is a real 0), which
      // fades a flushed stream's very end to silence rather than cutting it.
      weight[i] += w
      const src = readPos + i - base
      if (src < 0 || src >= held) continue // reads outside the input are silence
      for (let ch = 0; ch < channels; ch++) acc[i * channels + ch] += store[src * channels + ch] * w
    }

    // The natural continuation of the frame just placed: what a match should
    // look like SYNTH_HOP samples on.
    for (let i = 0; i < OVERLAP; i++) target[i] = monoAt(readPos + SYNTH_HOP + i)
    prevRead = readPos
    hasPrev = true
    pos += advance

    emit(out, at)
    acc.copyWithin(0, SYNTH_HOP * channels)
    acc.fill(0, (FRAME - SYNTH_HOP) * channels)
    weight.copyWithin(0, SYNTH_HOP)
    weight.fill(0, FRAME - SYNTH_HOP)
  }

  /**
   * Write the first SYNTH_HOP frames of the overlap-add, normalized by their
   * accumulated window weight → unity gain wherever the windows covered (COLA
   * already gives 1.0 in the interior; this also recovers the stream's first
   * samples). Zero where nothing was written, so silence stays silence.
   */
  function emit(out: Float32Array, at: number): void {
    for (let i = 0; i < SYNTH_HOP; i++) {
      const w = weight[i]
      for (let ch = 0; ch < channels; ch++) {
        out[(at + i) * channels + ch] = w > WEIGHT_EPSILON ? acc[i * channels + ch] / w : 0
      }
    }
  }

  /** Frames placeable while the next frame's ideal position stays below `limit` (same arithmetic as `step`). */
  function countSteps(limit: (ideal: number) => boolean): number {
    let n = 0
    let p = pos
    while (limit(Math.round(p))) {
      n++
      p += advance
    }
    return n
  }

  /** Shift out input no later frame can read: before the next target and the next search window. */
  function compact(): void {
    const keep = Math.min(hasPrev ? prevRead + SYNTH_HOP : Infinity, Math.round(pos) - SEARCH)
    const drop = keep - base
    if (drop < COMPACT_FRAMES || drop > held) return
    store.copyWithin(0, drop * channels, held * channels)
    if (channels > 1) mono.copyWithin(0, drop, held)
    held -= drop
    base += drop
  }

  function reset(): void {
    base = 0
    held = 0
    pos = 0
    prevRead = 0
    hasPrev = false
    acc.fill(0)
    weight.fill(0)
    target.fill(0)
  }

  return {
    push(input: Float32Array): Float32Array {
      if (f === 1) return input // strict identity — no buffering, no copy
      append(input)
      const end = base + held
      const n = countSteps((ideal) => ideal + STRETCH_LOOKAHEAD_FRAMES <= end)
      const out = new Float32Array(n * SYNTH_HOP * channels)
      for (let k = 0; k < n; k++) step(out, k * SYNTH_HOP)
      compact()
      return out
    },
    flush(): Float32Array {
      if (f === 1) {
        reset()
        return new Float32Array(0)
      }
      // Every frame whose ideal start lies inside the input, then the last
      // frame's tail, which no later frame will complete.
      const end = base + held
      const n = countSteps((ideal) => ideal < end)
      const out = new Float32Array((n + 1) * SYNTH_HOP * channels)
      for (let k = 0; k < n; k++) step(out, k * SYNTH_HOP)
      emit(out, n * SYNTH_HOP)
      reset()
      return out
    },
    setFactor(next: number): void {
      checkFactor(next)
      if (next === f) return
      f = next
      advance = SYNTH_HOP / Math.min(f, MAX_STRETCH)
      // Factor 1 bypasses the state entirely; leaving the old stream in it
      // would replay stale input if the factor later moved off 1 again.
      if (f === 1) reset()
    },
    reset,
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

function checkFactor(factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`timeStretch: factor must be a finite positive number, got ${factor}`)
  }
}

function checkChannels(channels: number): void {
  if (!Number.isInteger(channels) || channels < 1) {
    throw new Error(`timeStretch: channels must be a positive integer, got ${channels}`)
  }
}

/** Center-weight a similarity score by how far its offset strays from the ideal position. */
function weigh(score: number, off: number): number {
  const o = off / SEARCH
  return score * (1 - CENTER_BIAS * o * o)
}

/** Periodic Hann window (÷N, not ÷(N−1)) — the form whose 50%-overlap copies sum to exactly 1.0. */
function hann(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n))
  return w
}
