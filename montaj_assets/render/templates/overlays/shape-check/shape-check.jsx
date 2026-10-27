/**
 * shape-check.jsx: a checkmark.
 *
 * A carousel element (Elements panel, §587). No animation. An SVG that fills
 * the element box (inset:0); its viewBox is the box, so sizes are slide px.
 *
 * Props:
 *   fill        — fill colour (default '#bdbdbd')
 *   stroke      — stroke colour (default '#111111')
 *   strokeWidth — px, 0 for none (default '0'); drawn inside the box
 *   thickness   — the stroke of the mark, % of the box, 5 to 40 (default '22')
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

// The outline of a thick polyline through `pts`, `h` either side of it:
// mitred at its bends, its ends cut square.
function thickOutline(pts, h) {
  const nrm = (a, b) => {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l = Math.hypot(dx, dy) || 1
    return [-dy / l, dx / l]
  }
  const left = []
  const right = []
  pts.forEach((p, i) => {
    let n
    let len = h
    if (i === 0) n = nrm(p, pts[1])
    else if (i === pts.length - 1) n = nrm(pts[i - 1], p)
    else {
      const n1 = nrm(pts[i - 1], p)
      const n2 = nrm(p, pts[i + 1])
      const l = Math.hypot(n1[0] + n2[0], n1[1] + n2[1]) || 1
      n = [(n1[0] + n2[0]) / l, (n1[1] + n2[1]) / l]
      len = h / Math.max(0.2, n[0] * n1[0] + n[1] * n1[1])
    }
    left.push([p[0] + n[0] * len, p[1] + n[1] * len])
    right.push([p[0] - n[0] * len, p[1] - n[1] * len])
  })
  return [...left, ...right.reverse()]
}

export default function ShapeCheck({ fill = '#bdbdbd', stroke = '#111111', strokeWidth = '0', thickness = '22', strokeStyle = 'solid', roundJoins = false, boxWidth, boxHeight }) {
  const W = side(boxWidth)
  const H = side(boxHeight)
  const sw = clamp(num(strokeWidth, 0), 0, Math.min(W, H) / 2)
  const look = strokeLook(strokeStyle, sw, isOn(roundJoins))
  const paint = { fill, stroke: sw > 0 ? stroke : 'none', strokeWidth: sw }
  const t = clamp(num(thickness, 22), 5, 40) / 100
  // A short arm down to the bend, a long one up to the right.
  const pts = thickOutline([[0, 0.55], [0.36, 0.9], [1, 0.12]], t / 2)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={SVG_STYLE}>
      <polygon points={fitPoints(pts, W, H, sw)} {...paint} {...look} />
    </svg>
  )
}
