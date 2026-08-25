// @ts-check
// montaj_assets/timeline-core/src/audio.js
//
// audioWindow — the PURE half of the preview's per-track audio sync logic: is
// this track's audio window active at timeline time `t`, where inside the
// track's own source file does that land, and at what gain (fade envelope ×
// volume)?
//
// Ports the pure arithmetic slice of
// montaj_assets/editor/src/video/preview/useVideoPlayback.ts:435-484
// (`syncAudioTracks`). The IMPURE parts stay in the editor and are NOT ported
// here: reading/writing a live `<audio>` element's `currentTime`, calling
// `.play()`/`.pause()`, the `Math.abs(el.currentTime - trackTime) > 0.3`
// reseek-threshold check, and writing a Web Audio GainNode's `.gain.value`.
// This module computes what those imperative calls SHOULD do, without doing
// them.
//
// ── The derived-outPoint rule (a real "premature silence after trim" bug) ──
//
// useVideoPlayback.ts:440-446, verbatim:
//
//     const inPt = track.inPoint ?? 0
//     const trackTime = (playhead - track.start) + inPt
//     // Derive outPoint from the timeline span — the stored outPoint can drift
//     // out of sync with start/end during trim operations, causing premature silence.
//     // The HTML audio element naturally stops at end-of-file, so sourceDuration
//     // acts as an implicit ceiling without needing an explicit check here.
//     const outPoint = inPt + (track.end - track.start)
//
// The track's STORED `outPoint` is not trusted here. After a trim, `start`/
// `end` move but a stale `outPoint` can lag behind; comparing `trackTime`
// against that stale value would silence the track before the timeline span
// it now actually occupies has finished playing. Deriving `outPoint` from
// `inPt + (end - start)` — the span the track ACTUALLY occupies on the
// timeline right now — is the fix. See the module header of
// useVideoPlayback.ts for the full history; the comment above is carried
// verbatim in substance.
//
// KNOWN DIVERGENCE candidate for KNOWN-DIVERGENCES.md (T5): the RENDER-side
// audio mixer (montaj_assets/render/mix-audio.js, `buildAudioTrackInputs`)
// does NOT apply this derived-outPoint rule — it passes the track's STORED
// `outPoint` straight to ffmpeg's `-to` flag (`const outPt = track.outPoint
// ?? null`). So the exact "premature silence after trim" bug this function
// exists to fix in PREVIEW can still reproduce in the RENDERED output: a
// trimmed audio track may preview at full length but export truncated. SP2
// documents this; it does not fix it (T4 does not touch mix-audio.js).
//
// ── Purity ──────────────────────────────────────────────────────────────────
// No Date, no Math.random, no I/O, no globals, no mutation. `gain` is
// computed UNCONDITIONALLY: the legacy code only writes a GainNode for
// UNMUTED tracks that have a live `<audio>` element already wired up
// (`gainNodesMap.current.get(track.id)`), but that is a caller-side
// existence/mute guard wrapped around an imperative DOM write — not part of
// the pure arithmetic. A muted or currently-inactive track still gets a real,
// finite `gain` value here; the caller decides whether to apply it.

/**
 * A `project.audio.tracks[]` entry, as far as window/gain math is concerned.
 *
 * @typedef {Object} AudioTrack
 * @property {number} [start]   Timeline start, seconds.
 * @property {number} [end]     Timeline end, seconds.
 * @property {number} [inPoint] Source-time the track starts playing from, seconds.
 * @property {number} [fadeIn]  Fade-in duration, seconds.
 * @property {number} [fadeOut] Fade-out duration, seconds.
 * @property {number} [volume]  Base volume multiplier (1 = unity; >1 amplifies).
 */

/**
 * @typedef {Object} AudioWindow
 * @property {boolean} active
 *   Whether timeline time `t` falls inside this track's playable window —
 *   `!outsideWindow`, using the DERIVED outPoint (see the module header).
 * @property {number} trackTime
 *   Position inside the track's OWN source file, seconds: `(t - start) +
 *   inPoint`. Computed unconditionally (totality) — when `!active`, the
 *   caller must not seek to it, exactly as legacy's `if (outsideWindow) {
 *   ...; continue }` never reaches its own `el.currentTime = trackTime` line.
 * @property {number} gain
 *   `baseVolume * max(0, fadeMul)` — the fade-in/fade-out envelope times the
 *   base volume. See the module header for why this is unconditional.
 */

/**
 * Whether `track` is audible at timeline time `t`, where inside its own
 * source file that lands, and at what gain.
 *
 * @param {AudioTrack} track
 * @param {number} t Timeline time, seconds.
 * @returns {AudioWindow}
 */
export function audioWindow(track, t) {
  const start = track.start ?? 0
  const end = track.end ?? 0
  const inPt = track.inPoint ?? 0
  const trackTime = t - start + inPt
  // Derived, not stored — see the module header.
  const outPoint = inPt + (end - start)
  const outsideWindow = t < start || t >= end || trackTime < 0 || trackTime >= outPoint
  const active = !outsideWindow

  const fadeIn = track.fadeIn ?? 0
  const fadeOut = track.fadeOut ?? 0
  const baseVol = track.volume ?? 1
  const elapsed = t - start
  const remaining = end - t

  let fadeMul = 1
  if (fadeIn > 0 && elapsed < fadeIn) fadeMul = elapsed / fadeIn
  if (fadeOut > 0 && remaining < fadeOut) fadeMul = Math.min(fadeMul, remaining / fadeOut)
  const gain = baseVol * Math.max(0, fadeMul)

  return { active, trackTime, gain }
}
