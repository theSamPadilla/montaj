import { interpolate, captionOuterStyle, captionInnerStyle } from 'montaj/render'

/**
 * Phrase: one caption is one phrase (a clause or a sentence, up to about two
 * lines), set under a short rule and BUILT word by word as it is spoken. The
 * phrase is laid out whole from its first frame: an unspoken word is hidden
 * (opacity 0), never absent, so nothing reflows as it builds. Each word fades
 * in from its own start over `wordFade` seconds (smoothstep), computed from
 * the fractional time (motion blur samples between frames); the rule appears
 * with the first word, and the block fades out over its last 4 frames.
 *
 * A word's `accent` ('serif', 'sans' or 'script', the per-word field the
 * `accent` style reads) draws it in `accentColor`; 'serif' and 'script' also
 * take the accent face (`accentFontFamily`, `accentFontStyle`,
 * `accentFontWeight`) at `accentScale` times the size. A word's own `color`
 * (§558) wins over both.
 *
 * Every look is a prop with a fallback default. Layout: the block's box hugs
 * its text, at most `maxWidth` of the frame wide; its bottom sits
 * `insetBottom` up the frame and, aligned left (the default) or right, its
 * edge `insetX` in from that side; centred, it is centred. The box is the
 * block, so a segment `scale` (captionInnerStyle) grows it in place.
 * segments: caption track segments array from project.json
 *
 * Captions have LANES (rows), so more than one segment can be active at the
 * same instant. Every active one is drawn — see activeSegments below.
 */
const ACCENTS = new Set(['serif', 'sans', 'script'])

export default function Phrase({
  frame, fps,
  segments         = [],
  color            = '#ffffff',
  accentColor      = '#fbbf24',
  fontSize         = 64,
  fontFamily       = 'system-ui, -apple-system, sans-serif',
  fontWeight       = 600,
  textAlign        = 'left',
  letterSpacing    = '-0.01em',
  lineHeight       = 1.18,
  textTransform,
  textShadow       = '0 2px 12px rgba(0,0,0,0.6)',
  // The accent words' face ('serif' and 'script'); 'sans' keeps the running font.
  accentFontFamily = '"Playfair Display", Georgia, serif',
  accentFontStyle  = 'italic',
  accentFontWeight = 700,
  accentScale      = 1.08,
  // Each word's fade in, in seconds.
  wordFade         = 0.1,
  // The rule above the block: its colour (default: the accent colour in force),
  // thickness, length and gap to the text in px, and the share of its length
  // drawn solid before it fades out.
  showRule         = true,
  ruleColor,
  ruleWidth        = 4,
  ruleLength       = 336,
  ruleGap          = 40,
  ruleSolid        = 0.55,
  // A CSS length or a px number each, of the frame.
  maxWidth         = '75%',
  insetX           = '6%',
  insetBottom      = '13%',
}) {
  const t = frame / fps

  const active = activeSegments(segments, t)
  if (!active.length) return null

  const theme = {
    frame, fps, t, color, accentColor, fontSize, fontFamily, fontWeight, textAlign, letterSpacing, lineHeight, textTransform, textShadow,
    accentFontFamily, accentFontStyle, accentFontWeight, accentScale, wordFade,
    showRule, ruleColor, ruleWidth, ruleLength, ruleGap, ruleSolid, maxWidth, insetX, insetBottom,
  }
  return <>{captionGroups(active).map((g, i) => renderSegment(g.seg, g.seg.id ?? i, segmentTheme(g.seg, theme), g.lines.map(l => renderLine(l, segmentTheme(l, theme), isDark(g.seg)))))}</>
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

/**
 * §244, caption translations. A translated segment carries `lang` and
 * `translationOf` (the ids of the source segments it translates) and no
 * words. It is never drawn as a caption of its own: it stacks under the
 * source segment it translates, as a plain line inside that segment's
 * anchored box (renderLine, below), so the browser measures the stack in
 * every style and the rows never collide. A translation whose source is not
 * on screen draws alone, as the only line of its own block. Duplicated in all
 * the templates (they can import nothing but montaj/render); keep
 * isTranslation, captionGroups and stack identical in each.
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

/** The caption, then its translations under it, aligned like the caption.
 *  With no translations it is the caption itself, so nothing else changes. */
function stack(content, lines, textAlign) {
  if (!lines.length) return content
  const alignItems = textAlign === 'left' ? 'flex-start' : textAlign === 'right' ? 'flex-end' : 'center'
  return <div style={{ display: 'flex', flexDirection: 'column', alignItems, width: '100%', gap: 10 }}>{content}{lines}</div>
}

/** A word's (or the whole text's) fade in from `start`: smoothstep over `dur` seconds, from the fractional time. */
function fadeIn(t, start, dur) {
  const d = Number(dur)
  if (!(d > 0)) return t >= start ? 1 : 0
  const x = Math.min(1, Math.max(0, (t - start) / d))
  return x * x * (3 - 2 * x)
}

/** 'left', 'right' or 'center': where the block anchors. Anything but right or centre anchors left. */
function sideOf(textAlign) {
  return textAlign === 'right' || textAlign === 'end' ? 'right' : textAlign === 'center' ? 'center' : 'left'
}

/** The anchor box: the block itself (it hugs its text), bottom-anchored, on its side of the frame. */
function anchor(seg, th, side, opacity) {
  const place = side === 'right' ? { right: th.insetX }
    : side === 'left' ? { left: th.insetX }
      : { left: 0, right: 0, marginLeft: 'auto', marginRight: 'auto', width: 'fit-content' }
  return captionInnerStyle(seg, { bottom: th.insetBottom, ...place, maxWidth: th.maxWidth, textAlign: th.textAlign, opacity })
}

/** The rule: solid from the aligned edge for `ruleSolid` of its length, then fading out (centred: out to both ends). */
function rule(th, side, color, opacity) {
  const solid = Math.round(Math.min(1, Math.max(0, Number(th.ruleSolid) || 0)) * 100)
  const background = side === 'center'
    ? `linear-gradient(to right, transparent 0%, ${color} ${(100 - solid) / 2}%, ${color} ${(100 + solid) / 2}%, transparent 100%)`
    : `linear-gradient(${side === 'right' ? 'to left' : 'to right'}, ${color} 0%, ${color} ${solid}%, transparent 100%)`
  return (
    <div key="rule" style={{
      width: th.ruleLength,
      maxWidth: '100%',
      height: th.ruleWidth,
      marginBottom: th.ruleGap,
      marginLeft: side === 'left' ? 0 : 'auto',
      marginRight: side === 'right' ? 0 : 'auto',
      background,
      opacity,
    }} />
  )
}

/** One word's style: its fade, and its accent face and colour (a word's own colour wins). */
function wordStyle(w, seg, th, opacity) {
  const kind = ACCENTS.has(w.accent) ? w.accent : null
  const style = { opacity }
  if (kind === 'serif' || kind === 'script') {
    style.fontFamily = th.accentFontFamily
    style.fontStyle = th.accentFontStyle
    style.fontWeight = th.accentFontWeight
    style.fontSize = `${th.accentScale}em`
  }
  if (w.color) style.color = inkOf(seg, w.color)
  else if (kind) style.color = inkOf(seg, th.accentColor)
  return style
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
function renderSegment(seg, key, th, lines = []) {
  const { frame, fps, t, color, accentColor, fontSize, fontFamily, fontWeight, textAlign, letterSpacing, lineHeight, textTransform, textShadow } = th
  const side = sideOf(textAlign)
  const segEndFrame = Math.round(seg.end * fps)
  const dark = isDark(seg)
  // A word starts no later than a wordFade before the caption ends (a caption trimmed in the editor moves only `end`).
  const startOf = w => Math.min(w.start ?? seg.start, seg.end - th.wordFade)
  const words = isTranslation(seg) ? [] : (seg.words || [])
  // The end fade runs over the last 4 frames, but never starts before the last word is fully in; when that is at or
  // past the caption's end there is no fade.
  const lastIn = words.length ? (startOf(words[words.length - 1]) + th.wordFade) * fps : seg.start * fps
  const fadeStart = Math.max(segEndFrame - 4, Math.round(lastIn))
  const endOpacity = fadeStart >= segEndFrame ? 1 : interpolate(segEndFrame - frame, [0, segEndFrame - fadeStart], [0, 1])

  let content = null
  if (!isTranslation(seg)) {
    // No word timestamps: the text fades in whole, from the caption's start.
    const first = words.length ? fadeIn(t, startOf(words[0]), th.wordFade) : fadeIn(t, seg.start, th.wordFade)
    const text = words.length
      ? words.flatMap((w, i) => [
        // A real space between words, outside the spans, so a wrapped line has no trailing gap.
        i > 0 ? ' ' : null,
        <span key={i} style={wordStyle(w, seg, th, fadeIn(t, startOf(w), th.wordFade))}>{w.word}</span>,
      ])
      : seg.text
    content = (
      <div style={{
        fontSize,
        fontWeight,
        fontFamily,
        letterSpacing,
        lineHeight,
        textTransform,
        color: dark ? INK : color,
        textShadow: dark ? 'none' : textShadow,
      }}>
        {th.showRule ? rule(th, side, inkOf(seg, th.ruleColor ?? accentColor), first) : null}
        <div style={words.length ? undefined : { opacity: first }}>{text}</div>
      </div>
    )
  }

  return (
    <div key={key} style={captionOuterStyle(seg)} data-caption-id={seg.id}>
      <div style={anchor(seg, th, side, endOpacity)}>
        {stack(content, lines, side)}
      </div>
    </div>
  )
}

/** §244: a translation under its caption, as karaoke's plain line: the base
 *  font and colour, no build and no accent; it fades in with its own start. */
function renderLine(seg, { t, color, fontSize, fontFamily, fontWeight, letterSpacing, lineHeight, textTransform, textShadow, wordFade }, dark = isDark(seg)) {
  return (
    <div key={seg.id ?? seg.start} data-caption-id={seg.id} style={{
      fontSize,
      fontWeight,
      fontFamily,
      color: dark ? INK : color,
      textShadow: dark ? 'none' : textShadow,
      letterSpacing,
      lineHeight,
      textTransform,
      opacity: fadeIn(t, seg.start, wordFade),
    }}>
      {seg.text}
    </div>
  )
}

/**
 * Caption ink. A segment with `ink: "dark"` (written by the caption_ink step
 * or chosen by a person) is drawn as dark ink on paper: the base text takes
 * INK and loses its outline and shadow. Accents (the spoken word, a word's
 * own colour) is darkened in its own hue to 4.5:1 (darkSafe); highlight-box's box stays. A translation stacked
 * under a caption takes the ink of the caption it sits under. Duplicated in
 * the text-over-picture templates (plate and subtitle draw their own box and
 * ignore it); keep INK and isDark identical in each.
 */
const INK = '#1c1c1e'
const isDark = seg => seg.ink === 'dark'

/**
 * Under dark ink a colour drawn as text (the spoken word, a word's own
 * colour, an accent run) is darkened in its own hue until it reaches 4.5:1
 * against the backdrop, so a yellow keyword on paper becomes a deep amber.
 * Backdrop: the caption_ink step's measured luminance (`inkAuto.backdrop`),
 * else 0.5, the step's threshold for light. A colour that already passes is
 * returned as given; one it cannot parse falls back to INK. Duplicated in
 * the templates that draw an accent; keep identical in each.
 */
const backdropOf = seg => {
  const b = seg.inkAuto?.backdrop
  return Number.isFinite(b) && b >= 0 && b <= 1 ? b : 0.5
}
const inkOf = (seg, color) => (isDark(seg) ? darkSafe(color, backdropOf(seg)) : color)
function darkSafe(color, backdrop) {
  const s = String(color ?? '').trim().toLowerCase()
  let rgb = null
  let m = /^#([0-9a-f]{3,4})$/.exec(s)
  if (m) rgb = [0, 1, 2].map(i => parseInt(m[1][i] + m[1][i], 16))
  else if ((m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s))) rgb = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16))
  else if ((m = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,[^)]*)?\)$/.exec(s))) rgb = [m[1], m[2], m[3]].map(Number)
  if (!rgb || rgb.some(c => c > 255)) return INK
  const lin = rgb.map(c => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const lum = v => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
  const target = Math.max(0, (backdrop + 0.05) / 4.5 - 0.05)
  if (lum(lin) <= target) return color
  let k = target / lum(lin)
  for (let i = 0; i < 60; i++, k *= 0.98) {
    const out = lin.map(c => Math.round(255 * (c * k <= 0.0031308 ? c * k * 12.92 : 1.055 * (c * k) ** (1 / 2.4) - 0.055)))
    if (lum(out.map(c => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) <= target || k < 1e-6) {
      return '#' + out.map(c => c.toString(16).padStart(2, '0')).join('')
    }
  }
  return INK
}

/**
 * One segment's theme: a styling field set on the segment wins over the
 * track's (the props above), which wins over this template's default. Only
 * fields this template's theme already carries are taken, and a segment with
 * none of them gets the theme object itself, so a project without per-caption
 * styling renders exactly as before. Duplicated in all ten templates (they
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
