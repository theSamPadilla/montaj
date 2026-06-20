// Pure CSS-math for reflecting a clip's `sourceCrop` in the preview <video>.
//
// Render (montaj_assets/render/encode-segment.js:buildVideoItemFilterParts)
// applies sourceCrop as an ffmpeg `crop=cw:ch:cx:cy` BEFORE the
// `scale=...:force_original_aspect_ratio=decrease` + `pad` step — i.e. it crops
// the source to the sub-rect, then CONTAIN-fits that sub-rect into the output
// frame (letterboxing if the sub-rect's aspect differs from the frame).
//
// This helper produces the equivalent CSS for a <video> sitting in an
// overflow-hidden frame box (the player surface, fixed at the output aspect):
// size the video larger than the frame and translate it so only the crop
// sub-rect shows, scaled to contain within the frame. All values are ratios of
// the frame's own dimensions, so the result is frame-pixel-size-independent and
// can be expressed purely in `%`.
//
// Requires the source's intrinsic pixel dims (to know the crop region's aspect
// ratio). Without them — or without a crop — returns null and the caller keeps
// the default `object-contain` full-frame behavior.

import type { CSSProperties } from 'react'

export interface SourceCropInput {
  crop: { x: number; y: number; w: number; h: number }
  sourceWidth: number
  sourceHeight: number
  frameWidth: number
  frameHeight: number
}

export function sourceCropVideoStyle(input: SourceCropInput): CSSProperties | null {
  const { crop, sourceWidth, sourceHeight, frameWidth, frameHeight } = input
  if (!sourceWidth || !sourceHeight || !frameWidth || !frameHeight) return null
  if (!crop || crop.w <= 0 || crop.h <= 0) return null
  // A full-frame crop (the default) needs no special handling.
  if (crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1) return null

  const frameAspect = frameWidth / frameHeight
  const cropAspect = (sourceWidth * crop.w) / (sourceHeight * crop.h)

  // Contain-fit the crop region into the frame → its displayed size as a ratio
  // of the frame's own dimensions.
  let cropWRatio: number
  let cropHRatio: number
  if (cropAspect >= frameAspect) {
    cropWRatio = 1
    cropHRatio = frameAspect / cropAspect
  } else {
    cropHRatio = 1
    cropWRatio = cropAspect / frameAspect
  }

  // The full (uncropped) video's displayed size as a ratio of the frame.
  const videoWRatio = cropWRatio / crop.w
  const videoHRatio = cropHRatio / crop.h

  // Position the video so the crop sub-rect's top-left aligns, then center the
  // contained region within the frame (the letterbox offset).
  const leftRatio = (1 - cropWRatio) / 2 - crop.x * videoWRatio
  const topRatio = (1 - cropHRatio) / 2 - crop.y * videoHRatio

  return {
    position: 'absolute',
    width: `${videoWRatio * 100}%`,
    height: `${videoHRatio * 100}%`,
    left: `${leftRatio * 100}%`,
    top: `${topRatio * 100}%`,
    objectFit: 'fill',
    maxWidth: 'none',
  }
}
