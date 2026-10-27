/**
 * frame-corners.jsx: the box's four corners marked, no fill.
 *
 * A carousel element (Elements panel, §587). No animation. An SVG that fills
 * the element box (inset:0); its viewBox is the box, so sizes are slide px.
 *
 * Props (strings):
 *   stroke       — colour (default '#111111')
 *   strokeWidth  — px (default '8')
 *   cornerLength — each arm, % of the shorter side (default '20')
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

export default function FrameCorners({ stroke = '#111111', strokeWidth = '8', cornerLength = '20', boxWidth, boxHeight }) {
  const W = side(boxWidth)
  const H = side(boxHeight)
  const sw = clamp(num(strokeWidth, 8), 0, Math.min(W, H) / 2)
  const L = (clamp(num(cornerLength, 20), 1, 50) / 100) * Math.min(W, H)
  const p = sw / 2
  const d = [
    `M ${r2(p)} ${r2(p + L)} L ${r2(p)} ${r2(p)} L ${r2(p + L)} ${r2(p)}`,
    `M ${r2(W - p - L)} ${r2(p)} L ${r2(W - p)} ${r2(p)} L ${r2(W - p)} ${r2(p + L)}`,
    `M ${r2(W - p)} ${r2(H - p - L)} L ${r2(W - p)} ${r2(H - p)} L ${r2(W - p - L)} ${r2(H - p)}`,
    `M ${r2(p + L)} ${r2(H - p)} L ${r2(p)} ${r2(H - p)} L ${r2(p)} ${r2(H - p - L)}`,
  ].join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={SVG_STYLE}>
      {sw > 0 && <path d={d} fill="none" stroke={stroke} strokeWidth={sw} strokeLinejoin="miter" />}
    </svg>
  )
}
