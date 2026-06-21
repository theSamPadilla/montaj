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

export interface VideoTransform {
  scale?: number
  offsetX?: number // percent of frame width
  offsetY?: number // percent of frame height
}

// CSS transform for a frame-sized container wrapping the <video>. translate() %
// is relative to the container (= frame), matching the renderer's frame-percent
// offset; scale() is around center, matching the renderer's centered box.
export function videoTransformContainerStyle(t: VideoTransform): CSSProperties {
  const s = t.scale ?? 1
  const ox = t.offsetX ?? 0
  const oy = t.offsetY ?? 0
  if (s === 1 && ox === 0 && oy === 0) return {}
  return { transform: `translate(${ox}%, ${oy}%) scale(${s})`, transformOrigin: 'center center' }
}

// The transform box as a frame-relative % rect (left/top/width/height in %).
// This is the canvas-aspect box the cropped video is contained within; the crop
// handles for the on-canvas transform are drawn on it.
export function videoTransformBoxPct(t: VideoTransform): { left: number; top: number; width: number; height: number } {
  const s = t.scale ?? 1
  const ox = t.offsetX ?? 0
  const oy = t.offsetY ?? 0
  return {
    width: s * 100,
    height: s * 100,
    left: ((1 - s) / 2) * 100 + ox,
    top: ((1 - s) / 2) * 100 + oy,
  }
}
