// Pure math helpers for in-canvas image cropping.
//
// Coordinate spaces:
// - "wrapper" px: pixels inside the SlideElement wrapper, which is sized
//   `(element.w * scale, element.h * scale)` and rotated as a whole.
// - "rendered source" px: pixels inside the letterboxed source image's
//   rendered rectangle (which sits inside the wrapper at `(offsetX, offsetY)`).
// - "source fraction": 0–1 fractions of the source's natural dimensions —
//   exactly the storage format on `ImageElement.crop`.

export type RenderedRect = {
  offsetX: number
  offsetY: number
  width: number
  height: number
}

export function renderedSourceRect(args: {
  wrapperW: number
  wrapperH: number
  srcWidth: number
  srcHeight: number
}): RenderedRect {
  const { wrapperW, wrapperH, srcWidth, srcHeight } = args
  const wrapperAspect = wrapperW / wrapperH
  const srcAspect = srcWidth / srcHeight

  if (srcAspect >= wrapperAspect) {
    const width = wrapperW
    const height = wrapperW / srcAspect
    return { offsetX: 0, offsetY: (wrapperH - height) / 2, width, height }
  }
  const height = wrapperH
  const width = wrapperH * srcAspect
  return { offsetX: (wrapperW - width) / 2, offsetY: 0, width, height }
}

export type CropFraction = { x: number; y: number; w: number; h: number }
export type WrapperPxRect = { x: number; y: number; w: number; h: number }

export function fractionToWrapperPx(args: {
  crop: CropFraction
  rendered: RenderedRect
}): WrapperPxRect {
  const { crop, rendered } = args
  return {
    x: rendered.offsetX + crop.x * rendered.width,
    y: rendered.offsetY + crop.y * rendered.height,
    w: crop.w * rendered.width,
    h: crop.h * rendered.height,
  }
}

export function wrapperPxToFraction(args: {
  px: WrapperPxRect
  rendered: RenderedRect
}): CropFraction {
  const { px, rendered } = args
  return {
    x: (px.x - rendered.offsetX) / rendered.width,
    y: (px.y - rendered.offsetY) / rendered.height,
    w: px.w / rendered.width,
    h: px.h / rendered.height,
  }
}

export type CropHandle = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se'

const MIN_FRACTION = 0.02 // never let the crop shrink below 2% of source on either axis.

// Free-form crop drag. Each handle moves its own edges by the delta; corners
// move two edges, edges move one. Result is min-size enforced and clamped to
// the rendered source bounds. The element box will be resized at commit time
// to match the resulting crop's aspect — see commitAndExitCropMode.
export function applyCropHandleDrag(args: {
  handle: CropHandle
  initialCrop: CropFraction
  deltaPx: { x: number; y: number }
  wrapperW: number
  wrapperH: number
  srcWidth: number
  srcHeight: number
}): CropFraction {
  const { handle, initialCrop, deltaPx, wrapperW, wrapperH, srcWidth, srcHeight } = args
  const rendered = renderedSourceRect({ wrapperW, wrapperH, srcWidth, srcHeight })

  const initialPx = fractionToWrapperPx({ crop: initialCrop, rendered })

  let left = initialPx.x
  let top = initialPx.y
  let right = initialPx.x + initialPx.w
  let bottom = initialPx.y + initialPx.h

  if (handle === 'nw' || handle === 'w' || handle === 'sw') left += deltaPx.x
  if (handle === 'ne' || handle === 'e' || handle === 'se') right += deltaPx.x
  if (handle === 'nw' || handle === 'n' || handle === 'ne') top += deltaPx.y
  if (handle === 'sw' || handle === 's' || handle === 'se') bottom += deltaPx.y

  // Enforce min size, anchored on the side opposite to the dragged edge.
  const minW = MIN_FRACTION * rendered.width
  const minH = MIN_FRACTION * rendered.height
  if (right - left < minW) {
    if (handle === 'nw' || handle === 'w' || handle === 'sw') left = right - minW
    else right = left + minW
  }
  if (bottom - top < minH) {
    if (handle === 'nw' || handle === 'n' || handle === 'ne') top = bottom - minH
    else bottom = top + minH
  }

  // Clamp to source bounds.
  const minLeft = rendered.offsetX
  const minTop = rendered.offsetY
  const maxRight = rendered.offsetX + rendered.width
  const maxBottom = rendered.offsetY + rendered.height
  if (left < minLeft) left = minLeft
  if (top < minTop) top = minTop
  if (right > maxRight) right = maxRight
  if (bottom > maxBottom) bottom = maxBottom

  return wrapperPxToFraction({
    px: { x: left, y: top, w: right - left, h: bottom - top },
    rendered,
  })
}

// Move (pan) the crop window by a pixel delta, keeping its size and clamping so
// it stays fully inside the rendered source rect. Used by the crop modal's
// drag-to-reposition.
export function translateCropPx(args: {
  crop: CropFraction
  deltaPx: { x: number; y: number }
  wrapperW: number
  wrapperH: number
  srcWidth: number
  srcHeight: number
}): CropFraction {
  const { crop, deltaPx, wrapperW, wrapperH, srcWidth, srcHeight } = args
  const rendered = renderedSourceRect({ wrapperW, wrapperH, srcWidth, srcHeight })
  const px = fractionToWrapperPx({ crop, rendered })

  const minLeft = rendered.offsetX
  const minTop = rendered.offsetY
  const maxLeft = rendered.offsetX + rendered.width - px.w
  const maxTop = rendered.offsetY + rendered.height - px.h

  const left = Math.min(maxLeft, Math.max(minLeft, px.x + deltaPx.x))
  const top = Math.min(maxTop, Math.max(minTop, px.y + deltaPx.y))

  return wrapperPxToFraction({ px: { x: left, y: top, w: px.w, h: px.h }, rendered })
}

// Aspect-locked CORNER resize for the crop modal's shape-lock presets. Because
// `renderedSourceRect` scales x and y uniformly, a crop's wrapper-px aspect equals
// its source-pixel aspect — so we can lock the aspect directly in wrapper px. The
// corner opposite the dragged handle stays fixed; the dragged corner follows the
// pointer's dominant axis, and the other dimension is derived from `aspect`. Edge
// handles aren't supported here (the modal hides them when an aspect is locked).
export function aspectLockedCornerResize(args: {
  handle: 'nw' | 'ne' | 'sw' | 'se'
  initialCrop: CropFraction
  deltaPx: { x: number; y: number }
  wrapperW: number
  wrapperH: number
  srcWidth: number
  srcHeight: number
  aspect: number // target pixel aspect w/h
}): CropFraction {
  const { handle, initialCrop, deltaPx, wrapperW, wrapperH, srcWidth, srcHeight, aspect } = args
  const rendered = renderedSourceRect({ wrapperW, wrapperH, srcWidth, srcHeight })
  const px = fractionToWrapperPx({ crop: initialCrop, rendered })

  const isW = handle === 'nw' || handle === 'sw'
  const isN = handle === 'nw' || handle === 'ne'
  // Opposite corner stays fixed.
  const fixedX = isW ? px.x + px.w : px.x
  const fixedY = isN ? px.y + px.h : px.y
  // Dragged corner after the pointer delta.
  const dragX = (isW ? px.x : px.x + px.w) + deltaPx.x

  // Width is driven by the horizontal drag; height derived from the locked aspect.
  const minW = MIN_FRACTION * rendered.width
  let cw = Math.max(minW, Math.abs(dragX - fixedX))
  let ch = cw / aspect

  // Clamp the box to the rendered source bounds, preserving aspect (shrink to fit).
  const dirX = isW ? -1 : 1
  const dirY = isN ? -1 : 1
  const maxW = dirX < 0 ? fixedX - rendered.offsetX : rendered.offsetX + rendered.width - fixedX
  const maxH = dirY < 0 ? fixedY - rendered.offsetY : rendered.offsetY + rendered.height - fixedY
  if (cw > maxW) { cw = maxW; ch = cw / aspect }
  if (ch > maxH) { ch = maxH; cw = ch * aspect }

  const left = dirX < 0 ? fixedX - cw : fixedX
  const top = dirY < 0 ? fixedY - ch : fixedY
  return wrapperPxToFraction({ px: { x: left, y: top, w: cw, h: ch }, rendered })
}

// Compute a centered crop with a fixed OUTPUT aspect (width/height in *pixels*,
// e.g. 9/16) at a given zoom. `zoom` >= 1: 1 is the largest crop with that aspect
// that fits the source; higher zooms shrink the crop (magnifying the output).
// `center` (source fractions) is preserved where possible, then clamped so the
// crop stays inside [0, 1]. Used by the crop modal's preset + zoom controls.
export function cropForAspect(args: {
  aspect: number
  zoom: number
  srcWidth: number
  srcHeight: number
  center?: { x: number; y: number }
}): CropFraction {
  const { aspect, srcWidth, srcHeight } = args
  const srcAspect = srcWidth / srcHeight

  // Largest crop fractions whose pixel aspect (w·srcW)/(h·srcH) equals `aspect`.
  let w: number
  let h: number
  if (aspect >= srcAspect) {
    // Crop is wider than the source → full source width, letterbox vertically.
    w = 1
    h = srcAspect / aspect
  } else {
    // Crop is taller than the source → full source height, pillarbox horizontally.
    h = 1
    w = aspect / srcAspect
  }

  const z = Math.max(1, args.zoom)
  w = Math.min(1, w / z)
  h = Math.min(1, h / z)

  const cx = args.center?.x ?? 0.5
  const cy = args.center?.y ?? 0.5
  const x = Math.min(1 - w, Math.max(0, cx - w / 2))
  const y = Math.min(1 - h, Math.max(0, cy - h / 2))
  return { x, y, w, h }
}

// The smallest zoom (>= 1) that keeps a crop of the given aspect at or above the
// 2% min-fraction floor on both axes — i.e. the max useful zoom for the slider.
export function maxZoomForAspect(args: {
  aspect: number
  srcWidth: number
  srcHeight: number
}): number {
  const base = cropForAspect({ ...args, zoom: 1 })
  // base.w / z >= MIN_FRACTION  →  z <= base.w / MIN_FRACTION (same for h)
  const zByW = base.w / MIN_FRACTION
  const zByH = base.h / MIN_FRACTION
  return Math.max(1, Math.min(zByW, zByH))
}
