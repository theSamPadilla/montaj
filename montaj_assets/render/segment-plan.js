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

  // Floor every boundary at 0: the rendered timeline origin is t=0, never
  // earlier. An item may carry a NEGATIVE start — the interactive editor clamps
  // drags/trims to >=0, but programmatic authors (e.g. the overlays workflow
  // placing a full-source background reel at `-firstClipInPoint` to stay aligned
  // to source time) can persist a start < 0. Without this floor the earliest
  // boundary becomes that negative value, so the whole output shifts later by
  // |minStart|: tracks anchored at 0 (the video clips) get a black head gap for
  // |minStart| seconds while the negative-start overlay fills from frame 0 —
  // exactly the "black top for the first ~0.3s" bug, and the render disagrees
  // with the editor preview (which already treats t<0 as t=0). Flooring here
  // drops any pre-0 segment; encode-segment's existing `max(0, segStart - start)`
  // seek then advances each item into its pre-0 portion, matching the preview's
  // `playhead - start` convention. Items entirely before 0 collapse to a single
  // 0 boundary and produce no segment.
  const boundary = t => Math.max(0, quantize(t))

  // Collect all boundary times, snapped to the frame grid
  const boundaries = new Set()
  for (const item of allItems) {
    boundaries.add(boundary(item.start))
    boundaries.add(boundary(item.end))
  }
  for (const seg of puppeteerSegs) {
    boundaries.add(boundary(seg.startSeconds))
    boundaries.add(boundary(seg.endSeconds))
  }

  if (boundaries.size === 0) return []

  // Defense-in-depth proximity pass: deduplicate boundaries that land on the
  // same frame index. Compared via INTEGER frame indices, not float gaps —
  // the gap test `(b - a) < frameDur` looks correct but suffers IEEE 754
  // cancellation when `a` and `b` are adjacent grid points like 143/30 and
  // 144/30. The mathematical gap is exactly 1/30, but float subtraction can
  // return a value ~1e-16 below 1/30, which a `gap < frameDur` test
  // misreads as "collapse them" — silently dropping the boundary at clip
  // changes and producing a black-canvas segment between two clips that the
  // editor renders continuously. Integer frame comparison is cancellation-
  // proof: two boundaries are the same frame iff `round(t * fps)` matches.
  const frameOf = t => Math.round(t * fps)
  const sorted = [...boundaries].sort((a, b) => a - b)
  const snapped = [sorted[0]]
  let lastFrame = frameOf(sorted[0])
  for (let i = 1; i < sorted.length; i++) {
    const f = frameOf(sorted[i])
    if (f === lastFrame) continue
    snapped.push(sorted[i])
    lastFrame = f
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
