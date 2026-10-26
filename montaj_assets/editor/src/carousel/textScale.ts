import type { CarouselElement, OverlayElement } from '../types'

// A size this scales: a number, or a string of one with or without `px`.
const PX_SIZE = /^\s*(\d*\.?\d+)\s*(px)?\s*$/i

/**
 * `fontSize` times `ratio`, as px rounded to half a pixel, or null when it is
 * not a size this scales: only a number, a unitless string (static-text's
 * `'80'`, px implied) and a px length are. A relative size (em, rem, %, vw)
 * is left alone. Written as `${n}px`, as the font size picker writes it.
 */
export function scaleFontSize(fontSize: unknown, ratio: number): string | null {
  const source = typeof fontSize === 'number' ? String(fontSize) : fontSize
  if (typeof source !== 'string') return null
  const m = PX_SIZE.exec(source)
  if (!m || !Number.isFinite(ratio) || ratio <= 0) return null
  const size = Number(m[1])
  if (!(size > 0)) return null
  return `${Math.max(0.5, Math.round(size * ratio * 2) / 2)}px`
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
