import { interpolate, captionOuterStyle, captionInnerStyle } from 'montaj/render'

/**
 * Plain sentence-case subtitle. Full segment text visible at once, no
 * background box — just text over the footage. Fades in/out at segment
 * edges, same pattern as subtitle.jsx.
 * segments: caption track segments array from project.json
 *
 * Captions have LANES (rows), so more than one segment can be active at the
 * same instant. Every active one is drawn — see activeSegments below.
 */
export default function Clean({
  frame, fps,
  segments = [],
  color    = '#ffffff',
  fontSize = 54,
}) {
  const t = frame / fps

  const active = activeSegments(segments, t)
  if (!active.length) return null

  return <>{active.map((seg, i) => renderSegment(seg, seg.id ?? i, { frame, fps, color, fontSize }))}</>
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
 * verbatim. A plain function, NOT a `<Component/>`: render/test/*.test.mjs call
 * these templates as plain functions and read style objects straight off the
 * returned element tree, which only works while every node is a host element.
 *
 * `data-caption-id` marks the subtree so the editor preview can measure ONE
 * caption's rect instead of the union of everything on screen (see
 * measureCaptionContentRect in editor/src/video/preview/captionDragState.ts).
 */
function renderSegment(seg, key, { frame, fps, color, fontSize }) {
  const segStartFrame = Math.round(seg.start * fps)
  const segEndFrame   = Math.round(seg.end   * fps)
  const frameInSeg    = frame - segStartFrame
  const framesLeft    = segEndFrame - frame

  const opacity = Math.min(
    interpolate(frameInSeg, [0, 5], [0, 1]),
    interpolate(framesLeft, [0, 4], [0, 1]),
  )

  return (
    <div key={key} style={captionOuterStyle(seg)} data-caption-id={seg.id}>
      <div style={captionInnerStyle(seg, {
        bottom: '10%',
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        padding: '0 7%',
        opacity,
      })}>
        <div style={{
          color: seg.color ?? color,
          fontSize,
          fontFamily: '"Figtree", system-ui, sans-serif',
          fontWeight: 700,
          lineHeight: 1.3,
          textAlign: 'center',
          maxWidth: '92%',
          letterSpacing: '0.01em',
          textShadow: '0 2px 10px rgba(0,0,0,0.75), 0 0 34px rgba(0,0,0,0.45)',
        }}>
          {seg.text}
        </div>
      </div>
    </div>
  )
}
