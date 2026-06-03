// render/segment-plan.js
/**
 * Segment planner: splits the timeline into non-overlapping segments
 * at every clip and overlay boundary.
 *
 * Each segment carries:
 *   - items: ALL active visual items sorted ascending by trackIdx (lower = further back).
 *     The encoder composites them in order. Empty array = black canvas.
 *   - opaqueVideo: true when an opaque overlay covers this segment's frame. The
 *     encoder then skips compositing the items' VIDEO (the overlay replaces the
 *     frame) but still sources their AUDIO — opaque means "replace the picture",
 *     never "drop the voiceover". Items are kept precisely so their audio survives.
 *   - overlays: Puppeteer-rendered overlay + caption segments, with captions
 *     always sorted AFTER overlays (captions are the topmost z-layer).
 *
 * Accepts BOTH video and image items (merged). Image items are treated
 * like video items for segmentation but flagged as type:'image' so the
 * encoder can use -loop 1.
 */

/**
 * @param {Array} allItems — merged videoItems + imageItems from collectAllItems()
 * @param {Array} puppeteerSegs — rendered overlay/caption segments
 * @param {number} vw — output width
 * @param {number} vh — output height
 * @param {number} fps
 * @returns {Array<{ start, end, items: object[], opaqueVideo: boolean, overlays: object[], vw, vh, fps }>}
 */
export function planSegments(allItems, puppeteerSegs, vw, vh, fps) {
  const frameDur = 1 / fps
  // Quantize every boundary to the frame grid. Project boundaries come from the
  // editor as sub-frame floats (e.g. 4.7177s = frame 141.53, not frame 142). If
  // we feed those raw values through as segment start/end, `end - start` is not
  // an exact multiple of 1/fps — the encoder gets `-t 2.843` for what should be
  // 85 frames @ 30fps (2.833s), produces 85 frames of content, but MP4 records
  // 2.843s of track duration. The trailing ~10ms hangs off the last frame, and
  // stream-copy concat preserves it: the next segment's first frame lands one
  // third of a frame past the prior segment's last 30fps tick. Visually that's
  // a freeze-and-pop at every overlay start/end and clip transition. With 30
  // boundaries in a 62s render, drift also accumulates (~0.34s overall).
  // Quantizing here means every segment duration is an exact multiple of 1/fps,
  // the encoder emits an integer frame count whose pts span equals the declared
  // duration, and concat boundaries have uniform 1/fps gaps.
  const quantize = t => Math.round(t * fps) / fps

  // Collect all boundary times, snapped to the frame grid
  const boundaries = new Set()
  for (const item of allItems) {
    boundaries.add(quantize(item.start))
    boundaries.add(quantize(item.end))
  }
  for (const seg of puppeteerSegs) {
    boundaries.add(quantize(seg.startSeconds))
    boundaries.add(quantize(seg.endSeconds))
  }

  if (boundaries.size === 0) return []

  // Quantization above already collapses boundaries within half a frame of each
  // other onto the same grid point. The proximity pass remains as a defense in
  // depth: floating-point round-trips could in principle leave two grid points
  // separated by < frameDur, and the segment-build loop below assumes a strict
  // ascending sequence with at least frameDur between values.
  const sorted = [...boundaries].sort((a, b) => a - b)
  const snapped = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - snapped[snapped.length - 1]
    if (gap > 0 && gap < frameDur) {
      continue
    }
    snapped.push(sorted[i])
  }

  const segments = []

  for (let i = 0; i < snapped.length - 1; i++) {
    const start = snapped[i]
    const end = snapped[i + 1]

    // ALL visual items active during [start, end), sorted by trackIdx ascending.
    // Lower trackIdx = further back (composited first = background).
    const items = allItems
      .filter(v => v.start <= start + frameDur && v.end >= end - frameDur)
      .sort((a, b) => a.trackIdx - b.trackIdx)

    // Overlays active during [start, end), with captions sorted AFTER overlays.
    // Captions are always the topmost z-layer.
    const activeOverlays = puppeteerSegs.filter(
      s => s.startSeconds <= start + frameDur && s.endSeconds >= end - frameDur
    )
    const overlays = [
      ...activeOverlays.filter(o => !o.isCaption),
      ...activeOverlays.filter(o => o.isCaption),
    ]

    // Opaque overlay → the overlay replaces the visible frame, but the items are
    // KEPT so the encoder can still source their audio (the voiceover under a
    // full-screen animation). The opaqueVideo flag tells the encoder to skip the
    // items' video compositing only. See encode-segment.js Step 2.
    const hasOpaque = overlays.some(o => o.opaque)

    segments.push({
      start,
      end,
      items,
      opaqueVideo: hasOpaque,
      overlays,
      vw,
      vh,
      fps,
    })
  }

  return segments
}
