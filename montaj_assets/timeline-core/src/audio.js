// @ts-check
// montaj_assets/timeline-core/src/audio.js
//
// audioSourceWindow — THE one definition of where an audio track plays: where
// it lands on the timeline and which slice of its source file it plays. Both
// sides read it: the export (montaj_assets/render/mix-audio.js,
// `buildAudioTrackInputs`, turns it into ffmpeg's `-ss`/`-to`) and the preview
// (`audioWindow` below, called every tick by useVideoPlayback.ts and
// useEnginePlayback.ts). A track is therefore audible over the same span in the
// editor as in the exported file, for every shape a project can carry.
// render/test/audio-window-parity.test.mjs proves it against the export's real
// ffmpeg args, shape by shape.
//
// audioWindow — the PURE half of the preview's per-track audio sync: is this
// track audible at timeline time `t`, where inside its own source file does
// that land, and at what gain (fade envelope × volume)? The IMPURE half stays
// in the editor: reading/writing a live `<audio>` element's `currentTime`,
// calling `.play()`/`.pause()`, the re-seek threshold, stopping at the end of
// the file, and writing a GainNode.
//
// ── The window ──────────────────────────────────────────────────────────────
//
// `docs/schemas/project.md` gives every field a meaning, and all of them bind:
//
//   start     where the track begins on the timeline (absent = 0)
//   inPoint   where in the source it begins (absent or <= 0 = the file's start;
//             ffmpeg gets no `-ss` then)
//   end       where the track STOPS on the timeline
//   outPoint  where in the source it stops
//   the file  a track never plays past the end of its own source
//
// The track stops at whichever of `end`, `outPoint` and the end of the file
// comes first. Only the first two are knowable here, so `outPoint` in the
// result is `min(inPoint + (end - start), outPoint)` over whichever are
// declared, or `null` when neither is: the track plays to the end of its file.
//
// `end` and `outPoint` are OPTIONAL. A missing, non-numeric or non-finite
// `end`, or one at or before `start`, is no `end`; an `outPoint` at or before
// `inPoint` is no `outPoint`. The editor's timeline (`resolveAudioWindow`,
// editor/src/video/timeline/timeline-model.ts) reads them the same way.
//
// ── History: two divergences this closed ────────────────────────────────────
//
// 1. A track with no `end` NEVER played in preview. `audioWindow` read
//    `end ?? 0`, so `t >= end` held for every t. The export played it at its
//    natural length. A 12-track project (music, 5 voiceovers, SFX) previewed
//    only the one track that carried an explicit `end`.
// 2. The two sides disagreed on which fields END a track. The preview derived
//    its source end from `inPoint + (end - start)` and ignored a stored
//    `outPoint` (on the theory that trims left it stale; they no longer do,
//    `resizeWindowedItem` writes both window bounds). The export ignored `end`
//    and passed the stored `outPoint` to `-to`. A track with an `end` shorter
//    than its file previewed short and exported to the end of the file (a split
//    music bed's right half, whose `outPoint` is the whole file, exported past
//    its own bar); one with an `outPoint` short of its span previewed long and
//    exported short (KNOWN-DIVERGENCES D1). Both sides now honour both fields.
//
// ── Fades ────────────────────────────────────────────────────────────────────
// The fade-in anchors to `start`; the fade-out ENDS at the declared `end`, and
// a track with no `end` has no fade-out, matching mix-audio.js's
// `buildFadeFilters` (which has nothing to place `afade=t=out` at). The ramp
// here is linear; the export shapes it with `fadeInCurve`/`fadeOutCurve`.
//
// ── Purity ──────────────────────────────────────────────────────────────────
// No Date, no Math.random, no I/O, no globals, no mutation. `gain` is
// computed UNCONDITIONALLY: whether a muted or inactive track's GainNode is
// written is the caller's decision, not part of the arithmetic.

/**
 * A `project.audio.tracks[]` entry, as far as window/gain math is concerned.
 * Every field is optional and may be malformed on disk; see the module header.
 *
 * @typedef {Object} AudioTrack
 * @property {number} [start]    Timeline start, seconds.
 * @property {number} [end]      Timeline end, seconds.
 * @property {number} [inPoint]  Source-time the track starts playing from, seconds.
 * @property {number} [outPoint] Source-time the track stops playing at, seconds.
 * @property {number} [fadeIn]   Fade-in duration, seconds.
 * @property {number} [fadeOut]  Fade-out duration, seconds.
 * @property {number} [volume]   Base volume multiplier (1 = unity; >1 amplifies).
 */

/**
 * @typedef {Object} AudioSourceWindow
 * @property {number} start
 *   Timeline position the track begins at, seconds.
 * @property {number} inPoint
 *   Source position playback begins from, seconds. Never negative.
 * @property {number | null} outPoint
 *   Source position playback stops at, seconds, or `null` for the end of the
 *   file. Always `> inPoint` when set.
 * @property {number | null} end
 *   The declared timeline end when there is a usable one (finite, `> start`),
 *   else `null`. What the fade-out anchors to.
 */

/**
 * @typedef {Object} AudioWindow
 * @property {boolean} active
 *   Whether timeline time `t` falls inside this track's window
 *   (see {@link audioSourceWindow}). Open-ended when the window has no
 *   `outPoint`: the caller's element stops at the end of the file.
 * @property {number} trackTime
 *   Position inside the track's OWN source file, seconds: `(t - start) +
 *   inPoint`. Computed unconditionally (totality); when `!active` the caller
 *   must not seek to it.
 * @property {number} gain
 *   `baseVolume * max(0, fadeMul)` — the fade-in/fade-out envelope times the
 *   base volume. See the module header for why this is unconditional.
 */

/** @param {unknown} v @returns {number | null} */
function finite(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Where `track` plays: its timeline start, and the slice of its source file.
 * The export and the preview both read this; see the module header.
 *
 * @param {AudioTrack} track
 * @returns {AudioSourceWindow}
 */
export function audioSourceWindow(track) {
  const start = finite(track.start) ?? 0
  const inPoint = Math.max(0, finite(track.inPoint) ?? 0)

  const declaredEnd = finite(track.end)
  const end = declaredEnd !== null && declaredEnd > start ? declaredEnd : null

  const storedOut = finite(track.outPoint)
  const caps = []
  if (storedOut !== null && storedOut > inPoint) caps.push(storedOut)
  if (end !== null) caps.push(inPoint + (end - start))
  const outPoint = caps.length === 0 ? null : Math.min(...caps)

  return { start, inPoint, outPoint, end }
}

/**
 * Whether `track` is audible at timeline time `t`, where inside its own
 * source file that lands, and at what gain.
 *
 * @param {AudioTrack} track
 * @param {number} t Timeline time, seconds.
 * @returns {AudioWindow}
 */
export function audioWindow(track, t) {
  const { start, inPoint, outPoint, end } = audioSourceWindow(track)
  const trackTime = t - start + inPoint
  const active = t >= start && (outPoint === null || trackTime < outPoint)

  const fadeIn = track.fadeIn ?? 0
  const fadeOut = track.fadeOut ?? 0
  const baseVol = track.volume ?? 1
  const elapsed = t - start

  let fadeMul = 1
  if (fadeIn > 0 && elapsed < fadeIn) fadeMul = elapsed / fadeIn
  if (fadeOut > 0 && end !== null) {
    const remaining = end - t
    if (remaining < fadeOut) fadeMul = Math.min(fadeMul, remaining / fadeOut)
  }
  const gain = baseVol * Math.max(0, fadeMul)

  return { active, trackTime, gain }
}
