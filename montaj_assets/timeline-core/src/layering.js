// @ts-check
// montaj_assets/timeline-core/src/layering.js
//
// Which visual track draws over which (§308 P3): the ONE stacking rule, the
// one the editor preview uses, so the export and sample_frame never show a
// different picture from the one the user sees.
//
// ── The rule ─────────────────────────────────────────────────────────────────
//
// The editor reads every project through `normalizeTracks`, which puts the
// tracks in a canonical order before anything draws them
// (`montaj_assets/editor/src/video/timeline/timeline-model.ts:937`,
// `orderedTrackArray`): every track holding at least one VIDEO item first, in
// their JSON order, then every other track (images, overlays, or empty), in
// their JSON order. A stable partition, nothing else. The preview then stacks
// in that order, bottom to top (`OverlayItemsLayer.tsx`, z = position + 12),
// and every editor edit saves that order back, so a project the app saved is
// already in it.
//
// So a track holding video ALWAYS draws below every image and overlay track,
// wherever it sits in the JSON: an image-only track listed below a video track
// draws over that video, and an image track above an overlay track draws over
// the overlay. `trackLayerPositions` is that rule and nothing more. Change the
// editor's partition and this together; `editor/src/video/preview/__tests__/
// layering-parity.test.tsx` fails when they disagree.
//
// ── Within one track ─────────────────────────────────────────────────────────
//
// Not decided here. Render draws a track's clips (images, videos) before its
// overlays, which keeps a crossfade pair's two halves next to each other; the
// editor draws a track's items in document order. They differ only when an
// image and an overlay on ONE track overlap without being a pair
// (KNOWN-DIVERGENCES.md, "same-track-image-overlay-order").
//
// Pure. No project shape beyond each track's items' `type`.

/**
 * The layer position of each visual track, by its JSON index: 0 is the bottom.
 * Mirrors the editor's canonical track order (see the module header): every
 * track holding a video item first, then the rest, each group in JSON order.
 *
 * Read over ALL tracks, disabled ones included, as the editor's partition is:
 * a disabled track has nothing to draw, so where it sits changes no one's
 * relative order either way.
 *
 * @param {ReadonlyArray<ReadonlyArray<{ type?: string } | null | undefined> | null | undefined>} trackItems
 *   Every visual track's items, in JSON order.
 * @returns {number[]} `positions[jsonIndex]`; for tracks already in canonical
 *   order, `positions[i] === i`.
 */
export function trackLayerPositions(trackItems) {
  const tracks = Array.isArray(trackItems) ? trackItems : []
  const holdsVideo = tracks.map((items) => Array.isArray(items) && items.some((item) => item?.type === 'video'))
  /** @type {number[]} */
  const positions = new Array(tracks.length)
  let next = 0
  for (let i = 0; i < tracks.length; i++) if (holdsVideo[i]) positions[i] = next++
  for (let i = 0; i < tracks.length; i++) if (!holdsVideo[i]) positions[i] = next++
  return positions
}
