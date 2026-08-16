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
 *
 * ── SP2 T7: this file is now a wrapper ──────────────────────────────────────
 *
 * The boundary pipeline, the containment predicate and the overlay ordering
 * used to live here outright. They now live once, in `@bycrux/timeline-core`,
 * shared with the editor preview and sample-frame.js so the three engines can
 * no longer drift apart. This file keeps its signature and its shape; only the
 * arithmetic moved.
 *
 * The reasoning comments below stay because each one records a real production
 * bug. The code they describe is now inside the resolver's `frameGrid` /
 * `boundariesFrom` (`@bycrux/timeline-core/src/activation.js`), where they are
 * reproduced verbatim. Two copies of a bug's history is cheap; zero is how the
 * bug comes back.
 *
 * The swap is guarded permanently by `test/resolver-parity.test.mjs`, which
 * holds a FROZEN copy of the pre-T7 algorithm and requires this function to
 * agree with it over the whole shared fixture corpus at 24/30/60fps. That
 * harness also pins the two inputs on which the resolver legitimately differs
 * from the frozen original — see "DOCUMENTED DIVERGENCES" at the bottom of
 * this comment.
 *
 * DOCUMENTED DIVERGENCES from the pre-T7 code. Neither is reachable through
 * `compose.js`, which is the only production caller:
 *
 *   1. NON-FINITE ENDPOINTS (KNOWN-DIVERGENCES.md D4). `boundariesFrom` maps a
 *      missing or non-finite `start`/`end` to 0, so a malformed item drops out
 *      of boundary space. The old code let `Math.max(0, NaN)` = NaN into the
 *      boundary set, and that NaN reached ffmpeg as a literal `-t NaN`.
 *      Unreachable here because `collectAllItems` copies `start`/`end` from
 *      schema-required fields.
 *   2. AN ITEM WITH NO `trackIdx`. `byTrackIdx` reads a missing trackIdx as 0;
 *      the old comparator produced NaN, which ECMA-262's SortCompare coerces to
 *      +0, leaving such an item in input order instead. Unreachable here
 *      because `collectAllItems` (render.js:597) stamps `trackIdx` on every
 *      item it emits.
 */
import { boundariesFrom, activeIn, captionsLast, byTrackIdx } from '@bycrux/timeline-core'

/**
 * Puppeteer overlay segments name their endpoints `startSeconds`/`endSeconds`
 * rather than `start`/`end`, so every resolver call that reads them takes this
 * adapter. Note that `collectPuppeteerSegments` has ALREADY quantized these two
 * values (render.js:508-509) for its own frame-count reasons, while visual
 * items arrive raw — the resolver quantizes both again, and quantization is
 * idempotent, so that asymmetry is preserved exactly as it was.
 */
const readPuppeteer = s => ({ start: s.startSeconds, end: s.endSeconds })

/**
 * @param {Array} allItems — merged videoItems + imageItems from collectAllItems()
 * @param {Array} puppeteerSegs — rendered overlay/caption segments
 * @param {number} vw — output width
 * @param {number} vh — output height
 * @param {number} fps
 * @returns {Array<{ start, end, items: object[], opaqueVideo: boolean, overlays: object[], vw, vh, fps }>}
 */
export function planSegments(allItems, puppeteerSegs, vw, vh, fps) {
  // Collect every clip and overlay edge and snap it to the frame grid.
  // `boundariesFrom` is the collect → quantize → floor-at-0 → sort → dedupe
  // pipeline that used to be written out here. It returns an ascending, deduped
  // list; N boundaries describe N-1 segments, so an empty or single-boundary
  // list produces no segments at all (the old `boundaries.size === 0 → return []`
  // early exit is subsumed by the loop below never running).
  //
  // QUANTIZE. Project boundaries come from the editor as sub-frame floats (e.g.
  // 4.7177s = frame 141.53, not frame 142). If we feed those raw values through
  // as segment start/end, `end - start` is not an exact multiple of 1/fps — the
  // encoder gets `-t 2.843` for what should be 85 frames @ 30fps (2.833s),
  // produces 85 frames of content, but MP4 records 2.843s of track duration.
  // The trailing ~10ms hangs off the last frame, and stream-copy concat
  // preserves it: the next segment's first frame lands one third of a frame
  // past the prior segment's last 30fps tick. Visually that's a freeze-and-pop
  // at every overlay start/end and clip transition. With 30 boundaries in a 62s
  // render, drift also accumulates (~0.34s overall). Quantizing means every
  // segment duration is an exact multiple of 1/fps, the encoder emits an
  // integer frame count whose pts span equals the declared duration, and concat
  // boundaries have uniform 1/fps gaps.
  //
  // FLOOR AT 0. The rendered timeline origin is t=0, never earlier. An item may
  // carry a NEGATIVE start — the interactive editor clamps drags/trims to >=0,
  // but programmatic authors (e.g. the overlays workflow placing a full-source
  // background reel at `-firstClipInPoint` to stay aligned to source time) can
  // persist a start < 0. Without the floor the earliest boundary becomes that
  // negative value, so the whole output shifts later by |minStart|: tracks
  // anchored at 0 (the video clips) get a black head gap for |minStart| seconds
  // while the negative-start overlay fills from frame 0 — exactly the "black top
  // for the first ~0.3s" bug, and the render disagrees with the editor preview
  // (which already treats t<0 as t=0). Flooring drops any pre-0 segment;
  // encode-segment's existing `max(0, segStart - start)` seek then advances each
  // item into its pre-0 portion, matching the preview's `playhead - start`
  // convention. Items entirely before 0 collapse to a single 0 boundary and
  // produce no segment.
  //
  // DEDUPE BY INTEGER FRAME INDEX, never by float gap. The gap test
  // `(b - a) < frameDur` looks correct but suffers IEEE 754 cancellation when
  // `a` and `b` are adjacent grid points like 143/30 and 144/30. The
  // mathematical gap is exactly 1/30, but float subtraction can return a value
  // ~1e-16 below 1/30, which a `gap < frameDur` test misreads as "collapse
  // them" — silently dropping the boundary at clip changes and producing a
  // black-canvas segment between two clips that the editor renders
  // continuously. Integer frame comparison is cancellation-proof: two
  // boundaries are the same frame iff `round(t * fps)` matches.
  const snapped = boundariesFrom(
    [
      ...allItems.map(i => ({ start: i.start, end: i.end })),
      ...puppeteerSegs.map(readPuppeteer),
    ],
    fps,
  )

  const segments = []

  for (let i = 0; i < snapped.length - 1; i++) {
    const start = snapped[i]
    const end = snapped[i + 1]

    // ALL visual items active during [start, end), sorted by trackIdx ascending.
    // Lower trackIdx = further back (composited first = background).
    // `activeIn` is the containment predicate `v.start <= start + 1/fps &&
    // v.end >= end - 1/fps`; it preserves input order and object identity, so
    // the stable sort below sees exactly the array `compose.js` built. That
    // matters: `compose.js:64` merges as `[...imageItems, ...videoItems]`, so
    // two items sharing a trackIdx put all images before all videos
    // (KNOWN-DIVERGENCES.md D7), and the encoder mutates these very objects.
    const items = activeIn(allItems, start, end, fps).sort(byTrackIdx)

    // Overlays active during [start, end), with captions sorted AFTER overlays.
    // Captions are always the topmost z-layer. `captionsLast` is a stable
    // two-filter partition, not a sort, so relative order within each group
    // survives.
    const overlays = captionsLast(activeIn(puppeteerSegs, start, end, fps, readPuppeteer))

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
