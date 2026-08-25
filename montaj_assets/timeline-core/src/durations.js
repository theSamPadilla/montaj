// @ts-check
// montaj_assets/timeline-core/src/durations.js
//
// "How long is this project?" has TWO shipping answers, and they are not the
// same number. Both are ported here under honest names rather than being
// silently unified — unifying them would be a behavior change in one engine or
// the other, and SP2's budget is exactly two behavior changes, neither of them
// this.
//
//   visualDuration(project) — montaj_assets/render/render.js:770-774
//                             (`getTotalDurationSeconds`). The max `end` over
//                             EVERY item on EVERY track. Audio is EXCLUDED.
//                             This is what the renderer encodes to, what
//                             sample-frame range-checks against
//                             (sample-frame.js:520-525), and what sizes the
//                             caption Puppeteer segment (render.js:501).
//
//   projectEnd(project)     — montaj_assets/editor/src/video/preview/
//                             useVideoPlayback.ts:154-159.
//                             `max(videoEnd, overlayEnd, audioEnd)`. Audio is
//                             INCLUDED, and `videoEnd` is the LAST video clip
//                             of track 0 by start order — not a max. This is
//                             what the preview uses to decide whether to keep
//                             playing after the last video clip ends.
//
// The audio difference is a registry entry: KNOWN-DIVERGENCES.md entry 4,
// `audio-duration-mismatch`, owner SP4. A project whose music bed
// outlasts its footage previews longer than it renders.
//
// ── Faithfulness notes (do NOT "fix" these here) ────────────────────────────
//
// `projectEnd`'s `videoEnd` has two behaviors that look like bugs and are
// reproduced verbatim because they are what ships today. Both are pinned by
// named tests in test/durations.test.mjs:
//
//   1. LAST-BY-START, NOT MAX. `clips[clips.length - 1].end` over a
//      start-sorted list. A long clip [0,10] sitting under a short clip [5,6]
//      on track 0 yields videoEnd 6, even though picture is on screen until 10.
//   2. TRACK-0 VIDEO ONLY. The filter is `type === 'video'`, so a canvas
//      project (image-only track 0) has videoEnd 0. The editor routes canvas
//      projects around this through `isCanvasProject` (useVideoPlayback.ts:150),
//      but the function itself really does return 0.
//
// ── Purity ──────────────────────────────────────────────────────────────────
//
// No Date, no Math.random, no I/O, no globals. Neither function mutates the
// project: the start-sort inside `projectEnd` runs on the array `filter`
// already copied, exactly as the editor's `useMemo` does. Both are total —
// they return a finite number for every project, including `{}`.

/**
 * The subset of a project the duration functions read. Structural and minimal.
 *
 * @typedef {Object} DurationItem
 * @property {string} [type]
 * @property {number} [start]
 * @property {number} [end]
 */

/**
 * @typedef {Object} DurationProject
 * @property {ReadonlyArray<ReadonlyArray<DurationItem> | undefined>} [tracks]
 * @property {{ tracks?: ReadonlyArray<{ end?: number }> }} [audio]
 */

/**
 * RENDER semantics. The furthest `end` of any item on any track, with AUDIO
 * EXCLUDED. `0` for a project with no visual items at all.
 *
 * Verbatim from render.js:770-774:
 *
 *     function getTotalDurationSeconds(projectJson) {
 *       const allItems = (projectJson.tracks ?? []).flat()
 *       if (allItems.length === 0) return 0
 *       return Math.max(...allItems.map(i => i.end ?? 0))
 *     }
 *
 * There is no floor at 0 here — a project whose only item lives entirely before
 * the origin reports a negative duration. Only the boundary pipeline floors
 * (see `frameGrid().boundary`). Reproduced as-is.
 *
 * The one addition is `i?.end` instead of `i.end`: a hole in `tracks` (an
 * undefined track array) throws a TypeError in the original. The package
 * contract requires totality, so a hole contributes 0 instead. Every non-holed
 * project is byte-identical.
 *
 * @param {DurationProject} project
 * @returns {number}
 */
export function visualDuration(project) {
  const allItems = (project.tracks ?? []).flat()
  if (allItems.length === 0) return 0
  return Math.max(...allItems.map((i) => i?.end ?? 0))
}

/**
 * EDITOR semantics. `max(videoEnd, overlayEnd, audioEnd)`, with AUDIO INCLUDED.
 *
 * Verbatim from useVideoPlayback.ts:145 + :154-159:
 *
 *     const clips = (project.tracks?.[0] ?? []).filter(c => c.type === 'video')
 *                                              .sort((a, b) => a.start - b.start)
 *     ...
 *     const videoEnd   = clips.length > 0 ? clips[clips.length - 1].end : 0
 *     const overlayEnd = overlayTracks.flat().reduce((m, i) => Math.max(m, i.end), 0)
 *     const audioEnd   = (project.audio?.tracks ?? []).reduce((m, t) => Math.max(m, t.end ?? 0), 0)
 *     return Math.max(videoEnd, overlayEnd, audioEnd)
 *
 * Note that `overlayEnd` and `audioEnd` are `reduce`s seeded at 0, so neither
 * can pull the answer below 0 — but `videoEnd` can be negative if the last clip
 * ends before the origin, and `Math.max` then discards it. That is the shipping
 * behavior.
 *
 * See the module header for the two faithfulness notes on `videoEnd`.
 *
 * The only additions are `?? 0` tails on the three raw `.end` reads (the last
 * clip's, an overlay item's, a hole in `tracks`). The original propagates
 * `undefined` into `Math.max`, which yields `NaN` for the whole project; the
 * package contract requires a finite answer. Every well-formed project is
 * byte-identical.
 *
 * @param {DurationProject} project
 * @returns {number}
 */
export function projectEnd(project) {
  // `filter` already returns a fresh array, so the sort cannot reach the
  // project — the same reason the editor's useMemo is safe.
  const clips = (project.tracks?.[0] ?? [])
    .filter((c) => c.type === 'video')
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
  const videoEnd = clips.length > 0 ? (clips[clips.length - 1].end ?? 0) : 0
  const overlayTracks = project.tracks?.slice(1) ?? []
  const overlayEnd = overlayTracks.flat().reduce((m, i) => Math.max(m, i?.end ?? 0), 0)
  const audioEnd = (project.audio?.tracks ?? []).reduce((m, t) => Math.max(m, t.end ?? 0), 0)
  return Math.max(videoEnd, overlayEnd, audioEnd)
}
