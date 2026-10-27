/**
 * callout-speech-round.jsx: a round speech bubble, its tail at the bottom.
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
 *   roundJoins  — rounded corners (default true)
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

export default function CalloutSpeechRound({ fill = '#bdbdbd', stroke = '#111111', strokeWidth = '0', tail = 'left', strokeStyle = 'solid', roundJoins = true, boxWidth, boxHeight }) {
  const W = side(boxWidth)
  const H = side(boxHeight)
  const sw = clamp(num(strokeWidth, 0), 0, Math.min(W, H) / 2)
  const look = strokeLook(strokeStyle, sw, isOn(roundJoins))
  const paint = { fill, stroke: sw > 0 ? stroke : 'none', strokeWidth: sw }
  // An ellipse over the top four fifths, the tail's tip on the bottom edge.
  const p = sw / 2
  const right = String(tail) === 'right'
  const bodyH = H * 0.8
  const cx = W / 2
  const cy = bodyH / 2
  const rx = Math.max(0, (W - sw) / 2)
  const ry = Math.max(0, (bodyH - sw) / 2)
  const on = (deg) => {
    const a = (deg * Math.PI) / 180
    return `${r2(cx + rx * Math.cos(a))} ${r2(cy + ry * Math.sin(a))}`
  }
  // The tail leaves the ellipse between two points low on its side (angles
  // clockwise from the right), and the body is the long way round.
  const [from, to] = right ? [70, 40] : [140, 110]
  const tip = `${r2(right ? W * 0.82 : W * 0.18)} ${r2(H - p)}`
  const d = `M ${tip} L ${on(from)} A ${r2(rx)} ${r2(ry)} 0 1 1 ${on(to)} Z`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={SVG_STYLE}>
      <path d={d} {...paint} {...look} />
    </svg>
  )
}
