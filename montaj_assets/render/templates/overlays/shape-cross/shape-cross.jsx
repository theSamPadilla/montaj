/**
 * shape-cross.jsx: a cross, its bar across the upper part.
 *
 * A carousel element (Elements panel, §587). No animation. An SVG that fills
 * the element box (inset:0); its viewBox is the box, so sizes are slide px.
 *
 * Props:
 *   fill        — fill colour (default '#bdbdbd')
 *   stroke      — stroke colour (default '#111111')
 *   strokeWidth — px, 0 for none (default '0'); drawn inside the box
 *   thickness   — each bar, % of the box, 5 to 60 (default '26')
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

// `pts` (any units) stretched to fill the box, inset by half the stroke so the
// stroke stays inside it (round joins never reach past half the stroke; a
// sharp corner's miter may, a little).
function fitPoints(pts, W, H, sw) {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const spanX = Math.max(...xs) - minX || 1
  const spanY = Math.max(...ys) - minY || 1
  const iw = Math.max(0, W - sw)
  const ih = Math.max(0, H - sw)
  return pts.map(([x, y]) => `${r2(sw / 2 + ((x - minX) / spanX) * iw)},${r2(sw / 2 + ((y - minY) / spanY) * ih)}`).join(' ')
}

export default function ShapeCross({ fill = '#bdbdbd', stroke = '#111111', strokeWidth = '0', thickness = '26', strokeStyle = 'solid', roundJoins = false, boxWidth, boxHeight }) {
  const W = side(boxWidth)
  const H = side(boxHeight)
  const sw = clamp(num(strokeWidth, 0), 0, Math.min(W, H) / 2)
  const look = strokeLook(strokeStyle, sw, isOn(roundJoins))
  const paint = { fill, stroke: sw > 0 ? stroke : 'none', strokeWidth: sw }
  const t = clamp(num(thickness, 26), 5, 60) / 100
  const a = (1 - t) / 2
  const b = (1 + t) / 2
  // The crossbar sits a third of the way down, measured to its middle.
  const c = Math.max(0, 1 / 3 - t / 2)
  const e = c + t
  const pts = [[a, 0], [b, 0], [b, c], [1, c], [1, e], [b, e], [b, 1], [a, 1], [a, e], [0, e], [0, c], [a, c]]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={SVG_STYLE}>
      <polygon points={fitPoints(pts, W, H, sw)} {...paint} {...look} />
    </svg>
  )
}
