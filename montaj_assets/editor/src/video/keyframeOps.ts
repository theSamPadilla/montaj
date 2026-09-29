import type { EasingName, Keyframe, KeyframeProp, KeyframeTrack, VisualItem } from '../schema'
import { geometryAt, normalizeTrack } from '@bycrux/timeline-core'

/**
 * keyframeOps — the shared, DOM-free keyframe-mutation surface for SP9b.
 *
 * Every export below is a pure function shaped `(item, ...) => VisualItem`:
 * none of them touch React, the DOM, or the app store. Callers (an overlay
 * inspector panel and a canvas timeline keyframe strip, in later phases) are
 * expected to feed the returned item straight into a `sync.mutate` project
 * update. The input `item`, its `keyframes` array, and its point objects are
 * never mutated — every write returns fresh objects/arrays instead.
 *
 * The invariant this module exists to protect: every `KeyframeTrack` it
 * writes has `points` ascending by `t` with no duplicate `t` — the invariant
 * `@bycrux/timeline-core`'s `sampleTrack` assumes and does not itself enforce
 * (see that package's `src/curves.js` module header). Every mutating export
 * below builds its raw (possibly out-of-order, possibly duplicate-`t`) points
 * array and pipes it through `normalizeTrack` before it is ever installed on
 * the returned item — `withTrack`, at the bottom of the "writing" section, is
 * the single place a track is actually written, so that holds by
 * construction rather than by every export remembering to do it.
 *
 * No easing/interpolation math lives here. Curve evaluation stays in
 * `@bycrux/timeline-core` (`sampleTrack`, `geometryAt`) so the preview and
 * the render bake cannot drift from each other or from this module.
 */

/**
 * THE single gate on which items support keyframing. Every call site that used
 * to spell `item.type === 'overlay'` inline routes through here instead, so
 * the set of keyframeable kinds is defined in exactly one place.
 *
 * VIDEO, IMAGE AND OVERLAY, since SP9d. It was overlay-only for a real render
 * reason, not a UI preference: the ffmpeg composite emitted ONE static box per
 * segment and had no per-frame hook, while overlays escaped that only because
 * they are captured frame-by-frame in a browser. That changed when
 * `encode-segment.js` learned to compile a curve into a time-varying ffmpeg
 * expression (`animatedGeometry`), so a clip's position, scale and rotation now
 * animate in the export exactly as they do in the preview.
 *
 * Keyframeability is now PER PROPERTY PER KIND, though — a clip can animate
 * position but not opacity — so an item-level yes/no is no longer the whole
 * answer. Use {@link canKeyframeProp} wherever a specific property is in hand;
 * this predicate answers only "can ANY property on this item be keyframed".
 *
 * A type predicate, not a plain `boolean`: call sites used to spell
 * `!item || item.type !== 'overlay'`, which narrowed `item`'s nullability
 * through the guard for free. Returning `item is VisualItem` keeps that
 * narrowing available through this one call instead. It is deliberately
 * `VisualItem`, not some overlay-only subtype — `VisualItem` is a monolithic
 * interface with `type` as a plain field rather than a discriminant, so
 * there is no narrower shape to assert; this is the strongest claim TS can
 * check.
 */
export function canKeyframe(item: VisualItem | null | undefined): item is VisualItem {
  return !!item && (item.type === 'overlay' || item.type === 'video' || item.type === 'image')
}

/**
 * Whether ONE property on ONE item can be keyframed.
 *
 * Overlays: everything. Clips (video/image): everything EXCEPT `opacity`.
 *
 * The opacity exclusion is a hard limit of the render, not a scope decision.
 * A clip's transform reaches ffmpeg as a filter expression, and ffmpeg happily
 * evaluates expressions for `overlay`'s x/y, `scale`'s w/h and `rotate`'s
 * angle. Its alpha control does not play along: `colorchannelmixer` declares
 * `aa` as a `<double>`, which accepts a literal number and nothing else — no
 * expression, at any evaluation mode. (The `T` flag ffmpeg prints beside it is
 * `AV_OPT_FLAG_RUNTIME_PARAM`, i.e. settable via `sendcmd`/`zmq`; it is not
 * expression support, and it has been misread as such before.) There is
 * therefore no way to fade a clip through the ffmpeg path at all.
 *
 * Overlays are exempt because they never touch that filter: they are baked
 * frame-by-frame in a browser, where opacity is just another CSS value.
 *
 * Closing this gap needs the per-frame browser bake extended to video — decode
 * every frame of the animated span and composite it the way overlays already
 * are. That was measured at 14-33x the expression path's render time and is
 * explicitly out of scope; see docs/RENDER.md.
 */
export function canKeyframeProp(item: VisualItem | null | undefined, prop: KeyframeProp): boolean {
  if (!canKeyframe(item)) return false
  if (item.type === 'overlay') return true
  return prop !== 'opacity'
}

// ── Reading ──────────────────────────────────────────────────────────────

/** The track for `prop` on `item`, or `undefined` if the item isn't
 *  keyframed on that prop at all. */
export function trackFor(item: VisualItem, prop: KeyframeProp): KeyframeTrack | undefined {
  return item.keyframes?.find(track => track.prop === prop)
}

/**
 * True only when `prop` has a track AND that track has at least one point.
 * An empty track never lingers in a well-formed item (see `withTrack`), but
 * this checks the point count anyway rather than assuming that invariant
 * holds for every possible caller or hand-edited project.json.
 */
export function hasKeyframes(item: VisualItem, prop: KeyframeProp): boolean {
  const track = trackFor(item, prop)
  return !!track && track.points.length > 0
}

/** True when `item` has ANY non-empty keyframe track, on any prop. */
export function isKeyframed(item: VisualItem): boolean {
  return (item.keyframes ?? []).some(track => track.points.length > 0)
}

/**
 * Whether `item` scales UNIFORMLY — i.e. carries no per-axis scale AT ALL,
 * neither a static `scaleX`/`scaleY` scalar nor a keyframe track for either.
 *
 * ABSENCE is the test, deliberately, and not `scaleX === scaleY`: an overlay
 * the operator unlocked on purpose and happens to have left at 120%/120% is
 * authored per-axis, and an equality test would silently re-lock it the moment
 * the two numbers met.
 */
export function isUniformScale(item: VisualItem): boolean {
  return (
    item.scaleX === undefined && item.scaleY === undefined &&
    !hasKeyframes(item, 'scaleX') && !hasKeyframes(item, 'scaleY')
  )
}

/** The two orders {@link transformProps} chooses between. Position first,
 *  scale, then rotation and opacity — the order the inspector header's
 *  all-props actions walk them, kept identical for both shapes. */
const UNIFORM_TRANSFORM_PROPS: readonly KeyframeProp[] = ['offsetX', 'offsetY', 'scale', 'rotation', 'opacity']
const PER_AXIS_TRANSFORM_PROPS: readonly KeyframeProp[] = ['offsetX', 'offsetY', 'scaleX', 'scaleY', 'rotation', 'opacity']

/**
 * The transform props that are AUTHORITATIVE for `item` — the set that any
 * "do this to EVERY transform prop" action must walk, and the whole reason
 * {@link isUniformScale} exists.
 *
 * Never a flat list of all seven, and never one fixed list of five. The scale
 * props form a fallback chain — `sampleTrack(scaleX) ?? item.scaleX ??
 * <the resolved scale>` (see `geometry.js`'s non-uniform section) — so a
 * per-axis value SHADOWS the uniform one, and getting this set wrong breaks a
 * keyframe-everything action in one of two symmetric ways:
 *
 *   - Handing `scaleX`/`scaleY` to a UNIFORM item seeds one-point (i.e.
 *     constant) per-axis tracks. Those immediately shadow the `scale` track,
 *     and the overlay's uniform zoom silently stops happening — nothing on
 *     screen says why, and the damage is invisible until the operator scrubs.
 *   - Handing `scale` to a PER-AXIS item writes a prop that `scaleX`/`scaleY`
 *     already shadow, so the gesture appears to do nothing at all.
 *
 * Both the inspector's header actions and the canvas timeline's
 * double-click-to-key gesture read this, so the rule is defined once. It used
 * to be a hand-maintained constant in each of them; two copies of a rule whose
 * failure mode is a silent frozen animation is exactly the kind of thing that
 * drifts. Do NOT reintroduce a local copy.
 *
 * The result is ALSO filtered by {@link canKeyframeProp}, which is what keeps a
 * clip's un-animatable `opacity` out of every "do this to every transform prop"
 * action. That matters in both directions and both are easy to get wrong:
 * double-clicking a video would otherwise write an opacity track the renderer
 * silently ignores, and the inspector's header diamond — which lights only when
 * EVERY prop in this list is keyed at the playhead — could then never light on a
 * clip at all, because the one prop it waits for can never be keyed.
 */
export function transformProps(item: VisualItem): readonly KeyframeProp[] {
  const base = isUniformScale(item) ? UNIFORM_TRANSFORM_PROPS : PER_AXIS_TRANSFORM_PROPS
  return base.filter(prop => canKeyframeProp(item, prop))
}

/**
 * `prop`'s value at item-relative `localT`: the sampled curve when `prop` is
 * keyframed, else the item's static scalar, else the prop's default. This
 * delegates to {@link geometryAt} — the SAME function the preview and the
 * render bake sample from — rather than re-deriving defaults or calling
 * `sampleTrack` directly, so the defaults (scale 1, offsetX/offsetY/rotation
 * 0, opacity 1) live in exactly one place and cannot drift from what
 * actually gets painted. `item.type` is passed through as the `kind` rather
 * than a hardcoded `'overlay'`: `geometryAt`'s `kind` only selects `fit`,
 * which isn't a keyframeable prop, so every one of the five reads is
 * identical either way — but this way the function never lies about what
 * kind of item it's reading.
 */
export function valueAt(item: VisualItem, prop: KeyframeProp, localT: number): number {
  return geometryAt(item, item.type, localT)[prop]
}

/**
 * Two keyframe times closer than this are the same instant.
 *
 * Exact equality is not enough, because of the inspector's own arrows: they
 * seek to `item.start + t` and the panel reads back `playhead - item.start`,
 * which floating point does not always return as `t` ((0.1 + 0.2) - 0.1 is
 * 0.20000000000000004). Compared exactly, the keyframe the arrow just landed
 * on would read as "not at the playhead": its diamond would show empty, a
 * click would add a near-duplicate beside it, and the previous-arrow would
 * jump to the keyframe the playhead is already on. A microsecond is far below
 * one frame at any frame rate.
 */
export const KEYFRAME_TIME_EPSILON = 1e-6

/**
 * Item-relative time for absolute timeline `time`, clamped to the item's own
 * span `[0, end - start]`.
 *
 * The clamp matters because selecting an item does not move the playhead: a
 * playhead parked outside the item would otherwise hand a keyframe write a
 * negative or over-long `t`, outside the span every other keyframe consumer
 * (draw, hit-test, this module) assumes points stay within. Matches
 * `applyKeyframeMove`'s clamp in pointer-machine.ts. Shared by the inspector
 * and the preview drag commit so the two key at the same instant.
 */
export function localTimeOf(item: VisualItem, time: number): number {
  return Math.min(Math.max(0, time - item.start), Math.max(0, item.end - item.start))
}

/**
 * The `t` of `prop`'s keyframe sitting at `t` (within
 * {@link KEYFRAME_TIME_EPSILON}), or `undefined` when none does. Returns the
 * STORED time, not `t`, so a caller that goes on to update or remove that
 * keyframe addresses the point that actually exists.
 */
export function keyframeTimeAt(item: VisualItem, prop: KeyframeProp, t: number): number | undefined {
  return trackFor(item, prop)?.points.find(p => Math.abs(p.t - t) <= KEYFRAME_TIME_EPSILON)?.t
}

// ── Writing ──────────────────────────────────────────────────────────────

/**
 * Install `track` as the sole track for `prop` on a NEW item, or remove
 * `prop`'s track entirely when `track` is undefined or empty. This is the
 * single place `item.keyframes` is ever written, so the invariants every
 * mutating export below depends on hold by construction:
 *   - removing the last point of a track removes the track;
 *   - removing the last track removes `item.keyframes` itself (`undefined`,
 *     never a lingering `[]` — downstream code treats "no keyframes" as the
 *     static path, and `[]` must behave identically to absent).
 */
function withTrack(item: VisualItem, prop: KeyframeProp, track: KeyframeTrack | undefined): VisualItem {
  const existing = item.keyframes ?? []
  const idx = existing.findIndex(t => t.prop === prop)

  if (!track || track.points.length === 0) {
    if (idx < 0) return item // prop already had no track — no-op
    const others = existing.filter(t => t.prop !== prop)
    if (others.length === 0) {
      const next = { ...item }
      delete next.keyframes
      return next
    }
    return { ...item, keyframes: others }
  }

  const next = idx < 0 ? [...existing, track] : existing.map((t, i) => (i === idx ? track : t))
  return { ...item, keyframes: next }
}

/** Write `value` into `prop`'s own static scalar field on a new item. Used by
 *  `disableKeyframing`, once keyframing is turned off, and by `writeProp` for a
 *  prop that is not animated. An exhaustive
 *  switch (no `default`) rather than a computed property, so adding a new
 *  `KeyframeProp` without a case here is a compile error, not a silent gap. */
function withStaticValue(item: VisualItem, prop: KeyframeProp, value: number): VisualItem {
  switch (prop) {
    case 'offsetX': return { ...item, offsetX: value }
    case 'offsetY': return { ...item, offsetY: value }
    case 'scale': return { ...item, scale: value }
    case 'scaleX': return { ...item, scaleX: value }
    case 'scaleY': return { ...item, scaleY: value }
    case 'rotation': return { ...item, rotation: value }
    case 'opacity': return { ...item, opacity: value }
  }
}

/**
 * Add or replace the keyframe at `t` on `prop`'s track, creating the track
 * if `item` isn't keyframed on `prop` yet. Replacing an existing point at
 * `t` preserves its `easing` unless a new one is passed. Non-finite `t` or
 * `value` are ignored — `item` is returned unchanged rather than writing a
 * malformed point.
 */
export function setKeyframe(
  item: VisualItem,
  prop: KeyframeProp,
  t: number,
  value: number,
  easing?: EasingName,
): VisualItem {
  if (!Number.isFinite(t) || !Number.isFinite(value)) return item

  const existing = trackFor(item, prop)
  const existingPoint = existing?.points.find(p => p.t === t)
  const resolvedEasing = easing ?? existingPoint?.easing
  const point: Keyframe = resolvedEasing === undefined ? { t, value } : { t, value, easing: resolvedEasing }

  // Appended, not spliced in place: normalizeTrack's stable sort + last-wins
  // de-duplication is what actually resolves a collision at `t`, so the new
  // point only has to be LAST in authoring order among any duplicates.
  const rawPoints = existing ? [...existing.points, point] : [point]
  return withTrack(item, prop, normalizeTrack({ prop, points: rawPoints }))
}

/**
 * Remove the keyframe at `t` on `prop`'s track. Removing the last point
 * removes the whole track; removing the last track removes `item.keyframes`
 * entirely (see `withTrack`).
 */
export function removeKeyframe(item: VisualItem, prop: KeyframeProp, t: number): VisualItem {
  const track = trackFor(item, prop)
  if (!track) return item

  const points = track.points.filter(p => p.t !== t)
  if (points.length === track.points.length) return item // t wasn't present — no-op
  if (points.length === 0) return withTrack(item, prop, undefined)

  return withTrack(item, prop, normalizeTrack({ prop, points }))
}

/**
 * Remove every keyframe sitting at `t`, across all props — the whole diamond
 * the operator sees, since one diamond on the strip is the UNION of every prop
 * keyed at that instant (`keyframeUnionTimes`).
 *
 * Each prop goes through {@link removeKeyframeAt}, which owns the last-point
 * branch: removing a track's ONLY point writes the curve's value into the
 * static scalar so nothing moves. The canvas right-click menu, the timeline's
 * Delete key and every inspector diamond share that one rule; they disagreed
 * before it was shared.
 *
 * Returns the SAME item when no prop has a point at `t`, so callers can use
 * reference equality to skip a no-op commit.
 */
export function removeKeyframesAt(item: VisualItem, t: number): VisualItem {
  if (!Number.isFinite(t)) return item

  const props = (item.keyframes ?? [])
    .filter(track => track.points.some(p => p.t === t))
    .map(track => track.prop)
  if (props.length === 0) return item

  let next = item
  for (const prop of props) next = removeKeyframeAt(next, prop, t)
  return next
}

/**
 * Retime the keyframe at `fromT` to `toT`, preserving its value and easing.
 * If `toT` collides with an existing keyframe, the MOVED one wins: it is
 * appended after the rest of the points before normalizing, and
 * `normalizeTrack`'s last-wins de-duplication (stable sort, so the later
 * authoring-order entry survives a tie at the same `t`) always keeps the
 * moved point in that case. Non-finite `fromT`/`toT` are ignored.
 */
export function moveKeyframe(item: VisualItem, prop: KeyframeProp, fromT: number, toT: number): VisualItem {
  if (!Number.isFinite(fromT) || !Number.isFinite(toT)) return item

  const track = trackFor(item, prop)
  const point = track?.points.find(p => p.t === fromT)
  if (!track || !point) return item

  const moved: Keyframe = { ...point, t: toT }
  const rest = track.points.filter(p => p.t !== fromT)
  return withTrack(item, prop, normalizeTrack({ prop, points: [...rest, moved] }))
}

/** Set the OUTGOING easing (see `Keyframe.easing`'s doc comment) on the
 *  keyframe at `t`. No-op if `prop` has no track or no point at `t`. */
export function setKeyframeEasing(item: VisualItem, prop: KeyframeProp, t: number, easing: EasingName): VisualItem {
  const track = trackFor(item, prop)
  const point = track?.points.find(p => p.t === t)
  if (!track || !point) return item

  const points = track.points.map(p => (p.t === t ? { ...p, easing } : p))
  return withTrack(item, prop, normalizeTrack({ prop, points }))
}

/**
 * Turn keyframing ON for `prop`: seed a single keyframe at `atT` whose value
 * is the item's CURRENT value for that prop (via {@link valueAt}), so
 * switching keyframing on never moves the overlay.
 *
 * NO-OP, by construction, when `prop` already has keyframes
 * (`hasKeyframes(item, prop)`): "turn this on" applied to something already
 * on must never destroy the operator's existing animation. A caller with a
 * genuinely destructive intent — discard the current track and start over —
 * expresses that explicitly as `disableKeyframing` followed by
 * `enableKeyframing`, two calls, not a single one that quietly does both. Do
 * NOT "simplify" this back into an unconditional reset: a diamond-toggle UI,
 * a defensive re-render, or a future "enable all props" action can all call
 * this on an already-keyframed prop, and silently replacing a multi-point
 * curve with one seeded point is invisible data loss until the operator
 * scrubs. Non-finite `atT` is also ignored.
 */
export function enableKeyframing(item: VisualItem, prop: KeyframeProp, atT: number): VisualItem {
  if (!Number.isFinite(atT)) return item
  if (hasKeyframes(item, prop)) return item

  const value = valueAt(item, prop, atT)
  return withTrack(item, prop, normalizeTrack({ prop, points: [{ t: atT, value }] }))
}

/**
 * Turn keyframing OFF for `prop`: remove its track entirely and write the
 * value the curve held at `atT` into the item's static scalar, so the
 * overlay does not jump the instant keyframing is switched off (the
 * CapCut-style behaviour this is modelled on). The value is read via
 * {@link valueAt} BEFORE the track is removed — `valueAt` needs the track
 * still in place to sample it. Non-finite `atT` is ignored.
 */
export function disableKeyframing(item: VisualItem, prop: KeyframeProp, atT: number): VisualItem {
  if (!Number.isFinite(atT)) return item

  const value = valueAt(item, prop, atT)
  return withStaticValue(withTrack(item, prop, undefined), prop, value)
}

// ── Editing at the playhead ──────────────────────────────────────────────
//
// What the inspector and the preview drag do to a property at the playhead.
// Both used to carry their own copy of these rules, and the drag's copy was
// missing: it wrote static scalars that a keyframed property hides.

/**
 * THE auto-keyframe write rule (CapCut-style). A prop that is already animated
 * gets a keyframe at `localT` (updating the one already there, if any), so an
 * edit mid-animation refines the curve instead of detaching from it. A prop
 * that is not animated takes the static scalar.
 *
 * Every edit to a transform value routes through here: the inspector's typed
 * boxes, slider, dial, steppers, align and reset, and every preview gesture
 * commit (via {@link writeGestureProp}). Writing a static scalar onto an
 * animated prop is never right: the keyframes win on every frame and in the
 * export, so the edit would be silently discarded.
 */
export function writeProp(item: VisualItem, prop: KeyframeProp, localT: number, value: number): VisualItem {
  if (!hasKeyframes(item, prop)) return withStaticValue(item, prop, value)
  return setKeyframe(item, prop, keyframeTimeAt(item, prop, localT) ?? localT, value)
}

/**
 * Add a keyframe on `prop` at `t` holding the value it already has there, so
 * nothing moves. Starts an animation on a prop that had none. No-op (the SAME
 * item) when a keyframe already sits at `t`.
 */
export function addKeyframeAt(item: VisualItem, prop: KeyframeProp, t: number): VisualItem {
  if (keyframeTimeAt(item, prop, t) !== undefined) return item
  return setKeyframe(item, prop, t, valueAt(item, prop, t))
}

/**
 * Remove the ONE keyframe on `prop` sitting at `t`. Never the animation.
 *
 * End states, chosen so nothing on screen jumps:
 *   - other keyframes remain: they keep animating, only this point goes;
 *   - ONE keyframe remains: it stays, as a one-point (constant) track. That is
 *     exactly what a first "add" creates, so add and remove are inverses;
 *   - it was the ONLY keyframe: the track goes, and the value it held is
 *     written into the static scalar (via `disableKeyframing`). Plain
 *     `removeKeyframe` would drop the track without that write, and the item
 *     would snap back to whatever stale scalar predates the animation.
 *
 * Returns the SAME item when no keyframe sits at `t`.
 */
export function removeKeyframeAt(item: VisualItem, prop: KeyframeProp, t: number): VisualItem {
  const at = keyframeTimeAt(item, prop, t)
  if (at === undefined) return item
  return (trackFor(item, prop)?.points.length ?? 0) > 1
    ? removeKeyframe(item, prop, at)
    : disableKeyframing(item, prop, at)
}

/** The per-property diamond: remove the keyframe at `t` if one sits there,
 *  else add one holding the current value. */
export function toggleKeyframeAt(item: VisualItem, prop: KeyframeProp, t: number): VisualItem {
  return keyframeTimeAt(item, prop, t) !== undefined
    ? removeKeyframeAt(item, prop, t)
    : addKeyframeAt(item, prop, t)
}

/** Scale props compose by multiplication, so moving a scale animation keeps
 *  its proportions (a 0.5 -> 1 zoom doubled is 1 -> 2, not 1 -> 1.5). */
const MULTIPLICATIVE_PROPS: ReadonlySet<KeyframeProp> = new Set(['scale', 'scaleX', 'scaleY'])

/**
 * Move `prop`'s WHOLE animation so it reads `value` at `localT`: every keyframe
 * shifts by the same amount, so the motion keeps its shape and only its
 * position changes. The Option-drag gesture.
 *
 * Additive for offsets and rotation (every point + `value - current`),
 * multiplicative for scale (every point x `value / current`). A scale that
 * reads 0 at `localT` has no ratio, so it falls back to additive. Easing and
 * times are kept; the static scalar is untouched (the track hides it). Returns
 * the SAME item for a prop with no animation.
 */
export function offsetTrack(item: VisualItem, prop: KeyframeProp, localT: number, value: number): VisualItem {
  const track = trackFor(item, prop)
  if (!track || track.points.length === 0 || !Number.isFinite(localT) || !Number.isFinite(value)) return item

  const current = valueAt(item, prop, localT)
  const ratio = value / current
  const shift = MULTIPLICATIVE_PROPS.has(prop) && current !== 0 && Number.isFinite(ratio)
    ? (v: number) => v * ratio
    : (v: number) => v + (value - current)
  return withTrack(item, prop, normalizeTrack({ prop, points: track.points.map(p => ({ ...p, value: shift(p.value) })) }))
}

/** `deg`, moved by whole turns to the equivalent angle nearest `near`. */
function nearestTurn(deg: number, near: number): number {
  return near + ((((deg - near) % 360) + 540) % 360 - 180)
}

/**
 * How a PREVIEW GESTURE (move, resize, rotate) commits one transform prop.
 *
 *   - Not animated: the static scalar, exactly as before ({@link writeProp}).
 *   - Animated, `'key'` (the default drag): a keyframe at `localT`
 *     ({@link writeProp}), the same rule every inspector control follows.
 *   - Animated, `'shift'` (Option held at release): the whole animation moves
 *     by the drag ({@link offsetTrack}).
 *
 * Two gesture-specific rules on top:
 *   - An animated prop the gesture did not change is left alone. A move
 *     commits both axes and a resize commits the uniform `scale` even when only
 *     one axis moved; keying those unchanged would add keyframes the operator
 *     never made.
 *   - Rotation arrives normalized to [0, 360) (the drag handle's convention),
 *     so on an animated rotation it is first moved to the turn nearest the
 *     curve's current value. Mid-way through a 0 -> 720 spin the curve reads
 *     360; a 10 degree nudge reports 10, and keying a literal 10 would unwind
 *     the spin.
 */
export function writeGestureProp(
  item: VisualItem,
  prop: KeyframeProp,
  localT: number,
  value: number,
  mode: 'key' | 'shift',
): VisualItem {
  if (!hasKeyframes(item, prop)) return writeProp(item, prop, localT, value)

  const current = valueAt(item, prop, localT)
  const target = prop === 'rotation' ? nearestTurn(value, current) : value
  if (target === current) return item
  return mode === 'shift' ? offsetTrack(item, prop, localT, target) : writeProp(item, prop, localT, target)
}
