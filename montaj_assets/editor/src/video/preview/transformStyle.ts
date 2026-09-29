// Pure geometry for the base video's on-canvas TRANSFORM (position + zoom),
// distinct from its sourceCrop (which sub-rect of the footage). Mirrors the
// renderer (encode-segment.js buildVideoItemFilterParts): the cropped/contained
// video is fit into a box of size (canvas × scale), centered, then shifted by
// offsetX/offsetY which are percentages of the frame — `overlay=x=vw*(0.5*(1-s)
// + offsetX/100)`. The frame's overflow-hidden clips anything outside.
//
// Both helpers are expressed in frame-relative units so they're pixel-size
// independent: the container transform uses CSS translate %, which is relative to
// the container's own (frame) size, and scale() around center.

import type { CSSProperties } from 'react'
import { geometryFor, toCssBoxPct } from '@bycrux/timeline-core'

export interface VideoTransform {
  /** The legacy UNIFORM knob, and still the fallback for both axes. */
  scale?: number
  /** Multiplier on WIDTH. Absent ⇒ falls back to `scale` (then 1). */
  scaleX?: number
  /** Multiplier on HEIGHT. Absent ⇒ falls back to `scale` (then 1). */
  scaleY?: number
  offsetX?: number // percent of frame width
  offsetY?: number // percent of frame height
}

// CSS transform for a frame-sized container wrapping the <video>. translate() %
// is relative to the container (= frame), matching the renderer's frame-percent
// offset; scale() is around center, matching the renderer's centered box.
//
// The two-argument `scale(sx, sy)` is a strict superset of the old one-argument
// form: a legacy item carrying only `scale` resolves both axes to that same
// number, so it renders the identical box it always did.
export function videoTransformContainerStyle(t: VideoTransform): CSSProperties {
  const sx = t.scaleX ?? t.scale ?? 1
  const sy = t.scaleY ?? t.scale ?? 1
  const ox = t.offsetX ?? 0
  const oy = t.offsetY ?? 0
  // Identity on BOTH axes and no offset — emit nothing rather than an inert
  // CSS transform (which would otherwise create a containing block and a
  // compositing layer for every unmodified clip).
  if (sx === 1 && sy === 1 && ox === 0 && oy === 0) return {}
  return { transform: `translate(${ox}%, ${oy}%) scale(${sx}, ${sy})`, transformOrigin: 'center center' }
}

// The transform box as a frame-relative % rect (left/top/width/height in %).
// This is the canvas-aspect box the cropped video is contained within; the crop
// handles for the on-canvas transform are drawn on it.
//
// Per-axis scale needs no handling here: `geometryFor` resolves scaleX/scaleY
// (falling back to `scale`) and `toCssBoxPct` takes width/left from the X scale
// and height/top from the Y scale, so this inherits the split unchanged.
export function videoTransformBoxPct(t: VideoTransform): { left: number; top: number; width: number; height: number } {
  return toCssBoxPct(geometryFor(t, 'video'))
}

// A scale the export can actually draw a box at.
const drawable = (s: number) => s > 0 && Number.isFinite(s)

// How much wider the item's box is than a frame-aspect box of the same height:
// scaleX / scaleY. Anything fitted into the box fits into a frame this much
// wider — that is all a fit reads from the box, its aspect. Exactly 1 for a
// uniform item (x / x), so the callers' arithmetic is untouched there, and 1 for
// a degenerate scale the export cannot draw either.
export function perAxisRatio(t: VideoTransform): number {
  const sx = t.scaleX ?? t.scale ?? 1
  const sy = t.scaleY ?? t.scale ?? 1
  return drawable(sx) && drawable(sy) ? sx / sy : 1
}

const FULL_MEDIA_BOX: CSSProperties = {
  position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', overflow: 'hidden',
}

// The box an item's MEDIA is fitted into: a child of the frame-sized container
// that carries the item's `scale(sx, sy)` (videoTransformContainerStyle above
// for the base clip, OverlayItemsLayer's wrapper for everything else).
//
// That scale is right for the BOX and wrong for what is fitted INSIDE it. The
// export (encode-segment.js) fits the media straight into the scaled box: an
// image by its cover/contain/fill, a video by crop → contain. Fitting it to the
// FRAME and then scaling by (sx, sy) squashes it whenever sx ≠ sy — a photo in
// a 1032×1210 box on a 1080×1920 canvas came out a third flatter than the
// export. So on a per-axis item this child is laid out at the box's own size
// (sx·100% × sy·100%, centred) and counter-scaled by (1/sx, 1/sy): it lands
// exactly on the box with a net scale of 1, and whatever sits in it (object-fit,
// the sourceCrop style, the engine canvas) is fitted to the box undistorted.
// The counter-scale composes under the parent's rotation too, so a rotated item
// turns its fitted box, as the export's rotate-after-fit does.
//
// On a uniform item it is the plain full box, geometrically inert. It is always
// rendered, never toggled, so a clip switching between uniform and per-axis (a
// cut, an edge drag) keeps its <video>/<canvas> instead of remounting it.
//
// `overflow: hidden` because the box is what the export clips to: a sourceCrop
// style sizes the <video> larger than its box on purpose.
export function mediaBoxStyle(t: VideoTransform): CSSProperties {
  const sx = t.scaleX ?? t.scale ?? 1
  const sy = t.scaleY ?? t.scale ?? 1
  if (sx === sy || !drawable(sx) || !drawable(sy)) return FULL_MEDIA_BOX
  return {
    position: 'absolute',
    left: `${((1 - sx) / 2) * 100}%`,
    top: `${((1 - sy) / 2) * 100}%`,
    width: `${sx * 100}%`,
    height: `${sy * 100}%`,
    transform: `scale(${1 / sx}, ${1 / sy})`,
    transformOrigin: 'center center',
    overflow: 'hidden',
  }
}

// A uniform zoom to `s`. An item that carries scaleX/scaleY gets them scaled by
// the same factor: a scale-only change would do nothing to it, because
// `scaleX ?? scale` keeps the stale per-axis value winning (the trap
// useDragOverlay's commit also avoids). The box grows without changing shape.
export function zoomTo(t: VideoTransform, s: number): VideoTransform {
  const base = t.scale ?? 1
  const f = drawable(base) ? s / base : 1
  return {
    ...t,
    scale: s,
    ...(t.scaleX != null ? { scaleX: t.scaleX * f } : null),
    ...(t.scaleY != null ? { scaleY: t.scaleY * f } : null),
  }
}
