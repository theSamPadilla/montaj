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

  return <>{active.map((seg, i) => renderSegment(seg, seg.id ?? i, { frame, fps, t, color, highlightColor, fontSize, fontFamily, fontWeight, textAlign, letterSpacing, lineHeight, textTransform }))}</>
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
function renderSegment(seg, key, { frame, fps, t, color, highlightColor, fontSize, fontFamily, fontWeight, textAlign, letterSpacing, lineHeight, textTransform }) {
  const words = seg.words || []
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
          bottom: '18%',
          left: 0,
          right: 0,
          textAlign,
          padding: '0 8%',
          opacity,
        })}>
          <span style={{
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
          </span>
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
        bottom: '18%',
        left: 0,
        right: 0,
        textAlign,
        padding: '0 8%',
        opacity: fadeOpacity,
      })}>
        <div style={{
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
        </div>
      </div>
    </div>
  )
}
