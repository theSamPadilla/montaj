import { interpolate, captionOuterStyle, captionInnerStyle } from 'montaj/render'

/**
 * Full segment text visible at once. The currently-spoken word is highlighted
 * inside a rounded accent-colour box that hops from word to word — no
 * gradual sweep, the box just appears on whichever word is active.
 * segments: caption track segments array from project.json
 *
 * Captions have LANES (rows), so more than one segment can be active at the
 * same instant. Every active one is drawn — see activeSegments below.
 */
export default function HighlightBox({
  frame, fps,
  segments    = [],
  color       = '#ffffff',
  accentColor = '#fbbf24',
  fontSize    = 68,
}) {
  const t = frame / fps

  const active = activeSegments(segments, t)
  if (!active.length) return null

  return <>{active.map((seg, i) => renderSegment(seg, seg.id ?? i, { frame, fps, t, color, accentColor, fontSize }))}</>
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
function renderSegment(seg, key, { frame, fps, t, color, accentColor, fontSize }) {
  const words = seg.words || []
  if (!words.length) {
    // No word timestamps — fall back to plain text with a short fade-in
    const segStartFrame = Math.round(seg.start * fps)
    const opacity = interpolate(frame, [segStartFrame, segStartFrame + 5], [0, 1])
    return (
      <div key={key} style={captionOuterStyle(seg)} data-caption-id={seg.id}>
        <div style={captionInnerStyle(seg, {
          bottom: '18%',
          left: 0,
          right: 0,
          textAlign: 'center',
          padding: '0 6%',
          opacity,
        })}>
          <span style={{
            fontSize,
            fontWeight: 900,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            color: seg.color ?? color,
            textShadow: '0 2px 12px rgba(0,0,0,0.85)',
          }}>
            {seg.text}
          </span>
        </div>
      </div>
    )
  }

  // Active word: the one being spoken right now, or (between words) the
  // last word that has already started — the box jumps whole-word, never
  // sweeps mid-word.
  let activeIndex = words.findIndex(w => t >= w.start && t < w.end)
  if (activeIndex === -1) {
    for (let i = words.length - 1; i >= 0; i--) {
      if (words[i].start <= t) { activeIndex = i; break }
    }
  }

  return (
    <div key={key} style={captionOuterStyle(seg)} data-caption-id={seg.id}>
      <div style={captionInnerStyle(seg, {
        bottom: '18%',
        left: 0,
        right: 0,
        textAlign: 'center',
        padding: '0 6%',
      })}>
        <div style={{
          display: 'inline-flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'center',
          gap: '0.3em',
          fontSize,
          fontWeight: 900,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          lineHeight: 1.25,
        }}>
          {words.map((w, i) => {
            const active = i === activeIndex
            return (
              <span
                key={i}
                style={active ? {
                  background: accentColor,
                  color: '#111111',
                  borderRadius: 14,
                  padding: '4px 18px',
                  transform: 'scale(1.08)',
                } : {
                  color: seg.color ?? color,
                  textShadow: '0 2px 12px rgba(0,0,0,0.85)',
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
