// render/segment-plan.js
/**
 * Segment planner: splits the timeline into non-overlapping segments
 * at every clip and overlay boundary.
 *
 * Each segment carries:
 *   - items: ALL active visual items sorted ascending by trackIdx (lower = further back).
 *     The encoder composites them in order. Empty array = black canvas.
 *   - opaqueVideo: true when an opaque overlay covers this segment's frame (an
 *     opaque overlay placed over the whole canvas; a scaled one covers nothing). The
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
import { boundariesFrom, activeIn, captionsLast, byTrackIdx, opaqueReplacesPicture } from '@bycrux/timeline-core'

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
    //
    // Only an opaque overlay over the WHOLE canvas replaces the frame
    // (`opaqueReplacesPicture`, the rule the editor's scheduler reads too). A
    // scaled or moved one cannot cover it, so the footage around it stays.
    const hasOpaque = overlays.some(o => opaqueReplacesPicture(o))

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

/**
 * The fewest frames any one video encode is given (5.20.5).
 *
 * libx265 reads an UNINITIALISED member for the DTS of an encode of 2 frames or
 * fewer. x265 4.0 `Encoder::encode` sets `m_bframeDelayTime` only when the frame
 * numbered `m_bframeDelay` (0-based) arrives (encoder.cpp:1765-1766), and the
 * constructor never initialises it. `m_bframeDelay` is 2 with B-frames and
 * b-pyramid on (encoder.cpp:4222), as at our `preset fast`. Every packet's DTS is
 * then `pts - m_bframeDelayTime` (encoder.cpp:2393-2395): whatever the heap held.
 * In a small process that is 0 and nothing shows. In a 4K HDR segment it is
 * garbage (measured on Sam's seg-0017: dts -6161412657059652 at pts 0), and when
 * the garbage still fits after rescaling the mp4 muxer refuses the packet,
 * "pts/dts pair unsupported" (AVERROR_PATCHWELCOME, exit 176): ffmpeg writes the
 * audio, no video stream, and the export dies. When it overflows, the muxer
 * drops the DTS and the segment comes out fine, which is why the same project
 * exported one day and not the next.
 *
 * 3 is what x265 needs whatever its B-frame settings (`m_bframeDelay` is at most
 * 2), and the least that keeps a run of tiny clips in small groups. x264 has
 * the same logic but zeroes its context first (encoder.c:1513), so SDR was
 * never affected; grouping runs for every colour space anyway, because it costs
 * one lossless pass over a few frames and keeps one code path.
 */
export const MIN_SEGMENT_FRAMES = 3

/**
 * Group planned segments so that no group is shorter than `minFrames` (5.20.5).
 *
 * A segment that is already long enough becomes a group of one, the same object,
 * encoded exactly as before. Runs of shorter segments (an agent's zoom built as
 * a dozen 2-frame clips, or a cut landing one frame from an overlay edge) are
 * collected into one group, closed as soon as it holds `minFrames`. A run that
 * is still short borrows frames from the next segment: just the frames it needs
 * when the rest of that segment stays long enough, otherwise all of it. A short
 * run at the very end borrows from the segment before it the same way, or joins
 * the group before it. Only a whole timeline under `minFrames` stays short.
 *
 * Nothing is dropped and nothing moves. A group's parts are the planned segments
 * in order, a borrowed one cut on the frame grid, each with its own items and
 * overlays, so every frame shows what the planner said it shows. The encoder
 * renders each part on its own and encodes the joined frames once
 * (encode-segment.js `encodeSegmentGroup`).
 *
 * Kept OUT of `planSegments`, like compose.js's leading gap: resolver-parity
 * holds `planSegments` to the frozen pre-T7 algorithm, and the editor preview
 * never encodes, so this is a render-only concern.
 *
 * @param {Array<{start: number, end: number}>} segments  planSegments' output, in order
 * @param {number} fps
 * @param {number} [minFrames]
 * @returns {Array<{start: number, end: number, parts: object[]}>}
 */
export function groupShortSegments(segments, fps, minFrames = MIN_SEGMENT_FRAMES) {
  const frameOf = t => Math.round(t * fps)
  const framesIn = s => frameOf(s.end) - frameOf(s.start)
  const framesOf = parts => parts.reduce((n, s) => n + framesIn(s), 0)
  // Cut on the frame grid, the same rounding boundariesFrom uses, so the two
  // halves meet exactly and each keeps the planner's items, overlays and flag.
  const cut = (s, k) => {
    const t = (frameOf(s.start) + k) / fps
    return [{ ...s, end: t }, { ...s, start: t }]
  }

  const groups = []
  let run = null
  for (const seg of segments) {
    const f = framesIn(seg)
    if (!run) {
      if (f >= minFrames) groups.push([seg])
      else run = [seg]
      continue
    }
    const need = minFrames - framesOf(run)
    if (f >= minFrames && f - need >= minFrames) {
      const [head, rest] = cut(seg, need)
      groups.push([...run, head], [rest])
      run = null
      continue
    }
    run.push(seg)
    if (framesOf(run) >= minFrames) {
      groups.push(run)
      run = null
    }
  }
  if (run) {
    const prev = groups.pop()
    const need = minFrames - framesOf(run)
    if (!prev) {
      groups.push(run)
    } else if (prev.length === 1 && framesIn(prev[0]) - need >= minFrames) {
      const [rest, tail] = cut(prev[0], framesIn(prev[0]) - need)
      groups.push([rest], [tail, ...run])
    } else {
      groups.push([...prev, ...run])
    }
  }
  return groups.map(parts => ({ start: parts[0].start, end: parts[parts.length - 1].end, parts }))
}
