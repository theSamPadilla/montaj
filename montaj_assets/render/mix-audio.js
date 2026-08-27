/**
 * mix-audio.js — Independent audio track mixing for the montaj render pipeline.
 *
 * Handles project.audio.tracks: per-track delay, volume, trimming, and amix.
 * Video item audio (muted flag on VisualItems) is handled inline in compose.js.
 */
import { spawnSync } from 'child_process'
import { FFMPEG } from './ffmpeg-bin.js'

const FFMPEG_TIMEOUT_MS = 600_000

/**
 * Editor fade-shape name → ffmpeg `afade`'s own `curve=` vocabulary.
 *
 * `linear` → `tri` (ffmpeg has no filter named "linear"; `tri` — a
 * triangular/linear ramp — is its equivalent). `exp`/`log` map straight
 * across: the editor's shapes (see editor/src/video/timeline/canvas/
 * fade-curve.ts's `fadeGain`, `t²` for exp and `t(2-t)` for log) were picked
 * to READ as those two ffmpeg curve families, not to reproduce their exact
 * formulas — the editor's envelope and waveform are the visual preview, this
 * is what actually shapes the rendered audio, and both now agree on shape by
 * name.
 */
const FFMPEG_CURVE_BY_SHAPE = { linear: 'tri', log: 'log', exp: 'exp' }

/** `track.fadeInCurve`/`fadeOutCurve` → an ffmpeg `curve=` value, defaulting
 *  to `exp` — the same DEFAULT_FADE_CURVE the editor falls back to for a
 *  track that predates fade shapes, so an un-set project renders exactly as
 *  it always has. */
function ffmpegFadeCurve(shape) {
  return FFMPEG_CURVE_BY_SHAPE[shape] ?? FFMPEG_CURVE_BY_SHAPE.exp
}

/**
 * Build the `afade` chain for one track. Both `st=` values are in DELAYED-STREAM
 * time — absolute timeline position — NOT track-local time.
 *
 * Why: every track is pushed into place with `adelay=${start * 1000}`, which
 * PREPENDS `start` seconds of silence. Every filter chained after that delay
 * therefore sees the padded stream, so t=0 for `afade` is the start of the
 * TIMELINE, not the start of the track's own audio.
 *
 * Getting this wrong fails silently rather than loudly, which is why it went
 * unnoticed until 2026-08-26: the fade-out used `st = (end - start) - fadeOut`
 * (track-local), so for any offset track it fired `start` seconds early. A music
 * bed at start 27.67 / end 53.8 with a 3.08s fade-out hit zero gain at stream
 * time 26.13s — 1.5s BEFORE its audio was due to begin — and `afade=t=out` holds
 * zero for the rest of the stream. The track's entire audible length was
 * multiplied by zero — all 26.1s of it — and the deliverable measured -91 dB
 * across its last 24 seconds, once the voiceover underneath it ended. The render
 * reported success. `afade=t=in` had the same root cause — carrying
 * no `st` at all, it ran at stream time 0, entirely inside the silent padding,
 * so an offset track jumped in at full volume with no fade whatever.
 *
 * If you change these, test with `start > 0`. At `start: 0` the correct and the
 * broken expressions are numerically identical, which is exactly how this
 * survived a full audit (timeline-core KNOWN-DIVERGENCES D2).
 *
 * Deliberately shared by BOTH the ducking and plain branches below. They used to
 * hold byte-identical copies of this expression — catalogued as a drift hazard in
 * KNOWN-DIVERGENCES D3 — and the bug above lived in both of them. One copy means
 * the next fix cannot land on one branch and miss the other. Both must stay in
 * step: the ducking branch chains this same envelope into `sidechaincompress` as
 * its MAIN input (`#0`; the untouched speech split is `#1`, the detection key), so
 * a mistimed fade silences a ducked bed exactly as it silences a plain one.
 *
 * @param {object} track — one entry from project.audio.tracks
 * @returns {string}     — '' when the track has no fades, otherwise a
 *                         leading-comma fragment to append to the delay chain
 */
function buildFadeFilters(track) {
  const start   = track.start   ?? 0
  const fadeIn  = track.fadeIn  ?? 0
  const fadeOut = track.fadeOut ?? 0
  // NOT `?? 0`. A track with no `end` is legal and common — `_validate_audio_tracks`
  // in engine/validate.py deliberately does not require one, because this file
  // never trims on `end` (the source window is inPoint/outPoint alone), so a music
  // bed without one plays its natural length. Defaulting a missing `end` to 0 would
  // put the fade-out at st=0, inside the adelay padding, and zero the track for the
  // whole stream — the very failure this helper exists to prevent, reachable just by
  // dragging a fade-out grip on an end-less bed. A zero- or negative-width window
  // counts as undeclared too, matching the editor's `resolveAudioWindow`.
  const end = Number.isFinite(track.end) ? track.end : null

  let fadeFilters = ''
  // Begins the instant the adelay padding ends — i.e. when the track starts.
  if (fadeIn > 0) {
    fadeFilters += `,afade=t=in:st=${start}:d=${fadeIn}:curve=${ffmpegFadeCurve(track.fadeInCurve)}`
  }
  // Must FINISH at the track's end on the timeline, so it begins one fade-length
  // before it. `end`, not `end - start`: see the stream-time note above. With no
  // declared end there is no timeline position to fade out AT, so emit nothing
  // rather than guess — the track simply plays out.
  if (fadeOut > 0 && end !== null && end > start) {
    fadeFilters += `,afade=t=out:st=${Math.max(0, end - fadeOut)}:d=${fadeOut}:curve=${ffmpegFadeCurve(track.fadeOutCurve)}`
  }
  return fadeFilters
}

/**
 * Build ffmpeg input args for all unmuted audio tracks.
 *
 * @param {Array} audioTracks  — project.audio.tracks
 * @returns {string[]}         — flat array of ffmpeg input args
 */
export function buildAudioTrackInputs(audioTracks = []) {
  const args = []
  for (const track of audioTracks) {
    if (track.muted) continue
    const inPt  = track.inPoint  ?? 0
    const outPt = track.outPoint ?? null
    if (inPt > 0)       args.push('-ss', String(inPt))
    if (outPt !== null) args.push('-to', String(outPt))
    args.push('-i', track.src)
  }
  return args
}

/**
 * Build filter_complex parts that mix all unmuted audio tracks into the running audio stream.
 *
 * @param {Array}  audioTracks       — project.audio.tracks
 * @param {number} baseInputIdx      — ffmpeg input index of the first audio track
 * @param {string} currentAudioLabel — current audio label in the filter graph (e.g. '[canvas_a]')
 * @returns {{ filterParts: string[], audioLabel: string }}
 */
export function buildAudioTrackFilters(audioTracks = [], baseInputIdx, currentAudioLabel) {
  const filterParts = []
  let audioLabel = currentAudioLabel
  let offset = 0  // counts only unmuted tracks (maps to input index)

  for (const track of audioTracks) {
    if (track.muted) continue

    const inputIdx = baseInputIdx + offset
    const vol      = track.volume ?? 1.0
    const delayMs  = Math.round((track.start ?? 0) * 1000)
    const audioIn  = audioLabel.startsWith('[') ? audioLabel : `[${audioLabel}]`

    if (track.ducking?.enabled) {
      const depthDb = track.ducking.depth   ?? -12  // dB reduction when ducking
      const attack  = track.ducking.attack  ?? 0.3
      const release = track.ducking.release ?? 0.5
      // Map dB depth → compressor ratio (e.g. -12 dB ≈ ratio 4, -6 dB ≈ ratio 2)
      const ratio   = Math.max(1, Math.round(10 ** (-depthDb / 20)))
      const fadeFilters = buildFadeFilters(track)
      filterParts.push(
        `${audioIn}asplit=2[speech${offset}][sc${offset}]`,
        `[${inputIdx}:a]adelay=${delayMs}:all=1,volume=${vol}${fadeFilters}[mscaled${offset}]`,
        `[mscaled${offset}][sc${offset}]sidechaincompress=threshold=0.02:ratio=${ratio}:attack=${attack * 1000}:release=${release * 1000}[ducked${offset}]`,
        `[speech${offset}][ducked${offset}]amix=inputs=2:duration=first:normalize=0[aout${offset}]`,
      )
      audioLabel = `[aout${offset}]`
    } else {
      const fadeFilters = buildFadeFilters(track)
      filterParts.push(
        `[${inputIdx}:a]adelay=${delayMs}:all=1,volume=${vol}${fadeFilters}[atrack${offset}]`,
        `${audioIn}[atrack${offset}]amix=inputs=2:duration=longest:normalize=0[amid${offset}]`,
      )
      audioLabel = `[amid${offset}]`
    }

    offset++
  }

  return { filterParts, audioLabel }
}

/**
 * Mix audio tracks into a pre-rendered video file.
 * Used by compose.js after segment concat: video stream is copied, audio is re-encoded.
 *
 * @param {string} videoPath   — path to the pre-rendered video (no audio or silent)
 * @param {Array}  audioTracks — project.audio.tracks
 * @param {string} outputPath
 */
export function mixAudioIntoVideo(videoPath, audioTracks, outputPath) {
  // Pre-filter: helpers also skip muted tracks internally, but we need the
  // count here for the early-exit branch and to avoid an empty filter graph.
  const unmuted = (audioTracks ?? []).filter(t => !t.muted)
  if (unmuted.length === 0) {
    const result = spawnSync(FFMPEG, [
      '-y', '-i', videoPath, '-c', 'copy', outputPath,
    ], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })
    if (result.status !== 0) throw new Error(`ffmpeg copy failed:\n${result.stderr}`)
    return
  }

  const inputs = ['-i', videoPath]
  inputs.push(...buildAudioTrackInputs(unmuted))

  // [0:a] = audio stream from the input video (assumed present; chunked path
  // always produces a silent audio stream via anullsrc in compose.js)
  const { filterParts, audioLabel } = buildAudioTrackFilters(unmuted, 1, '[0:a]')

  const result = spawnSync(FFMPEG, [
    '-y', ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '0:v',
    '-map', audioLabel,
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  ], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })

  if (result.status !== 0) throw new Error(`ffmpeg audio mix failed:\n${result.stderr}`)
}
