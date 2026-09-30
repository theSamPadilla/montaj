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
    // The element is the WHOLE source: clip it to the crop sub-rect. The export
    // pads around a contained crop and never shows the source beyond it (PV55 review).
    clipPath: `inset(${Math.max(0, crop.y) * 100}% ${Math.max(0, 1 - crop.x - crop.w) * 100}% ${Math.max(0, 1 - crop.y - crop.h) * 100}% ${Math.max(0, crop.x) * 100}%)`,
  }
}

export interface SourceCropImageInput {
  crop: { x: number; y: number; w: number; h: number }
  /** The image's natural (decoded, EXIF-applied) size; 0 while unknown. */
  sourceWidth: number
  sourceHeight: number
  /** The item's box, any unit: only its aspect is read. */
  boxWidth: number
  boxHeight: number
  fit: 'cover' | 'contain' | 'fill'
}

export interface SourceCropImageStyle {
  /** The crop region fitted into the box, as ratios of the box. It clips. */
  clip: CSSProperties
  /** The whole image, placed so the crop region exactly fills `clip`. */
  img: CSSProperties
  /** False while a cover/contain fit still needs the natural size. */
  ready: boolean
}

/**
 * An IMAGE's `sourceCrop` as CSS (PV55). The export crops the source, then fits
 * the crop into the box by the item's fit (encode-segment.js
 * `buildImageItemFilterParts`). Here: a clip box that IS that fitted crop, and
 * inside it the whole image placed so the crop region fills the clip box. A
 * cover clip box overflows the item's box, whose own overflow-hidden trims it.
 * The same algebra as `sourceCropVideoStyle` above, fit-aware.
 */
export function sourceCropImageStyle(input: SourceCropImageInput): SourceCropImageStyle | null {
  const { crop, sourceWidth, sourceHeight, boxWidth, boxHeight, fit } = input
  if (!crop || !(crop.w > 0) || !(crop.h > 0)) return null
  if (crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1) return null
  const sized = sourceWidth > 0 && sourceHeight > 0 && boxWidth > 0 && boxHeight > 0
  let cw = 1
  let ch = 1
  if (fit !== 'fill' && sized) {
    const cropAspect = (sourceWidth * crop.w) / (sourceHeight * crop.h)
    const boxAspect = boxWidth / boxHeight
    const wider = cropAspect >= boxAspect
    if (fit === 'cover') {
      if (wider) cw = cropAspect / boxAspect
      else ch = boxAspect / cropAspect
    } else if (wider) {
      ch = boxAspect / cropAspect
    } else {
      cw = cropAspect / boxAspect
    }
  }
  const pct = (r: number) => `${r * 100}%`
  return {
    clip: { position: 'absolute', left: pct((1 - cw) / 2), top: pct((1 - ch) / 2), width: pct(cw), height: pct(ch), overflow: 'hidden' },
    img: {
      position: 'absolute', left: pct(-crop.x / crop.w), top: pct(-crop.y / crop.h),
      width: pct(1 / crop.w), height: pct(1 / crop.h), objectFit: 'fill', maxWidth: 'none',
    },
    ready: fit === 'fill' || sized,
  }
}
