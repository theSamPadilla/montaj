/**
 * Image geometry shared by the carousel's image edits: reading an image's
 * natural size, and the crop that makes a source fill a box.
 */

/** An image's natural size in pixels (EXIF orientation applied, as the browser
 *  decodes it). */
export interface ImageSize {
  width: number
  height: number
}

/**
 * The natural size of the image at `url`, or null when it cannot be read: the
 * load fails, the image has no size (an SVG with no intrinsic one), or nothing
 * arrives within `timeoutMs`. Never rejects. A timeout stops the download.
 */
export function loadImageNaturalSize(url: string, timeoutMs = 5000): Promise<ImageSize | null> {
  return new Promise((resolve) => {
    const img = new Image()
    // Settles once: a late event after a timeout, or a timer after a load,
    // finds the handlers gone and the timer cleared.
    const settle = (size: ImageSize | null) => {
      clearTimeout(timer)
      img.onload = null
      img.onerror = null
      resolve(size)
    }
    const timer = setTimeout(() => {
      settle(null)
      img.src = ''
    }, timeoutMs)
    img.onload = () => {
      const { naturalWidth: width, naturalHeight: height } = img
      settle(width > 0 && height > 0 ? { width, height } : null)
    }
    img.onerror = () => settle(null)
    img.src = url
  })
}

/** Aspects this close (relative to the box's) count as the same shape. */
const SAME_ASPECT = 0.005

/**
 * The crop, in 0..1 fractions of an `imgW` x `imgH` image, that fills a
 * `boxW` x `boxH` box with no bands: the CENTRED region of the image with the
 * box's aspect. A wider image keeps its full height and the middle of its
 * width; a taller one keeps its full width and the middle of its height. The
 * region has the box's aspect in source pixels, which is the aspect-lock
 * invariant of `ImageElement.crop`.
 *
 * `undefined` when no crop is needed (the aspects match within 0.5%) and when
 * a size is not a positive finite number.
 */
export function coverCrop(
  boxW: number,
  boxH: number,
  imgW: number,
  imgH: number,
): { x: number; y: number; w: number; h: number } | undefined {
  for (const n of [boxW, boxH, imgW, imgH]) {
    if (!Number.isFinite(n) || n <= 0) return undefined
  }
  const box = boxW / boxH
  const img = imgW / imgH
  if (Math.abs(img - box) / box <= SAME_ASPECT) return undefined

  if (img > box) {
    // Wider than the box: all of the height, the middle of the width.
    const w = box / img
    return { x: (1 - w) / 2, y: 0, w, h: 1 }
  }
  // Taller than the box: all of the width, the middle of the height.
  const h = img / box
  return { x: 0, y: (1 - h) / 2, w: 1, h }
}
