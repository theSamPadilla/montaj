/**
 * frame-double.jsx: two borders around the box, no fill.
 *
 * A carousel element (Elements panel, §587). No animation. An SVG that fills
 * the element box (inset:0); its viewBox is the box, so sizes are slide px.
 *
 * Props:
 *   stroke      — border colour (default '#111111')
 *   strokeWidth — px, each border (default '4')
 *   gap         — px between the borders (default '12')
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
const SVG_STYLE = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', display: 'block', overflow: 'visible' }

export default function FrameDouble({ stroke = '#111111', strokeWidth = '4', gap = '12', boxWidth, boxHeight }) {
  const W = side(boxWidth)
  const H = side(boxHeight)
  const sw = clamp(num(strokeWidth, 4), 0, Math.min(W, H) / 4)
  const g = clamp(num(gap, 12), 0, Math.max(0, Math.min(W, H) / 2 - 2 * sw))
  const rect = (inset) => (
    <rect x={inset} y={inset} width={Math.max(0, W - 2 * inset)} height={Math.max(0, H - 2 * inset)} fill="none" stroke={stroke} strokeWidth={sw} />
  )
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={SVG_STYLE}>
      {sw > 0 && rect(sw / 2)}
      {sw > 0 && rect(sw + g + sw / 2)}
    </svg>
  )
}
