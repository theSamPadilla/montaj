import { interpolate } from 'montaj/render'

/**
 * All words in the segment shown at once. Words change from unhighlighted to highlighted
 * colour as they are spoken (left-to-right reveal).
 * segments: caption track segments array from project.json
 */
export default function Karaoke({
  frame, fps,
  segments      = [],
  color         = 'rgba(255,255,255,0.55)',
  highlightColor = '#ffffff',
  fontSize      = 52,
}) {
  const t = frame / fps

  const seg = segments.find(s => t >= s.start && t < s.end)
  if (!seg) return null

  const words = seg.words || []
  if (!words.length) {
    // No word timestamps — fall back to plain text
    const opacity = interpolate(
      frame,
      [Math.round(seg.start * fps), Math.round(seg.start * fps) + 6],
      [0, 1],
    )
    return (
      <div style={{
        position: 'fixed',
        bottom: '18%',
        left: 0,
        right: 0,
        textAlign: 'center',
        padding: '0 8%',
        opacity,
      }}>
        <span style={{
          fontSize,
          fontWeight: 700,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          color: highlightColor,
          textShadow: '0 2px 12px rgba(0,0,0,0.85)',
        }}>
          {seg.text}
        </span>
      </div>
    )
  }

  const segStartFrame = Math.round(seg.start * fps)
  const frameInSeg = frame - segStartFrame
  const fadeOpacity = interpolate(frameInSeg, [0, 6], [0, 1])

  return (
    <div style={{
      position: 'fixed',
      bottom: '18%',
      left: 0,
      right: 0,
      textAlign: 'center',
      padding: '0 8%',
      opacity: fadeOpacity,
    }}>
      <div style={{
        display: 'inline',
        fontSize,
        fontWeight: 700,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        textShadow: '0 2px 12px rgba(0,0,0,0.85)',
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
          const wordColor = spoken || active ? highlightColor : color
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
  )
}
