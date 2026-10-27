import type { CarouselElement, FontFile, OverlayElement } from '../types'
import { STANDARD_TEXT_PROPS } from '../overlays/contract'
import { isFontFile } from '../lib/font-files'

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
  /** The family's own font files (§587 r3), which travel as `googleFonts` do. */
  fontFiles?: FontFile[]
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
  const style: TextStyle = element.googleFonts ? { props, googleFonts: [...element.googleFonts] } : { props }
  // `fontFiles` comes from the AI as often as from the editor: a malformed entry is left out.
  const files = Array.isArray(element.fontFiles) ? element.fontFiles.filter(isFontFile) : []
  if (files.length) style.fontFiles = files.map((f) => ({ ...f }))
  return style
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
  const styleFiles = Array.isArray(style.fontFiles) ? style.fontFiles.filter(isFontFile) : undefined
  const withFont = 'fontFamily' in style.props && current.fontFamily !== undefined && current.fontFamily !== null
  const fontsDiffer = withFont && (JSON.stringify(element.googleFonts ?? null) !== JSON.stringify(style.googleFonts ?? null)
    || JSON.stringify(element.fontFiles ?? null) !== JSON.stringify(styleFiles?.length ? styleFiles : null))
  if (Object.keys(written).length === 0 && !fontsDiffer) return element
  const next: OverlayElement = { ...element, overlay: { ...element.overlay, props: { ...current, ...written } } }
  if (withFont) {
    if (style.googleFonts) next.googleFonts = [...style.googleFonts]
    else delete next.googleFonts
    if (styleFiles?.length) next.fontFiles = styleFiles.map((f) => ({ ...f }))
    else delete next.fontFiles
  }
  return next
}
