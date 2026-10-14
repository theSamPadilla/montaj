import { interpolate, captionOuterStyle, captionInnerStyle } from 'montaj/render'

/**
 * All words in the segment shown at once. Words change from unhighlighted to highlighted
 * colour as they are spoken (left-to-right reveal).
 * segments: caption track segments array from project.json
 *
 * Captions have LANES (rows), so more than one segment can be active at the
 * same instant. Every active one is drawn — see activeSegments below.
 */
export default function Karaoke({
  frame, fps,
  segments      = [],
  color         = 'rgba(255,255,255,0.55)',
  highlightColor = '#ffffff',
  fontSize      = 52,
  fontFamily    = 'system-ui, -apple-system, sans-serif',
  fontWeight    = 700,
  textAlign     = 'center',
  letterSpacing,
  lineHeight,
  textTransform,
}) {
  const t = frame / fps

  const active = activeSegments(segments, t)
  if (!active.length) return null

  const theme = { frame, fps, t, color, highlightColor, fontSize, fontFamily, fontWeight, textAlign, letterSpacing, lineHeight, textTransform }
  return <>{captionGroups(active).map((g, i) => renderSegment(g.seg, g.seg.id ?? i, segmentTheme(g.seg, theme), g.lines.map(l => renderLine(l, segmentTheme(l, theme), frame, fps))))}</>
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
function renderSegment(seg, key, { frame, fps, t, color, highlightColor, fontSize, fontFamily, fontWeight, textAlign, letterSpacing, lineHeight, textTransform }, lines = []) {
  const words = isTranslation(seg) ? [] : (seg.words || [])
  if (!words.length) {
    // No word timestamps — fall back to plain text
    const opacity = interpolate(
      frame,
      [Math.round(seg.start * fps), Math.round(seg.start * fps) + 6],
      [0, 1],
    )
    return (
      <div key={key} style={captionOuterStyle(seg)} data-caption-id={seg.id}>
        <div style={captionInnerStyle(seg, {
          bottom: '25%',
          left: 0,
          right: 0,
          textAlign,
          padding: '0 8%',
          opacity,
        })}>
          {stack(isTranslation(seg) ? null : <span style={{
            fontSize,
            fontWeight,
            fontFamily,
            color: highlightColor,
            textShadow: '0 2px 12px rgba(0,0,0,0.85)',
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

  const segStartFrame = Math.round(seg.start * fps)
  const frameInSeg = frame - segStartFrame
  const fadeOpacity = interpolate(frameInSeg, [0, 6], [0, 1])

  return (
    <div key={key} style={captionOuterStyle(seg)} data-caption-id={seg.id}>
      <div style={captionInnerStyle(seg, {
        bottom: '25%',
        left: 0,
        right: 0,
        textAlign,
        padding: '0 8%',
        opacity: fadeOpacity,
      })}>
        {stack(<div style={{
          display: 'inline',
          fontSize,
          fontWeight,
          fontFamily,
          textShadow: '0 2px 12px rgba(0,0,0,0.85)',
          letterSpacing,
          lineHeight,
          textTransform,
        }}>
          {words.map((w, i) => {
            const spoken = t >= w.end
            const active = t >= w.start && t < w.end
            // Smooth reveal within the active word — use frames, not seconds
            const wordStartFrame = Math.round(w.start * fps)
            const wordEndFrame   = Math.round(w.end   * fps)
            const progress = active
              ? interpolate(frame, [wordStartFrame, wordEndFrame], [0, 1])
              : spoken ? 1 : 0
            const wordColor = spoken || active ? highlightColor : (seg.color ?? color)
            return (
              <span
                key={i}
                style={{
                  color: wordColor,
                  opacity: spoken ? 1 : active ? 0.6 + 0.4 * progress : 1,
                  marginRight: '0.28em',
                  display: 'inline-block',
                  transition: 'none',
                }}
              >
                {w.word}
              </span>
            )
          })}
        </div>, lines, textAlign)}
      </div>
    </div>
  )
}

/** §244: a translation under its caption, as karaoke's plain line: the
 *  spoken colour, no reveal (the box already fades in). */
function renderLine(seg, { fontSize, fontFamily, fontWeight, highlightColor, letterSpacing, lineHeight, textTransform }) {
  return (
    <div key={seg.id ?? seg.start} data-caption-id={seg.id} style={{
      fontSize,
      fontWeight,
      fontFamily,
      color: seg.color ?? highlightColor,
      textShadow: '0 2px 12px rgba(0,0,0,0.85)',
      letterSpacing,
      lineHeight,
      textTransform,
    }}>
      {seg.text}
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
