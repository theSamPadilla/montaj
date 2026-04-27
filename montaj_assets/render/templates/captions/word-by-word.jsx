import { interpolate, spring } from 'montaj/render'

/**
 * One word visible at a time. Each word pops in with a spring scale.
 * segments: caption track segments array from project.json
 */
export default function WordByWord({
  frame, fps,
  segments = [],
  color    = '#ffffff',
  fontSize = 72,
}) {
  const t = frame / fps

  const seg = segments.find(s => t >= s.start && t < s.end)
  if (!seg) return null

  const words = seg.words || []
  if (!words.length) return null

  // Active word: the one being spoken right now, or the last spoken in this segment
  const activeWord = words.find(w => t >= w.start && t < w.end)
    ?? (t >= seg.start ? words[words.length - 1] : null)
  if (!activeWord) return null

  // Frames elapsed since this word started
  const wordFrame = Math.max(0, Math.round((t - activeWord.start) * fps))
  const sc = spring({ frame: wordFrame, fps, stiffness: 420, damping: 28 })
  const opacity = interpolate(wordFrame, [0, 4], [0, 1])

  return (
    <div style={{
      position: 'fixed',
      bottom: '18%',
      left: 0,
      right: 0,
      textAlign: 'center',
      padding: '0 8%',
    }}>
      <span style={{
        display: 'inline-block',
        fontSize,
        fontWeight: 800,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color,
        textShadow: '0 2px 12px rgba(0,0,0,0.85)',
        letterSpacing: '-0.02em',
        opacity,
        transform: `scale(${sc})`,
        transformOrigin: 'center bottom',
      }}>
        {activeWord.word}
      </span>
    </div>
  )
}
