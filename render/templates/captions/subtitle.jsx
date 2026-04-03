import { interpolate } from 'montaj/render'

/**
 * Standard subtitle block. Full segment text visible at once, fades in at segment start.
 * segments: caption track segments array from project.json
 */
export default function Subtitle({
  frame, fps,
  segments        = [],
  color           = '#ffffff',
  backgroundColor = 'rgba(0,0,0,0.6)',
  fontSize        = 46,
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
      bottom: '8%',
      left: 0,
      right: 0,
      display: 'flex',
      justifyContent: 'center',
      padding: '0 6%',
      opacity,
    }}>
      <div style={{
        background: backgroundColor,
        color,
        fontSize,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontWeight: 600,
        padding: '8px 18px',
        borderRadius: 6,
        lineHeight: 1.4,
        textAlign: 'center',
        maxWidth: '90%',
        textShadow: '0 1px 4px rgba(0,0,0,0.5)',
      }}>
        {seg.text}
      </div>
    </div>
  )
}
