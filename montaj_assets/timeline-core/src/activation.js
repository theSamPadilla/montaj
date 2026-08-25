// @ts-check
// montaj_assets/timeline-core/src/activation.js
//
// Activation + boundaries: which items are on screen, and where the timeline
// is allowed to be cut. This module is the single implementation of logic that
// shipped three times:
//
//   (1) render      — montaj_assets/render/segment-plan.js:29-133 (`planSegments`):
//                     the boundary pipeline (quantize → floor-at-0 → integer-frame
//                     dedupe) and the SEGMENT containment predicate.
//   (2) editor      — PreviewPlayer.tsx:117 and OverlayItemsLayer.tsx:412:
//                     the POINT-in-interval predicate `start <= t < end`.
//   (3) sample-frame — montaj_assets/render/sample-frame.js:538: the same point
//                     predicate, carrying the "LATER clip wins" tiebreak.
//
// Every legacy reasoning comment is carried over verbatim next to the code that
// reproduces it. Those comments record real production bugs; do not paraphrase
// them away.
//
// ── The two-level API, and why ──────────────────────────────────────────────
//
// Legacy `planSegments(allItems, puppeteerSegs, vw, vh, fps)` is NOT
// project-shaped: it takes an already-flattened item array (merged
// image+video items from `collectAllItems`, each carrying a `trackIdx`) and an
// already-rendered Puppeteer overlay-segment array (`startSeconds`/`endSeconds`,
// not `start`/`end`). The resolver's public API, by contrast, is project-shaped.
// Both are provided, deliberately:
//
//   LEVEL 1 — flat primitives, no project required:
//     frameGrid(fps) · boundariesFrom(intervals, fps) ·
//     coversSegment(...) · containsTime(...) · activeIn(...) ·
//     captionsLast(...) · byTrackIdx
//
//     T7 rewrote `segment-plan.js` to delegate to exactly these, keeping its
//     public signature untouched. It landed exactly as sketched below —
//     `render/segment-plan.js:74-152`'s `planSegments` matches this shape
//     verbatim (interleaved with the legacy reasoning comments carried over
//     from the pre-T7 implementation, omitted here for brevity):
//
//       const readPuppeteer = s => ({ start: s.startSeconds, end: s.endSeconds })
//       const snapped = boundariesFrom(
//         [...allItems.map(i => ({ start: i.start, end: i.end })),
//          ...puppeteerSegs.map(readPuppeteer)], fps)
//       for (let i = 0; i < snapped.length - 1; i++) {
//         const start = snapped[i], end = snapped[i + 1]
//         const items    = activeIn(allItems, start, end, fps).sort(byTrackIdx)
//         const overlays = captionsLast(activeIn(puppeteerSegs, start, end, fps, readPuppeteer))
//         segments.push({ start, end, items, opaqueVideo: overlays.some(o => o.opaque), overlays, vw, vh, fps })
//       }
//
//     — a thin wrapper, no restructuring, exactly as planned. The parity
//     harness in test/activation.test.mjs asserts that wrapper's output
//     equals `planSegments`' output.
//
//   LEVEL 2 — project-shaped, the API the plan's contract block names:
//     planBoundaries(project, fps) · resolveAt(project, t, {variant}) ·
//     resolveSegment(project, segStart, segEnd, fps)
//
//     These walk `project.tracks` (every track, with its index — the render /
//     sample-frame model, NOT the editor's `clips` / `tracks0NonVideo` /
//     `overlayTracks` partition at useVideoPlayback.ts:145-147; T6 maps the
//     Scene back onto that partition) plus `project.captions`.
//
// ── Where the two levels legitimately differ from today's render pipeline ───
//
// Documented here rather than silently absorbed. None of them affect T7, which
// delegates through LEVEL 1 with the caller's own arrays:
//
//   • TRACK-0 OVERLAYS. `collectAllItems` (render.js:581-637) takes only
//     image/video items and `collectPuppeteerSegments` (render.js:502) slices
//     tracks from 1, so an `overlay` item sitting on track 0 contributes no
//     boundary and never renders today. `sample-frame.js:535-545` DOES honour
//     it. The project-shaped level follows sample-frame and treats it as a
//     first-class item. Registered as KNOWN-DIVERGENCES.md entry D5,
//     `track-0-overlay-items`.
//   • OVERLAY QUANTIZATION. `collectPuppeteerSegments` pre-quantizes overlay
//     `startSeconds`/`endSeconds` (render.js:508-509) for its own frame-count
//     reasons, so legacy compares overlays against segment bounds using
//     QUANTIZED times while comparing items using RAW times. The project-shaped
//     level compares every item raw; the difference can only show up within
//     half a frame of a boundary.
//   • SAME-TRACK TIE ORDER. `compose.js:64` builds `allItems` as
//     `[...imageItems, ...videoItems]`, so for two items sharing one trackIdx
//     the stable sort puts ALL images before ALL videos regardless of their
//     order in the track. The project-shaped level walks each track in document
//     order instead.
//
// ── Purity ──────────────────────────────────────────────────────────────────
//
// No Date, no Math.random, no I/O, no globals, no mutation of the input project
// or of any array handed in by a caller. Same inputs always produce the same
// outputs. Every boundary returned is a finite number; `resolveAt` on an empty
// project returns `{ items: [], t }` rather than throwing. An invalid `variant`,
// by contrast, throws — see `checkVariant`.

import { sourceWindow } from './source-window.js'
import { visualDuration } from './durations.js'
import { geometryAt } from './geometry.js'

// NOTE: T2's `Variant` / `SourceWindow` / `SourceWindowItem` are referenced
// below as inline `import('./source-window.js').X` types rather than aliased
// with a local `@typedef`. A top-level JSDoc typedef in an ES module is itself
// an export, so aliasing them here would make the barrel's `export *` re-export
// each name twice and tsc would report TS2308 ambiguity. Verbose, but it keeps
// exactly one definition of each type in the package.

/**
 * The three item types the resolver understands. Anything else on a track is
 * skipped, reproducing `sample-frame.js:539-546`, whose if/else-if chain has no
 * final `else` (audio items in particular are silently dropped there).
 *
 * @typedef {'video' | 'image' | 'overlay'} ItemKind
 */

/**
 * A timeline `VisualItem` (montaj_assets/editor/src/schema.ts:78) as far as
 * activation is concerned: everything source-window math reads, plus the few
 * fields activation itself consults, plus (T4) everything geometry math
 * reads — `resolveItem` calls `geometryAt(item, kind, elapsed)` on every item,
 * so the type needs to structurally overlap `GeometryItem` for `tsc` to accept
 * it. That overlap is also what carries the optional `keyframes` field.
 *
 * `start` / `end` are required by the project schema but typed optional here so
 * the functions stay total over partial fixtures — same stance as T2.
 *
 * @typedef {import('./source-window.js').SourceWindowItem &
 *   import('./geometry.js').GeometryItem & {
 *   id?: string,
 *   type?: string,
 *   opaque?: boolean,
 * }} TimelineItem
 */

/**
 * Any half-open `[start, end)` span on the timeline. Deliberately structural:
 * items, Puppeteer overlay segments (after a field rename) and the synthetic
 * caption span all reduce to this.
 *
 * @typedef {Object} Interval
 * @property {number} [start] Seconds. Absent is tolerated — see the per-function notes.
 * @property {number} [end]   Seconds. Absent is tolerated — see the per-function notes.
 */

/**
 * One item that is on screen, with everything a consumer needs to draw it.
 *
 * @typedef {Object} ResolvedItem
 * @property {TimelineItem} item The ORIGINAL item object from the project — a reference, never a copy.
 * @property {number} trackIdx   Index of the track the item was found on. Lower = further back.
 * @property {ItemKind} kind     Narrowed from `item.type`.
 * @property {import('./source-window.js').SourceWindow | null} window
 *   The source window for items backed by a media file, i.e. `kind === 'video'`
 *   only. `null` for images and overlays — see `seek` for what that implies.
 *   An overlay's `src` is a JSX component path, not a media file with in/out
 *   points, and a still image has no source timeline at all; inventing an
 *   in/outPoint for either would be fabrication. Both still expose their file
 *   through `item.src`.
 * @property {number} seek
 *   Always `inPointOrZero + max(0, t - item.start)`. The `window` field tells
 *   you which coordinate system that lands in:
 *     • `window !== null` → a position INSIDE `window.src`, i.e. exactly
 *       `seekTime(item, t, variant)` (useVideoPlayback.ts:680 /
 *       encode-segment.js:217-218).
 *     • `window === null` → elapsed time since the item's own start, because
 *       the in point is definitionally 0. For an overlay that is the quantity
 *       both consumers already compute — `sample-frame.js:556`'s
 *       `round((atSeconds - ov.start) * fps)` and `encode-segment.js:299`'s
 *       `-ss max(0, segStart - ov.startSeconds)`. For an image it is dwell
 *       time; nothing consumes it today, but it is the honest reading of the
 *       same formula rather than a placeholder.
 *   The `max(0, …)` clamp means an item whose window starts before `t` (a
 *   negative-start overlay, a render segment that begins mid-item) reports how
 *   far INTO itself it already is.
 * @property {import('./geometry.js').Geometry} geometry
 *   The shared percent-of-frame geometry for this item AT THIS INSTANT —
 *   `geometryAt(item, kind, elapsed)` (src/geometry.js), where the clock is
 *   the item-relative `max(0, t - item.start)` (SP9b). For an item with no
 *   `keyframes` that IS `geometryFor(item, kind)`: `geometryAt` hands such an
 *   item to `geometryFor` itself, so the static result is unchanged by
 *   construction. Frame-relative and engine-agnostic; see that module for the
 *   three adapters (`toCssBoxPct`, `toPixelBox`, `toRotatedPixelBox`) that
 *   derive CSS-percent and ffmpeg-pixel numbers from it.
 *
 *   NOTE for `resolveSegment`: it resolves the whole segment at `segStart`, so
 *   an animated item's geometry there is the value at the SEGMENT's start, not
 *   a per-frame curve. The render bake samples per frame through its own
 *   `geometryAt` calls; `resolveSegment` is the segment-planning view.
 */

/**
 * Everything on screen at one instant, ordered back-to-front.
 *
 * @typedef {Object} Scene
 * @property {ResolvedItem[]} items
 *   Ordered by `trackIdx` ascending — lower = further back = composited first
 *   (segment-plan.js:106). The sort is STABLE, so items sharing a trackIdx keep
 *   their document order. Captions are conceptually the topmost layer but are
 *   NOT Scene items: `project.captions` is a top-level object, not a track
 *   entry, and its per-instant content is T4's `activeCaptionSegment`. Note
 *   also that the render encoder composites ALL video under ALL overlays
 *   regardless of track — that is a consumer-side compositing rule in
 *   encode-segment.js, not the resolver's ordering.
 * @property {number} t
 *   The instant this Scene answers for. `resolveSegment` sets it to `segStart`,
 *   which is the reference point every `seek` was measured from.
 */

/**
 * The subset of a project the resolver reads.
 *
 * @typedef {Object} ResolverProject
 * @property {ReadonlyArray<ReadonlyArray<TimelineItem> | undefined>} [tracks]
 * @property {{ style?: string, segments?: ReadonlyArray<unknown> }} [captions]
 * @property {{ tracks?: ReadonlyArray<{ end?: number }> }} [audio]
 */

/**
 * @typedef {Object} ResolveOptions
 * @property {import('./source-window.js').Variant} variant Which consumer is asking. Required; there is no default.
 */

/**
 * The frame grid for one frame rate: the three verbatim primitives from
 * `planSegments`, hoisted so every caller shares one definition.
 *
 * @typedef {Object} FrameGrid
 * @property {number} fps      The frame rate this grid was built for.
 * @property {number} frameDur `1 / fps` — the tolerance `coversSegment` uses.
 * @property {(t: number) => number} quantize Snap to the nearest frame boundary. NOT floored.
 * @property {(t: number) => number} boundary `max(0, quantize(t))` — floored at the timeline origin.
 * @property {(t: number) => number} frameOf  Integer frame index. The dedupe key.
 */

/**
 * A bad `variant` is a programming bug, never a runtime condition, so it throws
 * instead of quietly defaulting — same rule and same message shape as T2's
 * private `assertVariant` (src/source-window.js:108). It is duplicated rather
 * than shared because T2's copy is intentionally not exported and T2's file is
 * frozen; the two must be kept in step.
 *
 * @param {unknown} variant
 * @returns {import('./source-window.js').Variant}
 */
function checkVariant(variant) {
  if (variant === 'preview' || variant === 'render') return variant
  throw new TypeError(
    `@bycrux/timeline-core: unknown variant ${JSON.stringify(variant)} — expected 'preview' or 'render'.`,
  )
}

/**
 * Totality guard for boundary collection ONLY. A malformed item with a missing
 * or non-finite endpoint contributes the timeline origin instead of poisoning
 * the whole boundary list: legacy `boundary(undefined)` evaluates to
 * `Math.max(0, NaN)` = `NaN`, which reaches the encoder as a segment start.
 * The package contract requires every returned boundary to be finite.
 *
 * The ACTIVATION predicates deliberately do NOT use this — see `activeIn`.
 *
 * @param {number | undefined} v
 * @returns {number}
 */
function finiteOr0(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * A missing endpoint must make an item INACTIVE, matching legacy exactly:
 * `undefined <= x` and `undefined >= x` are both false, and so is every
 * comparison against `NaN`. Substituting 0 here would silently activate
 * malformed items, so the two guards deliberately differ.
 *
 * @param {number | undefined} v
 * @returns {number}
 */
function orNaN(v) {
  return typeof v === 'number' ? v : Number.NaN
}

/**
 * Default interval reader: an object that already has `start` / `end`.
 * @param {any} x
 * @returns {Interval}
 */
function readStartEnd(x) {
  return { start: x?.start, end: x?.end }
}

/**
 * Default caption test, matching `segment-plan.js:114-115`'s truthiness check.
 * @param {any} o
 * @returns {boolean}
 */
function readIsCaption(o) {
  return !!o?.isCaption
}

/**
 * @param {TimelineItem} item
 * @returns {ItemKind | null} `null` for anything the resolver does not draw.
 */
function kindOf(item) {
  if (!item) return null
  if (item.type === 'video') return 'video'
  if (item.type === 'image') return 'image'
  if (item.type === 'overlay') return 'overlay'
  return null
}

/**
 * Build the frame grid for `fps`.
 *
 * @param {number} fps
 * @returns {FrameGrid}
 */
export function frameGrid(fps) {
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
  /** @type {(t: number) => number} */
  const quantize = (t) => Math.round(t * fps) / fps

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
  /** @type {(t: number) => number} */
  const boundary = (t) => Math.max(0, quantize(t))

  // The dedupe key. See `boundariesFrom` for why this must be an integer frame
  // index and never a float gap.
  /** @type {(t: number) => number} */
  const frameOf = (t) => Math.round(t * fps)

  return { fps, frameDur, quantize, boundary, frameOf }
}

/**
 * The boundary pipeline of `planSegments` (segment-plan.js:62-94), verbatim in
 * semantics: collect → quantize → floor-at-0 → sort → integer-frame dedupe.
 *
 * Returns the deduped, ascending boundary list. `N` boundaries describe `N - 1`
 * segments; a list of length 0 or 1 describes none.
 *
 * @param {ReadonlyArray<Interval>} intervals Every span whose edges may cut the timeline.
 * @param {number} fps
 * @returns {number[]} Ascending, deduped, all finite, all >= 0.
 */
export function boundariesFrom(intervals, fps) {
  const { boundary, frameOf } = frameGrid(fps)

  // Collect all boundary times, snapped to the frame grid
  /** @type {Set<number>} */
  const boundaries = new Set()
  for (const iv of intervals) {
    boundaries.add(boundary(finiteOr0(iv.start)))
    boundaries.add(boundary(finiteOr0(iv.end)))
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
  const sorted = [...boundaries].sort((a, b) => a - b)
  const snapped = [sorted[0]]
  let lastFrame = frameOf(sorted[0])
  for (let i = 1; i < sorted.length; i++) {
    const f = frameOf(sorted[i])
    if (f === lastFrame) continue
    snapped.push(sorted[i])
    lastFrame = f
  }

  return snapped
}

/**
 * The RENDER containment predicate (segment-plan.js:105): is `[itemStart,
 * itemEnd]` present for the whole of segment `[segStart, segEnd]`, within one
 * frame of slack on each side?
 *
 *     v.start <= start + frameDur && v.end >= end - frameDur
 *
 * The slack absorbs the sub-frame difference between an item's raw times and
 * the quantized segment bounds derived from them.
 *
 * A `NaN` endpoint (a malformed item) makes every comparison false, i.e. the
 * item is not active — exactly what the legacy `undefined` comparison did.
 *
 * @param {number} itemStart
 * @param {number} itemEnd
 * @param {number} segStart
 * @param {number} segEnd
 * @param {number} fps
 * @returns {boolean}
 */
export function coversSegment(itemStart, itemEnd, segStart, segEnd, fps) {
  const frameDur = 1 / fps
  return itemStart <= segStart + frameDur && itemEnd >= segEnd - frameDur
}

/**
 * The PREVIEW / sample-frame point-in-interval predicate: `start <= t < end`.
 *
 * Half-open by design. `sample-frame.js:530` states the consequence outright —
 * "Handles clip boundary tiebreak: the LATER clip wins" — and T9 depends on it:
 * at an exact boundary `t`, the clip STARTING at `t` is active and the clip
 * ENDING at `t` is not. The same predicate is
 * `PreviewPlayer.tsx:117` (`currentTime >= c.start && currentTime < c.end`) and
 * `OverlayItemsLayer.tsx:412`.
 *
 * TWO EDITOR-SIDE BEHAVIORS ARE DELIBERATELY NOT REPRODUCED HERE:
 *
 *   • `PreviewPlayer.tsx:117`'s trailing `?? clips[clips.length - 1]`. Falling
 *     back to the last clip when nothing matches is PRESENTATION — it keeps a
 *     frame on screen after playback ends and through lift-style gaps. The
 *     resolver answers "what is actually on the timeline at t", so a gap
 *     resolves to nothing. The fallback stays in PreviewPlayer and is tested
 *     editor-side.
 *   • `OverlayItemsLayer.tsx:414-415`'s `VIDEO_PRELOAD_S` pre-mount window
 *     (`currentTime >= item.start - VIDEO_PRELOAD_S`). Mounting a video element
 *     early so its first frame is decoded is also presentation — it avoids a
 *     flash, it does not make the item visible. `visible` on line 412 is the
 *     real activation test and is what this function ports.
 *
 * @param {number} itemStart
 * @param {number} itemEnd
 * @param {number} t
 * @returns {boolean}
 */
export function containsTime(itemStart, itemEnd, t) {
  return itemStart <= t && t < itemEnd
}

/**
 * Filter any interval-shaped array down to the entries that cover the whole of
 * `[segStart, segEnd]`, i.e. `segment-plan.js:104-105` and :110-111 in one
 * function.
 *
 * Input order and object identity are preserved and the input array is never
 * mutated; callers apply their own ordering (`byTrackIdx`, `captionsLast`)
 * afterwards, exactly as legacy does.
 *
 * @template T
 * @param {ReadonlyArray<T>} intervals
 * @param {number} segStart
 * @param {number} segEnd
 * @param {number} fps
 * @param {(x: T) => Interval} [readInterval]
 *   How to read `{start, end}` off an entry. Defaults to the fields of the same
 *   name; pass `s => ({ start: s.startSeconds, end: s.endSeconds })` for the
 *   Puppeteer overlay-segment shape T7 needs.
 * @returns {T[]}
 */
export function activeIn(intervals, segStart, segEnd, fps, readInterval = readStartEnd) {
  /** @type {T[]} */
  const out = []
  for (const x of intervals) {
    const iv = readInterval(x)
    if (coversSegment(orNaN(iv.start), orNaN(iv.end), segStart, segEnd, fps)) out.push(x)
  }
  return out
}

/**
 * Captions are always the topmost z-layer, so they sort AFTER every other
 * overlay (segment-plan.js:113-116). Relative order inside each group is
 * preserved. Returns a new array; the input is never mutated.
 *
 * @template T
 * @param {ReadonlyArray<T>} overlays
 * @param {(o: T) => boolean} [isCaption] Defaults to the truthiness of `o.isCaption`.
 * @returns {T[]}
 */
export function captionsLast(overlays, isCaption = readIsCaption) {
  return [...overlays.filter((o) => !isCaption(o)), ...overlays.filter((o) => isCaption(o))]
}

/**
 * Back-to-front comparator: lower `trackIdx` = further back = composited first
 * (segment-plan.js:106). `Array.prototype.sort` is stable, so entries sharing a
 * trackIdx keep their input order.
 *
 * @param {{ trackIdx?: number }} a
 * @param {{ trackIdx?: number }} b
 * @returns {number}
 */
export function byTrackIdx(a, b) {
  return (a.trackIdx ?? 0) - (b.trackIdx ?? 0)
}

/**
 * Every interval in a project that may cut the timeline: one per drawable item
 * on every track, plus the synthetic caption span when the project has
 * captions.
 *
 * @param {ResolverProject} project
 * @returns {Interval[]}
 */
function projectIntervals(project) {
  /** @type {Interval[]} */
  const intervals = []
  const tracks = project.tracks ?? []
  for (let trackIdx = 0; trackIdx < tracks.length; trackIdx++) {
    for (const item of tracks[trackIdx] ?? []) {
      // Items the resolver does not draw contribute no boundary, mirroring
      // collectAllItems / collectPuppeteerSegments, which both ignore them.
      if (kindOf(item) === null) continue
      intervals.push({ start: item.start, end: item.end })
    }
  }

  // Captions render as ONE Puppeteer segment spanning [0, project duration]
  // (render.js:534-568), so they contribute exactly that pair of boundaries.
  // The guard is render.js:535's, and `visualDuration` is the same
  // `getTotalDurationSeconds` render.js:566 feeds in. collectPuppeteerSegments
  // pre-quantizes that duration (render.js:501); `boundariesFrom` quantizes
  // again and quantization is idempotent, so pre-quantizing here would be a
  // no-op.
  const captions = project.captions
  if ((captions?.segments?.length ?? 0) > 0 || captions?.style) {
    intervals.push({ start: 0, end: visualDuration(project) })
  }

  return intervals
}

/**
 * Every frame-grid boundary at which the timeline may be cut, for a whole
 * project. `N` boundaries describe `N - 1` segments.
 *
 * The project-shaped counterpart of `boundariesFrom`; see the module header for
 * the three places this walk legitimately differs from today's render pipeline.
 *
 * @param {ResolverProject} project
 * @param {number} fps
 * @returns {number[]} Ascending, deduped, all finite, all >= 0.
 */
export function planBoundaries(project, fps) {
  return boundariesFrom(projectIntervals(project), fps)
}

/**
 * Resolve one item that is already known to be active.
 *
 * @param {TimelineItem} item
 * @param {ItemKind} kind
 * @param {number} trackIdx
 * @param {number} t
 * @param {import('./source-window.js').Variant} variant
 * @returns {ResolvedItem}
 */
function resolveItem(item, kind, trackIdx, t, variant) {
  const elapsed = Math.max(0, t - (item.start ?? 0))
  // `elapsed` is already the ITEM-RELATIVE clock keyframes are authored
  // against (src/curves.js convention 1), so the same number that drives
  // `seek` drives the curves. An item with no keyframes routes straight back
  // through `geometryFor` inside `geometryAt`, unchanged.
  const geometry = geometryAt(item, kind, elapsed)
  if (kind === 'video') {
    const window = sourceWindow(item, variant)
    // Identical to `seekTime(item, t, variant)` by construction — that function
    // is `sourceWindow(item, variant).inPoint + max(0, t - item.start)`. Reusing
    // the window we already computed just avoids resolving it twice; the test
    // suite asserts the two agree.
    return { item, trackIdx, kind, window, seek: window.inPoint + elapsed, geometry }
  }
  // Images and overlays have no source window; `seek` is elapsed time into the
  // item itself. See the `ResolvedItem` typedef for why.
  return { item, trackIdx, kind, window: null, seek: elapsed, geometry }
}

/**
 * Walk every track, keep the drawable items `isActive` accepts, and order them
 * back-to-front.
 *
 * @param {ResolverProject} project
 * @param {number} t
 * @param {import('./source-window.js').Variant} variant
 * @param {(item: TimelineItem) => boolean} isActive
 * @returns {ResolvedItem[]}
 */
function collectScene(project, t, variant, isActive) {
  /** @type {ResolvedItem[]} */
  const items = []
  const tracks = project.tracks ?? []
  // ALL tracks, each with its index — the render / sample-frame model
  // (sample-frame.js:535-545). NOT the editor's clips / tracks0NonVideo /
  // overlayTracks partition (useVideoPlayback.ts:145-147); T6 maps this Scene
  // onto that partition rather than the resolver pre-splitting it.
  for (let trackIdx = 0; trackIdx < tracks.length; trackIdx++) {
    for (const item of tracks[trackIdx] ?? []) {
      const kind = kindOf(item)
      if (kind === null) continue
      if (!isActive(item)) continue
      items.push(resolveItem(item, kind, trackIdx, t, variant))
    }
  }
  // Sorted by trackIdx ascending. Lower trackIdx = further back (composited
  // first = background). The walk above already produces that order, so this is
  // a no-op today; it is kept explicit because the ordering is contract, not a
  // side effect of iteration order.
  return items.sort(byTrackIdx)
}

/**
 * Everything on screen at instant `t`, using the point-in-interval predicate
 * `start <= t < end` (see `containsTime`, including the two editor-side
 * behaviors it deliberately omits).
 *
 * A `t` inside a gap resolves to an EMPTY Scene — there is no last-clip
 * fallback here.
 *
 * @param {ResolverProject} project
 * @param {number} t Timeline time, seconds.
 * @param {ResolveOptions} options
 * @returns {Scene}
 * @throws {TypeError} if `options.variant` is not `'preview'` or `'render'`.
 */
export function resolveAt(project, t, options) {
  const variant = checkVariant(options?.variant)
  const items = collectScene(project, t, variant, (item) =>
    containsTime(orNaN(item.start), orNaN(item.end), t),
  )
  return { items, t }
}

/**
 * Everything on screen for the whole of render segment `[segStart, segEnd]`,
 * using the containment predicate (see `coversSegment`).
 *
 * RENDER-ONLY, and therefore variant-free: the containment predicate exists
 * only because the render engine cuts the timeline into segments, so the source
 * window is resolved with `'render'` precedence. The plan's contract block
 * specifies the signature without a variant for exactly this reason.
 *
 * `Scene.t` is `segStart`, which is the reference point every `seek` was
 * measured from — the same `max(0, segStart - item.start)` offset
 * `encode-segment.js:217-218` computes.
 *
 * @param {ResolverProject} project
 * @param {number} segStart
 * @param {number} segEnd
 * @param {number} fps
 * @returns {Scene}
 */
export function resolveSegment(project, segStart, segEnd, fps) {
  const items = collectScene(project, segStart, 'render', (item) =>
    coversSegment(orNaN(item.start), orNaN(item.end), segStart, segEnd, fps),
  )
  return { items, t: segStart }
}
