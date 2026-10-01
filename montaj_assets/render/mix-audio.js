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
import { externalizeFilterGraph } from './filter-script.js'

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
    if (inPoint > 0)       args.push('-ss', String(inPoint))
    if (outPoint !== null) args.push('-to', String(outPoint))
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

/** Final-pass loudness normalization. `lufs` is the integrated target
 *  (project settings.loudness); absent = no normalization.
 *
 *  `aresample=48000` after `loudnorm` is load-bearing, not decoration:
 *  loudnorm resamples internally to 192kHz to do its true-peak limiting, and
 *  without an explicit resample back down, the AAC encode downstream inherits
 *  that 192kHz stream and comes out at 96kHz instead — silently doubling the
 *  project's working sample rate. Every other stage in this pipeline (segment
 *  encode, concat) is 48kHz; this filter is the only one that would drift.
 *
 *  `!Number.isFinite(lufs)`, not `typeof lufs !== 'number'`: `typeof NaN` is
 *  `'number'`, so the old check let a NaN settings.loudness sail through —
 *  `NaN < -30` and `NaN > -5` are both false, so the range check never fired
 *  either, and loudnorm would have received a literal `I=NaN`. */
export function loudnessFilter(inLabel, lufs) {
  if (lufs === undefined || lufs === null) return null
  if (!Number.isFinite(lufs) || lufs < -30 || lufs > -5) {
    throw new Error(`settings.loudness must be a number from -30 to -5 LUFS, got ${JSON.stringify(lufs)}`)
  }
  return { part: `${inLabel}loudnorm=I=${lufs}:TP=-1:LRA=11,aresample=48000[aloud]`, label: '[aloud]' }
}

/** Pull `input_i` (integrated loudness, LUFS) out of loudnorm's
 *  `print_format=json` block on stderr. `-inf` for digital silence is a real
 *  value here (Number('-inf') is NaN, so it is spelled out). `null` when the
 *  block is missing or unparseable, which callers treat as "not known silent". */
export function parseLoudnormInputI(stderr) {
  const m = /"input_i"\s*:\s*"([^"]+)"/.exec(stderr ?? '')
  if (!m) return null
  const raw = m[1].trim().toLowerCase()
  if (raw === '-inf') return -Infinity
  const v = Number(raw)
  return Number.isFinite(v) ? v : null
}

/** loudnorm's absolute gate is -70 LUFS: at or under it there is nothing to
 *  normalize. Unknown (null) is NOT silent, so a failed measurement keeps the
 *  old behaviour of normalizing. */
export function isSilentInputI(inputI) {
  return inputI !== null && inputI !== undefined && !(inputI > -70)
}

/** Measure (decode only, nothing encoded) whether the audio ffmpeg would feed
 *  into loudnorm is silent. `args` select the audio: inputs plus, for a
 *  filter graph, `-filter_complex ... -map [label]`.
 *
 *  Why this exists: loudnorm over digital silence shorter than its ~3 s window
 *  emits NaN samples and the AAC encoder behind it aborts with "Input contains
 *  (near) NaN/+-Inf", failing the whole render. Silence has nothing to
 *  normalize, so the callers skip loudnorm when this says true. */
function audioIsSilent(inputs, lufs, graph = null) {
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
  if (result.status !== 0) return false
  return isSilentInputI(parseLoudnormInputI(result.stderr))
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
 */
export function mixAudioIntoVideo(videoPath, audioTracks, outputPath, { loudness } = {}) {
  // Pre-filter: helpers also skip muted tracks internally, but we need the
  // count here for the early-exit branch and to avoid an empty filter graph.
  const unmuted = (audioTracks ?? []).filter(t => !t.muted)
  if (unmuted.length === 0) {
    // No project.audio.tracks to mix, but the video's OWN clip audio (from
    // compose.js's segment encode) still lives in `videoPath` and still needs
    // normalizing when settings.loudness is set — otherwise a project with no
    // music bed / no voiceover track silently skips loudness entirely, even
    // though the caption in schema.ts used to promise it only "applies when
    // project.audio.tracks is non-empty." `loudnessFilter` throws on an
    // out-of-range/non-finite value, so call it here purely to reuse that
    // validation before touching ffmpeg.
    if (loudness !== undefined && loudness !== null) {
      loudnessFilter('[a]', loudness)
      // A silent timeline (video-only clips) has nothing to normalize and
      // loudnorm over short silence yields NaN: fall through to the copy.
      if (!audioIsSilent(['-i', videoPath], loudness)) {
        const result = spawnSync(FFMPEG, [
          '-y', '-i', videoPath,
          '-c:v', 'copy',
          '-af', `loudnorm=I=${loudness}:TP=-1:LRA=11,aresample=48000`,
          '-c:a', 'aac', '-b:a', '192k',
          '-movflags', '+faststart',
          outputPath,
        ], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS })
        if (result.status !== 0) throw new Error(`ffmpeg loudness normalize failed:\n${result.stderr}`)
        return
      }
    }
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

  let ln = loudnessFilter(audioLabel, loudness)
  // Measure the mix BEFORE loudnorm; a silent mix skips it (see audioIsSilent).
  if (ln && audioIsSilent(inputs, loudness, { parts: filterParts, label: audioLabel })) {
    ln = null
  }
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

  if (result.status !== 0) throw new Error(`ffmpeg audio mix failed:\n${result.stderr}`)
}
