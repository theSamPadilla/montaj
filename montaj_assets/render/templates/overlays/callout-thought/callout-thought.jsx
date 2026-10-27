/**
 * callout-thought.jsx: a thought bubble: an ellipse and two small ones trailing below it.
 *
 * A carousel element (Elements panel, §587). No animation. An SVG that fills
 * the element box (inset:0); its viewBox is the box, so sizes are slide px.
 *
 * Props:
 *   fill        — fill colour (default '#bdbdbd')
 *   stroke      — stroke colour (default '#111111')
 *   strokeWidth — px, 0 for none (default '0'); drawn inside the box
 *   tail        — which side of the bottom the tail leaves from: 'left' | 'right' (default 'left')
 *   strokeStyle — 'solid' | 'long-dash' | 'short-dash' | 'dotted' (default 'solid')
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

export default function CalloutThought({ fill = '#bdbdbd', stroke = '#111111', strokeWidth = '0', tail = 'left', strokeStyle = 'solid', boxWidth, boxHeight }) {
  const W = side(boxWidth)
  const H = side(boxHeight)
  const sw = clamp(num(strokeWidth, 0), 0, Math.min(W, H) / 2)
  const look = strokeLook(strokeStyle, sw, false)
  const paint = { fill, stroke: sw > 0 ? stroke : 'none', strokeWidth: sw }
  const p = sw / 2
  const right = String(tail) === 'right'
  const sx = (x) => (right ? W - x : x)
  const loop = (cx, cy, a, b) => `M ${r2(cx - a)} ${r2(cy)} A ${r2(a)} ${r2(b)} 0 1 0 ${r2(cx + a)} ${r2(cy)} A ${r2(a)} ${r2(b)} 0 1 0 ${r2(cx - a)} ${r2(cy)} Z`
  const bodyH = H * 0.74
  const big = loop(W / 2, bodyH / 2, Math.max(0, (W - sw) / 2), Math.max(0, (bodyH - sw) / 2))
  const mid = loop(sx(W * 0.26), H * 0.83, W * 0.075, H * 0.075)
  // The smallest keeps its stroke inside the box.
  const sy = H * 0.94
  const small = loop(sx(W * 0.13), sy, W * 0.045, Math.max(0, Math.min(H * 0.045, H - p - sy)))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={SVG_STYLE}>
      <path d={`${big} ${mid} ${small}`} {...paint} {...look} />
    </svg>
  )
}
