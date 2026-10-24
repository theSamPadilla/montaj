import { interpolate, captionOuterStyle, captionInnerStyle } from 'montaj/render'

/**
 * The whole phrase on one rounded plate, the spoken word picked out on top.
 * Full segment text visible at once, fading in at the segment's start; the
 * plate colour, opacity, padding and radius are theme fields (the track's, a
 * brand kit's, or one caption's own). The word being spoken takes `accentColor`
 * and a slight lift, never a second box: the plate IS the box. The plate hugs the
 * text: it is as wide as the widest line plus the padding, however the text wraps.
 * segments: caption track segments array from project.json
 *
 * Captions have LANES (rows), so more than one segment can be active at the
 * same instant. Every active one is drawn — see activeSegments below.
 */
export default function Plate({
  frame, fps,
  segments        = [],
  color           = '#ffffff',
  accentColor     = '#fbbf24',
  // The plate: any CSS colour, drawn at plateOpacity when it is #rrggbb (a
  // value that is not hex, such as rgba(...), carries its own alpha and is
  // used as it is). padding is in px (the vertical figure; the sides take 1.6x).
  backgroundColor = '#000000',
  plateOpacity    = 0.6,
  platePadding    = 14,
  plateRadius     = 16,
  fontSize        = 56,
  fontFamily      = 'system-ui, -apple-system, sans-serif',
  fontWeight      = 800,
  textAlign       = 'center',
  letterSpacing,
  lineHeight      = 1.25,
  textTransform,
}) {
  const t = frame / fps

  const active = activeSegments(segments, t)
  if (!active.length) return null

  const theme = { frame, fps, t, color, accentColor, backgroundColor, plateOpacity, platePadding, plateRadius, fontSize, fontFamily, fontWeight, textAlign, letterSpacing, lineHeight, textTransform }
  return <>{captionGroups(active).map((g, i) => renderSegment(g.seg, g.seg.id ?? i, segmentTheme(g.seg, theme), g.lines.map(l => renderLine(l, segmentTheme(l, theme)))))}</>
}

/**
 * §244, caption translations. A translated segment carries `lang` and
 * `translationOf` (the ids of the source segments it translates) and no
 * words. It is drawn as its OWN plate, directly under the plate of the source
 * segment it translates (never inside it: one box per language), in one column
 * so the plates never overlap, each hugging its own text. The spoken-word accent
 * stays on the caption's plate. A translation whose source is not on screen draws
 * alone, as the only plate of its block. Same helpers as the other eight
 * templates (they can import nothing but montaj/render); keep isTranslation and
 * captionGroups identical in each (stack and the plate box are plate's own).
 */
function isTranslation(seg) {
  return typeof seg.lang === 'string' && Array.isArray(seg.translationOf)
}

function captionGroups(active) {
  const groups = active.filter(s => !isTranslation(s)).map(seg => ({ seg, lines: [] }))
  for (const tr of active) {
    if (!isTranslation(tr)) continue
    const group = groups.find(g => g.seg.id != null && tr.translationOf.includes(g.seg.id))
    if (group) group.lines.push(tr)
    else groups.push({ seg: tr, lines: [tr] })
  }
  return groups
}

/** The caption's plate, then each translation's plate under it with a small gap, aligned like the caption.
 *  With no translations it is the caption's plate itself, so nothing else changes. */
function stack(content, lines, textAlign) {
  if (!lines.length) return content
  const alignItems = textAlign === 'left' ? 'flex-start' : textAlign === 'right' ? 'flex-end' : 'center'
  return <div style={{ display: 'flex', flexDirection: 'column', alignItems, width: '100%', gap: 10 }}>{content}{lines}</div>
}

/** A translation's own plate: the caption's plate look (its theme, its colour rule), plain text, no accent. */
function renderLine(seg, th) {
  return plateBox(seg, th, seg.text, seg.id ?? seg.start)
}

/**
 * Every segment active at `t`, ordered by lane ascending — which IS the
 * z-order, since the blocks paint in this order and a higher lane therefore
 * lands on top. There is deliberately NO vertical offset per row: two
 * simultaneous captions draw at their own offsetX/offsetY and may overlap.
 * `sort` is stable, so segments sharing a lane keep document order.
 *
 * `seg.lane ?? 0` is duplicated here rather than imported from the editor's
 * `laneOf()` or from `@bycrux/timeline-core`'s `activeCaptionSegments`: a
 * caption template is standalone JSX compiled into the browser/Puppeteer
 * bundle and can import nothing but `montaj/render`. Deliberate duplication —
 * change the predicate or the lane default in timeline-core/src/captions.js
 * and in all the templates together, never in one alone.
 */
function activeSegments(segments, t) {
  return segments
    .filter(s => t >= s.start && t < s.end)
    .sort((a, b) => (a.lane ?? 0) - (b.lane ?? 0))
}

/** `#rrggbb` at `opacity` as rgba(); anything else (rgba(), a name) as it is. */
function plateBackground(backgroundColor, plateOpacity) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(backgroundColor).trim())
  if (!m) return backgroundColor
  const n = parseInt(m[1], 16)
  const a = Math.min(1, Math.max(0, Number(plateOpacity)))
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Number.isFinite(a) ? a : 0.6})`
}

/**
 * Hug the text: shrink the plate to its widest line plus the padding. CSS cannot
 * do this for wrapped text (the box stays as wide as the room it wrapped in),
 * so once the block is laid out the real lines are measured and the box gets
 * that width. Lines come from the rects of the text's own range, grouped by
 * their top edge; the padding is added when the box is border-box; a transformed ancestor (the editor preview's scaled frame,
 * a caption's own scale) is divided out through the box's on-screen over its
 * layout width. A couple of px of slack keeps the text from re-wrapping. No
 * layout (a test, a server) or nothing measured: the box is left as it was.
 */
function hug(el) {
  if (!el || !el.style) return
  el.style.width = ''
  try {
    const doc = el.ownerDocument
    if (!doc || typeof doc.createRange !== 'function') return
    const range = doc.createRange()
    range.selectNodeContents(el)
    const lines = new Map()
    for (const r of Array.from(range.getClientRects())) {
      if (!(r.width > 0)) continue
      const key = Math.round(r.top / 4)
      const line = lines.get(key)
      if (line) { line.left = Math.min(line.left, r.left); line.right = Math.max(line.right, r.right) } else lines.set(key, { left: r.left, right: r.right })
    }
    if (!lines.size) return
    const widest = Math.max(...[...lines.values()].map(l => l.right - l.left))
    const box = el.getBoundingClientRect()
    const k = el.offsetWidth > 0 && box.width > 0 ? box.width / el.offsetWidth : 1
    // The box's own sizing: with border-box (the page's usual reset) the width includes the padding.
    const cs = doc.defaultView && doc.defaultView.getComputedStyle ? doc.defaultView.getComputedStyle(el) : null
    const pad = cs && cs.boxSizing === 'border-box' ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0
    const width = Math.ceil(widest / k) + pad + 2
    if (width > 2) el.style.width = `${width}px`
  } catch {
    // measuring is a nicety: never the reason a caption fails to draw
  }
}

/**
 * One plate: the box, its look from the theme, the text inside. `captionId` marks a translation's plate (the
 * caption's own plate is marked by its block). A plain function, not a component (see renderSegment).
 */
function plateBox(seg, { color, backgroundColor, plateOpacity, platePadding, plateRadius, fontSize, fontFamily, fontWeight, textAlign, letterSpacing, lineHeight, textTransform }, content, captionId) {
  return (
    <div
      key={captionId ?? undefined}
      ref={hug}
      data-caption-id={captionId == null ? undefined : seg.id}
      style={{
        background: plateBackground(backgroundColor, plateOpacity),
        borderRadius: plateRadius,
        padding: `${platePadding}px ${Math.round(platePadding * 1.6)}px`,
        maxWidth: '90%',
        textAlign,
        fontSize,
        fontWeight,
        fontFamily,
        letterSpacing,
        lineHeight,
        textTransform,
        color: seg.color ?? color,
      }}
    >
      {content}
    </div>
  )
}

/**
 * One segment's block. A plain function, NOT a `<Component/>`:
 * render/test/*.test.mjs call these templates as plain functions and read
 * style objects straight off the returned element tree, which only works while
 * every node is a host element.
 *
 * `data-caption-id` marks the subtree so the editor preview can measure ONE
 * caption's rect instead of the union of everything on screen (see
 * measureCaptionContentRect in editor/src/video/preview/captionDragState.ts).
 */
function renderSegment(seg, key, { frame, fps, t, color, accentColor, backgroundColor, plateOpacity, platePadding, plateRadius, fontSize, fontFamily, fontWeight, textAlign, letterSpacing, lineHeight, textTransform }, lines = []) {
  const segStartFrame = Math.round(seg.start * fps)
  const segEndFrame   = Math.round(seg.end   * fps)
  const opacity = Math.min(
    interpolate(frame - segStartFrame, [0, 5], [0, 1]),
    interpolate(segEndFrame - frame, [0, 4], [0, 1]),
  )

  // A translation is only ever the plate under its caption's (renderLine), never the caption itself.
  const words = isTranslation(seg) ? [] : (seg.words || [])

  // Active word: the one being spoken right now, or (between words) the last
  // word that has already started — the highlight jumps whole-word.
  let activeIndex = -1
  if (words.length) {
    activeIndex = words.findIndex(w => t >= w.start && t < w.end)
    if (activeIndex === -1) {
      for (let i = words.length - 1; i >= 0; i--) {
        if (words[i].start <= t) { activeIndex = i; break }
      }
    }
  }

  // §558: a word's own colour (words[].color) shows except while it is spoken
  const captionText = words.length ? words.flatMap((w, i) => [
    // A real space between words, outside the spans: an inline-block (the lit word, which lifts) swallows a
    // leading space, and a margin would leave a gap at the end of a wrapped line.
    i > 0 ? ' ' : null,
    <span
      key={i}
      style={i === activeIndex ? { display: 'inline-block', color: accentColor, transform: 'scale(1.06)' } : (w.color ? { color: w.color } : undefined)}
    >
      {w.word}
    </span>,
  ]) : seg.text

  return (
    <div key={key} style={captionOuterStyle(seg)} data-caption-id={seg.id}>
      <div style={captionInnerStyle(seg, {
        // 25% to match every other caption style, so switching styles keeps the
        // caption in the same area of the frame.
        bottom: '25%',
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        padding: '0 6%',
        opacity,
      })}>
        {stack(isTranslation(seg) ? null : plateBox(seg, { color, backgroundColor, plateOpacity, platePadding, plateRadius, fontSize, fontFamily, fontWeight, textAlign, letterSpacing, lineHeight, textTransform }, captionText, null), lines, textAlign)}
      </div>
    </div>
  )
}

/**
 * One segment's theme: a styling field set on the segment wins over the
 * track's (the props above), which wins over this template's default. Only
 * fields this template's theme already carries are taken, and a segment with
 * none of them gets the theme object itself, so a project without per-caption
 * styling renders exactly as before. Duplicated in all nine templates (they
 * can import nothing but montaj/render); keep the list identical in each and
 * in step with the editor's video/captionSegmentStyle.ts.
 */
const SEGMENT_STYLE_FIELDS = ['color', 'fontSize', 'fontFamily', 'fontWeight', 'textTransform', 'textAlign', 'letterSpacing', 'lineHeight', 'accentColor', 'highlightColor', 'activeColor', 'backgroundColor', 'plateOpacity', 'platePadding', 'plateRadius']
function segmentTheme(seg, theme) {
  let out = theme
  for (const k of SEGMENT_STYLE_FIELDS) {
    if (seg[k] == null || !(k in theme)) continue
    if (out === theme) out = { ...theme }
    out[k] = seg[k]
  }
  return out
}
