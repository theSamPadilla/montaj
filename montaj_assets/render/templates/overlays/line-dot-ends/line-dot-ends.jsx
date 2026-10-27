/**
 * line-dot-ends.jsx: a line across the box at mid height, a cap at each end (dots by default).
 *
 * A carousel element (Elements panel, §587). No animation. An SVG that fills
 * the element box (inset:0); its viewBox is the box, so sizes are slide px.
 *
 * Props:
 *   stroke      — line colour (default '#111111')
 *   strokeWidth — px, at most the box height (default '8')
 *   cap         — each end: 'dot' | 'circle' | 'square' | 'bar' (default 'dot')
 *   arrowhead   — 'none' | 'end' | 'start' | 'both'; an end with a head has no cap (default 'none')
 *   strokeStyle — 'solid' | 'long-dash' | 'short-dash' | 'dotted' (default 'solid')
 *   roundCaps   — rounded line ends and dashes (default false)
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

const CAPS = ['dot', 'circle', 'square', 'bar']

export default function LineDotEnds({ stroke = '#111111', strokeWidth = '8', cap = 'dot', arrowhead = 'none', strokeStyle = 'solid', roundCaps = false, boxWidth, boxHeight }) {
  const W = side(boxWidth)
  const H = side(boxHeight)
  const sw = clamp(num(strokeWidth, 8), 0, H)
  const y = H / 2
  const head = String(arrowhead)
  const atEnd = head === 'end' || head === 'both'
  const atStart = head === 'start' || head === 'both'
  // A head is a filled triangle whose tip is the line's end, as on the arrow line.
  const hw = Math.min(H / 2, Math.max(8, sw * 1.75))
  const hl = Math.min((atEnd && atStart ? W / 2 : W), Math.max(12, sw * 3))
  const kind = CAPS.includes(String(cap)) ? String(cap) : 'dot'
  // A cap sits inside the box at each end without a head: a dot, a ring or a
  // square of half size `rc`, or a bar across the line, `bt` wide.
  const rc = Math.min(H / 2, W / 4, Math.max(6, sw * 1.5))
  const bt = Math.min(W / 4, Math.max(2, sw))
  const bl = Math.min(H, Math.max(24, sw * 4)) / 2
  const centre = kind === 'bar' ? bt / 2 : rc
  // Where the line meets a cap: under a dot or a square, at a ring's outside.
  const reach = kind === 'circle' ? 2 * rc - sw / 2 : centre
  const round = isOn(roundCaps)
  const lineCap = round || String(strokeStyle) === 'dotted' ? 'round' : 'butt'
  const x0 = atStart ? hl - 0.5 : reach
  const x1 = atEnd ? W - hl + 0.5 : W - reach
  const capAt = (cx, key) => {
    if (kind === 'bar') return <rect key={key} x={r2(cx - bt / 2)} y={r2(y - bl)} width={r2(bt)} height={r2(2 * bl)} fill={stroke} />
    if (kind === 'square') return <rect key={key} x={r2(cx - rc)} y={r2(y - rc)} width={r2(2 * rc)} height={r2(2 * rc)} fill={stroke} />
    if (kind === 'circle') return <circle key={key} cx={r2(cx)} cy={r2(y)} r={r2(Math.max(0, rc - sw / 2))} fill="none" stroke={stroke} strokeWidth={sw} />
    return <circle key={key} cx={r2(cx)} cy={r2(y)} r={r2(rc)} fill={stroke} />
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={SVG_STYLE}>
      {sw > 0 && x1 > x0 && <line x1={x0} y1={y} x2={x1} y2={y} stroke={stroke} strokeWidth={sw} strokeDasharray={dashOf(strokeStyle, sw, round)} strokeLinecap={lineCap} />}
      {sw > 0 && !atStart && capAt(centre, 'start')}
      {sw > 0 && !atEnd && capAt(W - centre, 'end')}
      {atEnd && <polygon points={`${r2(W)},${r2(y)} ${r2(W - hl)},${r2(y - hw)} ${r2(W - hl)},${r2(y + hw)}`} fill={stroke} />}
      {atStart && <polygon points={`0,${r2(y)} ${r2(hl)},${r2(y - hw)} ${r2(hl)},${r2(y + hw)}`} fill={stroke} />}
    </svg>
  )
}
