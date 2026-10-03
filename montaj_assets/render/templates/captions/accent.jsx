import { captionOuterStyle, captionInnerStyle } from 'montaj/render'

/**
 * Accent (PL41): short bold running captions, plus hero blocks with one
 * accent word. Every change is a hard cut: no spring, no fade. The defaults
 * were matched to the reference by measurement (PL41 T6).
 *
 * Running segment: its words in windows of at most RUN_WINDOW, breaking
 * early after punctuation or a pause. The window whose first word has been
 * spoken is on screen, whole, until the next one starts.
 *
 * Hero segment (`seg.hero`): the whole segment as a stacked block on two
 * staggered lines (line 1 flush left, line 2 indented LINE2_INDENT), the
 * block centred as a whole. A hero is the layout plus the accent, not a size:
 * HERO_SCALE is 1. Each word cuts on when spoken, and the layout is fixed from
 * the first frame: an unspoken word is hidden, never absent, so nothing
 * reflows.
 *
 * A word's `accent` picks its treatment: 'serif' (red italic serif),
 * 'sans' (red, the running font), 'script' (white script; in a running
 * window it draws as 'serif'). Consecutive script words form ONE script run.
 * In a hero the run sits on its own line directly above the word it
 * qualifies: that word starts its line, the run starts at the block's left
 * and the word's line is indented SCRIPT_INDENT.
 *
 * Both tiers are centred vertically on CENTRE_Y. The anchor box has no height
 * and sits on that line, so a segment `scale` (set on the anchor by
 * captionInnerStyle) grows the block around its own centre; the centring
 * translate lives on a nested node so that scale cannot overwrite it.
 *
 * `activeSegments` is duplicated in every template on purpose; see
 * word-by-word.jsx before changing it.
 */
const RUN_WINDOW = 3
const RUN_PAUSE_S = 0.35
const HERO_SCALE = 1.0
const SERIF_SCALE = 1.2
const SCRIPT_SCALE = 0.8
/** The script line overlaps the line under it by this much of the hero size. */
const SCRIPT_GAP = 0.07
/** Hero line 2's indent, in hero font sizes. */
const LINE2_INDENT = 0.45
/** The indent of a line whose first word carries a script run, in hero font sizes. */
const SCRIPT_INDENT = 0.66
const CENTRE_Y = '59.5%'
const TEXT_SHADOW = '0 1px 3px rgba(0,0,0,0.25)'
const ACCENTS = new Set(['serif', 'sans', 'script'])

export default function Accent({
  frame, fps,
  segments = [],
  color = '#FBFBFB',
  accentColor = '#F00000',
  fontSize = 168,
  fontFamily = '"Inter Tight", system-ui, sans-serif',
  fontWeight = 700,
  accentFontFamily = '"Playfair Display", Georgia, serif',
  scriptFontFamily = '"Caveat", cursive',
  textAlign = 'center',
  letterSpacing = '-0.03em',
  lineHeight = 0.76,
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

/**
 * Hero lines: units of `{ script, main }`, where `script` is a run of
 * consecutive script words (or null) and `main` the word it qualifies (or
 * null for a trailing run). At most two lines. A run with a word to qualify
 * starts a line, so it can sit directly above that word; otherwise the lines
 * are balanced by character count.
 */
export function heroLines(words) {
  const units = []
  words.forEach(w => {
    const prev = units[units.length - 1]
    const open = prev && prev.script && !prev.main
    if (w.accent === 'script') {
      if (open) prev.script.push(w)
      else units.push({ script: [w], main: null })
    } else if (open) prev.main = w
    else units.push({ script: null, main: w })
  })
  if (units.length < 2) return [units]
  const k = units.findIndex((u, i) => i > 0 && u.script && u.main)
  if (k > 0) return [units.slice(0, k), units.slice(k)]
  const len = u => (u.main ? u.main.word.length : 0) + 1
  const total = units.reduce((n, u) => n + len(u), 0)
  let best = 1, bestDiff = Infinity, acc = 0
  for (let i = 1; i < units.length; i++) {
    acc += len(units[i - 1])
    const diff = Math.abs(total - 2 * acc)
    if (diff < bestDiff) { bestDiff = diff; best = i }
  }
  return [units.slice(0, best), units.slice(best)]
}

function wordStyle(w, size, th, { running }) {
  const kind = w.accent === 'script' && running ? 'serif' : w.accent
  const base = {
    display: 'inline-block',
    fontFamily: th.fontFamily, fontWeight: th.fontWeight, fontSize: size,
    letterSpacing: th.letterSpacing, lineHeight: th.lineHeight, textTransform: th.textTransform,
    color: th.color, textShadow: TEXT_SHADOW, whiteSpace: 'pre',
  }
  if (kind === 'serif') return { ...base, fontFamily: th.accentFontFamily, fontWeight: 700, fontStyle: 'italic', fontSize: size * SERIF_SCALE, letterSpacing: '-0.02em', color: th.accentColor }
  if (kind === 'sans') return { ...base, color: th.accentColor }
  if (kind === 'script') return { ...base, fontFamily: th.scriptFontFamily, fontWeight: 700, fontSize: size * SCRIPT_SCALE, letterSpacing: '-0.08em' }
  return base
}

/** The anchor box: no height, on the CENTRE_Y line; carries the segment scale. */
function anchor(seg, th) {
  return captionInnerStyle(seg, { top: CENTRE_Y, left: 0, right: 0, height: 0, textAlign: th.textAlign, padding: '0 6%' })
}

/** Centres the block on the anchor line. Never on the anchor itself (see the header). */
const CENTRE = { transform: 'translateY(-50%)' }

function renderRunning(seg, key, th) {
  const words = seg.words || []
  if (!words.length) return null
  const windows = runWindows(words)
  const win = [...windows].reverse().find(w => th.t >= w[0].start)
  if (!win) return null
  return (
    <div key={key} style={captionOuterStyle(seg)} data-caption-id={seg.id}>
      <div style={anchor(seg, th)}>
        <div style={CENTRE}>
          {win.map((w, i) => (
            <span key={i} style={{ ...wordStyle(w, th.fontSize, th, { running: true }), color: ACCENTS.has(w.accent) ? th.accentColor : (seg.color ?? th.color) }}>
              {(i ? ' ' : '') + w.word}
            </span>
          ))}
        </div>
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
    const run = line.flatMap(u => u.script || [])
    if (run.length) {
      lineDivs.push(
        <div key={`s${li}`} style={{ marginBottom: -size * SCRIPT_GAP }}>
          {run.map((w, i) => <span key={i} style={{ ...wordStyle(w, size, th, { running: false }), ...vis(w) }}>{(i ? ' ' : '') + w.word}</span>)}
        </div>,
      )
    }
    const mains = line.filter(u => u.main)
    if (!mains.length) return
    const indent = line[0].script && line[0].main ? SCRIPT_INDENT : li > 0 ? LINE2_INDENT : 0
    lineDivs.push(
      <div key={`l${li}`} style={{ paddingLeft: size * indent }}>
        {mains.map((u, i) => (
          <span key={i} style={{ ...wordStyle(u.main, size, th, { running: false }), ...(ACCENTS.has(u.main.accent) ? null : { color: seg.color ?? th.color }), ...vis(u.main) }}>
            {(i ? ' ' : '') + u.main.word}
          </span>
        ))}
      </div>,
    )
  })
  return (
    <div key={key} style={captionOuterStyle(seg)} data-caption-id={seg.id}>
      <div style={anchor(seg, th)}>
        <div style={CENTRE}>
          <div style={{ display: 'inline-block', textAlign: 'left' }}>{lineDivs}</div>
        </div>
      </div>
    </div>
  )
}
