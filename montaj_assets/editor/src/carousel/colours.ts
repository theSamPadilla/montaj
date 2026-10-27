import type { CarouselElement, Slide } from '../types'
import { isLocked } from './lock'

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
  const next = slides.map((slide): Slide => {
    let s = slide
    if (slide.base_color && normalizeHex(slide.base_color) === f) s = { ...s, base_color: to }
    let elements = slide.elements
    const mapped = slide.elements.map((el): CarouselElement => {
      if (el.type !== 'overlay' || isLocked(el)) return el
      const hits = overlayColourEntries(el).filter(([, c]) => c === f)
      if (hits.length === 0) return el
      const props = { ...el.overlay.props }
      for (const [k] of hits) props[k] = to
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
