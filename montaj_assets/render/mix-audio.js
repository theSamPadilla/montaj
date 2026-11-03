/**
 * mix-audio.js — Independent audio track mixing for the montaj render pipeline.
 *
 * Handles project.audio.tracks: per-track delay, volume, trimming, and amix.
 * Video item audio (muted flag on VisualItems) is handled inline in compose.js.
 *
 * WHERE a track plays (its start, and the slice of its source) is not decided
 * here: it is timeline-core's `audioSourceWindow`, the same function the
 * editor preview's `audioWindow` reads, so the export and the preview play
 * every track over the same span. render/test/audio-window-parity.test.mjs
 * holds them together.
 */
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { audioSourceWindow } from '@bycrux/timeline-core'
import { FFMPEG } from './ffmpeg-bin.js'
import { ffSeconds } from './ff-seconds.js'
import { finiteNumber } from './filter-number.js'
import { externalizeFilterGraph } from './filter-script.js'
import { ffmpegErrorTail, assertInputsExist } from './ffmpeg-error.js'
import { syncResultError } from './child-killed.js'

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
  const start   = finiteNumber(track.start ?? 0, 'audio.tracks[].start')  // §563: text in the graph
  const fadeIn  = track.fadeIn  ?? 0
  const fadeOut = track.fadeOut ?? 0
  // NOT `?? 0`. A track with no `end` is legal and common — `_validate_audio_tracks`
  // in engine/validate.py deliberately does not require one: such a track plays
  // to the end of its source slice (see `buildAudioTrackInputs`), so a music bed
  // without one plays its natural length. Defaulting a missing `end` to 0 would
  // put the fade-out at st=0, inside the adelay padding, and zero the track for the
  // whole stream — the very failure this helper exists to prevent, reachable just by
  // dragging a fade-out grip on an end-less bed. A zero- or negative-width window
  // counts as undeclared too, matching the editor's `resolveAudioWindow`.
  const end = Number.isFinite(track.end) ? track.end : null

  let fadeFilters = ''
  // Begins the instant the adelay padding ends — i.e. when the track starts.
  if (fadeIn > 0) {
    fadeFilters += `,afade=t=in:st=${ffSeconds(start)}:d=${ffSeconds(fadeIn)}:curve=${ffmpegFadeCurve(track.fadeInCurve)}`
  }
  // Must FINISH at the track's end on the timeline, so it begins one fade-length
  // before it. `end`, not `end - start`: see the stream-time note above. With no
  // declared end there is no timeline position to fade out AT, so emit nothing
  // rather than guess — the track simply plays out.
  if (fadeOut > 0 && end !== null && end > start) {
    fadeFilters += `,afade=t=out:st=${ffSeconds(Math.max(0, end - fadeOut))}:d=${ffSeconds(fadeOut)}:curve=${ffmpegFadeCurve(track.fadeOutCurve)}`
  }
  return fadeFilters
}

/**
 * Build ffmpeg input args for all unmuted audio tracks.
 *
 * The source slice is `audioSourceWindow`'s: `-ss inPoint`, and `-to` at
 * whichever of `outPoint` and the declared `end` comes first (as input
 * options, `-to` is a SOURCE position, so the slice is `to - ss` long). With
 * neither, there is no `-to` and the track plays to the end of its file.
 *
 * `end` used to be ignored here, so a track stopped at its `outPoint` or its
 * file's end while the editor stopped it at `end`: a split music bed's right
 * half (`outPoint` = the whole file) played on past its own bar. And an
 * `outPoint` at or before the `inPoint` (`outPoint: 0` exists on disk) went to
 * ffmpeg as-is, which aborts the whole render with "-to value smaller than
 * -ss"; `audioSourceWindow` drops it as undeclared.
 *
 * @param {Array} audioTracks  — project.audio.tracks
 * @returns {string[]}         — flat array of ffmpeg input args
 */
export function buildAudioTrackInputs(audioTracks = []) {
  const args = []
  for (const track of audioTracks) {
    if (track.muted) continue
    const { inPoint, outPoint } = audioSourceWindow(track)
    if (Number(ffSeconds(inPoint)) > 0) args.push('-ss', ffSeconds(inPoint))
    if (outPoint !== null)               args.push('-to', ffSeconds(outPoint))
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
  const ducked = []  // { offset, inputIdx, track, vol, delayMs }, in array order

  // Pass 1: every un-ducked track mixes into the running label. The result is the
  // speech bus: canvas audio plus all un-ducked tracks, WHEREVER they sit in the
  // array. (Ducking used to key off whatever was mixed before the ducked track, so
  // a voiceover listed after the music never reached the sidechain.)
  for (const track of audioTracks) {
    if (track.muted) continue

    const inputIdx = baseInputIdx + offset
    const vol      = finiteNumber(track.volume ?? 1.0, 'audio.tracks[].volume')  // §563: text in the graph
    const delayMs  = Math.round((track.start ?? 0) * 1000)

    if (track.ducking?.enabled) {
      ducked.push({ offset, inputIdx, track, vol, delayMs })
    } else {
      const audioIn = audioLabel.startsWith('[') ? audioLabel : `[${audioLabel}]`
      const fadeFilters = buildFadeFilters(track)
      filterParts.push(
        `[${inputIdx}:a]adelay=${delayMs}:all=1,volume=${vol}${fadeFilters}[atrack${offset}]`,
        `${audioIn}[atrack${offset}]amix=inputs=2:duration=longest:normalize=0[amid${offset}]`,
      )
      audioLabel = `[amid${offset}]`
    }

    offset++
  }

  if (ducked.length === 0) return { filterParts, audioLabel }

  // Pass 2: every ducked track compresses against the same speech bus (so two
  // beds duck against the speech and never against each other), and the final
  // mix is the speech bus plus every ducked bed.
  const speechIn = audioLabel.startsWith('[') ? audioLabel : `[${audioLabel}]`
  const first = ducked[0].offset
  const last  = ducked[ducked.length - 1].offset
  filterParts.push(
    `${speechIn}asplit=${ducked.length + 1}[speech${first}]${ducked.map(d => `[sc${d.offset}]`).join('')}`,
  )
  for (const { offset: o, inputIdx, track, vol, delayMs } of ducked) {
    const depthRaw = track.ducking.depth
    const depthDb = Number.isFinite(depthRaw) ? depthRaw : -12  // dB reduction when ducking
    const attack  = track.ducking.attack  ?? 0.3
    const release = track.ducking.release ?? 0.5
    // Map dB depth → compressor ratio (e.g. -12 dB ≈ ratio 4, -6 dB ≈ ratio 2),
    // clamped to ffmpeg's sidechaincompress range of 1..20: an unclamped
    // depth of -60 asked for ratio 1000 and failed the whole mix. So depths
    // below about -26 dB all duck the same as -26 dB (ratio 20).
    const ratio   = Math.min(20, Math.max(1, Math.round(10 ** (-depthDb / 20))))
    const fadeFilters = buildFadeFilters(track)
    filterParts.push(
      `[${inputIdx}:a]adelay=${delayMs}:all=1,volume=${vol}${fadeFilters}[mscaled${o}]`,
      `[mscaled${o}][sc${o}]sidechaincompress=threshold=0.02:ratio=${ratio}:attack=${attack * 1000}:release=${release * 1000}[ducked${o}]`,
    )
  }
  filterParts.push(
    `[speech${first}]${ducked.map(d => `[ducked${d.offset}]`).join('')}amix=inputs=${ducked.length + 1}:duration=first:normalize=0[aout${last}]`,
  )
  return { filterParts, audioLabel: `[aout${last}]` }
}

/** The export's leveling (§697): ONE static master gain, then a peak limiter.
 *
 *  The gain is `settings.loudness - I`, I the integrated loudness of the
 *  speech (or the whole mix when the project has none) over the entire
 *  timeline, measured once by mix-loudness.js, the same number the editor
 *  preview plays at (video/preview/master-bus.ts). A static gain, never a
 *  dynamic loudnorm, so preview equals export and a fader is heard as set.
 *
 *  The limiter matches the preview's master bus: a ceiling at -1.5 dBFS
 *  (LIMITER_LIMIT), 1 ms attack, 100 ms release. `level=disabled` is
 *  load-bearing: alimiter's default auto-level would re-level its output, the
 *  very thing this replaces. `latency=1` takes its look-ahead back off, so the
 *  sound stays on the picture.
 *
 *  `aresample=48000` keeps the AAC encode downstream at the pipeline's 48 kHz.
 *
 *  `!Number.isFinite(lufs)`, not `typeof lufs !== 'number'`: `typeof NaN` is
 *  `'number'`, so the old check let a NaN settings.loudness sail through —
 *  `NaN < -30` and `NaN > -5` are both false, so the range check never fired. */
export const LIMITER_CEILING_DB = -1.5
const LIMITER_LIMIT = Number((10 ** (LIMITER_CEILING_DB / 20)).toFixed(6))
/** The preview's clamp (editor/src/engine/mix/loudness-client.ts LOUDNESS_MIN/MAX_GAIN_DB). */
export const MASTER_GAIN_MIN_DB = -30
export const MASTER_GAIN_MAX_DB = 30

/** The filter chain (no labels) that levels by `gainDb`. */
export function levelChain(gainDb = 0) {
  const g = Number.isFinite(gainDb) ? Number(gainDb.toFixed(4)) : 0
  return `volume=${g}dB,alimiter=limit=${LIMITER_LIMIT}:attack=1:release=100:level=disabled:latency=1,aresample=48000`
}

export function loudnessFilter(inLabel, lufs, gainDb = 0) {
  if (lufs === undefined || lufs === null) return null
  if (!Number.isFinite(lufs) || lufs < -30 || lufs > -5) {
    throw new Error(`settings.loudness must be a number from -30 to -5 LUFS, got ${JSON.stringify(lufs)}`)
  }
  return { part: `${inLabel}${levelChain(gainDb)}[aloud]`, label: '[aloud]' }
}

/** The static master gain (dB) for a target and a measured integrated
 *  loudness: `targetI - inputI`, clamped to -30..+30 dB as the preview clamps
 *  it; 0 dB when either is unknown or the measurement is silent. */
export function masterGainDb(targetI, inputI) {
  if (!Number.isFinite(targetI) || !Number.isFinite(inputI) || isSilentInputI(inputI)) return 0
  const g = Math.min(MASTER_GAIN_MAX_DB, Math.max(MASTER_GAIN_MIN_DB, targetI - inputI))
  return Number(g.toFixed(4))
}

/** Pull `input_i` (integrated loudness, LUFS) out of loudnorm's
 *  `print_format=json` block on stderr. `-inf` for digital silence is a real
 *  value here (Number('-inf') is NaN, so it is spelled out). `null` when the
 *  block is missing or unparseable, which callers treat as "not known silent". */
export function parseLoudnormInputI(stderr) {
  return parseLoudnormField(stderr, 'input_i')
}

/** One numeric field of that block (`input_i`, `input_tp`, `input_lra`, ...),
 *  read the same way: `-inf` is -Infinity, missing or unparseable is null. */
export function parseLoudnormField(stderr, field) {
  const m = new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`).exec(stderr ?? '')
  if (!m) return null
  const raw = m[1].trim().toLowerCase()
  if (raw === '-inf') return -Infinity
  const v = Number(raw)
  return Number.isFinite(v) ? v : null
}

/** The measurement's absolute gate is -70 LUFS (BS.1770): at or under it
 *  there is nothing to level, and the gain is 0 dB (masterGainDb). Unknown
 *  (null) is not silent either; masterGainDb gives it 0 dB too. */
export function isSilentInputI(inputI) {
  return inputI !== null && inputI !== undefined && !(inputI > -70)
}

/** Measure (decode only, nothing encoded) a mix's loudness, with loudnorm used
 *  only as a meter (its print_format block): `{inputI, inputTP, inputLRA}`
 *  (LUFS, dBTP, LU; each null when the block lacks it), or null when ffmpeg
 *  fails. `inputs` are ffmpeg input args; `graph` (`{parts, label}`, as
 *  `buildMixGraph` returns) selects the audio, and without one it is input 0's.
 *  A kill throws: it is not an answer.
 *
 *  mix-loudness.js (§660, §697) measures the level the preview and the
 *  export share through this; mixAudioIntoVideo, handed no gain, measures the
 *  mix it is given through it too. */
export function measureLoudness(inputs, lufs, graph = null) {
  const measure = `loudnorm=I=${lufs}:TP=-1:LRA=11:print_format=json`
  const select = graph
    ? ['-filter_complex', [...graph.parts, `${graph.label}${measure}[m]`].join(';'), '-map', '[m]']
    : ['-map', '0:a', '-af', measure]
  const script = externalizeFilterGraph(
    ['-hide_banner', ...inputs, ...select, '-f', 'null', '-'], tmpdir())
  let result
  try {
    result = spawnSync(FFMPEG, script.args, { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })
  } finally {
    script.cleanup()
  }
  const killed = syncResultError(result, { child: 'ffmpeg', phase: 'loudness-measure',
    message: `ffmpeg loudness measure failed:\n${ffmpegErrorTail(result.stderr)}` })
  if (killed) throw killed
  if (result.status !== 0) return null
  return {
    inputI: parseLoudnormField(result.stderr, 'input_i'),
    inputTP: parseLoudnormField(result.stderr, 'input_tp'),
    inputLRA: parseLoudnormField(result.stderr, 'input_lra'),
  }
}

/** The gain for a mix nobody measured (mixAudioIntoVideo handed no gainDb):
 *  the whole mix it is given, measured as mix-loudness.js measures, so a
 *  direct caller still levels to the target. A silent or failed measurement
 *  is 0 dB. render.js always hands the gain in (mix-loudness.js
 *  `exportMasterGain`, the speech when there is speech). */
function measuredGainDb(inputs, lufs, graph = null) {
  const m = measureLoudness(inputs, lufs, graph)
  return masterGainDb(lufs, m?.inputI ?? null)
}

/**
 * The export's final audio mix: `canvasInputArgs` (one ffmpeg input whose
 * audio is the clips' own, input 0) plus every unmuted lane, mixed by
 * buildAudioTrackFilters. `{inputs, parts, label}`: `label` is the mix,
 * before the master gain. mixAudioIntoVideo builds its graph here, and so does
 * mix-loudness.js's measurement (§660), so the two cannot drift.
 */
export function buildMixGraph(audioTracks, canvasInputArgs) {
  const unmuted = (audioTracks ?? []).filter(t => !t.muted)
  const inputs = [...canvasInputArgs, ...buildAudioTrackInputs(unmuted)]
  const { filterParts, audioLabel } = buildAudioTrackFilters(unmuted, 1, '[0:a]')
  return { inputs, parts: filterParts, label: audioLabel }
}

/**
 * Mix audio tracks into a pre-rendered video file.
 * Used by compose.js after segment concat: video stream is copied, audio is re-encoded.
 *
 * @param {string} videoPath   — path to the pre-rendered video (no audio or silent)
 * @param {Array}  audioTracks — project.audio.tracks
 * @param {string} outputPath
 * @param {object} [opts]
 * @param {number} [opts.loudness] — project settings.loudness (integrated LUFS target)
 * @param {number} [opts.gainDb]   — the static master gain (§697, mix-loudness.js
 *   `exportMasterGain`); absent, the whole mix given here is measured for it
 */
export function mixAudioIntoVideo(videoPath, audioTracks, outputPath, { loudness, gainDb = null } = {}) {
  // Pre-filter: helpers also skip muted tracks internally, but we need the
  // count here for the early-exit branch and to avoid an empty filter graph.
  const unmuted = (audioTracks ?? []).filter(t => !t.muted)
  // validateProjectFiles ran long ago; a file deleted since must fail by name.
  assertInputsExist(unmuted.map(t => t.src))
  if (unmuted.length === 0) {
    // No project.audio.tracks to mix, but the video's OWN clip audio (from
    // compose.js's segment encode) still lives in `videoPath` and still needs
    // normalizing when settings.loudness is set — otherwise a project with no
    // music bed / no voiceover track silently skips loudness entirely, even
    // though the caption in schema.ts used to promise it only "applies when
    // project.audio.tracks is non-empty." `loudnessFilter` throws on an
    // out-of-range/non-finite value, so call it here purely to reuse that
    // validation before touching ffmpeg. The leveling is the static gain and
    // limiter (§697); silence through it stays silence (loudnorm, which turned
    // short silence into NaN, is gone), so a silent timeline needs no skip.
    if (loudness !== undefined && loudness !== null) {
      loudnessFilter('[a]', loudness)
      const g = Number.isFinite(gainDb) ? gainDb : measuredGainDb(['-i', videoPath], loudness)
      const result = spawnSync(FFMPEG, [
        '-y', '-i', videoPath,
        '-c:v', 'copy',
        '-af', levelChain(g),
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        outputPath,
      ], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })
      if (result.status !== 0) {
        const message = `ffmpeg loudness normalize failed:\n${ffmpegErrorTail(result.stderr)}`
        throw syncResultError(result, { child: 'ffmpeg', phase: 'loudness-normalize', message }) ?? new Error(message)
      }
      return
    }
    const result = spawnSync(FFMPEG, [
      '-y', '-i', videoPath, '-c', 'copy', outputPath,
    ], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })
    if (result.status !== 0) {
      const message = `ffmpeg copy failed:\n${ffmpegErrorTail(result.stderr)}`
      throw syncResultError(result, { child: 'ffmpeg', phase: 'audio-copy', message }) ?? new Error(message)
    }
    return
  }

  // [0:a] = audio stream from the input video (assumed present; chunked path
  // always produces a silent audio stream via anullsrc in compose.js)
  const { inputs, parts: filterParts, label: audioLabel } = buildMixGraph(unmuted, ['-i', videoPath])

  // Validated before anything is measured (throws on a bad target).
  const level = loudnessFilter(audioLabel, loudness) !== null
  const g = !level ? 0 : Number.isFinite(gainDb) ? gainDb
    : measuredGainDb(inputs, loudness, { parts: filterParts, label: audioLabel })
  const ln = loudnessFilter(audioLabel, loudness, g)
  const parts = ln ? [...filterParts, ln.part] : filterParts
  const outLabel = ln ? ln.label : audioLabel

  // The graph goes by file in the system temp dir (WIN1b: a Windows command
  // line caps at 32,767 characters), removed however the spawn ends.
  const script = externalizeFilterGraph([
    '-y', ...inputs,
    '-filter_complex', parts.join(';'),
    '-map', '0:v',
    '-map', outLabel,
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  ], tmpdir())
  let result
  try {
    result = spawnSync(FFMPEG, script.args, { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })
  } finally {
    script.cleanup()
  }

  if (result.status !== 0) {
    const message = `ffmpeg audio mix failed:\n${ffmpegErrorTail(result.stderr)}`
    throw syncResultError(result, { child: 'ffmpeg', phase: 'audio-mix', message }) ?? new Error(message)
  }
}
