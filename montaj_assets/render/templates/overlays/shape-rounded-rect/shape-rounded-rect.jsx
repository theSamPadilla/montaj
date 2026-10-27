/**
 * shape-rounded-rect.jsx: a rectangle with round corners.
 *
 * A carousel element (Elements panel, §587). No animation. An SVG that fills
 * the element box (inset:0); its viewBox is the box, so sizes are slide px.
 *
 * Props (strings):
 *   fill        — fill colour (default '#bdbdbd')
 *   stroke      — stroke colour (default '#111111')
 *   strokeWidth — px, 0 for none (default '0'); drawn inside the box
 *   cornerRadius — px, the outer edge's radius (default '48')
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

export default function ShapeRoundedRect({ fill = '#bdbdbd', stroke = '#111111', strokeWidth = '0', cornerRadius = '48', boxWidth, boxHeight }) {
  const W = side(boxWidth)
  const H = side(boxHeight)
  const sw = clamp(num(strokeWidth, 0), 0, Math.min(W, H) / 2)
  const paint = { fill, stroke: sw > 0 ? stroke : 'none', strokeWidth: sw }
  const r = clamp(num(cornerRadius, 48), 0, Math.min(W, H) / 2)
  // The stroke is centred on the path: its outer edge keeps the radius asked for.
  const rx = Math.max(0, r - sw / 2)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={SVG_STYLE}>
      <rect x={sw / 2} y={sw / 2} width={Math.max(0, W - sw)} height={Math.max(0, H - sw)} rx={rx} ry={rx} {...paint} />
    </svg>
  )
}
