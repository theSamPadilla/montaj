import type { CarouselElement, OverlayElement } from '../types'
import { STANDARD_TEXT_PROPS } from '../overlays/contract'

/** The props a copied text style carries: the standard text props but the text
 *  itself, plus the effect trio the toolbar also writes. */
export const TEXT_STYLE_PROPS: readonly string[] = [
  ...[...STANDARD_TEXT_PROPS].filter((key) => key !== 'text'),
  'effect', 'effectColor', 'effectStrength',
]

/** A text overlay's style, ready to paste. `googleFonts` travels with
 *  `fontFamily`: a family whose file is never fetched renders as the fallback. */
export interface TextStyle {
  props: Record<string, unknown>
  googleFonts?: string[]
}

/** Whether `element` is a text overlay: an overlay with a string `text` prop. */
export function isTextOverlay(element: CarouselElement): element is OverlayElement {
  return element.type === 'overlay' && typeof element.overlay.props.text === 'string'
}

/** The style of a text overlay: each style prop it has, and its `googleFonts`. */
export function pickTextStyle(element: OverlayElement): TextStyle {
  const props: Record<string, unknown> = {}
  for (const key of TEXT_STYLE_PROPS) {
    const value = element.overlay.props[key]
    if (value !== undefined && value !== null) props[key] = value
  }
  return element.googleFonts ? { props, googleFonts: [...element.googleFonts] } : { props }
}

/** `element` wearing `style`. Only the props it already has are written: the
 *  toolbar shows a control for each prop present, so adding one would add a
 *  control that does nothing. Its text is left alone. `googleFonts` follows a
 *  pasted `fontFamily`. The same object comes back when nothing changes. */
export function applyTextStyle(element: OverlayElement, style: TextStyle): OverlayElement {
  const current = element.overlay.props
  const written: Record<string, unknown> = {}
  for (const key of TEXT_STYLE_PROPS) {
    if (key in style.props && current[key] !== undefined && current[key] !== null && current[key] !== style.props[key]) {
      written[key] = style.props[key]
    }
  }
  const withFont = 'fontFamily' in style.props && current.fontFamily !== undefined && current.fontFamily !== null
  const fontsDiffer = withFont && JSON.stringify(element.googleFonts ?? null) !== JSON.stringify(style.googleFonts ?? null)
  if (Object.keys(written).length === 0 && !fontsDiffer) return element
  const next: OverlayElement = { ...element, overlay: { ...element.overlay, props: { ...current, ...written } } }
  if (withFont) {
    if (style.googleFonts) next.googleFonts = [...style.googleFonts]
    else delete next.googleFonts
  }
  return next
}
