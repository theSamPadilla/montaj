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
