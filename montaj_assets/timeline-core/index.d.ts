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
 * `sourceWindow(item, variant).inPoint + max(0, t - item.start)`.
 *
 * @throws {TypeError} if `variant` is not `'preview'` or `'render'`.
 */
export declare function seekTime(item: SourceWindowItem, t: number, variant: Variant): number

/**
 * The out point to use when the item stores none:
 * `outPoint ?? effectiveInPoint + (end - start)`, in the chosen src's
 * coordinates. Takes a variant because the effective in point it builds on is
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
   * quantity `sample-frame.js:556` and `encode-segment.js:299` compute.
   */
  seek: number
  /**
   * The shared percent-of-frame geometry for this item — see {@link geometryFor}.
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
// in render (encode-segment.js:154-159/210-214, pixels) and the editor
// (transformStyle.ts, CSS %). `toCssBoxPct` and `toPixelBox` are its two
// engine-specific adapters — see the src/geometry.js module header for the
// full naming rationale, the fit/sourceCrop/rotation decisions, and the
// (0,0,1,1) preview short-circuit's exact legacy location.
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
  /** Degrees. Carried, never applied by this package — see {@link geometryFor}. */
  rotation?: number
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
   * Degrees. Carried so a future fix has somewhere to read it from.
   * KNOWN DIVERGENCE (KNOWN-DIVERGENCES.md, T5; owner backlog/SP7): render
   * NEVER reads `rotation` anywhere in encode-segment.js — an overlay rotated
   * in the editor exports un-rotated today. {@link toPixelBox} MUST NOT
   * consume this field.
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
 * `render.js:124-130`'s inline copy.
 */
export declare function designCanvas(
  resolution: readonly [number, number] | null | undefined,
): [number, number]

/** One caption segment, as far as activation is concerned. */
export interface CaptionSegment {
  start?: number
  end?: number
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
 */
export declare function activeCaptionSegment(
  captions: CaptionsTrack | null | undefined,
  currentTime: number,
  fps: number,
): CaptionSegment | null

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
