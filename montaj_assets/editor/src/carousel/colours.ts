import type { CarouselElement, Slide } from '../types'
import { isLocked } from './lock'
import { isTextOverlay } from './textStyle'

// The colour panel's data rules (§587 M5): which colours a carousel uses, and
// the project-wide replace. Pure, so one mutation can apply them.

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** `value` as lowercase `#rrggbb` or `#rrggbbaa` (a `#rgb` is expanded; a missing `#` is added), or null when it is no hex colour. */
export function normalizeHex(value: string): string | null {
  const v = value.trim()
  const m = HEX.exec(v.startsWith('#') ? v : `#${v}`)
  if (!m) return null
  const digits = m[1].toLowerCase()
  return `#${digits.length === 3 ? digits.split('').map((c) => c + c).join('') : digits}`
}

/** A normalised hex split into its opaque `#rrggbb` and its alpha (1 when it has none). */
export function splitAlpha(hex: string): { base: string; alpha: number } {
  const h = normalizeHex(hex) ?? '#000000'
  if (h.length !== 9) return { base: h, alpha: 1 }
  return { base: h.slice(0, 7), alpha: parseInt(h.slice(7), 16) / 255 }
}

/** `base` (`#rrggbb`) at `alpha` (0 to 1): 8-digit hex, or plain 6-digit when opaque. */
export function withAlphaHex(base: string, alpha: number): string {
  const b = splitAlpha(base).base
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
  return a >= 255 ? b : `${b}${a.toString(16).padStart(2, '0')}`
}

function overlayColourEntries(el: CarouselElement): Array<[string, string]> {
  if (el.type !== 'overlay') return []
  const out: Array<[string, string]> = []
  for (const [k, v] of Object.entries(el.overlay.props)) {
    if (typeof v !== 'string') continue
    const n = normalizeHex(v)
    if (n && v.trim().startsWith('#')) out.push([k, n])
  }
  return out
}

/** The distinct colours the carousel uses (overlay hex props, slide backgrounds), most used first, at most `max`. */
export function collectColours(slides: Slide[], max = 16): string[] {
  const counts = new Map<string, number>()
  const bump = (c: string) => counts.set(c, (counts.get(c) ?? 0) + 1)
  for (const slide of slides) {
    const bg = slide.base_color ? normalizeHex(slide.base_color) : null
    if (bg) bump(bg)
    for (const el of slide.elements) for (const [, c] of overlayColourEntries(el)) bump(c)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([c]) => c)
}

/**
 * `slides` with every use of `from` replaced by `to`: overlay props and slide
 * backgrounds. Locked elements are skipped (a lock protects content). The same
 * array comes back when nothing used `from`.
 */
export function replaceColour(slides: Slide[], from: string, to: string): Slide[] {
  const f = normalizeHex(from)
  if (!f) return slides
  let changed = false
  const opaque = splitAlpha(to).base
  const next = slides.map((slide): Slide => {
    let s = slide
    if (slide.base_color && normalizeHex(slide.base_color) === f) s = { ...s, base_color: opaque }
    let elements = slide.elements
    const mapped = slide.elements.map((el): CarouselElement => {
      if (el.type !== 'overlay' || isLocked(el)) return el
      const hits = overlayColourEntries(el).filter(([, c]) => c === f)
      if (hits.length === 0) return el
      const props = { ...el.overlay.props }
      // Only a text element's own colours take transparency; elsewhere the colour stays opaque.
      const keepsAlpha = isTextOverlay(el)
      for (const [k] of hits) props[k] = keepsAlpha && (k === 'color' || k === 'bgColor') ? to : opaque
      return { ...el, overlay: { ...el.overlay, props } }
    })
    if (mapped.some((el, i) => el !== slide.elements[i])) elements = mapped
    if (elements !== slide.elements) s = { ...s, elements }
    if (s !== slide) changed = true
    return s
  })
  return changed ? next : slides
}

/** `slides` with one overlay prop set; the same array back when the element is missing, locked or already holds it. */
export function setOverlayPropIn(slides: Slide[], slideId: string, elementId: string, key: string, value: string): Slide[] {
  let changed = false
  const next = slides.map((slide): Slide => {
    if (slide.id !== slideId) return slide
    const elements = slide.elements.map((el): CarouselElement => {
      if (el.id !== elementId || el.type !== 'overlay' || isLocked(el) || el.overlay.props[key] === value) return el
      changed = true
      return { ...el, overlay: { ...el.overlay, props: { ...el.overlay.props, [key]: value } } }
    })
    return changed ? { ...slide, elements } : slide
  })
  return changed ? next : slides
}

// ── The element toolbar's swatch and the panel's sections (§587 R9) ─────────

/** The panel's default solid colours: a fixed grid, seven across. Neutrals, then hues. */
export const DEFAULT_SOLIDS: readonly string[] = [
  '#000000', '#404040', '#737373', '#a3a3a3', '#d4d4d4', '#f5f5f5', '#ffffff',
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981',
  '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7',
  '#d946ef', '#ec4899', '#f43f5e', '#7f1d1d', '#78350f', '#14532d', '#1e3a8a',
]

/** What the search field holds as a colour: a CSS colour name, or a hex (with or without `#`). Null when neither. */
export function resolveColourQuery(query: string, named: (name: string) => string | null): string | null {
  const q = query.trim()
  if (!q) return null
  return named(q) ?? normalizeHex(q)
}

/** The element colour the toolbar swatch shows and edits. */
export interface ElementColourTarget {
  /** The overlay prop. */
  key: string
  /** The colour panel's title. */
  label: string
  /** Whether the prop takes an 8-digit hex. */
  alpha: boolean
  /** The colour now, as a hex. */
  value: string
}

/** The kind of a shipped shape template, from its path (`…/shape-rect/shape-rect.jsx`). */
export function shapeKind(template: string): 'shape' | 'line' | 'frame' | null {
  const base = (template.split('/').pop() ?? '').replace(/\.[jt]sx?$/, '')
  const m = /^(shape|line|frame)-/.exec(base)
  return m ? (m[1] as 'shape' | 'line' | 'frame') : null
}

/** A prop value that draws a colour: a hex that is not fully transparent. */
function drawnHex(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const n = normalizeHex(v)
  if (!n) return null
  return n.length === 9 && n.endsWith('00') ? null : n
}

/**
 * The colour the toolbar swatch stands for: a text element's text colour; a
 * shape's fill (its stroke when the fill draws nothing); a line's or a frame's
 * stroke. Null for anything else (an image, a graphic).
 */
export function elementColourTarget(el: CarouselElement): ElementColourTarget | null {
  if (el.type !== 'overlay') return null
  const props = el.overlay.props
  const kind = shapeKind(el.overlay.template)
  if (isTextOverlay(el)) return { key: 'color', label: 'Text color', alpha: true, value: normalizeHex(String(props.color ?? '')) ?? '#111111' }
  if (!kind) return null
  const stroke = { key: 'stroke', label: 'Stroke color', alpha: false, value: drawnHex(props.stroke) ?? '#111111' }
  if (kind !== 'shape') return stroke
  const fill = drawnHex(props.fill)
  if (fill) return { key: 'fill', label: 'Fill color', alpha: false, value: fill }
  return 'stroke' in props ? stroke : { key: 'fill', label: 'Fill color', alpha: false, value: '#bdbdbd' }
}

/** The element's own colours (its hex props), distinct, in prop order. */
export function elementColours(el: CarouselElement): string[] {
  return [...new Set(overlayColourEntries(el).map(([, c]) => c))]
}
