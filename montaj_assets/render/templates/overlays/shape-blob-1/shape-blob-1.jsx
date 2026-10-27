/**
 * shape-blob-1.jsx: a blob: a smooth closed curve, lumpy round its edge.
 *
 * A carousel element (Elements panel, §587). No animation. An SVG that fills
 * the element box (inset:0); its viewBox is the box, so sizes are slide px.
 *
 * Props:
 *   fill        — fill colour (default '#bdbdbd')
 *   stroke      — stroke colour (default '#111111')
 *   strokeWidth — px, 0 for none (default '0'); drawn inside the box
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

// `segs` (any units; ['M', x, y], ['L', x, y], ['C', x1, y1, x2, y2, x, y] or
// ['Z']) stretched to fill the box, inset by half the stroke so the stroke
// stays inside it. The curves' own extent (sampled) fills the box, not their
// control points'.
function fitPath(segs, W, H, sw) {
  const xs = []
  const ys = []
  let px = 0
  let py = 0
  for (const s of segs) {
    if (s[0] === 'C') {
      for (let i = 1; i <= 24; i++) {
        const t = i / 24
        const u = 1 - t
        xs.push(u * u * u * px + 3 * u * u * t * s[1] + 3 * u * t * t * s[3] + t * t * t * s[5])
        ys.push(u * u * u * py + 3 * u * u * t * s[2] + 3 * u * t * t * s[4] + t * t * t * s[6])
      }
      px = s[5]
      py = s[6]
    } else if (s[0] !== 'Z') {
      xs.push(s[1])
      ys.push(s[2])
      px = s[1]
      py = s[2]
    }
  }
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const spanX = Math.max(...xs) - minX || 1
  const spanY = Math.max(...ys) - minY || 1
  const iw = Math.max(0, W - sw)
  const ih = Math.max(0, H - sw)
  const X = (x) => r2(sw / 2 + ((x - minX) / spanX) * iw)
  const Y = (y) => r2(sw / 2 + ((y - minY) / spanY) * ih)
  return segs.map((s) => {
    if (s[0] === 'Z') return 'Z'
    if (s[0] === 'C') return `C ${X(s[1])} ${Y(s[2])} ${X(s[3])} ${Y(s[4])} ${X(s[5])} ${Y(s[6])}`
    return `${s[0]} ${X(s[1])} ${Y(s[2])}`
  }).join(' ')
}

// A smooth closed curve through `pts` (Catmull-Rom, as cubic Béziers).
function smoothClosed(pts) {
  const n = pts.length
  const at = (i) => pts[(i + n) % n]
  const segs = [['M', pts[0][0], pts[0][1]]]
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)]
    segs.push(['C', p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]])
  }
  segs.push(['Z'])
  return segs
}

export default function ShapeBlob1({ fill = '#bdbdbd', stroke = '#111111', strokeWidth = '0', strokeStyle = 'solid', boxWidth, boxHeight }) {
  const W = side(boxWidth)
  const H = side(boxHeight)
  const sw = clamp(num(strokeWidth, 0), 0, Math.min(W, H) / 2)
  const look = strokeLook(strokeStyle, sw, false)
  const paint = { fill, stroke: sw > 0 ? stroke : 'none', strokeWidth: sw }
  // A smooth curve through points round the middle, at these radii.
  const R = [1, 0.82, 0.95, 0.74, 0.92, 0.8]
  const segs = smoothClosed(R.map((r, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / R.length
    return [r * Math.cos(a), r * Math.sin(a)]
  }))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={SVG_STYLE}>
      <path d={fitPath(segs, W, H, sw)} {...paint} {...look} />
    </svg>
  )
}
