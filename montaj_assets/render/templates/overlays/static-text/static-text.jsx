/**
 * static-text.jsx — Static text overlay for carousel slides.
 *
 * No animation. Ignores frame/fps/duration. Renders one styled string,
 * sized to fill the overlay's element box. The slide.jsx wrapper provides
 * the position/size box; this template fills inset:0.
 *
 * Props (all values stored as strings for round-trip through PropertyPanel):
 *   text          — string to render (default 'Your text here')
 *   fontSize      — CSS px (default '80'; coerced via Number(), NaN→80)
 *   fontFamily    — CSS font-family string (default system-ui stack)
 *   fontWeight    — CSS font-weight (default '400'; numeric or named OK)
 *   fontStyle     — CSS font-style: 'normal' | 'italic' (default 'normal')
 *   color         — text color (default '#111111')
 *   textAlign     — 'left' | 'center' | 'right' (default 'center')
 *   textTransform — CSS text-transform: 'none' | 'uppercase' | 'lowercase' | 'capitalize' (default 'none')
 *   bgColor       — backdrop color or 'transparent' (default 'transparent')
 *   effect        — 'none' | 'shadow' | 'outline' | 'glow' (default 'none')
 *   effectColor   — the effect's color (default '#000000')
 *   effectStrength — '0'..'100' (default '60')
 *   fit           — 'true' shrinks the text until it fits the box (default 'false')
 *   minFontSize   — CSS px the fit never goes below (default '24')
 *   runs          — optional styled runs, a JSON array string beside `text`:
 *                   [{"t":"Make it "},{"t":"red","c":"#ff0000","b":1}]. `t` the
 *                   run's text, `c` a hex colour, `b`/`i`/`u` 1 (bold, italic,
 *                   underline on) or 0 (off); absent = the element's own. Used
 *                   only when the runs spell `text` exactly and no boundary
 *                   splits an emoji's two halves; otherwise ignored.
 *
 * Effects are sized in em, so they follow the size the text is drawn at,
 * fitted or not. Fit measures the laid-out text in the browser (a callback
 * ref, no hooks: the editor preview calls this function directly), so the
 * editor and the render both fit with their own real font metrics.
 */

const EFFECTS = new Set(['shadow', 'outline', 'glow'])

// '#rgb', '#rrggbb' or '#rrggbbaa' at the given alpha; any other color as is.
function withAlpha(color, alpha) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(color).trim())
  if (!m) return color
  let hex = m[1]
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('')
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16))
  const own = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
  return `rgba(${r}, ${g}, ${b}, ${+(alpha * own).toFixed(3)})`
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

// The runs in `raw` when they are well formed and spell `text`, else null (draw `text`).
function decodeRuns(raw, text) {
  if (typeof raw !== 'string' || raw === '') return null
  let list
  try { list = JSON.parse(raw) } catch { return null }
  if (!Array.isArray(list) || !list.every(r => r && typeof r === 'object' && typeof r.t === 'string')) return null
  if (list.map(r => r.t).join('') !== String(text)) return null
  // A boundary between an emoji's two UTF-16 halves would draw each half alone.
  for (let i = 0; i < list.length - 1; i++) {
    if (/[\uD800-\uDBFF]$/.test(list[i].t) && /^[\uDC00-\uDFFF]/.test(list.slice(i + 1).map(r => r.t).join(''))) return null
  }
  return list.filter(r => r.t !== '')
}

// A run's own style. Underline is drawn per run: a child cannot take back its parent's.
function runStyle(r) {
  const s = { textDecorationLine: r.u === 1 ? 'underline' : 'none' }
  if (typeof r.c === 'string' && HEX.test(r.c)) s.color = r.c
  if (r.b === 1 || r.b === 0) s.fontWeight = r.b === 1 ? '700' : '400'
  if (r.i === 1 || r.i === 0) s.fontStyle = r.i === 1 ? 'italic' : 'normal'
  return s
}

const em = (n) => `${+n.toFixed(4)}em`

function effectStyle(effect, color, strength) {
  if (!EFFECTS.has(effect) || strength <= 0) return {}
  const s = strength
  if (effect === 'shadow') {
    return { textShadow: `0 ${em(0.06 * s)} ${em(0.22 * s)} ${withAlpha(color, 0.35 + 0.5 * s)}` }
  }
  if (effect === 'glow') {
    return { textShadow: `0 0 ${em(0.1 * s)} ${withAlpha(color, 0.95)}, 0 0 ${em(0.35 * s)} ${withAlpha(color, 0.75)}` }
  }
  // Outline: paint-order draws the stroke under the fill, so the glyphs keep
  // their shape and the visible ring is half the stroke width.
  return { WebkitTextStroke: `${em(0.14 * s)} ${color}`, paintOrder: 'stroke fill' }
}

// The largest whole px size in [min, max] at which the text fits the box's
// content area without breaking a word; min when nothing fits.
function fitFontSize(box, p, max, min) {
  const cs = getComputedStyle(box)
  const availW = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  const availH = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
  const wrap = p.style.overflowWrap
  p.style.overflowWrap = 'normal'
  const fits = (size) => {
    p.style.fontSize = `${size}px`
    return p.scrollHeight <= availH + 0.5 && p.scrollWidth <= availW + 0.5
  }
  let best = min
  if (fits(max)) best = max
  else if (fits(min)) {
    let lo = min
    let hi = max
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (fits(mid)) lo = mid
      else hi = mid
    }
    best = lo
  }
  p.style.overflowWrap = wrap
  return best
}

export default function StaticText({
  text          = 'Your text here',
  fontSize      = '80',
  fontFamily    = 'system-ui, -apple-system, "Helvetica Neue", sans-serif',
  fontWeight    = '400',
  fontStyle     = 'normal',
  color         = '#111111',
  textAlign     = 'center',
  textTransform = 'none',
  bgColor       = 'transparent',
  effect        = 'none',
  effectColor   = '#000000',
  effectStrength = '60',
  fit           = 'false',
  minFontSize   = '24',
  runs          = '',
}) {
  // parseFloat (not Number) so we tolerate both "64" (legacy unit-less) and
  // "64px" (the canonical FontSizePicker storage format). Number("64px") = NaN
  // would otherwise fall back to the default 80 and ignore the operator's
  // chosen size — the symptom would be "fontSize edits do nothing in render."
  const sizeNum = parseFloat(String(fontSize))
  const safeSize = Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : 80
  const minNum = parseFloat(String(minFontSize))
  const floor = Math.min(safeSize, Number.isFinite(minNum) && minNum > 0 ? minNum : 24)
  const strengthNum = parseFloat(String(effectStrength))
  const strength = Number.isFinite(strengthNum) ? Math.min(Math.max(strengthNum, 0), 100) / 100 : 0.6
  const fitOn = String(fit) === 'true'
  const styled = decodeRuns(runs, text)

  // Runs after every commit (a new function each render). With fit off it
  // puts the chosen size back, since React leaves a style it did not change.
  const sizeText = (p) => {
    if (!p) return
    if (!fitOn) {
      p.style.fontSize = `${safeSize}px`
      delete p.dataset.fittedSize
      return
    }
    const apply = () => {
      if (!p.isConnected || !p.parentElement) return
      p.dataset.fittedSize = String(fitFontSize(p.parentElement, p, safeSize, floor))
      p.style.fontSize = `${p.dataset.fittedSize}px`
    }
    apply()
    // Webfonts that are still loading change the metrics: fit again once they land.
    if (typeof document !== 'undefined' && document.fonts && document.fonts.status !== 'loaded') {
      document.fonts.ready.then(apply)
    }
  }

  return (
    <div style={{
      position:       'absolute',
      inset:          0,
      display:        'flex',
      alignItems:     'center',
      justifyContent: textAlign === 'left' ? 'flex-start' : textAlign === 'right' ? 'flex-end' : 'center',
      background:     bgColor,
      padding:        '6% 8%',
      boxSizing:      'border-box',
      overflow:       'hidden',
    }}>
      <p ref={sizeText} data-montaj-text="" style={{
        margin:        0,
        fontFamily,
        fontWeight,
        fontStyle,
        color,
        fontSize:      safeSize,
        textAlign,
        textTransform,
        lineHeight:    1.2,
        letterSpacing: '-0.01em',
        width:         '100%',
        whiteSpace:    'pre-wrap',
        wordBreak:     'normal',
        overflowWrap:  'break-word',
        ...effectStyle(effect, effectColor, strength),
      }}>{styled ? styled.map((r, i) => <span key={i} style={runStyle(r)}>{r.t}</span>) : text}</p>
    </div>
  )
}
