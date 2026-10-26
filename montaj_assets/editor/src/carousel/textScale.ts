import type { CarouselElement, OverlayElement } from '../types'

// A string size this scales: a number with or without `px`.
const PX_SIZE = /^\s*(\d*\.?\d+)\s*(px)?\s*$/i

/**
 * `fontSize` times `ratio`, rounded to half a pixel and in the form it came
 * in, or null when it is not a size this scales. A number stays a number (a
 * template may do arithmetic on it), a unitless string stays unitless
 * (static-text's `'80'`, px implied) and a px length stays px. A relative
 * size (em, rem, %, vw) is left alone.
 */
export function scaleFontSize(fontSize: unknown, ratio: number): string | number | null {
  if (!Number.isFinite(ratio) || ratio <= 0) return null
  const m = typeof fontSize === 'string' ? PX_SIZE.exec(fontSize) : null
  const size = typeof fontSize === 'number' ? fontSize : m ? Number(m[1]) : NaN
  if (!(size > 0) || !Number.isFinite(size)) return null
  const scaled = Math.max(0.5, Math.round(size * ratio * 2) / 2)
  if (typeof fontSize === 'number') return scaled
  return m?.[2] ? `${scaled}px` : String(scaled)
}

/**
 * Whether a corner resize that keeps `element`'s ratio scales its text with
 * the box: an overlay with a font size `scaleFontSize` scales, and Fit to box
 * off (with it on, the fit sizes the text to the new box).
 */
export function scalesTextWithBox(element: CarouselElement): element is OverlayElement {
  if (element.type !== 'overlay') return false
  const props = element.overlay.props
  return String(props.fit) !== 'true' && scaleFontSize(props.fontSize, 1) !== null
}
