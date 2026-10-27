/**
 * line-arrow.jsx: a line with an arrowhead, across the box at mid height.
 *
 * A carousel element (Elements panel, §587). No animation. An SVG that fills
 * the element box (inset:0); its viewBox is the box, so sizes are slide px.
 *
 * Props:
 *   stroke      — line colour (default '#111111')
 *   strokeWidth — px, at most the box height (default '8')
 *   arrowhead   — 'none' | 'end' | 'start' | 'both' (default 'end')
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

export default function LineArrow({ stroke = '#111111', strokeWidth = '8', arrowhead = 'end', boxWidth, boxHeight }) {
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
  // The line stops just under each head's base (0.5 px of overlap, no seam).
  const x0 = atStart ? hl - 0.5 : 0
  const x1 = atEnd ? W - hl + 0.5 : W

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={SVG_STYLE}>
      {sw > 0 && x1 > x0 && <line x1={x0} y1={y} x2={x1} y2={y} stroke={stroke} strokeWidth={sw} />}
      {atEnd && <polygon points={`${r2(W)},${r2(y)} ${r2(W - hl)},${r2(y - hw)} ${r2(W - hl)},${r2(y + hw)}`} fill={stroke} />}
      {atStart && <polygon points={`0,${r2(y)} ${r2(hl)},${r2(y - hw)} ${r2(hl)},${r2(y + hw)}`} fill={stroke} />}
    </svg>
  )
}
