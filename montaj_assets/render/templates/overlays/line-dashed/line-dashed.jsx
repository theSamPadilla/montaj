/**
 * line-dashed.jsx: a dashed line across the box, at mid height.
 *
 * A carousel element (Elements panel, §587). No animation. An SVG that fills
 * the element box (inset:0); its viewBox is the box, so sizes are slide px.
 *
 * Props:
 *   stroke      — line colour (default '#111111')
 *   strokeWidth — px, at most the box height (default '8')
 *   dash        — the long dash's length, px (default '24')
 *   gap         — the long dash's gap, px (default '16')
 *   strokeStyle — 'solid' | 'long-dash' | 'short-dash' | 'dotted' (default 'long-dash')
 *   roundCaps   — rounded end points (default false)
 *   arrowhead   — 'none' | 'end' | 'start' | 'both' (default 'none')
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
  return p ? dashArray(p[0] * sw, p[1] * sw, sw, round) : undefined
}
// A dash and gap as drawn, as a dasharray for butt or round caps.
function dashArray(d, g, sw, round) {
  return round ? `${r2(Math.max(0, d - sw))} ${r2(g + sw)}` : `${r2(d)} ${r2(g)}`
}
const SVG_STYLE = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', display: 'block', overflow: 'visible' }

export default function LineDashed({ stroke = '#111111', strokeWidth = '8', dash = '24', gap = '16', arrowhead = 'none', strokeStyle = 'long-dash', roundCaps = false, boxWidth, boxHeight }) {
  const W = side(boxWidth)
  const H = side(boxHeight)
  const sw = clamp(num(strokeWidth, 8), 0, H)
  const y = H / 2
  const head = String(arrowhead)
  const atEnd = head === 'end' || head === 'both'
  const atStart = head === 'start' || head === 'both'
  // A head is a filled triangle whose tip is the line's end; its half width
  // covers the line and stays inside the box.
  const hw = Math.min(H / 2, Math.max(8, sw * 1.75))
  const hl = Math.min((atEnd && atStart ? W / 2 : W), Math.max(12, sw * 3))
  const round = isOn(roundCaps)
  // Dots and rounded ends are round caps; an end without a head keeps its
  // cap inside the box.
  const cap = round || String(strokeStyle) === 'dotted' ? 'round' : 'butt'
  const inset = cap === 'round' ? sw / 2 : 0
  // The line stops just under each head's base (0.5 px of overlap, no seam).
  const x0 = atStart ? hl - 0.5 : inset
  const x1 = atEnd ? W - hl + 0.5 : W - inset

  // Long dash is this line's own `dash` and `gap`, in px (an element saved
  // before `strokeStyle` has none and draws as it did).
  const d = Math.max(0, num(dash, 24))
  const g = Math.max(0, num(gap, 16))
  const pattern = String(strokeStyle) === 'long-dash'
    ? (d > 0 && g > 0 && sw > 0 ? dashArray(d, g, sw, round) : undefined)
    : dashOf(strokeStyle, sw, round)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={SVG_STYLE}>
      {sw > 0 && x1 > x0 && <line x1={x0} y1={y} x2={x1} y2={y} stroke={stroke} strokeWidth={sw} strokeDasharray={pattern} strokeLinecap={cap} />}
      {atEnd && <polygon points={`${r2(W)},${r2(y)} ${r2(W - hl)},${r2(y - hw)} ${r2(W - hl)},${r2(y + hw)}`} fill={stroke} />}
      {atStart && <polygon points={`0,${r2(y)} ${r2(hl)},${r2(y - hw)} ${r2(hl)},${r2(y + hw)}`} fill={stroke} />}
    </svg>
  )
}
