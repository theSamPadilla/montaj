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
 * `prop`'s value at item-relative `localT`: the sampled curve when `prop` is
 * keyframed, else the item's static scalar, else the prop's default. This
 * delegates to {@link geometryAt} — the SAME function the preview and the
 * render bake sample from — rather than re-deriving defaults or calling
 * `sampleTrack` directly, so the defaults (scale 1, offsetX/offsetY/rotation
 * 0, opacity 1) live in exactly one place and cannot drift from what
 * actually gets painted. `'overlay'` is the right `kind` for every
 * `KeyframeProp` read: keyframing is overlay-only (see `KeyframeProp`'s doc
 * comment in schema.ts), and `geometryAt`'s `kind` only changes `fit`, which
 * isn't a keyframeable prop.
 */
export function valueAt(item: VisualItem, prop: KeyframeProp, localT: number): number {
  return geometryAt(item, 'overlay', localT)[prop]
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
