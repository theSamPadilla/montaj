// montaj_assets/timeline-core/index.d.ts
//
// NORMATIVE. This file is the contract for @bycrux/timeline-core's public
// API, not a derived artifact — it is hand-written and is the source of
// truth consumers code against. T4 extended it with geometryFor and the rest
// of the public API this package now ships.
// index.js's JSDoc must never diverge from what is declared here.

/**
 * Salts resolver-derived caches (see index.js). Bump this when resolver
 * semantics change in a way that should invalidate stale cached output.
 */
export declare const RESOLVER_VERSION: string

// ---------------------------------------------------------------------------
// T2 — source-window math (src/source-window.js)
// ---------------------------------------------------------------------------

/**
 * Which consumer is asking. Preview and render legitimately differ in src
 * precedence (and therefore in whether the normalized cache is in play), so
 * every function that can differ takes the variant explicitly. An unknown
 * value is a programming bug and throws a `TypeError` — it never defaults.
 */
export type Variant = 'preview' | 'render'

/**
 * The subset of a timeline `VisualItem` that source-window math reads. Nothing
 * outside this list is consulted. `start`/`end` are required by the project
 * schema but optional here so the functions stay total; absent means 0.
 */
export interface SourceWindowItem {
  /** Original source file. Never replaced on the item itself. */
  src?: string
  /** Per-window normalized cache; covers [normalizedInPoint, +duration] and plays from its own 0. */
  normalizedSrc?: string
  /** Source-time the normalized cache starts at. Absent ⇒ assume the item's `inPoint`. */
  normalizedInPoint?: number
  /**
   * Full-source 720p AV1+Opus editing proxy (SP3). Preview-only, and — like
   * the `nobg_*` artifacts below — covers the WHOLE source, never a window,
   * so it is never rebased. Render must never choose it.
   */
  proxySrc?: string
  /** ProRes 4444 alpha artifact — render only, covers the FULL source (not a window cache). */
  nobg_src?: string
  /** VP9 WebM alpha artifact — preview only, covers the FULL source (not a window cache). */
  nobg_preview_src?: string
  /** Whether background removal is active. Render ignores `nobg_src` unless this is true. */
  remove_bg?: boolean
  /** In point in ORIGINAL-source coordinates, seconds. */
  inPoint?: number
  /** Out point in ORIGINAL-source coordinates, seconds. */
  outPoint?: number
  /** Timeline start, seconds. */
  start?: number
  /** Timeline end, seconds. */
  end?: number
  /**
   * Per-clip playback speed S (montaj/speed), default 1. At S the clip plays S×
   * faster: `seekTime` scales the elapsed offset by S and `synthesizedOutPoint`'s
   * window length is `(end − start)·S`. `inPoint`/`outPoint` stay in
   * ORIGINAL-source coords (never scaled by S), so `sourceWindow` is speed-agnostic.
   */
  speed?: number
}

/** What to load, and where to seek inside it. */
export interface SourceWindow {
  /**
   * File the consumer should load.
   *
   * `'preview'` always yields a string — `''` when the item has no src field at
   * all, the tail the editor original (`useVideoPlayback.ts:30`) has always had.
   * `'render'` can yield `undefined`: `render.js:611` has no such tail and its
   * `chosenSrc` reaches `collectAllItems`' output as `undefined` today, so the
   * behavior is reproduced verbatim. The asymmetry is deliberate — preview's
   * totality guarantee is stronger than render's by design.
   */
  src: string | undefined
  /** In point in the CHOSEN src's own timeline. Always a finite number. */
  inPoint: number
  /**
   * Out point in the chosen src's timeline, or `undefined` when the item stores
   * none (a stored `null` normalizes to `undefined`). Callers that need a number
   * use `synthesizedOutPoint`.
   */
  outPoint: number | undefined
  /** Whether the normalized cache was chosen — i.e. whether the points above were rebased. */
  usedNormalizedCache: boolean
}

/**
 * Resolve the playback/encode source for `item` plus its in/out points inside
 * that source's own timeline.
 *
 * When the chosen src is the `normalizedSrc` window cache, in/outPoint are
 * rebased by the cache origin `normalizedInPoint ?? inPoint ?? 0`. Full-source
 * sources (the original, and the `nobg_*` alpha artifacts) are never rebased.
 *
 * @throws {TypeError} if `variant` is not `'preview'` or `'render'`.
 */
export declare function sourceWindow(item: SourceWindowItem, variant: Variant): SourceWindow

/**
 * The src-selection half of {@link sourceWindow} on its own. Always equal to
 * `sourceWindow(item, variant).src`, including the preview-only `?? ''` tail:
 * `'preview'` always returns a string (`''` when the item has no src field at
 * all), while `'render'` can return `undefined`, faithfully reproducing
 * `render.js:611`. See the `src` note on {@link SourceWindow}.
 *
 * @throws {TypeError} if `variant` is not `'preview'` or `'render'`.
 */
export declare function playbackSrcFor(
  item: SourceWindowItem,
  variant: Variant,
): string | undefined

/**
 * Where to seek inside the chosen src to show timeline time `t`:
 * `sourceWindow(item, variant).inPoint + (item.speed ?? 1) · max(0, t - item.start)`.
 * The `·(speed ?? 1)` factor converts elapsed timeline-seconds to source-seconds
 * (montaj/speed); a strict no-op at S undefined/1.
 *
 * @throws {TypeError} if `variant` is not `'preview'` or `'render'`.
 */
export declare function seekTime(item: SourceWindowItem, t: number, variant: Variant): number

/**
 * The out point to use when the item stores none:
 * `outPoint ?? effectiveInPoint + (end - start) · (speed ?? 1)`, in the chosen
 * src's coordinates. The `·(speed ?? 1)` factor (montaj/speed) applies only to
 * the SYNTHESIZED length; a stored `outPoint` is already the true source out and
 * passes through. Takes a variant because the effective in point it builds on is
 * variant-dependent.
 *
 * @throws {TypeError} if `variant` is not `'preview'` or `'render'`.
 */
export declare function synthesizedOutPoint(item: SourceWindowItem, variant: Variant): number

// ---------------------------------------------------------------------------
// T3 — activation, boundaries, durations (src/activation.js, src/durations.js)
//
// The API comes at TWO levels, deliberately. The flat primitives
// (`frameGrid`, `boundariesFrom`, `coversSegment`, `containsTime`, `activeIn`,
// `captionsLast`, `byTrackIdx`) operate on plain interval-shaped arrays and
// exist so `render/segment-plan.js` — whose `planSegments(allItems,
// puppeteerSegs, vw, vh, fps)` signature is not project-shaped — can delegate
// to the resolver in T7 without being restructured. The project-shaped
// functions (`planBoundaries`, `resolveAt`, `resolveSegment`) are what every
// other consumer uses. See the src/activation.js module header for the worked
// T7 wrapper and for the three places the project-shaped walk legitimately
// differs from today's render pipeline.
// ---------------------------------------------------------------------------

/** The three item types the resolver draws. Anything else on a track is skipped. */
export type ItemKind = 'video' | 'image' | 'overlay'

/**
 * A timeline `VisualItem` as far as activation is concerned. `start`/`end` are
 * required by the project schema but optional here so the functions stay total
 * over partial fixtures.
 */
export interface TimelineItem extends SourceWindowItem, GeometryItem {
  id?: string
  type?: string
  /** Render-only: the overlay replaces the picture but never the audio. */
  opaque?: boolean
}

/** Any half-open `[start, end)` span on the timeline. */
export interface Interval {
  start?: number
  end?: number
}

/** The subset of a project the resolver reads. */
export interface ResolverProject {
  tracks?: ReadonlyArray<ReadonlyArray<TimelineItem> | undefined>
  captions?: { style?: string; segments?: ReadonlyArray<unknown> }
  audio?: { tracks?: ReadonlyArray<{ end?: number }> }
}

/** Which consumer is asking. Required; there is no default. */
export interface ResolveOptions {
  variant: Variant
}

/** The frame grid for one frame rate — the three verbatim `planSegments` primitives. */
export interface FrameGrid {
  /** The frame rate this grid was built for. */
  readonly fps: number
  /** `1 / fps` — the tolerance {@link coversSegment} applies on each side. */
  readonly frameDur: number
  /** Snap to the nearest frame boundary. NOT floored; may return a negative. */
  quantize(t: number): number
  /** `max(0, quantize(t))` — floored at the timeline origin. */
  boundary(t: number): number
  /** Integer frame index. The dedupe key — never compare boundaries by float gap. */
  frameOf(t: number): number
}

/**
 * One item that is on screen, with everything a consumer needs to draw it.
 */
export interface ResolvedItem {
  /** The ORIGINAL item object from the project — a reference, never a copy. */
  item: TimelineItem
  /** Index of the track the item was found on. Lower = further back. */
  trackIdx: number
  kind: ItemKind
  /**
   * The source window, for items backed by a media file — i.e. `kind ===
   * 'video'` only. `null` for images and overlays: an overlay's `src` is a JSX
   * component path, not a media file with in/out points, and a still has no
   * source timeline. Both still expose their file through `item.src`.
   */
  window: SourceWindow | null
  /**
   * Always `inPointOrZero + max(0, t - item.start)`. `window` says which
   * coordinate system that lands in: non-null ⇒ a position inside
   * `window.src` (identical to `seekTime(item, t, variant)`); null ⇒ elapsed
   * time since the item's own start, which for an overlay is exactly the
   * quantity `sample-frame.js:597` and `encode-segment.js:532` compute.
   */
  seek: number
  /**
   * The shared percent-of-frame geometry for this item AT THIS INSTANT — see
   * {@link geometryAt}, called with the item-relative clock
   * `max(0, t - item.start)` (SP9b). For an item with no `keyframes` that IS
   * {@link geometryFor}'s result, by construction rather than by coincidence.
   *
   * NOTE for {@link resolveSegment}: it resolves the whole segment at
   * `segStart`, so an animated item's geometry there is the value at the
   * SEGMENT's start, not a per-frame curve.
   */
  geometry: Geometry
}

/** Everything on screen at one instant, ordered back-to-front. */
export interface Scene {
  /**
   * Ordered by `trackIdx` ascending — lower = further back = composited first.
   * The sort is stable, so items sharing a trackIdx keep document order.
   * Captions are conceptually the topmost layer but are NOT Scene items:
   * `project.captions` is a top-level object, and its per-instant content is
   * T4's `activeCaptionSegment`.
   */
  items: ResolvedItem[]
  /** The instant this Scene answers for. `resolveSegment` sets it to `segStart`. */
  t: number
}

/** Build the frame grid for `fps`. */
export declare function frameGrid(fps: number): FrameGrid

/**
 * The boundary pipeline of `planSegments`, verbatim in semantics: collect →
 * quantize → floor-at-0 → sort → integer-frame dedupe (never an epsilon gap).
 * `N` boundaries describe `N - 1` segments. Every value returned is finite,
 * `>= 0`, ascending and unique.
 */
export declare function boundariesFrom(intervals: ReadonlyArray<Interval>, fps: number): number[]

/**
 * The RENDER containment predicate:
 * `itemStart <= segStart + 1/fps && itemEnd >= segEnd - 1/fps`.
 * A `NaN` endpoint makes it false, i.e. the item is not active.
 */
export declare function coversSegment(
  itemStart: number,
  itemEnd: number,
  segStart: number,
  segEnd: number,
  fps: number,
): boolean

/**
 * The PREVIEW / sample-frame point-in-interval predicate: `start <= t < end`.
 * Half-open, so at an exact clip boundary the LATER clip wins.
 *
 * Does NOT include `PreviewPlayer.tsx:117`'s last-clip fallback or
 * `OverlayItemsLayer.tsx:414`'s pre-mount window — both are editor-side
 * presentation and stay there.
 */
export declare function containsTime(itemStart: number, itemEnd: number, t: number): boolean

/**
 * Filter an interval-shaped array down to entries covering the whole of
 * `[segStart, segEnd]`. Input order and object identity are preserved; the
 * input array is never mutated. Pass `readInterval` for arrays that name their
 * endpoints differently (e.g. a Puppeteer segment's `startSeconds`/`endSeconds`).
 */
export declare function activeIn<T>(
  intervals: ReadonlyArray<T>,
  segStart: number,
  segEnd: number,
  fps: number,
  readInterval?: (x: T) => Interval,
): T[]

/**
 * Captions sort AFTER every other overlay (topmost z-layer). Relative order
 * inside each group is preserved. Returns a new array.
 */
export declare function captionsLast<T>(
  overlays: ReadonlyArray<T>,
  isCaption?: (o: T) => boolean,
): T[]

/** Back-to-front comparator: lower `trackIdx` composites first. Stable. */
export declare function byTrackIdx(a: { trackIdx?: number }, b: { trackIdx?: number }): number

/**
 * Every frame-grid boundary at which a whole project's timeline may be cut.
 * The project-shaped counterpart of {@link boundariesFrom}: it walks every
 * track (including overlays on track 0, which today's render pipeline skips)
 * and adds the `[0, visualDuration]` caption span when the project has
 * captions.
 */
export declare function planBoundaries(project: ResolverProject, fps: number): number[]

/**
 * Everything on screen at instant `t`, using `start <= t < end`. A `t` inside a
 * gap resolves to an EMPTY Scene — there is no last-clip fallback here.
 *
 * @throws {TypeError} if `options.variant` is not `'preview'` or `'render'`.
 */
export declare function resolveAt(
  project: ResolverProject,
  t: number,
  options: ResolveOptions,
): Scene

/**
 * Everything on screen for the whole of render segment `[segStart, segEnd]`,
 * using {@link coversSegment}. RENDER-ONLY and therefore variant-free: the
 * containment predicate exists only because the render engine cuts the timeline
 * into segments, so source windows resolve with `'render'` precedence.
 * `Scene.t` is `segStart`.
 */
export declare function resolveSegment(
  project: ResolverProject,
  segStart: number,
  segEnd: number,
  fps: number,
): Scene

/** The subset of a project the duration functions read. */
export interface DurationProject {
  tracks?: ReadonlyArray<ReadonlyArray<TimelineItem> | undefined>
  audio?: { tracks?: ReadonlyArray<{ end?: number }> }
}

/**
 * RENDER semantics (`render.js:770-774`). The furthest `end` of any item on any
 * track, with AUDIO EXCLUDED. `0` for a project with no visual items.
 */
export declare function visualDuration(project: DurationProject): number

/**
 * EDITOR semantics (`useVideoPlayback.ts:154-159`).
 * `max(videoEnd, overlayEnd, audioEnd)`, with AUDIO INCLUDED, where `videoEnd`
 * is the LAST video clip of track 0 BY START ORDER — not a max, and not
 * counting non-video track-0 items.
 *
 * This function and {@link visualDuration} legitimately disagree whenever audio
 * outlasts picture. Registry: KNOWN-DIVERGENCES.md entry 4,
 * `audio-duration-mismatch`, owner SP4.
 */
export declare function projectEnd(project: DurationProject): number

// ---------------------------------------------------------------------------
// T4 — geometry, captions, audio (src/geometry.js, src/captions.js, src/audio.js)
//
// geometryFor is the shared percent-of-frame formula that shipped IDENTICALLY
// in FOUR places until SP9a-1 retired the duplication: THREE copies in render
// (encode-segment.js, pixels — buildImageItemFilterParts, buildVideoItemFilterParts,
// buildOverlayFilterParts) and one in the editor (transformStyle.ts, CSS %).
// All four now delegate to this shared implementation — encode-segment.js:305
// (image), :375 (video), :546 (overlay), transformStyle.ts:36 (editor).
// `toCssBoxPct`, `toPixelBox` and `toRotatedPixelBox` are its engine-specific
// adapters (the third added by SP9a-2, and it DELEGATES to the second rather
// than duplicating it) — see the src/geometry.js module header for the full
// naming rationale, the
// fit/sourceCrop/rotation decisions, and the (0,0,1,1) preview short-circuit's
// exact legacy location.
//
// SP9b adds `geometryAt(item, kind, localT)` — the ANIMATED sibling. It is the
// one function both engines call to place a keyframed item at an instant, and
// an item with no `keyframes` is handed to `geometryFor` itself, so the static
// path cannot drift from it.
// ---------------------------------------------------------------------------

/** The subset of a timeline item that geometry math reads. */
export interface GeometryItem {
  /** Multiplier on the frame's own size. Default 1. */
  scale?: number
  /** Percent of frame WIDTH. Default 0. */
  offsetX?: number
  /** Percent of frame HEIGHT. Default 0. */
  offsetY?: number
  /** 0-1. Default 1. */
  opacity?: number
  /** Images only; ignored for video (video is always 'contain'). */
  fit?: 'cover' | 'contain' | 'fill'
  /** Sub-rect of the SOURCE, as ratios of the source's own dimensions. Forwarded verbatim. */
  sourceCrop?: { x: number; y: number; w: number; h: number }
  /** Source intrinsic pixel width. Forwarded verbatim. */
  sourceWidth?: number
  /** Source intrinsic pixel height. Forwarded verbatim. */
  sourceHeight?: number
  /**
   * Degrees. Carried by {@link geometryFor}; consumed ONLY by
   * {@link toRotatedPixelBox}. {@link toPixelBox} and {@link toCssBoxPct} stay
   * rotation-blind — see the src/geometry.js module header.
   */
  rotation?: number
  /**
   * Per-property animation (SP9b), at most one track per prop. Read ONLY by
   * {@link geometryAt}; {@link geometryFor} does not know this field exists.
   * Absent — the overwhelmingly common case — means the item is static.
   */
  keyframes?: KeyframeTrack[]
}

/**
 * Frame-relative geometry for one item: percents and ratios, no pixels, no
 * CSS units. {@link toCssBoxPct} and {@link toPixelBox} derive engine-specific
 * numbers from this.
 */
export interface Geometry {
  /** Multiplier on the frame's own size. */
  scale: number
  /** Percent of frame width. */
  offsetX: number
  /** Percent of frame height. */
  offsetY: number
  /** 0-1. */
  opacity: number
  /**
   * `'contain'` ALWAYS for video (never reads `item.fit`); the item's own
   * tri-state (default `'cover'`) for image; `undefined` for overlay and any
   * other kind — a JSX overlay has no fit concept to fabricate.
   */
  fit: 'cover' | 'contain' | 'fill' | undefined
  /** Forwarded verbatim, by reference — never cloned. */
  sourceCrop: { x: number; y: number; w: number; h: number } | undefined
  /** Forwarded verbatim. */
  sourceWidth: number | undefined
  /** Forwarded verbatim. */
  sourceHeight: number | undefined
  /**
   * Degrees, as authored — NOT normalized here (normalization into [0, 360)
   * happens inside {@link toRotatedPixelBox}, which is the one adapter that
   * consumes this field). {@link toPixelBox} MUST NOT consume it: its
   * rotation-blindness is a frozen contract that SP9a-1's four switched-over
   * call sites depend on, and there is a test pinning it.
   */
  rotation: number
}

/**
 * The shared percent-of-frame geometry for one item. Frame-relative and
 * engine-agnostic — see the src/geometry.js module header for the full fit /
 * sourceCrop / rotation decisions.
 */
export declare function geometryFor(item: GeometryItem, kind: ItemKind): Geometry

/**
 * The shared percent-of-frame geometry for one item AT ONE INSTANT — the
 * animated sibling of {@link geometryFor} (SP9b).
 *
 * Keyframed properties have to move identically in the editor preview and in
 * the ffmpeg render, so BOTH engines ask this ONE function for the SAME
 * instant: the preview samples it at the playhead, the render bake samples it
 * per frame, and neither interpolates anything itself. Curve evaluation lives
 * in {@link sampleTrack} and nowhere else — easing math anywhere else is a
 * PARITY BUG.
 *
 * `localT` is ITEM-RELATIVE seconds (0 = the item's own `start`), so an item
 * dragged along the timeline carries its animation with it unchanged. A
 * non-finite `localT` is not an error: it reads as "before the first
 * keyframe".
 *
 * An item with no `keyframes` is handed to {@link geometryFor} ITSELF — the
 * same function, not a copy of its body — so the static path is identical BY
 * CONSTRUCTION and a keyframe-free project keeps producing a byte-identical
 * ffmpeg filter graph. Only the five {@link KeyframeProp} values can be
 * animated; `fit`/`sourceCrop`/`sourceWidth`/`sourceHeight` are forwarded
 * exactly as the static path forwards them (`sourceCrop` by reference, never
 * cloned). The per-prop fallback is `??` and never `||`, so a legitimately
 * animated 0 (opacity 0, offset 0) survives instead of snapping back to the
 * item's static scalar.
 */
export declare function geometryAt(item: GeometryItem, kind: ItemKind, localT: number): Geometry

/**
 * The editor-CSS adapter. Verbatim port of `videoTransformBoxPct`
 * (transformStyle.ts): the frame-relative % rect the item's box occupies.
 */
export declare function toCssBoxPct(
  geometry: Pick<Geometry, 'scale' | 'offsetX' | 'offsetY'>,
): { left: number; top: number; width: number; height: number }

/**
 * The ffmpeg-pixel adapter. Verbatim port of the shared five-line formula in
 * `buildImageItemFilterParts`/`buildVideoItemFilterParts`, including the
 * even-pixel rounding on width/height (`round(vw*s/2)*2`, NOT the same as
 * `round(vw*s)`). Does NOT include the separate `sourceCrop` ffmpeg crop step
 * — see the src/geometry.js module header.
 */
export declare function toPixelBox(
  geometry: Pick<Geometry, 'scale' | 'offsetX' | 'offsetY'>,
  vw: number,
  vh: number,
): { x: number; y: number; width: number; height: number }

/**
 * The rotated placement of one item, in pixels. `scaledW`/`scaledH`/`xPx`/`yPx`
 * are exactly {@link toPixelBox}'s `width`/`height`/`x`/`y`; `outW`/`outH`/`x`/`y`
 * describe the axis-aligned bounding box the rotated content occupies and where
 * that grown box is composited.
 */
export interface RotatedPixelBox {
  /** Unrotated width, even. Straight from {@link toPixelBox}. */
  scaledW: number
  /** Unrotated height, even. Straight from {@link toPixelBox}. */
  scaledH: number
  /** Unrotated left. Straight from {@link toPixelBox}. */
  xPx: number
  /** Unrotated top. Straight from {@link toPixelBox}. */
  yPx: number
  /** Bounding-box width after rotation, even-rounded. */
  outW: number
  /** Bounding-box height after rotation, even-rounded. */
  outH: number
  /** Left of the GROWN box. Exact integer; deliberately NOT even-rounded. */
  x: number
  /** Top of the GROWN box. Exact integer; deliberately NOT even-rounded. */
  y: number
  /**
   * Normalized rotation in [0, 360) DEGREES — not radians, not a filter string.
   * timeline-core owns the numbers; formatting an ffmpeg `rotate=` step is the
   * consumer's job.
   */
  rotationDeg: number
  /**
   * `rotationDeg === 0`, i.e. the grown box IS the unrotated box and no rotate
   * step needs appending.
   */
  isIdentity: boolean
}

/**
 * The rotation-aware sibling of {@link toPixelBox}: the same unrotated numbers
 * (obtained by delegating to it, never by duplicating its math) plus the grown
 * bounding box and the adjusted top-left that keeps the item's CENTRE fixed
 * (`x + outW/2 === xPx + scaledW/2`, exactly).
 *
 * Always returns a full box, never `null`: at rotation 0 / 360 / absent /
 * non-finite the grown box IS the unrotated box and `isIdentity` is true, so a
 * call site can read `.x`/`.y` unconditionally and branch only on whether to
 * append a rotate step. See the src/geometry.js module header for the verified
 * formula, why the grown box is `round`ed and never `ceil`ed, and why `x`/`y`
 * are not even-rounded.
 */
export declare function toRotatedPixelBox(
  geometry: Pick<Geometry, 'scale' | 'offsetX' | 'offsetY'> & { rotation?: number },
  vw: number,
  vh: number,
): RotatedPixelBox

/**
 * Whether `crop` is the default full-frame crop, i.e. "no crop at all" —
 * verbatim port of `sourceCropStyle.ts:35`'s check (which lives INSIDE the
 * CSS-adapter function `sourceCropVideoStyle`, not at its call site). Does
 * NOT also reproduce that file's separate `w <= 0 || h <= 0` invalid-crop
 * guard — a different predicate, out of scope here.
 */
export declare function isFullFrameCrop(
  crop: { x: number; y: number; w: number; h: number } | null | undefined,
): boolean

/**
 * The 1080-short-edge overlay design canvas. Verbatim port of
 * `design-canvas.ts:5-11`, confirmed algebraically identical to
 * `render.js:263-269`'s inline copy.
 */
export declare function designCanvas(
  resolution: readonly [number, number] | null | undefined,
): [number, number]

/** One caption segment, as far as activation is concerned. */
export interface CaptionSegment {
  start?: number
  end?: number
  /**
   * Vertical row. Absent ⇒ lane 0; lanes are dense from 0. Read ONLY as a sort
   * key by {@link activeCaptionSegments} — never as an array index — so no
   * coercion of a hand-edited bad value is needed here.
   */
  lane?: number
}

/** A captions track, as far as activation is concerned. */
export interface CaptionsTrack {
  segments?: ReadonlyArray<CaptionSegment>
}

/**
 * The caption segment active at `currentTime`, after quantizing to the frame
 * grid — exactly `CaptionPreview.tsx:187-194`'s `frame = round(currentTime *
 * fps); t = fps > 0 ? frame / fps : 0; find(s => t >= s.start && t < s.end)`.
 * Half-open (`start <= t < end`). Returns `null` when nothing matches.
 *
 * Paired with {@link activeCaptionSegments} — the two must agree on
 * quantization and on the activation predicate.
 */
export declare function activeCaptionSegment(
  captions: CaptionsTrack | null | undefined,
  currentTime: number,
  fps: number,
): CaptionSegment | null

/**
 * EVERY caption segment active at `currentTime`, ordered by `lane ?? 0`
 * ascending — which IS the z-order, since consumers paint in the returned
 * order and a higher lane therefore paints on top. Stable within a lane, so
 * document order breaks ties. Identical quantization, `fps <= 0` guard and
 * half-open predicate to {@link activeCaptionSegment}; the only difference is
 * that this collects every match instead of the first.
 *
 * Returns a new array of the ORIGINAL segment objects — `[]` when nothing
 * matches. Never mutates or re-orders `captions.segments`.
 *
 * Generic in the segment type (unlike the singular, whose signature predates
 * this and is left alone): consumers hold a much richer segment than the
 * `start`/`end`/`lane` this function reads, and they need `id`, `text`,
 * `words` and the rest back out. `T` carries their own type through.
 */
export declare function activeCaptionSegments<T extends CaptionSegment>(
  captions: { segments?: ReadonlyArray<T> } | null | undefined,
  currentTime: number,
  fps: number,
): T[]

/** A `project.audio.tracks[]` entry, as far as window/gain math is concerned. */
export interface AudioTrack {
  /** Timeline start, seconds. */
  start?: number
  /** Timeline end, seconds. */
  end?: number
  /** Source-time the track starts playing from, seconds. */
  inPoint?: number
  /** Fade-in duration, seconds. */
  fadeIn?: number
  /** Fade-out duration, seconds. */
  fadeOut?: number
  /** Base volume multiplier (1 = unity; >1 amplifies). */
  volume?: number
}

export interface AudioWindow {
  /** Whether timeline time `t` falls inside this track's playable window (derived-outPoint rule). */
  active: boolean
  /** Position inside the track's OWN source file, seconds. Meaningful only when `active`. */
  trackTime: number
  /** `baseVolume * max(0, fadeMul)` — the fade envelope times base volume. Computed unconditionally. */
  gain: number
}

/**
 * Whether `track` is audible at timeline time `t`, where inside its own
 * source file that lands, and at what gain. Pure port of the arithmetic slice
 * of `useVideoPlayback.ts:435-484` (`syncAudioTracks`) — the derived-outPoint
 * rule and the fade-in/fade-out envelope. See src/audio.js's module header
 * for the verbatim original and the render-side (`mix-audio.js`) divergence
 * this documents.
 */
export declare function audioWindow(track: AudioTrack, t: number): AudioWindow

// ---------------------------------------------------------------------------
// SP9b-T0.1 — keyframe curves (src/curves.js)
//
// THE single source of truth for easing. Keyframed properties have to animate
// identically in the editor preview and in the ffmpeg render, so curve
// evaluation lives here and ONLY here: any easing math that appears in the
// preview, the render shim or encode-segment.js is a parity bug. The named
// presets are the CSS ones by name and by control points, but the numbers are
// always produced by this package's own deterministic solver — never by a
// browser on one side and a solver on the other.
//
// Three conventions are load-bearing and each is silent-bug territory if read
// backwards; see the src/curves.js module header for the long form:
//   1. a keyframe's `t` is ITEM-RELATIVE seconds (0 = the item's own `start`),
//      never timeline seconds;
//   2. `easing` is OUTGOING — it shapes the segment LEAVING its keyframe, so
//      the last keyframe's `easing` is never read;
//   3. `hold` is step-END — it holds keyframe i's value for the whole segment
//      and jumps at keyframe i+1's own `t`.
// ---------------------------------------------------------------------------

/**
 * The supported easing names. The five bezier ones are the CSS keywords by
 * name AND by control points (`ease` = (0.25, 0.1, 0.25, 1), `ease-in` =
 * (0.42, 0, 1, 1), `ease-out` = (0, 0, 0.58, 1), `ease-in-out` =
 * (0.42, 0, 0.58, 1)); `hold` is the step function CSS spells `steps(1, end)`
 * and has no bezier form. An unrecognized name is never an error — it falls
 * back to `'linear'`, because a hand-edited project must still render.
 */
export type EasingName = 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold'

/**
 * The item properties that can be keyframed — deliberately the five
 * {@link geometryFor} already understands. A track naming anything else is
 * simply never consulted.
 */
export type KeyframeProp = 'offsetX' | 'offsetY' | 'scale' | 'rotation' | 'opacity'

/** One keyframe. */
export interface Keyframe {
  /**
   * Seconds from the ITEM's own `start` — item-relative, NEVER timeline time,
   * so moving an item on the timeline carries its animation with it unchanged.
   */
  t: number
  /**
   * The property's value at `t`, in the property's own units (percent of frame
   * for offsets, a multiplier for scale, degrees for rotation, 0-1 for
   * opacity). This package never interprets them.
   */
  value: number
  /**
   * How the segment LEAVING this keyframe is shaped — OUTGOING, not incoming.
   * Absent (and unrecognized) means `'linear'`. Ignored on the last keyframe,
   * which has no outgoing segment.
   */
  easing?: EasingName
}

/**
 * One animated property's keyframes. `points` MUST be ascending by `t` with
 * no duplicate `t`: {@link sampleTrack} assumes it and deliberately does not
 * re-sort (it is a per-frame path and must not allocate).
 * {@link normalizeTrack} is how the editor establishes that invariant at
 * write time.
 */
export interface KeyframeTrack {
  /** Which property these keyframes drive. */
  prop: KeyframeProp
  /** Ascending by `t`, no duplicate `t`. */
  points: Keyframe[]
}

/**
 * Every supported easing, in picker order. Frozen — the UI reads it, it never
 * edits it.
 */
export declare const EASING_NAMES: ReadonlyArray<EasingName>

/**
 * The eased progress along one segment: given linear progress `p` in [0, 1],
 * how far the VALUE has travelled. Every easing decision in Montaj funnels
 * through this one function.
 *
 * Total by design: `p` is clamped to [0, 1] (a non-finite `p` reads as 0) and
 * an unrecognized `easing` falls back to `'linear'` rather than throwing.
 * Both anchors are EXACT for every easing — `p === 0` returns 0 and `p === 1`
 * returns 1 with no solver round-trip — and `'linear'` is short-circuited
 * entirely, returning `p` bit-for-bit. `'hold'` returns 0 for all `p < 1` and
 * 1 only at `p === 1` (step-END).
 *
 * Deterministic: a hand-rolled Newton-Raphson-with-bisection solver (the
 * classic WebKit `UnitBezier`), no lookup tables, no memoization, no globals.
 */
export declare function easeProgress(easing: EasingName | undefined, p: number): number

/**
 * The value of one keyframed property at item-relative time `localT`, or the
 * `undefined` SENTINEL when there is nothing to sample — `track` is
 * null/undefined, has no `points` array, has an empty one, or every point in
 * it is malformed. It is `undefined` and NOT 0 precisely so callers can fall
 * back to the static scalar:
 *
 *     const scale = sampleTrack(track, t - item.start) ?? item.scale ?? 1
 *
 * 0 is an ordinary keyframe value (opacity 0, offset 0), so the sentinel has
 * to sit outside the number line.
 *
 * Rules: `localT` at or before the first keyframe clamps to that keyframe's
 * value and at or after the last clamps to that one's (no extrapolation,
 * ever); a single keyframe is a constant; AT a keyframe's own `t` the value
 * reads back exactly, for every easing including `hold`; a non-finite
 * `localT` reads as "before the first keyframe"; malformed points are skipped
 * rather than thrown on; and two keyframes sharing a `t` do not divide by
 * zero — the later one wins, matching {@link normalizeTrack}.
 *
 * `points` is ASSUMED ascending. Allocates nothing: this runs per animated
 * prop, per item, per frame.
 */
export declare function sampleTrack(
  track: KeyframeTrack | Keyframe[] | null | undefined,
  localT: number,
): number | undefined

/**
 * The WRITE-time normalizer: a NEW track whose `points` satisfy the invariant
 * {@link sampleTrack} assumes — ascending by `t`, at most one keyframe per
 * `t`, nothing malformed. The editor calls it whenever keyframes are added,
 * dragged or pasted, so the read path never has to sort.
 *
 * De-duplication is LAST WINS in AUTHORING order (the sort is stable, so a key
 * added later at an existing `t` replaces the one already there). Points with
 * a non-finite `t` or `value` are dropped. Pure: the input track and its array
 * are never mutated or re-ordered, and surviving keyframe objects are carried
 * across BY REFERENCE, not cloned — the same forwarding posture
 * {@link geometryFor} takes with `sourceCrop`.
 */
export declare function normalizeTrack(track: KeyframeTrack | null | undefined): KeyframeTrack | undefined
