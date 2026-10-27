import type { CarouselBrand, GlobalOverlay, OverlayElement } from '../types'

export type TextPresetId = 'heading' | 'subheading' | 'body'

/** Each preset: its text, size as a share of the slide width, weight and box height as a share of the slide height. */
export const TEXT_PRESETS: Record<TextPresetId, { label: string; text: string; size: number; weight: string; box: number }> = {
  heading: { label: 'Add a heading', text: 'Heading', size: 0.1, weight: '700', box: 0.18 },
  subheading: { label: 'Add a subheading', text: 'Subheading', size: 0.06, weight: '600', box: 0.12 },
  body: { label: 'Add body text', text: 'Body text', size: 0.035, weight: '400', box: 0.1 },
}

/**
 * A new text box for the host's default text overlay `tpl`, centred on the
 * slide, its standard text props seeded from the template's declared defaults.
 * Shared by the "+ Text" button and the T key.
 * With a preset and brand fonts: heading and subheading take the heading font,
 * body the body font, each falling back to the other.
 */
export function newTextElement(tpl: GlobalOverlay, resolution: readonly [number, number], preset?: TextPresetId, fonts?: CarouselBrand['fonts']): OverlayElement {
  const props: Record<string, unknown> = Object.fromEntries(
    tpl.props.filter(p => p.default !== undefined).map(p => [p.name, p.default]),
  )
  if (typeof props.text !== 'string') props.text = 'Your text here'
  const [fullW, fullH] = resolution
  const p = preset ? TEXT_PRESETS[preset] : null
  if (p) {
    props.text = p.text
    props.fontSize = String(Math.round(fullW * p.size))
    props.fontWeight = p.weight
  }
  const family = preset && fonts
    ? (preset === 'body' ? fonts.body ?? fonts.heading : fonts.heading ?? fonts.body)
    : undefined
  if (family) props.fontFamily = family
  const elementW = Math.round(fullW * 0.7)
  const elementH = Math.round(fullH * (p ? p.box : 0.18))
  return {
    id: crypto.randomUUID(),
    type: 'overlay',
    overlay: { template: tpl.jsxPath, props },
    frame: 0,
    x: Math.round(fullW / 2 - elementW / 2),
    y: Math.round(fullH / 2 - elementH / 2),
    w: elementW,
    h: elementH,
    rotation: 0,
    ...(family && fonts?.googleFonts?.length ? { googleFonts: [...fonts.googleFonts] } : {}),
  }
}
