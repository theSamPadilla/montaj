/**
 * Pitch-preserving audio time-stretch — the shared primitive behind every
 * variable-rate playback path (the fast-forward shuttle's audible scrub and
 * per-clip speed).
 *
 * Runs on the MAIN thread, NOT in the AudioWorklet: it is called from the
 * WebCodecs `AudioDecoder`'s `output` callback (which fires on main), so the
 * stretch happens once, inline, as the PCM is produced, and the already-
 * stretched buffer is what gets posted into the ring — the same seam
 * `audio-clock.ts` already resamples at. Keeping the DSP here (and out of the
 * worklet, which stays "thin by architecture" — see `audio-worklet-source.ts`)
 * is what lets it be a pure function under vitest instead of untestable code
 * inlined in a string.
 *
 * The algorithm is WSOLA (Waveform-Similarity Overlap-Add). Cut the input into
 * overlapping Hann-windowed frames and overlap-add them back at a DIFFERENT
 * hop: advance the read head slower than the write head and the signal grows
 * longer; faster and it shrinks. Because each frame keeps its own local
 * waveform, the pitch is untouched — this is the whole reason it is not a
 * resample (`resampleInterleaved` in `audio-clock.ts`), which changes length by
 * changing pitch. The "waveform-similarity" part is a small cross-correlation
 * search that nudges each frame a few samples so successive frames stay phase-
 * aligned across their overlap; that is what stops periodic sounds from beating
 * or clicking and is the difference between WSOLA and plain OLA.
 *
 * This is PREVIEW quality: clearly intelligible, cheap enough to run inline in
 * a decode callback. The final render stretches with ffmpeg's `atempo`
 * elsewhere, not this code, so broadcast-grade transient handling is out of
 * scope here on purpose.
 */

// ── Tuning constants ─────────────────────────────────────────────────────────

/**
 * Analysis/synthesis frame length in samples. ~21ms at 48kHz, ~23ms at 44.1kHz
 * — long enough to hold a couple of periods of a low speech/music fundamental
 * (down to ~90Hz), short enough that the local-stationarity assumption OLA
 * rests on holds. Sample-count fixed (the function isn't handed a rate); the
 * 8% span difference between the two target rates is immaterial.
 */
const FRAME = 1024

/**
 * Synthesis hop — the fixed output advance per frame. FRAME/2 (50% overlap) is
 * the COLA sweet spot for a periodic Hann window: two half-overlapped Hann
 * windows sum to exactly 1.0, so the overlap-add has unity gain in the interior
 * with no per-sample renormalization needed there. The realized stretch factor
 * is `SYNTH_HOP / analysisHop`.
 */
const SYNTH_HOP = FRAME / 2

/** Overlap region length (= FRAME − SYNTH_HOP). The span the similarity search matches over. */
const OVERLAP = FRAME - SYNTH_HOP

/**
 * How far, in samples, a frame may be nudged from its ideal read position to
 * find the best waveform continuation. ±128 covers more than one full period of
 * anything above ~190Hz and comfortably locks onto a 440Hz test tone (period
 * ~109 samples), while keeping the correlation search — the hot loop — bounded.
 */
const SEARCH = 128

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

/** Below this candidate-window energy the correlation is meaningless (silence) → score 0, keep offset 0. */
const ENERGY_EPSILON = 1e-9

/**
 * Time-stretch interleaved PCM by `factor` with pitch preserved.
 * factor = output_duration / input_duration:
 *   factor > 1 → longer/slower (e.g. 2.0 doubles length, half speed playback)
 *   factor < 1 → shorter/faster (e.g. 0.5 halves length, double speed playback)
 *   factor === 1 → identity (return input unchanged or a faithful copy)
 * `input` is interleaved (L,R,L,R,... for stereo) Float32 at any sample rate.
 * Returns a new interleaved Float32Array with ~ (input.length * factor) samples.
 */
export function timeStretch(input: Float32Array, channels: number, factor: number): Float32Array {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`timeStretch: factor must be a finite positive number, got ${factor}`)
  }
  if (!Number.isInteger(channels) || channels < 1) {
    throw new Error(`timeStretch: channels must be a positive integer, got ${channels}`)
  }
  if (input.length === 0) return new Float32Array(0)
  if (factor === 1) return input.slice() // faithful copy — never alias the caller's buffer

  const f = Math.min(factor, MAX_STRETCH)
  const inFrames = Math.floor(input.length / channels)
  if (inFrames === 0) return new Float32Array(0)

  // Read head advance per frame. `round` keeps the realized factor
  // (SYNTH_HOP/analysisHop) as close to requested as integer hops allow;
  // `max(1, …)` stops a large factor from rounding the hop to 0 (infinite loop).
  const analysisHop = Math.max(1, Math.round(SYNTH_HOP / f))
  const numFrames = Math.max(1, Math.round(inFrames / analysisHop))

  // The mono mix drives the ONE similarity decision every channel shares, so L
  // and R are nudged by the same offset and the stereo image is preserved.
  const mono = channels === 1 ? input : downmix(input, channels, inFrames)
  const win = hann(FRAME)

  // Size for the full overlap-add span, then slice to the exact target length.
  // Normalization (below) makes the slice clean — there is no fade at the cut.
  const outFrames = Math.round(inFrames * f)
  const spanFrames = (numFrames - 1) * SYNTH_HOP + FRAME
  const totalFrames = Math.max(spanFrames, outFrames)
  const out = new Float32Array(totalFrames * channels)
  const weight = new Float32Array(totalFrames)

  // `target` holds the previous frame's natural continuation (from the mono
  // mix): the waveform the next frame's leading OVERLAP samples should match.
  const target = new Float32Array(OVERLAP)
  let hasTarget = false

  for (let m = 0; m < numFrames; m++) {
    const idealPos = m * analysisHop
    // First frame is placed as-is; each later one is nudged within ±SEARCH to
    // best continue the previous frame's tail across the overlap region.
    const readPos = hasTarget ? idealPos + bestOffset(mono, inFrames, idealPos, target) : idealPos
    const synthPos = m * SYNTH_HOP

    for (let ch = 0; ch < channels; ch++) {
      for (let i = 0; i < FRAME; i++) {
        const src = readPos + i
        if (src < 0 || src >= inFrames) continue // reads outside the input are silence
        out[(synthPos + i) * channels + ch] += input[src * channels + ch] * win[i]
      }
    }
    // Window weights are identical for every channel; accumulate once. Out-of-
    // input samples still count (their signal is a real 0), which crossfades the
    // buffer's very edges to silence rather than cutting them hard.
    for (let i = 0; i < FRAME; i++) weight[synthPos + i] += win[i]

    // The natural continuation of the frame just placed: what a match should
    // look like SYNTH_HOP samples on. Read from the mono mix, zero-padded.
    for (let i = 0; i < OVERLAP; i++) {
      const p = readPos + SYNTH_HOP + i
      target[i] = p >= 0 && p < inFrames ? mono[p] : 0
    }
    hasTarget = true
  }

  // Normalize by accumulated window weight → unity gain everywhere the windows
  // covered (COLA already gives 1.0 in the interior; this also recovers the
  // first/last samples and absorbs any drift from integer hops). Zero where
  // nothing was written, so silence stays silence and the tail never divides
  // by ~0.
  for (let fr = 0; fr < totalFrames; fr++) {
    const w = weight[fr]
    for (let ch = 0; ch < channels; ch++) {
      out[fr * channels + ch] = w > WEIGHT_EPSILON ? out[fr * channels + ch] / w : 0
    }
  }

  return out.length === outFrames * channels ? out : out.slice(0, outFrames * channels)
}

// ── Internals ────────────────────────────────────────────────────────────────

/** Periodic Hann window (÷N, not ÷(N−1)) — the form whose 50%-overlap copies sum to exactly 1.0. */
function hann(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n))
  return w
}

/** Average all channels into one mono track for the shared similarity decision. */
function downmix(input: Float32Array, channels: number, inFrames: number): Float32Array {
  const mono = new Float32Array(inFrames)
  for (let fr = 0; fr < inFrames; fr++) {
    let s = 0
    for (let ch = 0; ch < channels; ch++) s += input[fr * channels + ch]
    mono[fr] = s / channels
  }
  return mono
}

/**
 * Offset within ±SEARCH of `idealPos` whose OVERLAP-sample window best continues
 * `target`. Ties (and total silence) resolve to 0, so a silent or aperiodic
 * signal degrades gracefully to plain OLA at the ideal hop.
 */
function bestOffset(mono: Float32Array, inFrames: number, idealPos: number, target: Float32Array): number {
  let bestOff = 0
  let bestScore = correlate(mono, inFrames, idealPos, target)
  for (let off = -SEARCH; off <= SEARCH; off++) {
    if (off === 0) continue
    const score = correlate(mono, inFrames, idealPos + off, target)
    if (score > bestScore) {
      bestScore = score
      bestOff = off
    }
  }
  return bestOff
}

/**
 * Cross-correlation of `mono[pos … pos+OVERLAP)` against `target`, normalized by
 * the candidate window's energy. The target's energy is constant across all
 * offsets in one search, so dropping it from the denominator leaves the argmax
 * unchanged while halving the work; normalizing by the candidate energy is what
 * removes the bias toward louder windows. Out-of-input samples read as 0.
 */
function correlate(mono: Float32Array, inFrames: number, pos: number, target: Float32Array): number {
  let dot = 0
  let energy = 0
  for (let i = 0; i < OVERLAP; i++) {
    const p = pos + i
    const c = p >= 0 && p < inFrames ? mono[p] : 0
    dot += c * target[i]
    energy += c * c
  }
  return energy <= ENERGY_EPSILON ? 0 : dot / Math.sqrt(energy)
}
