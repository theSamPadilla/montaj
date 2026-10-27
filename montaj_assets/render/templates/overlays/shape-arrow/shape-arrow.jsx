/**
 * shape-arrow.jsx: a block arrow pointing right (rotate the element to turn it).
 *
 * A carousel element (Elements panel, §587). No animation. An SVG that fills
 * the element box (inset:0); its viewBox is the box, so sizes are slide px.
 *
 * Props:
 *   fill        — fill colour (default '#bdbdbd')
 *   stroke      — stroke colour (default '#111111')
 *   strokeWidth — px, 0 for none (default '0'); drawn inside the box
 *   headLength  — the head, % of the width (default '40')
 *   shaftWidth  — the shaft, % of the height (default '40')
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
const SVG_STYLE = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', display: 'block', overflow: 'visible' }

// `pts` (any units) stretched to fill the box, inset by half the stroke so the
// stroke stays inside it (round joins never reach past half the stroke).
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

export default function ShapeArrow({ fill = '#bdbdbd', stroke = '#111111', strokeWidth = '0', headLength = '40', shaftWidth = '40', boxWidth, boxHeight }) {
  const W = side(boxWidth)
  const H = side(boxHeight)
  const sw = clamp(num(strokeWidth, 0), 0, Math.min(W, H) / 2)
  const paint = { fill, stroke: sw > 0 ? stroke : 'none', strokeWidth: sw }
  const hl = clamp(num(headLength, 40), 5, 95) / 100
  const s = clamp(num(shaftWidth, 40), 5, 100) / 100
  const a = (1 - s) / 2
  const b = (1 + s) / 2
  const pts = [[0, a], [1 - hl, a], [1 - hl, 0], [1, 0.5], [1 - hl, 1], [1 - hl, b], [0, b]]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={SVG_STYLE}>
      <polygon points={fitPoints(pts, W, H, sw)} strokeLinejoin="round" {...paint} />
    </svg>
  )
}
