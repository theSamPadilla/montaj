import type { CarouselElement } from '../types'

// The element toolbar's stroke control (§587 round 2, F-F): which shipped
// templates take it, and what their stroke props read as now. Pure.

export type StrokeStyle = 'solid' | 'long-dash' | 'short-dash' | 'dotted'
export const STROKE_STYLES: ReadonlyArray<{ value: StrokeStyle; label: string }> = [
  { value: 'solid', label: 'Solid' },
  { value: 'long-dash', label: 'Long dash' },
  { value: 'short-dash', label: 'Short dash' },
  { value: 'dotted', label: 'Dotted' },
]

/** A template that takes the stroke control, with its sidecar's defaults. */
interface StrokeTemplate {
  /** A line has end points and arrows; a shape or frame has corners. */
  kind: 'line' | 'shape'
  /** The prop that rounds it (`roundCaps` on a line, `roundJoins` where a shape has corners), or null (an ellipse). */
  roundKey: 'roundCaps' | 'roundJoins' | null
  round: boolean
  style: StrokeStyle
  width: number
  arrowhead: string
}

const line = (style: StrokeStyle = 'solid', arrowhead = 'none'): StrokeTemplate => ({ kind: 'line', roundKey: 'roundCaps', round: false, style, width: 8, arrowhead })
const shape = (roundKey: 'roundJoins' | null, round: boolean, width = 0): StrokeTemplate => ({ kind: 'shape', roundKey, round, style: 'solid', width, arrowhead: 'none' })

/** The shipped templates, by name. Their sidecars (`montaj_assets/render/templates/overlays/<name>/<name>.json`) hold the same defaults. */
const TEMPLATES: Record<string, StrokeTemplate> = {
  'line-straight': line(),
  'line-arrow': line('solid', 'end'),
  'line-dashed': line('long-dash'),
  'shape-rect': shape('roundJoins', false),
  'shape-rounded-rect': shape(null, false),
  'shape-ellipse': shape(null, false),
  'shape-triangle': shape('roundJoins', true),
  'shape-star': shape('roundJoins', true),
  'shape-polygon': shape('roundJoins', true),
  'shape-arrow': shape('roundJoins', true),
  'frame-border': shape('roundJoins', false, 12),
  'frame-corners': shape('roundJoins', false, 8),
  'frame-double': shape('roundJoins', false, 4),
}

const templateName = (template: string) => (template.split('/').pop() ?? '').replace(/\.[jt]sx?$/, '')

/** The stroke as the control shows it. */
export interface StrokeState {
  kind: 'line' | 'shape'
  style: StrokeStyle
  roundKey: 'roundCaps' | 'roundJoins' | null
  round: boolean
  width: number
  /** A line's `arrowhead`: none, start, end or both. */
  arrowhead: string
}

const isStyle = (v: unknown): v is StrokeStyle => STROKE_STYLES.some((s) => s.value === v)
const isOn = (v: unknown) => v === true || v === 'true'

/** The stroke of a shipped line, shape or frame; null for anything else. */
export function strokeStateOf(el: CarouselElement | undefined): StrokeState | null {
  if (!el || el.type !== 'overlay') return null
  const t = TEMPLATES[templateName(el.overlay.template)]
  if (!t) return null
  const props = el.overlay.props
  const w = parseFloat(String(props.strokeWidth))
  const round = t.roundKey && t.roundKey in props ? isOn(props[t.roundKey]) : t.round
  return {
    kind: t.kind,
    style: isStyle(props.strokeStyle) ? props.strokeStyle : t.style,
    roundKey: t.roundKey,
    round,
    width: Number.isFinite(w) ? w : t.width,
    arrowhead: typeof props.arrowhead === 'string' ? props.arrowhead : t.arrowhead,
  }
}

/** `arrowhead` with the head at `side` turned on or off. */
export function toggleArrowhead(arrowhead: string, side: 'start' | 'end'): string {
  const start = arrowhead === 'start' || arrowhead === 'both'
  const end = arrowhead === 'end' || arrowhead === 'both'
  const s = side === 'start' ? !start : start
  const e = side === 'end' ? !end : end
  return s && e ? 'both' : s ? 'start' : e ? 'end' : 'none'
}

/** Whether a head is drawn at `side`. */
export const hasArrow = (arrowhead: string, side: 'start' | 'end') => arrowhead === side || arrowhead === 'both'
