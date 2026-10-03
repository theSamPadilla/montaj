import { captionOuterStyle, captionInnerStyle } from 'montaj/render'

/**
 * Accent (PL41): short bold running captions, plus hero blocks with one
 * accent word. Every change is a hard cut: no spring, no fade.
 *
 * Running segment: its words in windows of at most RUN_WINDOW, breaking
 * early after punctuation or a pause. The window whose first word has been
 * spoken is on screen, whole, until the next one starts.
 *
 * Hero segment (`seg.hero`): the whole segment as a stacked block HERO_SCALE
 * times larger, on two balanced lines. Each word cuts on when spoken, and
 * the layout is fixed from the first frame: an unspoken word is hidden, never
 * absent, so nothing reflows.
 *
 * A word's `accent` picks its treatment: 'serif' (red italic serif),
 * 'sans' (red, the running font), 'script' (a small white script line over
 * the next word; in a running window it draws as 'serif').
 *
 * `activeSegments` is duplicated in every template on purpose; see
 * word-by-word.jsx before changing it.
 */
const RUN_WINDOW = 3
const RUN_PAUSE_S = 0.35
const HERO_SCALE = 2.4
const SERIF_SCALE = 1.12
const SCRIPT_SCALE = 0.42
const ACCENTS = new Set(['serif', 'sans', 'script'])

export default function Accent({
  frame, fps,
  segments = [],
  color = '#F5F5F5',
  accentColor = '#F00000',
  fontSize = 64,
  fontFamily = '"Inter Tight", system-ui, sans-serif',
  fontWeight = 800,
  accentFontFamily = '"Instrument Serif", Georgia, serif',
  scriptFontFamily = '"Caveat", cursive',
  textAlign = 'center',
  letterSpacing = '-0.04em',
  lineHeight = 0.86,
  textTransform,
}) {
  const t = frame / fps
  const active = activeSegments(segments, t)
  if (!active.length) return null
  const theme = { t, color, accentColor, fontSize, fontFamily, fontWeight, accentFontFamily, scriptFontFamily, textAlign, letterSpacing, lineHeight, textTransform }
  const blocks = active.map((seg, i) => (seg.hero ? renderHero : renderRunning)(seg, seg.id ?? i, theme)).filter(Boolean)
  return blocks.length ? <>{blocks}</> : null
}

function activeSegments(segments, t) {
  return segments
    .filter(s => t >= s.start && t < s.end)
    .sort((a, b) => (a.lane ?? 0) - (b.lane ?? 0))
}

/** Running windows: at most RUN_WINDOW words, broken after punctuation or a pause. */
export function runWindows(words) {
  const out = []
  let cur = []
  words.forEach((w, i) => {
    cur.push(w)
    const next = words[i + 1]
    const punct = /[.,!?;:]$/.test(w.word)
    const pause = next && next.start - w.end > RUN_PAUSE_S
    if (cur.length >= RUN_WINDOW || punct || pause || !next) { out.push(cur); cur = [] }
  })
  return out
}

/** Two balanced lines by character count; a script word rides with the word after it. */
export function heroLines(words) {
  const units = []
  words.forEach(w => {
    const prev = units[units.length - 1]
    if (prev && prev.script && !prev.main) prev.main = w
    else units.push(w.accent === 'script' ? { script: w, main: null } : { script: null, main: w })
  })
  if (units.length < 2) return [units]
  const len = u => (u.main ? u.main.word.length : 0) + 1
  const total = units.reduce((n, u) => n + len(u), 0)
  let best = 1, bestDiff = Infinity, acc = 0
  for (let k = 1; k < units.length; k++) {
    acc += len(units[k - 1])
    const diff = Math.abs(total - 2 * acc)
    if (diff < bestDiff) { bestDiff = diff; best = k }
  }
  return [units.slice(0, best), units.slice(best)]
}

function wordStyle(w, size, th, { running }) {
  const kind = w.accent === 'script' && running ? 'serif' : w.accent
  const base = {
    display: 'inline-block',
    fontFamily: th.fontFamily, fontWeight: th.fontWeight, fontSize: size,
    letterSpacing: th.letterSpacing, lineHeight: th.lineHeight, textTransform: th.textTransform,
    color: th.color, textShadow: '0 2px 10px rgba(0,0,0,0.35)', whiteSpace: 'pre',
  }
  if (kind === 'serif') return { ...base, fontFamily: th.accentFontFamily, fontWeight: 400, fontStyle: 'italic', fontSize: size * SERIF_SCALE, letterSpacing: '-0.02em', color: th.accentColor }
  if (kind === 'sans') return { ...base, color: th.accentColor }
  if (kind === 'script') return { ...base, fontFamily: th.scriptFontFamily, fontWeight: 700, fontSize: size * SCRIPT_SCALE, letterSpacing: 0, transform: 'rotate(-4deg)' }
  return base
}

function anchor(seg, th) {
  return captionInnerStyle(seg, { bottom: '38%', left: 0, right: 0, textAlign: th.textAlign, padding: '0 6%' })
}

function renderRunning(seg, key, th) {
  const words = seg.words || []
  if (!words.length) return null
  const windows = runWindows(words)
  const win = [...windows].reverse().find(w => th.t >= w[0].start)
  if (!win) return null
  return (
    <div key={key} style={captionOuterStyle(seg)} data-caption-id={seg.id}>
      <div style={anchor(seg, th)}>
        {win.map((w, i) => (
          <span key={i} style={{ ...wordStyle(w, th.fontSize, th, { running: true }), color: ACCENTS.has(w.accent) ? th.accentColor : (seg.color ?? th.color) }}>
            {(i ? ' ' : '') + w.word}
          </span>
        ))}
      </div>
    </div>
  )
}

function renderHero(seg, key, th) {
  const words = seg.words || []
  if (!words.length || th.t < words[0].start) return null
  const size = th.fontSize * HERO_SCALE
  const vis = w => ({ visibility: th.t >= w.start ? 'visible' : 'hidden' })
  const lineDivs = []
  heroLines(words).forEach((line, li) => {
    const scripts = line.filter(u => u.script)
    if (scripts.length) {
      lineDivs.push(
        <div key={`s${li}`} style={{ marginBottom: -size * 0.18 }}>
          {scripts.map((u, i) => <span key={i} style={{ ...wordStyle(u.script, size, th, { running: false }), ...vis(u.script) }}>{(i ? ' ' : '') + u.script.word}</span>)}
        </div>,
      )
    }
    if (!line.some(u => u.main)) return
    lineDivs.push(
      <div key={`l${li}`}>
        {line.filter(u => u.main).map((u, i) => (
          <span key={i} style={{ ...wordStyle(u.main, size, th, { running: false }), ...(ACCENTS.has(u.main.accent) ? null : { color: seg.color ?? th.color }), ...vis(u.main) }}>
            {(i ? ' ' : '') + u.main.word}
          </span>
        ))}
      </div>,
    )
  })
  return (
    <div key={key} style={captionOuterStyle(seg)} data-caption-id={seg.id}>
      <div style={anchor(seg, th)}>{lineDivs}</div>
    </div>
  )
}
