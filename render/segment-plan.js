// render/segment-plan.js
/**
 * Segment planner: splits the timeline into non-overlapping segments
 * at every clip and overlay boundary.
 *
 * Each segment carries:
 *   - items: ALL active visual items sorted ascending by trackIdx (lower = further back).
 *     The encoder composites them in order. Empty array = black canvas.
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
 * @returns {Array<{ start, end, items: object[], overlays: object[], vw, vh, fps }>}
 */
export function planSegments(allItems, puppeteerSegs, vw, vh, fps) {
  // Collect all boundary times
  const boundaries = new Set()
  for (const item of allItems) {
    boundaries.add(item.start)
    boundaries.add(item.end)
  }
  for (const seg of puppeteerSegs) {
    boundaries.add(seg.startSeconds)
    boundaries.add(seg.endSeconds)
  }

  if (boundaries.size === 0) return []
  const frameDur = 1 / fps

  // Snap boundaries that are within one frame of each other to the same value.
  // The UI allows independent positioning of clips and overlays with float precision,
  // so "same moment" often lands 1-3ms apart. Without snapping, the planner creates
  // degenerate micro-segments that corrupt the concat stream.
  const sorted = [...boundaries].sort((a, b) => a - b)
  const snapped = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - snapped[snapped.length - 1] < frameDur) {
      // Close enough — snap to the earlier boundary (don't add a new one)
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

    // Opaque overlay → clear the items stack (overlay replaces all visuals)
    const hasOpaque = overlays.some(o => o.opaque)

    segments.push({
      start,
      end,
      items: hasOpaque ? [] : items,
      overlays,
      vw,
      vh,
      fps,
    })
  }

  return segments
}
