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
