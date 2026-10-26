import { interpolate, captionOuterStyle, captionInnerStyle } from 'montaj/render'

/**
 * All words of the active segment visible at once, heavy black stroke,
 * all-caps stencil look. Only the currently-spoken word is filled with the
 * accent colour — whole word at once, no gradual karaoke fill, no scale/pop.
 * segments: caption track segments array from project.json
 *
 * Captions have LANES (rows), so more than one segment can be active at the
 * same instant. Every active one is drawn — see activeSegments below.
 */
export default function Outline({
  frame, fps,
  segments    = [],
  color       = '#ffffff',
  accentColor = '#fbbf24',
  // Smaller default than before (was 80): the heavy outline reads big, so a
  // lower size keeps this style compact and sitting a little lower in the frame
  // (Sam, 2026-08-25).
  fontSize    = 70,
  fontFamily    = 'system-ui, -apple-system, sans-serif',
  fontWeight    = 900,
  textAlign     = 'center',
  letterSpacing,
  // No shared default: the no-words fallback (below) renders with no
  // lineHeight today, while the words branch renders at 1.15 — the `??`
  // fallback at each call site preserves both current looks exactly when
  // this prop is absent, and still lets an explicit value reach both.
  lineHeight,
  // Same story for textTransform: the words branch is deliberately all-caps
  // ('uppercase' is this template's stencil look, not a placeholder), while
  // the fallback branch renders the segment text as-is. `??` per call site
  // again, not a shared default, to avoid uppercasing the fallback branch.
  textTransform,
}) {
  const t = frame / fps

  const active = activeSegments(segments, t)
  if (!active.length) return null

  const theme = { frame, fps, t, color, accentColor, fontSize, fontFamily, fontWeight, textAlign, letterSpacing, lineHeight, textTransform }
  return <>{captionGroups(active).map((g, i) => renderSegment(g.seg, g.seg.id ?? i, segmentTheme(g.seg, theme), g.lines.map(l => renderLine(l, segmentTheme(l, theme), frame, fps, isDark(g.seg)))))}</>
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
 * and in all seven templates together, never in one alone.
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
 * eight templates (they can import nothing but montaj/render); keep
 * isTranslation, captionGroups, stack and lineOpacity identical in each.
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

/** A plain line's fade, for templates whose box does not fade by itself. */
function lineOpacity(seg, frame, fps) {
  return Math.min(
    interpolate(frame - Math.round(seg.start * fps), [0, 5], [0, 1]),
    interpolate(Math.round(seg.end * fps) - frame, [0, 4], [0, 1]),
  )
}

/**
 * One segment's block — everything below the old `segments.find(...)`, moved
 * verbatim (both branches: the no-words fallback and the main words branch).
 * A plain function, NOT a `<Component/>`: render/test/*.test.mjs call these
 * templates as plain functions and read style objects straight off the
 * returned element tree, which only works while every node is a host element.
 *
 * `data-caption-id` marks the subtree so the editor preview can measure ONE
 * caption's rect instead of the union of everything on screen (see
 * measureCaptionContentRect in editor/src/video/preview/captionDragState.ts).
 */
function renderSegment(seg, key, { frame, fps, t, color, accentColor, fontSize, fontFamily, fontWeight, textAlign, letterSpacing, lineHeight, textTransform }, lines = []) {
  const words = isTranslation(seg) ? [] : (seg.words || [])
  if (!words.length) {
    // No word timestamps — fall back to plain text with a short fade-in
    const segStartFrame = Math.round(seg.start * fps)
    const opacity = interpolate(frame, [segStartFrame, segStartFrame + 5], [0, 1])
    return (
      <div key={key} style={captionOuterStyle(seg)} data-caption-id={seg.id}>
        <div style={captionInnerStyle(seg, {
          bottom: '25%',
          left: 0,
          right: 0,
          textAlign,
          padding: '0 6%',
          // A translation drawn alone fades by its own line (lineOpacity).
          opacity: isTranslation(seg) ? 1 : opacity,
        })}>
          {stack(isTranslation(seg) ? null : <span style={{
            fontSize,
            fontWeight,
            fontFamily,
            color: isDark(seg) ? INK : (seg.color ?? color),
            textShadow: isDark(seg) ? 'none' : '0 2px 12px rgba(0,0,0,0.85)',
            letterSpacing,
            lineHeight,
            textTransform,
          }}>
            {seg.text}
          </span>, lines, textAlign)}
        </div>
      </div>
    )
  }

  // Active word: strictly the word being spoken right now. No fallback to
  // the last-started word — between words, nothing is highlighted.
  const activeIndex = words.findIndex(w => t >= w.start && t < w.end)

  return (
    <div key={key} style={captionOuterStyle(seg)} data-caption-id={seg.id}>
      <div style={captionInnerStyle(seg, {
        bottom: '25%',
        left: 0,
        right: 0,
        textAlign,
        padding: '0 6%',
      })}>
        {stack(<div style={{
          fontSize,
          fontWeight,
          fontFamily,
          letterSpacing,
          textTransform: textTransform ?? 'uppercase',
          lineHeight: lineHeight ?? 1.15,
          ...(isDark(seg) ? { textShadow: 'none' } : {
            WebkitTextStroke: '9px #000000',
            paintOrder: 'stroke fill',
            textShadow: '0 6px 18px rgba(0,0,0,0.55)',
          }),
        }}>
          {words.map((w, i) => (
            <span
              key={i}
              style={{
                display: 'inline-block',
                marginRight: i === words.length - 1 ? 0 : '0.35em',
                // §558: a word's own colour (words[].color) shows except while it is spoken
                color: i === activeIndex ? inkOf(seg, accentColor) : (w.color ? inkOf(seg, w.color) : (isDark(seg) ? INK : (seg.color ?? color))),
              }}
            >
              {w.word}
            </span>
          ))}
        </div>, lines, textAlign)}
      </div>
    </div>
  )
}

/** §244: a translation under its caption, in outline's stencil look (stroke,
 *  caps) with no word highlighted. */
function renderLine(seg, { color, fontSize, fontFamily, fontWeight, letterSpacing, lineHeight, textTransform }, frame, fps, dark = isDark(seg)) {
  return (
    <div key={seg.id ?? seg.start} data-caption-id={seg.id} style={{
      fontSize,
      fontWeight,
      fontFamily,
      letterSpacing,
      textTransform: textTransform ?? 'uppercase',
      lineHeight: lineHeight ?? 1.15,
      ...(dark ? { textShadow: 'none' } : {
        WebkitTextStroke: '9px #000000',
        paintOrder: 'stroke fill',
        textShadow: '0 6px 18px rgba(0,0,0,0.55)',
      }),
      color: dark ? INK : (seg.color ?? color),
      opacity: lineOpacity(seg, frame, fps),
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
 * the seven text-over-picture templates (plate and subtitle draw their own
 * box and ignore it); keep INK and isDark identical in each.
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
