/**
 * callout-speech-rect.jsx: a rectangular speech bubble with round corners, its tail at the bottom.
 *
 * A carousel element (Elements panel, §587). No animation. An SVG that fills
 * the element box (inset:0); its viewBox is the box, so sizes are slide px.
 *
 * Props:
 *   fill        — fill colour (default '#bdbdbd')
 *   stroke      — stroke colour (default '#111111')
 *   strokeWidth — px, 0 for none (default '0'); drawn inside the box
 *   cornerRadius — px, the outer edge's radius (default '40')
 *   tail        — which side of the bottom the tail leaves from: 'left' | 'right' (default 'left')
 *   strokeStyle — 'solid' | 'long-dash' | 'short-dash' | 'dotted' (default 'solid')
 *   roundJoins  — rounded corners (default false)
 */
// Values arrive as strings (the prop editor's round trip); parseFloat takes "8" and "8px".
const num = (v, d) => {
  const n = parseFloat(String(v))
  return Number.isFinite(n) ? n : d
}
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
// The element box in slide px: slide.jsx (the export) and the editor's canvas
// both pass it, so the viewBox is the box and a stroke width is in px.
const side = (v) => {
  const n = num(v, 100)
  return n > 0 ? n : 100
}
const r2 = (n) => Math.round(n * 100) / 100
// The stroke's style (§587): its dashes scale with the width, so a style
// keeps its look at any weight, and dots are round. A round cap adds half the
// width to each end of a dash, which the pattern takes back from the dash.
const DASHES = { 'long-dash': [3, 2], 'short-dash': [1.5, 1] }
const isOn = (v) => v === true || v === 'true'
function dashOf(style, sw, round) {
  if (!(sw > 0)) return undefined
  if (String(style) === 'dotted') return `0 ${r2(2 * sw)}`
  const p = DASHES[String(style)]
  if (!p) return undefined
  const [d, g] = [p[0] * sw, p[1] * sw]
  return round ? `${r2(Math.max(0, d - sw))} ${r2(g + sw)}` : `${r2(d)} ${r2(g)}`
}
// The stroke's dashes, ends and corners: rounded corners round the dash ends too.
const strokeLook = (style, sw, round) => ({
  strokeDasharray: dashOf(style, sw, round),
  strokeLinecap: round || String(style) === 'dotted' ? 'round' : 'butt',
  strokeLinejoin: round ? 'round' : 'miter',
})
const SVG_STYLE = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', display: 'block', overflow: 'visible' }

// A rounded rectangle over the top of the box with a pointer down to `tip`
// on the bottom edge, leaving the bottom between `b1` and `b2` (x, slide px).
function pointerBox(W, H, sw, radius, bodyH, b1, b2, tipX) {
  const p = sw / 2
  const x0 = p
  const x1 = W - p
  const y0 = p
  const yb = bodyH - p
  const r = clamp(radius - p, 0, Math.max(0, Math.min((x1 - x0) / 2, (yb - y0) / 2)))
  const hi = clamp(Math.max(b1, b2), x0 + r, x1 - r)
  const lo = clamp(Math.min(b1, b2), x0 + r, hi)
  return [
    `M ${r2(x0 + r)} ${r2(y0)} H ${r2(x1 - r)}`,
    `A ${r2(r)} ${r2(r)} 0 0 1 ${r2(x1)} ${r2(y0 + r)} V ${r2(yb - r)}`,
    `A ${r2(r)} ${r2(r)} 0 0 1 ${r2(x1 - r)} ${r2(yb)} H ${r2(hi)}`,
    `L ${r2(tipX)} ${r2(H - p)} L ${r2(lo)} ${r2(yb)} H ${r2(x0 + r)}`,
    `A ${r2(r)} ${r2(r)} 0 0 1 ${r2(x0)} ${r2(yb - r)} V ${r2(y0 + r)}`,
    `A ${r2(r)} ${r2(r)} 0 0 1 ${r2(x0 + r)} ${r2(y0)} Z`,
  ].join(' ')
}

export default function CalloutSpeechRect({ fill = '#bdbdbd', stroke = '#111111', strokeWidth = '0', cornerRadius = '40', tail = 'left', strokeStyle = 'solid', roundJoins = false, boxWidth, boxHeight }) {
  const W = side(boxWidth)
  const H = side(boxHeight)
  const sw = clamp(num(strokeWidth, 0), 0, Math.min(W, H) / 2)
  const look = strokeLook(strokeStyle, sw, isOn(roundJoins))
  const paint = { fill, stroke: sw > 0 ? stroke : 'none', strokeWidth: sw }
  const right = String(tail) === 'right'
  const [b1, b2, tipX] = right ? [W * 0.62, W * 0.82, W * 0.88] : [W * 0.18, W * 0.38, W * 0.12]
  const d = pointerBox(W, H, sw, num(cornerRadius, 40), H * 0.8, b1, b2, tipX)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={SVG_STYLE}>
      <path d={d} {...paint} {...look} />
    </svg>
  )
}
