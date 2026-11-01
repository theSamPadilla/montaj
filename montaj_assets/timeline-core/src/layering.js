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
// A video item with `remove_bg` on is not a video here (§644): render draws its
// cut-out, a picture with alpha, so it follows track order the way an image
// does. A track counts as a video track only if it holds a video item that is
// NOT a cut-out; a track of cut-outs, images and overlays stacks with the rest.
// The exception is the track at JSON index 0, the base video track: it counts as
// video if it holds ANY video item, cut-out or not, so it stays the bottom layer
// and re-normalizing never moves primary audio, transcripts or cut plans off it.
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
// Pure. No project shape beyond each track's items' `type` and `remove_bg`.

/**
 * The layer position of each visual track, by its JSON index: 0 is the bottom.
 * Mirrors the editor's canonical track order (see the module header): every
 * track holding a plain video item first, then the rest, each group in JSON order.
 * A `remove_bg` video is a cut-out and counts as a non-video item (§644),
 * except on the base track (JSON index 0), where any video item counts.
 *
 * Read over ALL tracks, disabled ones included, as the editor's partition is:
 * a disabled track has nothing to draw, so where it sits changes no one's
 * relative order either way.
 *
 * @param {ReadonlyArray<ReadonlyArray<{ type?: string, remove_bg?: boolean } | null | undefined> | null | undefined>} trackItems
 *   Every visual track's items, in JSON order.
 * @returns {number[]} `positions[jsonIndex]`; for tracks already in canonical
 *   order, `positions[i] === i`.
 */
export function trackLayerPositions(trackItems) {
  const tracks = Array.isArray(trackItems) ? trackItems : []
  const holdsVideo = tracks.map((items, i) => Array.isArray(items) && items.some((item) => item?.type === 'video' && (i === 0 || !item.remove_bg)))
  /** @type {number[]} */
  const positions = new Array(tracks.length)
  let next = 0
  for (let i = 0; i < tracks.length; i++) if (holdsVideo[i]) positions[i] = next++
  for (let i = 0; i < tracks.length; i++) if (!holdsVideo[i]) positions[i] = next++
  return positions
}
