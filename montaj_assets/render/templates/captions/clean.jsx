import { interpolate } from 'montaj/render'

/**
 * Plain sentence-case subtitle. Full segment text visible at once, no
 * background box — just text over the footage. Fades in/out at segment
 * edges, same pattern as subtitle.jsx.
 * segments: caption track segments array from project.json
 */
export default function Clean({
  frame, fps,
  segments = [],
  color    = '#ffffff',
  fontSize = 54,
}) {
  const t = frame / fps

  const seg = segments.find(s => t >= s.start && t < s.end)
  if (!seg) return null

  const segStartFrame = Math.round(seg.start * fps)
  const segEndFrame   = Math.round(seg.end   * fps)
  const frameInSeg    = frame - segStartFrame
  const framesLeft    = segEndFrame - frame

  const opacity = Math.min(
    interpolate(frameInSeg, [0, 5], [0, 1]),
    interpolate(framesLeft, [0, 4], [0, 1]),
  )

  return (
    <div style={{
      position: 'fixed',
      bottom: '10%',
      left: 0,
      right: 0,
      display: 'flex',
      justifyContent: 'center',
      padding: '0 7%',
      opacity,
    }}>
      <div style={{
        color,
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
  )
}
