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

/** Write `value` into `prop`'s own static scalar field on a new item. Used
 *  only by `disableKeyframing`, once keyframing is turned off. An exhaustive
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
 * The last-point branch is the reason this exists rather than callers looping
 * `removeKeyframe`. `removeKeyframe` on a track's ONLY point drops the track
 * without writing the sampled value into the item's static scalar, so the
 * overlay snaps back to whatever stale value was sitting there from before
 * keyframing was switched on. `disableKeyframing` samples the curve FIRST and
 * writes it, so nothing moves. Every removal path must take that branch, or
 * the two disagree — which is exactly what happened between the canvas
 * right-click menu and the properties panel before this helper existed.
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
  for (const prop of props) {
    const points = trackFor(next, prop)?.points ?? []
    next = points.length > 1
      ? removeKeyframe(next, prop, t)
      : disableKeyframing(next, prop, t)
  }
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
