// @ts-check
// montaj_assets/timeline-core/index.js
//
// Public API barrel for @bycrux/timeline-core: the single pure resolver for
// "what is on screen at time T", shared by Montaj's consumers:
//   - the editor preview (useVideoPlayback / PreviewPlayer / OverlayItemsLayer)
//   - the render engine (segment-plan.js / render.js)
//   - sample-frame.js (diagnostic frame sampling)
//   - (out of band, not an importer of this package) Python's caption_job.py,
//     kept in agreement via the shared fixture corpus instead
//
// The first six `export * from './src/...'` lines below landed in T4; the
// seventh (curves) landed in SP9b-T0.1.

// T2 — source-window math: sourceWindow, playbackSrcFor, seekTime,
// synthesizedOutPoint (absorbs useVideoPlayback.ts:29-88 and render.js:605-632).
export * from './src/source-window.js'

// T3 — activation + boundaries: resolveAt, resolveSegment, planBoundaries and
// the flat primitives T7 delegates to — frameGrid, boundariesFrom,
// coversSegment, containsTime, activeIn, captionsLast, byTrackIdx
// (absorbs segment-plan.js:29-133, PreviewPlayer.tsx:117,
// OverlayItemsLayer.tsx:412, sample-frame.js:538).
export * from './src/activation.js'

// T3 — the two project-duration functions, which legitimately disagree:
// visualDuration (render semantics, audio EXCLUDED) and projectEnd (editor
// semantics, audio INCLUDED). Registry: KNOWN-DIVERGENCES.md (T5),
// "audio-duration mismatch".
export * from './src/durations.js'

// T4 — geometry: geometryFor (the shared percent-of-frame primitive) and
// SP9b's geometryAt (its animated sibling: the same geometry AT an instant,
// and the ONE function both engines call to place a keyframed item),
// toCssBoxPct / toPixelBox (its two engine-specific adapters), isFullFrameCrop
// (the (0,0,1,1) preview short-circuit predicate), designCanvas (the
// 1080-short-edge overlay design canvas rule) (absorbs:
// transformStyle.ts, encode-segment.js:245/305/457, sourceCropStyle.ts:35,
// design-canvas.ts:5-11).
export * from './src/geometry.js'

// T4 — captions: activeCaptionSegment, frame-quantized (absorbs
// CaptionPreview.tsx:187-194), and its plural sibling activeCaptionSegments
// (every active segment, lane-ascending) for multi-row captions.
export * from './src/captions.js'

// T4 — audio: audioWindow, derived-outPoint rule + fade envelope (absorbs the
// pure arithmetic slice of useVideoPlayback.ts:435-484).
export * from './src/audio.js'

// SP9b-T0.1 — keyframe curves: sampleTrack (the per-frame read path),
// normalizeTrack (the editor's write-time normalizer), easeProgress (the
// bezier/step solver) and EASING_NAMES. THE single source of truth for easing:
// any curve math in the preview, the render shim or encode-segment.js is a
// parity bug — see the src/curves.js module header.
export * from './src/curves.js'

// SP9d-T2 — curve → ffmpeg expression: compileTrackExpr (and the diagnostic
// compileTrackExprInfo the render path warns from). Emits a piecewise-LINEAR
// approximation sampled through curves.js's own sampleTrack rather than a
// second implementation of the easing maths — see the src/expr.js header for
// why translating the beziers into ffmpeg's expression language was rejected.
export * from './src/expr.js'

// SP9d-T3 — crossfade math: transitionPairs, transitionProgress, fadeShape.
// THE single definition of "what a crossfade is", shared by the editor's
// derived keyframes, the resolver's `crossfade` stamp and the segment
// encoder's `blend` expression — see the src/transitions.js header.
export * from './src/transitions.js'

/**
 * Version salt for resolver-derived caches. sample-frame.js mixes this into its
 * cache key so a change in resolver semantics invalidates stale cached frames
 * instead of silently reusing them.
 *
 * MUST be bumped on ANY semantic change to this package — different src
 * selection, rebase, activation, ordering or geometry output for the same
 * input. Forgetting is silent and invisible: `sample_frame` keeps serving
 * frames computed by the OLD logic from its on-disk cache, so the tool reports
 * stale output while the code looks correct. A pure refactor, comment change
 * or new function with no effect on existing outputs does not need a bump.
 * @type {string}
 */
export const RESOLVER_VERSION = '3'
