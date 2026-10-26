import type { GlobalOverlay, OverlayElement } from '../types'

/**
 * A new text box for the host's default text overlay `tpl`, centred on the
 * slide, its standard text props seeded from the template's declared defaults.
 * Shared by the "+ Text" button and the T key.
 */
export function newTextElement(tpl: GlobalOverlay, resolution: readonly [number, number]): OverlayElement {
  const props: Record<string, unknown> = Object.fromEntries(
    tpl.props.filter(p => p.default !== undefined).map(p => [p.name, p.default]),
  )
  if (typeof props.text !== 'string') props.text = 'Your text here'
  const [fullW, fullH] = resolution
  const elementW = Math.round(fullW * 0.7)
  const elementH = Math.round(fullH * 0.18)
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
  }
}
