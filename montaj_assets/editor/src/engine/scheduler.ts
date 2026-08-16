/**
 * SP4 T5 — the scheduler: ONE tick, and every transport semantic the editor has.
 *
 * The legacy player (`../video/preview/useVideoPlayback.ts`) runs three clocks —
 * a canvas rAF, a gap rAF, and a per-frame `handleTimeUpdate` pump over a
 * `<video>` element's `currentTime` — plus a double-buffered pair of `<video>`
 * slots and a `loopOffsetRef` threaded through three call sites. All of it
 * exists to answer one question sixty times a second: *what should be on screen
 * and where is the playhead*. This module answers that question once, from a
 * single master clock, and the legacy hook is its specification: every branch
 * below cites the site it reproduces.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SYNCHRONOUS STATE MACHINE
 * ─────────────────────────────────────────────────────────────────────────
 * Everything genuinely asynchronous lives BEHIND an injected interface:
 *
 *   - `SourceHost` — fetch + demux + `createFrameServer` + `createMasterClock`
 *     for one clip. The scheduler never awaits it; it declares which clips it
 *     needs (`retain`) and reads a status (`state`) that is `'loading'` until
 *     the host says otherwise. The host pokes the scheduler with
 *     `sourceChanged(clipId)` when a load lands or fails.
 *   - `Painter` — `drawImage` onto a canvas.
 *   - `MasterClock` — the T4 clock (audio-derived or wall-clock fallback).
 *
 * The only `await` in the whole module is the frame promise a paused seek
 * returns, and it is guarded by a generation counter. Everything else is
 * straight-line synchronous logic over the injected surfaces — which is exactly
 * what makes "play into a gap", "scrub past the end", "loop wrap", "boundary
 * swap", "opaque toggle mid-play" and "decode failure mid-clip" unit-testable
 * with fakes in jsdom, where there is no WebCodecs, no `Worker` and no canvas.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE TWO STATE AXES (and why they are not one enum)
 * ─────────────────────────────────────────────────────────────────────────
 * `transport` (idle → paused ↔ playing → ended) and `picture` (video / black /
 * opaque / preparing) are ORTHOGONAL. You can be paused on a gap, playing under
 * an opaque overlay, or playing through a clip whose proxy is still encoding.
 * Collapsing them into one enum would make the transition table a product
 * rather than a sum, and would hide the single most important invariant this
 * task exists to establish: **the picture state never stops the clock.** A gap,
 * an opaque overlay and a missing/failed proxy all hide the picture while
 * project time keeps advancing — the legacy gap clock's behavior
 * (`useVideoPlayback.ts`'s `tickGap`), generalized.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MAPPING FROM THE LEGACY HOOK (the spec, by content not by line number)
 * ─────────────────────────────────────────────────────────────────────────
 *   gap          `tickGap` + the `idx === -1` branch of the scrub effect + the
 *                `next.start > cur.end + 0.02` branch of `handleTimeUpdate`.
 *                Here: `plan.active === null` ⇒ picture `'black'`, the clock is
 *                a wall-clock fallback, time advances, and the boundary is
 *                simply the tick at which `resolveAt` starts returning the next
 *                clip. No gap-specific clock, no `gapTargetRef`.
 *   loop         the three `loopOffsetRef` sites (scrub-into-loop, wrap-at-
 *                outPoint, stop-at-clip.end). Here: `placeInSource` is the
 *                scrub site's arithmetic made total, and `loopOffset` is
 *                derived (`wraps * loopDur`) rather than accumulated — a
 *                derived offset cannot drift, and a scrub lands identically to
 *                a wrap by construction.
 *   end          `handleTimeUpdate`'s last-clip branch (which hands off to the
 *                gap clock with `gapTargetRef = projectEnd` so trailing
 *                overlays/audio keep playing) + `tickGap`'s no-next-clip tail
 *                (`setIsPlaying(false)`). Here: `transportEndFor` and the
 *                `t >= end` clamp.
 *   opaque       NOT a legacy behavior — the legacy `<video>` path keeps showing
 *                the video under an opaque overlay while render replaces the
 *                picture. The registry disposition (KNOWN-DIVERGENCES, opaque)
 *                is to unify on RENDER semantics now that there is a
 *                compositing stage: skip the paint, keep the audio.
 *   sourceCrop   `../video/preview/sourceCropStyle.ts`, re-expressed as a
 *                `drawImage` source+destination rect. See `sourceCropDrawPlan`.
 *   canvas       `isCanvasProject` — a project with no track-0 video items runs
 *                the whole timeline on the fallback clock with picture
 *                `'black'`; the overlay/caption DOM layers do the drawing.
 */
import {
  projectEnd as timelineProjectEnd,
  resolveAt,
  sourceWindow,
} from '@bycrux/timeline-core'
import type { Scene, SourceWindow } from '@bycrux/timeline-core'
import type { EditorProject as Project, VisualItem } from '../schema'
import type { ClipTimebase, MasterClock } from './audio-clock'
import type { FrameServer } from './frame-server'

// ── Tuning constants ────────────────────────────────────────────────────────

/**
 * How far ahead of a clip boundary the NEXT clip's decode session is built.
 *
 * The plan names 1s ("prewarm next item at boundary−1s (the preload analog)").
 * Worth knowing while tuning it: the legacy hook deliberately abandoned a ~1s
 * lead and preloads the next `<video>` slot for the WHOLE of the current clip
 * instead — its comment records that 1s was "far too short" and stalled
 * playback at cross-source cuts. That lesson was measured against 4K 10-bit
 * HEVC masters with the moov atom at the END of the file (a slow tail range
 * fetch before anything can be indexed). The engine only ever opens SP3's
 * faststart AV1 proxies, which is a different order of magnitude — hence the
 * plan's 1s. It is a dep (`prewarmLeadS`) precisely so the parity checklist can
 * move it without a code change if a real project says otherwise.
 */
export const PREWARM_LEAD_S = 1

/**
 * Tolerance for "the loop window was exhausted at the same instant the clip's
 * project window ended" — see `endsOnLoopBoundary`. Authors set loop spans
 * deliberately (a 2s loop across a 6s clip), so the coincidence is exact
 * arithmetic in practice and this only absorbs float error.
 */
export const LOOP_BOUNDARY_EPS_S = 1e-3

// ── Painting ────────────────────────────────────────────────────────────────

/**
 * One `drawImage(frame, sx, sy, sw, sh, dx, dy, dw, dh)` call, split out so the
 * arithmetic is pure and testable without a canvas.
 *
 * Source coordinates are in the decoded frame's own pixels; destination
 * coordinates are in the canvas backing store's pixels. Neither carries the
 * item's `scale`/`offsetX`/`offsetY`: those stay on the CSS transform container
 * that wraps the canvas, untouched, exactly as they wrap the `<video>` slots
 * today (`PreviewPlayer.tsx`'s `transformContainerStyle`).
 */
export interface DrawPlan {
  sx: number
  sy: number
  sw: number
  sh: number
  dx: number
  dy: number
  dw: number
  dh: number
}

/** The canvas surface, injected so the scheduler can be tested without one. */
export interface Painter {
  /** Backing-store size in pixels. Re-read every paint — the host may resize. */
  size(): { width: number; height: number }
  /** Draw one frame. The scheduler closes the frame immediately after this returns. */
  paint(frame: VideoFrame, plan: DrawPlan): void
  /** Fill the whole surface with black (gap / opaque / preparing). */
  clear(): void
}

/**
 * `object-fit: contain` as a `drawImage` rect — the no-crop default, matching
 * `PreviewPlayer.tsx`'s `baseVideoStyle` (`objectFit: 'contain'`, inset 0).
 */
export function containFitPlan(
  codedWidth: number,
  codedHeight: number,
  frameWidth: number,
  frameHeight: number,
): DrawPlan {
  if (!codedWidth || !codedHeight || !frameWidth || !frameHeight) {
    return { sx: 0, sy: 0, sw: 0, sh: 0, dx: 0, dy: 0, dw: 0, dh: 0 }
  }
  const scale = Math.min(frameWidth / codedWidth, frameHeight / codedHeight)
  const dw = codedWidth * scale
  const dh = codedHeight * scale
  return {
    sx: 0,
    sy: 0,
    sw: codedWidth,
    sh: codedHeight,
    dx: (frameWidth - dw) / 2,
    dy: (frameHeight - dh) / 2,
    dw,
    dh,
  }
}

export interface SourceCropDrawInput {
  crop: { x: number; y: number; w: number; h: number } | undefined
  /** The ITEM's intrinsic source dims. Absent ⇒ no crop; see the guard note below. */
  sourceWidth: number | undefined
  sourceHeight: number | undefined
  /** The DECODED frame's dims — what the source rect is expressed in. */
  codedWidth: number
  codedHeight: number
  frameWidth: number
  frameHeight: number
}

/**
 * `sourceCropStyle.ts`'s algebra, re-expressed as a `drawImage` rect.
 *
 * The CSS version sizes the `<video>` LARGER than its frame box and translates
 * it so only the crop sub-rect is visible; the canvas version draws only the
 * crop sub-rect, into the box that sub-rect would have occupied. They are the
 * same statement:
 *
 *     CSS: video box = (videoWRatio, videoHRatio) at (leftRatio, topRatio),
 *          with videoWRatio = cropWRatio / crop.w and
 *          leftRatio = (1 - cropWRatio)/2 - crop.x * videoWRatio.
 *     The crop sub-rect therefore lands at
 *          leftRatio + crop.x * videoWRatio = (1 - cropWRatio)/2
 *     and spans crop.w * videoWRatio = cropWRatio.
 *
 * …which is exactly `dx`/`dw` below. `__tests__/scheduler-crop.test.ts` asserts
 * that equality against `sourceCropVideoStyle`'s own test vectors rather than
 * trusting this comment.
 *
 * ── The no-dims guard (a parity decision, not an oversight) ──
 * Returns `null` — i.e. NO crop — when the ITEM carries no
 * `sourceWidth`/`sourceHeight`. `sourceCropStyle.ts:32` makes the same call,
 * and so does render (`encode-segment.js`'s `if (sc && item.sourceWidth &&
 * item.sourceHeight)` gate, which drops the `crop=` filter step entirely) —
 * KNOWN-DIVERGENCES entry 8, `sourcecrop-missing-dims-silent-drop`.
 *
 * What is deliberately NOT reproduced is `PreviewPlayer.tsx`'s call-site
 * fallback `activeClip?.sourceWidth ?? videoDims?.w`, which substitutes the
 * loaded `<video>`'s intrinsic dims when the item has none. The decoded frame's
 * `coded` dims are the engine's equivalent of `videoDims` and were available
 * here, so this is a choice: that fallback makes the PREVIEW crop an item render
 * would not crop, which is the divergence entry 8 documents. The plan's
 * disposition is the "parity-safe" guard, so the engine gates on the item.
 */
export function sourceCropDrawPlan(input: SourceCropDrawInput): DrawPlan | null {
  const { crop, sourceWidth, sourceHeight, codedWidth, codedHeight, frameWidth, frameHeight } =
    input
  // sourceCropStyle.ts:32 — all four dims required.
  if (!sourceWidth || !sourceHeight || !frameWidth || !frameHeight) return null
  if (!codedWidth || !codedHeight) return null
  // sourceCropStyle.ts:33 — an inverted or empty crop is not a crop.
  if (!crop || crop.w <= 0 || crop.h <= 0) return null
  // sourceCropStyle.ts:35 — a full-frame crop is the default and needs nothing.
  if (crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1) return null

  const frameAspect = frameWidth / frameHeight
  const cropAspect = (sourceWidth * crop.w) / (sourceHeight * crop.h)

  // Contain-fit the crop region into the frame → its displayed size as a ratio
  // of the frame's own dimensions. Verbatim from sourceCropStyle.ts:44-50.
  let cropWRatio: number
  let cropHRatio: number
  if (cropAspect >= frameAspect) {
    cropWRatio = 1
    cropHRatio = frameAspect / cropAspect
  } else {
    cropHRatio = 1
    cropWRatio = cropAspect / frameAspect
  }

  return {
    // The crop sub-rect inside the DECODED frame. Expressed against the coded
    // dims rather than the item's `sourceWidth`/`sourceHeight` because the
    // proxy is a re-encode at a different resolution — `sourceCrop` is stored
    // as RATIOS of the source precisely so it survives that.
    sx: crop.x * codedWidth,
    sy: crop.y * codedHeight,
    sw: crop.w * codedWidth,
    sh: crop.h * codedHeight,
    dx: ((1 - cropWRatio) / 2) * frameWidth,
    dy: ((1 - cropHRatio) / 2) * frameHeight,
    dw: cropWRatio * frameWidth,
    dh: cropHRatio * frameHeight,
  }
}

/** The crop plan when the item has one, the contain-fit default otherwise. */
export function drawPlanFor(
  item: Pick<VisualItem, 'sourceCrop' | 'sourceWidth' | 'sourceHeight'>,
  codedWidth: number,
  codedHeight: number,
  frameWidth: number,
  frameHeight: number,
): DrawPlan {
  const cropped = sourceCropDrawPlan({
    crop: item.sourceCrop,
    sourceWidth: item.sourceWidth,
    sourceHeight: item.sourceHeight,
    codedWidth,
    codedHeight,
    frameWidth,
    frameHeight,
  })
  return cropped ?? containFitPlan(codedWidth, codedHeight, frameWidth, frameHeight)
}

// ── Source placement (the loop reimplementation) ─────────────────────────────

export interface SourcePlacement {
  /** Position inside the LOADED src, seconds — the `<video>.currentTime` analog. */
  mediaS: number
  /** Whole loop windows elapsed. 0 for a non-looping clip. */
  wraps: number
  /** `wraps * loopDur` — the legacy `loopOffsetRef.current`, derived rather than accumulated. */
  loopOffset: number
  /** Whether loop arithmetic actually applied (`item.loop` AND a usable window). */
  looping: boolean
}

/**
 * Where inside the loaded source project time `t` lands, loop included.
 *
 * This is the legacy scrub site's arithmetic, made total:
 *
 *     if (clip.loop && clipOutPoint != null) {
 *       const loopDur = clipOutPoint - inPoint
 *       const elapsed = currentTime - clip.start
 *       const loops   = Math.floor(elapsed / loopDur)
 *       loopOffsetRef.current = loops * loopDur
 *       video.currentTime = inPoint + (elapsed % loopDur)
 *     } else {
 *       loopOffsetRef.current = 0
 *       video.currentTime = Math.max(inPoint, inPoint + (currentTime - clip.start))
 *     }
 *
 * **`loopOffset` is derived, not accumulated.** The legacy hook keeps a mutable
 * `loopOffsetRef` that the wrap site increments (`loopOffsetRef.current +=
 * loopDur`) and the scrub site recomputes — two writers, one of which can drift
 * if a wrap is missed (a dropped frame, a backgrounded tab). Deriving it from
 * `t` makes a wrap during playback and a scrub into the middle of the same loop
 * land on identical media positions by construction, which is the property the
 * three legacy sites were trying to maintain by hand.
 *
 * `outPoint == null` falls to the non-loop branch exactly as the legacy site's
 * `clipOutPoint != null` guard does; a non-positive `loopDur` does too (the
 * legacy expression would produce `Infinity`/`NaN` there).
 */
export function placeInSource(
  item: Pick<VisualItem, 'start' | 'loop'>,
  window: Pick<SourceWindow, 'inPoint' | 'outPoint'>,
  t: number,
): SourcePlacement {
  const inPoint = window.inPoint
  const elapsed = Math.max(0, t - (item.start ?? 0))
  const outPoint = window.outPoint
  const loopDur = outPoint == null ? 0 : outPoint - inPoint
  if (!item.loop || outPoint == null || loopDur <= 0) {
    return { mediaS: inPoint + elapsed, wraps: 0, loopOffset: 0, looping: false }
  }
  const wraps = Math.floor(elapsed / loopDur)
  return {
    mediaS: inPoint + (elapsed - wraps * loopDur),
    wraps,
    loopOffset: wraps * loopDur,
    looping: true,
  }
}

/**
 * Does a looping clip's project window end exactly ON a loop wrap?
 *
 * This decides which of the legacy hook's two loop-end behaviors applies when
 * project time reaches `clip.end`:
 *
 *   - **On a wrap** — `handleTimeUpdate`'s `video.currentTime >= outPoint`
 *     branch fires first, sees `projectT >= clip.end`, and falls THROUGH to the
 *     ordinary next-clip / end-of-project logic.
 *   - **Mid-loop** (the common case, since `end - start` is rarely an exact
 *     multiple of the loop) — the separate `if (clip.loop && t >= clip.end)`
 *     site fires instead: `video.pause()`, playhead parked at `clip.end`, every
 *     audio element paused, `setIsPlaying(false)`. Playback STOPS; it does not
 *     continue into the next clip.
 *
 * The second behavior looks like a bug and is reproduced anyway: it is what
 * ships, the plan's acceptance asks for loop transport "indistinguishable from
 * legacy", and quietly changing it would be a behavior change smuggled in under
 * a refactor. `KNOWN-DIVERGENCES` is where a decision to drop it belongs.
 */
export function endsOnLoopBoundary(
  item: Pick<VisualItem, 'start' | 'end' | 'loop'>,
  window: Pick<SourceWindow, 'inPoint' | 'outPoint'>,
): boolean {
  if (!item.loop || window.outPoint == null) return false
  const loopDur = window.outPoint - window.inPoint
  if (loopDur <= 0) return false
  const span = (item.end ?? 0) - (item.start ?? 0)
  if (span <= 0) return true
  const remainder = span % loopDur
  return remainder < LOOP_BOUNDARY_EPS_S || loopDur - remainder < LOOP_BOUNDARY_EPS_S
}

// ── Per-tick plan ────────────────────────────────────────────────────────────

/** The track-0 video item on screen at `t`, with everything the tick needs. */
export interface ActiveClip {
  item: VisualItem
  clipId: string
  /** The editing proxy the engine may open, or `''` when this clip is not playable — see {@link engineSrcFor}. */
  src: string
  /** Why `src` is empty. Surfaces as the Preparing placeholder's reason. */
  blocked?: string
  window: SourceWindow
  placement: SourcePlacement
}

/** Everything one tick needs to know about the timeline at `t`. */
export interface TickPlan {
  t: number
  /** The active track-0 video item, or `null` for a gap / canvas project / past the last clip. */
  active: ActiveClip | null
  /** An `opaque` overlay is active — picture suppressed, audio kept (render semantics). */
  opaque: boolean
  /** The next track-0 video item starting after `t` — the prewarm target. */
  next: { item: VisualItem; clipId: string; start: number } | null
  /** No track-0 video items at all — the legacy `isCanvasProject`. */
  canvas: boolean
}

/**
 * Track-0 video items, filtered and start-sorted — the legacy hook's `clips`
 * memo verbatim (`(project.tracks?.[0] ?? []).filter(c => c.type === 'video')
 * .sort((a, b) => a.start - b.start)`).
 */
export function track0VideoItems(project: Project): VisualItem[] {
  return (project.tracks?.[0] ?? [])
    .filter((c) => c.type === 'video')
    .slice()
    .sort((a, b) => a.start - b.start)
}

/**
 * The transport's last instant.
 *
 * Two formulas, because the legacy hook has two and they legitimately differ:
 *
 *   - **Canvas projects** (no track-0 video) run the `isCanvasProject` rAF,
 *     whose ceiling is `canvasMaxEndRef` = `max(overlayEnd, captionEnd)`. Note
 *     what is NOT in it: audio. A canvas project whose music outlasts its
 *     overlays stops at the overlays today.
 *   - **Video projects** use `projectEnd` = `max(videoEnd, overlayEnd,
 *     audioEnd)` — captions excluded, audio included — which timeline-core
 *     already ports verbatim (including its two documented faithfulness warts:
 *     last-clip-by-start rather than max, and track-0-video-only).
 *
 * Unifying them would be a behavior change in one mode or the other, so both
 * are kept and the divergence is named here rather than smoothed over.
 */
export function transportEndFor(project: Project): number {
  const clips = track0VideoItems(project)
  if (clips.length > 0) return timelineProjectEnd(project)
  const overlayEnd = (project.tracks?.slice(1) ?? [])
    .flat()
    .reduce((m, i) => Math.max(m, i?.end ?? 0), 0)
  const captionEnd = (project.captions?.segments ?? []).reduce(
    (m: number, s) => Math.max(m, s.end ?? 0),
    0,
  )
  return Math.max(overlayEnd, captionEnd)
}

/**
 * The one source the engine is allowed to open for a clip — or why it can't.
 *
 * **Proxy-only playback is structural, not a preference** (SP1 requirement 4).
 * `playbackSrcFor(item, 'preview')` answers a broader question than the engine
 * can act on: its chain is `nobg_preview_src > proxySrc > normalizedSrc > src`,
 * and three of those four are things this engine must never hand to its
 * demuxer — the masters are 4K 10-bit HEVC and `nobg_preview_src` is VP9 WebM,
 * while the demuxer is MP4-only in v1 and the decoder is configured for AV1.
 *
 * `eligibility.ts` keeps whole projects containing those out of engine mode in
 * the first place, but eligibility is evaluated once per project-LOAD (plan
 * decision 2, no mid-session mode-flapping), so a clip added or edited
 * afterwards can still present one. That clip alone goes to `preparing`; the
 * project does not fall back. Comparing against the resolved src rather than
 * just reading `item.proxySrc` is what catches the second case: a
 * `nobg_preview_src` appearing mid-session outranks the proxy in the chain, and
 * silently decoding the proxy instead would show a preview with the background
 * the user just removed still in it.
 */
export function engineSrcFor(
  item: Pick<VisualItem, 'proxySrc'>,
  window: Pick<SourceWindow, 'src'>,
): { src: string; blocked?: string } {
  if (!item.proxySrc) return { src: '', blocked: 'no editing proxy yet' }
  if (window.src !== item.proxySrc) {
    return { src: '', blocked: 'a higher-precedence preview source the engine cannot decode' }
  }
  return { src: item.proxySrc }
}

/** Injected resolver — `resolveAt(project, t, {variant:'preview'})` in production. */
export type SceneResolver = (project: Project, t: number) => Scene

/** The production resolver: timeline-core's preview variant, no wrapper semantics. */
export const previewResolver: SceneResolver = (project, t) =>
  resolveAt(project, t, { variant: 'preview' })

/**
 * What the timeline says at `t`. Pure: no clock, no host, no painter.
 *
 * Activation comes from `resolveAt`, so the engine inherits the resolver's
 * half-open `start <= t < end` predicate and its src precedence — the same
 * answers `sample_frame` and (post-adoption) render give. Two details are
 * resolved here rather than in the resolver:
 *
 *  - **Which track-0 video item wins** when two overlap. `resolveAt` returns
 *    them in document order; the legacy hook picks the first in START order.
 *    The earliest-start rule is reproduced so an overlapping pair resolves the
 *    same way it does today.
 *  - **`opaque`** is read off any active OVERLAY item on any track, matching
 *    render's `overlays.some(o => o.opaque)` (`segment-plan.js`). Track-0
 *    videos and images never carry it.
 */
export function planTick(
  project: Project,
  t: number,
  clips: readonly VisualItem[],
  resolver: SceneResolver = previewResolver,
): TickPlan {
  const scene = resolver(project, t)

  let active: ActiveClip | null = null
  let opaque = false
  for (const resolved of scene.items) {
    if (resolved.kind === 'overlay' && resolved.item.opaque === true) opaque = true
    if (resolved.trackIdx !== 0 || resolved.kind !== 'video' || !resolved.window) continue
    // `ResolvedItem.item` is the project's own object by reference (documented
    // in timeline-core's `ResolvedItem`), so this recovers the editor-side
    // fields (`loop`, `volume`, `muted`) the resolver's structural view omits.
    const item = resolved.item as unknown as VisualItem
    if (active && (active.item.start ?? 0) <= (item.start ?? 0)) continue
    const usable = engineSrcFor(item, resolved.window)
    active = {
      item,
      clipId: item.id,
      src: usable.src,
      blocked: usable.blocked,
      window: resolved.window,
      placement: placeInSource(item, resolved.window, t),
    }
  }

  let next: TickPlan['next'] = null
  for (const clip of clips) {
    if (clip.start > t) {
      next = { item: clip, clipId: clip.id, start: clip.start }
      break
    }
  }

  return { t, active, opaque, next, canvas: clips.length === 0 }
}

// ── Injected async surfaces ─────────────────────────────────────────────────

/** One clip's live decode session: a frame server for its src plus its own clock. */
export interface ClipSource {
  clipId: string
  src: string
  frameServer: FrameServer
  clock: MasterClock
  timebase: ClipTimebase
}

export type SourceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; source: ClipSource }
  | { status: 'failed'; reason: string }

/** What the scheduler asks the host to have ready. */
export interface SourceRequest {
  clipId: string
  item: VisualItem
  /** The resolved preview src — the host does not re-derive it. */
  src: string
  /** Project time this clip's clock should be anchored at when it is built. */
  anchorProjectS: number
}

/**
 * The async half of the engine, injected.
 *
 * `retain` is the ONLY lifecycle call, deliberately: the scheduler declares the
 * exact set of clips whose decode sessions must exist right now (the active one
 * plus, inside the prewarm lead, the next one) and the host reconciles. Anything
 * not in the set is disposed — that is the spike's `load` rule
 * (`spikes/playback-engine/src/player.ts`: terminate the worker and spawn a new
 * one, never `reset()` a live decoder and never `configure()` it again) stated
 * as a set difference rather than as a sequence of imperative teardown calls
 * the scheduler could get out of order.
 */
export interface SourceHost {
  /**
   * Reconcile live sessions to exactly `requests`. Idempotent; safe every tick.
   *
   * CONTRACT: never call `Scheduler.sourceChanged` synchronously from inside
   * this method. A session's readiness is an async fact by nature (a fetch, a
   * demux, an `AudioWorklet` module load), and the scheduler reads `state()`
   * immediately after this call within the same tick — a re-entrant notify
   * would land mid-decision. `index.ts`'s host satisfies this by construction:
   * every notify sits behind at least one `await`.
   */
  retain(requests: readonly SourceRequest[]): void
  state(clipId: string): SourceState
  /**
   * A wall-clock `MasterClock` anchored at `startProjectS`, for every stretch
   * with no clip audio to derive time from: gaps, canvas projects, and clips
   * stuck in `preparing`. The scheduler disposes what it is handed.
   */
  fallbackClock(startProjectS: number): MasterClock
}

// ── Status ──────────────────────────────────────────────────────────────────

export type Transport = 'idle' | 'paused' | 'playing' | 'ended'

/**
 * What the canvas shows.
 *  - `video`     — painting decoded frames.
 *  - `black`     — nothing on track 0 (gap, canvas project, past the last clip).
 *                  The legacy `showVideo === false`.
 *  - `opaque`    — an opaque overlay replaces the picture; audio keeps running.
 *  - `preparing` — the active clip has no usable media (proxy still encoding,
 *                  load failed, decode failed). T7 draws "Preparing preview…".
 */
export type Picture = 'video' | 'black' | 'opaque' | 'preparing'

export interface EngineStatus {
  transport: Transport
  picture: Picture
  /** The track-0 clip that owns the picture at the current instant, or `null`. */
  clipId: string | null
  /** Set when `picture === 'preparing'`: why. */
  reason?: string
  /** True between a paused seek and the frame it asked for landing on the canvas. */
  seeking: boolean
  /** Which clock is driving time — for T7's HUD. */
  clock: 'audio' | 'fallback'
}

export interface SchedulerDeps {
  project: Project
  host: SourceHost
  painter?: Painter | null
  resolver?: SceneResolver
  /** Playhead, every tick. T6 bridges this to the editor's `clock.set`. */
  onTime?: (projectS: number) => void
  /** Called only when the status actually changes, never per tick. */
  onStatusChange?: (status: EngineStatus) => void
  onError?: (message: string) => void
  /** Boundary−N seconds. Defaults to {@link PREWARM_LEAD_S}. */
  prewarmLeadS?: number
  /** Where playback starts. Defaults to 0. */
  startProjectS?: number
}

export interface Scheduler {
  /** Bind (or unbind) the canvas. Re-paints the current frame when one is due. */
  attach(painter: Painter | null): void
  play(): void
  pause(): void
  /** External scrub. Continues playing if it was playing (the legacy scrub effect's contract). */
  seek(projectS: number): void
  /** One rAF step. No-op while `idle`; the facade pumps this only while `playing`. */
  tick(): void
  /** Project edits. Does NOT re-evaluate engine eligibility — that policy is T6's. */
  setProject(project: Project): void
  /** The host calls this when a clip's load resolves or fails. */
  sourceChanged(clipId: string): void
  status(): EngineStatus
  /** Current playhead in project seconds. */
  now(): number
  dispose(): void
}

// ── The machine ─────────────────────────────────────────────────────────────

/** What the previous `apply` settled on — the change detector for the next one. */
interface AppliedSnapshot {
  t: number
  clipId: string | null
  status: SourceState['status']
  picture: Picture
  wraps: number
}

class SchedulerImpl implements Scheduler {
  private project: Project
  private readonly host: SourceHost
  private readonly resolver: SceneResolver
  private readonly onTime?: (projectS: number) => void
  private readonly onStatusChange?: (status: EngineStatus) => void
  private readonly onError?: (message: string) => void
  private readonly prewarmLeadS: number

  private painter: Painter | null

  /**
   * Always non-null. Ours to dispose when `clockOwner === null` (a wall-clock
   * fallback we asked the host for); the host's otherwise (it lives and dies
   * with the clip's decode session).
   */
  private clock: MasterClock
  private clockOwner: string | null = null
  /** Identity of the session the clock came from — catches a rebuild under the same clip id. */
  private clockSource: ClipSource | null = null

  private transport: Transport = 'idle'
  private picture: Picture = 'black'
  private pictureReason: string | undefined
  private clipId: string | null = null
  /** The session with a streaming decode-ahead session open, if any. */
  private streamingSource: ClipSource | null = null
  /** Bumped on every seek / boundary / dispose; a resolved seek frame paints only if it still matches. */
  private seekGen = 0
  private pendingSeeks = 0
  /**
   * `clipId@mediaUs` of the frame the canvas holds (or has been asked for)
   * while PAUSED. The dedupe key that keeps a project edit from re-seeking the
   * decoder for a picture that has not moved. `null` whenever the canvas
   * content is unknown — after a clear, during playback, or on a fresh attach.
   */
  private paintedKey: string | null = null
  /** The looping clip the last applied tick was inside — the loop-end stop needs it after it goes inactive. */
  private lastLoopClip: ActiveClip | null = null

  private clips: VisualItem[]
  private transportEnd: number
  private applied: AppliedSnapshot | null = null
  private lastStatusKey = ''
  private disposed = false

  constructor(deps: SchedulerDeps) {
    this.project = deps.project
    this.host = deps.host
    this.resolver = deps.resolver ?? previewResolver
    this.onTime = deps.onTime
    this.onStatusChange = deps.onStatusChange
    this.onError = deps.onError
    this.prewarmLeadS = deps.prewarmLeadS ?? PREWARM_LEAD_S
    this.painter = deps.painter ?? null
    this.clips = track0VideoItems(deps.project)
    this.transportEnd = transportEndFor(deps.project)
    this.clock = this.host.fallbackClock(deps.startProjectS ?? 0)
  }

  // ── public surface ────────────────────────────────────────────────────────

  attach(painter: Painter | null): void {
    this.painter = painter
    // A canvas that just appeared is blank, whatever was on the last one.
    this.paintedKey = null
    if (this.disposed) return
    // Re-establish the current frame. While playing the next tick does it for free.
    if (painter && this.transport !== 'playing') this.apply(this.clock.now(), { force: true })
  }

  play(): void {
    if (this.disposed) return
    const t = this.clock.now()
    // Legacy `togglePlay`, parked at or past the end: the gap branch finds no
    // next clip, falls through its `if (t < projectEnd)` guard and RETURNS —
    // pressing play at the end of a project does nothing at all. Reproduced so
    // the button can't fake a running transport with nowhere to run.
    if (t >= this.transportEnd) {
      this.transport = 'ended'
      this.publish()
      return
    }
    this.transport = 'playing'
    this.clock.play()
    this.apply(t, { force: true })
  }

  pause(): void {
    if (this.disposed) return
    if (this.transport === 'playing') this.transport = 'paused'
    this.clock.pause()
    this.stopStream()
    this.publish()
  }

  seek(projectS: number): void {
    if (this.disposed) return
    const t = Math.max(0, projectS)
    if (t >= this.transportEnd) {
      // Scrubbed past the end. Legacy: the scrub effect's no-next-clip branch
      // pauses the active video and calls `setIsPlaying(false)` — "the picture
      // goes dark but its audio keeps going" is the bug that comment describes,
      // and stopping outright is its fix.
      this.clock.pause()
      this.stopStream()
      this.transport = 'ended'
    } else if (this.transport === 'ended') {
      this.transport = 'paused'
    }
    this.apply(t, { force: true, seeked: true })
  }

  tick(): void {
    if (this.disposed || this.transport === 'idle') return
    const t = this.clock.now()

    if (this.transport === 'playing' && t >= this.transportEnd) {
      // End of project. Legacy arrives here two ways and both land on the same
      // number: the gap clock's `t >= gapTargetRef` tail with `gapTargetRef =
      // projectEnd` (trailing overlays and audio having played out — the
      // "continue advancing time via the gap clock" branch of the last-clip
      // case), and the canvas rAF's `next >= maxEnd` clamp. Both emit the
      // ceiling exactly, then stop.
      this.clock.pause()
      this.clock.seek(this.transportEnd)
      this.transport = 'ended'
      this.apply(this.transportEnd, { force: true })
      return
    }

    this.apply(t, {})
  }

  setProject(project: Project): void {
    if (this.disposed) return
    this.project = project
    this.clips = track0VideoItems(project)
    this.transportEnd = transportEndFor(project)
    // This is how a `preparing` clip resolves: the SSE that delivered
    // `proxySrc` produced a new project object, `retain` reports a different
    // `src` for the same clip id, and the host rebuilds that ONE session. No
    // mode change and no reload — the engine never reverts a running project to
    // the legacy player because one clip's media was late.
    //
    // Engine ELIGIBILITY is deliberately not re-evaluated here (plan decision
    // 2: evaluated once per project-load, no mid-session mode-flapping). That
    // policy, including "initially-ineligible stays legacy for the session",
    // belongs to T6.
    this.apply(this.clock.now(), { force: true })
  }

  sourceChanged(clipId: string): void {
    if (this.disposed) return
    // Only the clip currently on screen can change what is painted; a prewarmed
    // clip landing early changes nothing until its boundary arrives.
    if (clipId !== this.clipId) return
    this.apply(this.clock.now(), { force: true })
  }

  status(): EngineStatus {
    return {
      transport: this.transport,
      picture: this.picture,
      clipId: this.clipId,
      reason: this.pictureReason,
      seeking: this.pendingSeeks > 0,
      clock: this.clock.kind,
    }
  }

  now(): number {
    return this.clock.now()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.seekGen++
    this.stopStream()
    if (this.clockOwner === null) this.clock.dispose()
    this.clockOwner = null
    this.clockSource = null
    this.host.retain([])
    this.painter = null
  }

  // ── the tick ──────────────────────────────────────────────────────────────

  /**
   * The single decision point. Everything above funnels here with a project
   * time and a reason; nothing below it reads a clock.
   *
   * `force` re-runs the side effects (repaint, clear) even when nothing the
   * snapshot tracks moved — used by the four events whose entire point is that
   * something OUTSIDE the snapshot did: `seek`, `setProject`, `attach`,
   * `sourceChanged`. It deliberately does NOT restart a live decode stream;
   * only a genuine discontinuity (`seeked`, a boundary, a loop wrap, a rebuilt
   * session) does that, so a project edit during playback — an overlay drag
   * spreads the project object every frame — cannot stutter the picture.
   */
  private apply(t: number, opts: { force?: boolean; seeked?: boolean }): void {
    if (this.disposed) return
    if (this.transport === 'idle') this.transport = 'paused'

    const plan = planTick(this.project, t, this.clips, this.resolver)
    const nextClipId = plan.active?.clipId ?? null

    // ── 1. Loop-end stop — the legacy hook's THIRD loopOffset site ──────────
    // A looping clip whose project window ends mid-loop stops the transport at
    // `clip.end` rather than advancing to whatever comes next. Detected on the
    // tick that leaves the clip, since `resolveAt` is half-open and simply
    // stops returning it at `end`. See `endsOnLoopBoundary` for the other case.
    const leaving = this.lastLoopClip
    if (
      leaving &&
      this.transport === 'playing' &&
      !opts.seeked &&
      nextClipId !== leaving.clipId &&
      t >= (leaving.item.end ?? 0) &&
      !endsOnLoopBoundary(leaving.item, leaving.window)
    ) {
      const stopAt = leaving.item.end ?? 0
      this.lastLoopClip = null
      this.clock.pause()
      this.clock.seek(stopAt)
      this.transport = 'paused'
      this.apply(stopAt, { force: true })
      return
    }

    // ── 2. Release the outgoing session BEFORE the host can dispose it ──────
    // `retain` below drops everything not in the new set, and a dropped session
    // takes its clock and its worker with it. Anything still pointing at the
    // outgoing session has to let go here, while it is definitely alive.
    if (nextClipId !== this.clipId) {
      this.stopStream()
      if (this.clockOwner !== null) this.clock.pause()
    }

    // ── 3. Declare the live-session set (prewarm lives here) ───────────────
    this.retainFor(plan, t)

    const state: SourceState = plan.active
      ? this.host.state(plan.active.clipId)
      : { status: 'idle' }
    const source = state.status === 'ready' ? state.source : null

    // ── 4. Picture ─────────────────────────────────────────────────────────
    let picture: Picture
    let reason: string | undefined
    if (!plan.active) {
      picture = 'black'
    } else if (!source) {
      // ONE state for three causes — proxy not yet encoded, proxy failed to
      // load, proxy failed to DECODE mid-session. The plan is explicit that
      // they route identically: this clip's range shows the Preparing
      // placeholder while project time keeps advancing (gap semantics), and the
      // engine never hands the whole project back to the legacy player.
      picture = 'preparing'
      reason =
        state.status === 'failed'
          ? state.reason
          : (plan.active.blocked ?? 'preparing preview')
    } else if (plan.opaque) {
      // Registry disposition: `opaque` unifies onto RENDER semantics now that
      // there is a compositing stage. The overlay replaces the picture; the
      // clip's audio — and therefore the clock derived from it — keeps running.
      picture = 'opaque'
    } else {
      picture = 'video'
    }

    // ── 5. Clock ownership ─────────────────────────────────────────────────
    const owner = source ? plan.active!.clipId : null
    const ownerChanged = owner !== this.clockOwner || source !== this.clockSource
    if (ownerChanged) {
      if (this.clockOwner === null) this.clock.dispose()
      const wasPlaying = this.transport === 'playing'
      this.clock = source ? source.clock : this.host.fallbackClock(t)
      this.clockOwner = owner
      this.clockSource = source
      // Anchored at `t`, NOT at the incoming clip's `start`.
      //
      // Legacy snaps (`lastTimeRef.current = next.start; onTimeUpdate(next.start)`)
      // because on that path project time is DERIVED from the freshly loaded
      // <video>'s currentTime, so the playhead had to be told where the cut
      // was. Here project time is primary and media position is derived from
      // it, so there is nothing to snap — and anchoring at `t` removes the
      // ≤1-frame backwards step the snap introduces at every cut.
      this.clock.seek(t)
      if (wasPlaying) this.clock.play()
      this.seekGen++
    } else if (opts.seeked) {
      this.clock.seek(t)
      this.seekGen++
    }

    const clipChanged = nextClipId !== this.clipId
    this.clipId = nextClipId
    const pictureChanged = picture !== this.picture
    this.picture = picture
    this.pictureReason = reason

    // ── 6. Media session ───────────────────────────────────────────────────
    if (source && plan.active) {
      const mediaUs = containerTsUsFor(
        source.frameServer.video.firstPresentationTsUs,
        plan.active.placement.mediaS,
      )
      const wrapped = (this.applied?.wraps ?? 0) !== plan.active.placement.wraps
      // A discontinuity in MEDIA time — the only thing a decode session cares
      // about. `force` is absent on purpose (see the method doc).
      const discontinuity = ownerChanged || clipChanged || wrapped || opts.seeked === true

      if (this.transport === 'playing') {
        if (discontinuity || this.streamingSource !== source) {
          // Loop wrap: the media pointer jumps back to the window start while
          // project time keeps advancing — the legacy wrap site's
          // `video.currentTime = clipInPoint`, expressed as a fresh decode
          // session rather than a seek on a live one (the spike's rule).
          this.stopStream()
          source.frameServer.startStream(mediaUs)
          this.streamingSource = source
          // A wrap resets the PICTURE's media position to the loop window's
          // start while project time keeps climbing; the audio clock's ring
          // must restart at that same media position too, or it keeps
          // decoding from the pre-wrap mapping (`MasterClock.seek`'s `mediaS`
          // param exists exactly for this).
          if (wrapped) source.clock.seek(t, plan.active.placement.mediaS)
        }
        // The stream owns the canvas while playing; whatever a paused seek had
        // put there is long gone.
        this.paintedKey = null
        this.pullFrame(source, plan.active, mediaUs)
      } else {
        this.stopStream()
        // Repaint only when the canvas does not already hold this exact frame.
        // Without this guard every project spread — an overlay drag emits one
        // per pointer event — would fire a fresh decoder seek for a picture
        // that has not moved.
        const key = `${plan.active.clipId}@${Math.round(mediaUs)}`
        if (picture === 'video' && key !== this.paintedKey) {
          this.paintedKey = key
          this.paintFromSeek(source, plan.active, mediaUs)
        }
      }
    } else {
      this.stopStream()
    }

    // ── 7. Surface ─────────────────────────────────────────────────────────
    if (picture !== 'video' && (pictureChanged || opts.force)) {
      this.painter?.clear()
      this.paintedKey = null
    }

    this.lastLoopClip = plan.active?.placement.looping ? plan.active : null
    this.applied = {
      t,
      clipId: nextClipId,
      status: state.status,
      picture,
      wraps: plan.active?.placement.wraps ?? 0,
    }
    this.onTime?.(t)
    this.publish()
  }

  /**
   * Declare the live-session set: the active clip, plus the next one once its
   * boundary is inside the prewarm lead. Everything else the host disposes —
   * terminate-and-respawn stated as a set difference.
   */
  private retainFor(plan: TickPlan, t: number): void {
    const requests: SourceRequest[] = []
    if (plan.active && plan.active.src) {
      requests.push({
        clipId: plan.active.clipId,
        item: plan.active.item,
        src: plan.active.src,
        anchorProjectS: t,
      })
    }
    if (plan.next && plan.next.start - t <= this.prewarmLeadS) {
      // The same proxy-only gate the active clip goes through, over the same
      // timeline-core window the resolver itself computes — never a second,
      // drifting copy of the precedence chain.
      const { src } = engineSrcFor(plan.next.item, sourceWindow(plan.next.item, 'preview'))
      if (src) {
        requests.push({
          clipId: plan.next.clipId,
          item: plan.next.item,
          src,
          anchorProjectS: plan.next.start,
        })
      }
    }
    this.host.retain(requests)
  }

  /** Playback path: paint whatever frame is due at the media clock. */
  private pullFrame(source: ClipSource, active: ActiveClip, mediaUs: number): void {
    const { frame } = source.frameServer.nextFrameFor(mediaUs)
    if (!frame) return
    // Under an opaque overlay the frame is still PULLED, then closed unpainted.
    // Not painting is the point; not pulling would let the decode-ahead buffer
    // fill, stall the pipeline behind it, and leave a stale frame to slam onto
    // the canvas the instant the overlay ends.
    if (this.picture !== 'video' || !this.painter) {
      frame.close()
      return
    }
    this.paintFrame(frame, source, active)
  }

  /** Paused path: one frame-accurate seek, painted when it lands. */
  private paintFromSeek(source: ClipSource, active: ActiveClip, mediaUs: number): void {
    if (!this.painter) return
    const gen = this.seekGen
    this.pendingSeeks++
    const { frame } = source.frameServer.seek(mediaUs)
    void frame.then((f) => {
      this.pendingSeeks--
      if (!f) {
        // Nothing landed on the canvas, so the dedupe key must not claim it did
        // — otherwise a retry (the source rebuilt, the clip re-entered) would be
        // suppressed forever.
        if (gen === this.seekGen) this.paintedKey = null
        this.publish()
        return
      }
      // Superseded by a newer scrub, a boundary or a dispose: the frame is ours
      // to close and must not reach the canvas.
      if (this.disposed || gen !== this.seekGen || !this.painter || this.picture !== 'video') {
        f.close()
        this.publish()
        return
      }
      this.paintFrame(f, source, active)
      this.publish()
    })
  }

  private paintFrame(frame: VideoFrame, source: ClipSource, active: ActiveClip): void {
    const painter = this.painter
    if (!painter) {
      frame.close()
      return
    }
    try {
      const size = painter.size()
      // `drawImage` reads a VideoFrame in its DISPLAY coordinates (pixel aspect
      // applied); the track's `coded` dims are the fallback for a frame that
      // does not report them.
      const w = frame.displayWidth || source.frameServer.video.coded.width
      const h = frame.displayHeight || source.frameServer.video.coded.height
      painter.paint(frame, drawPlanFor(active.item, w, h, size.width, size.height))
    } catch (err) {
      this.onError?.(`paint: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      // The frame-server contract: whoever receives a frame closes it. Holding
      // one past the paint exhausts the decoder's surface pool.
      frame.close()
    }
  }

  private stopStream(): void {
    const source = this.streamingSource
    if (!source) return
    this.streamingSource = null
    source.frameServer.stopStream()
  }

  private publish(): void {
    const status = this.status()
    const key = [
      status.transport,
      status.picture,
      status.clipId,
      status.reason ?? '',
      status.seeking,
      status.clock,
    ].join('|')
    if (key === this.lastStatusKey) return
    this.lastStatusKey = key
    this.onStatusChange?.(status)
  }
}

/**
 * Media position (seconds inside the loaded src) → container µs.
 *
 * The loop-aware counterpart of `audio-clock.ts`'s `mediaTsUsForProjectTime`,
 * which folds the project→media mapping and the track origin together and is
 * therefore only linear for a non-looping clip. `placeInSource` has already
 * done the (possibly wrapped) project→media step, so all that is left here is
 * the track's own t=0 origin.
 *
 * The origin passed in is the VIDEO track's (`frameServer.video
 * .firstPresentationTsUs`), never the clock's — `ClipTimebase
 * .firstPresentationTsUs` is the AUDIO track's origin, and demux is explicit
 * that the two tracks of one file need not share one. Crossing them would
 * offset every painted frame by their difference.
 */
function containerTsUsFor(videoFirstPresentationTsUs: number, mediaS: number): number {
  return videoFirstPresentationTsUs + mediaS * 1_000_000
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  return new SchedulerImpl(deps)
}
