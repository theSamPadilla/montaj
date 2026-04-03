import { interpolate, spring } from 'montaj/render'

/**
 * Each word scales in with a spring bounce, then fades out as the next word starts.
 * segments: caption track segments array from project.json
 */
export default function Pop({
  frame, fps,
  segments    = [],
  color       = '#ffffff',
  activeColor = '#ffe600',
  fontSize    = 68,
}) {
  const t = frame / fps

  const seg = segments.find(s => t >= s.start && t < s.end)
  if (!seg) return null

  const words = seg.words || []
  if (!words.length) return null

  const activeIdx = words.findIndex(w => t >= w.start && t < w.end)
  const activeWord = activeIdx >= 0 ? words[activeIdx] : null
  if (!activeWord) return null

  // Frames elapsed since word start (for entry spring)
  const wordFrame = Math.max(0, Math.round((t - activeWord.start) * fps))

  // How close to the next word (for exit fade)
  const wordDuration = (activeWord.end - activeWord.start) * fps
  const exitOpacity = interpolate(wordFrame, [Math.max(1, wordDuration - 6), wordDuration], [1, 0.3])

  const sc = spring({ frame: wordFrame, fps, stiffness: 500, damping: 24 })
  const entryOpacity = interpolate(wordFrame, [0, 3], [0, 1])
  const opacity = Math.min(entryOpacity, exitOpacity)

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
        color: activeColor,
        textShadow: '0 0 30px rgba(255,230,0,0.4), 0 2px 12px rgba(0,0,0,0.85)',
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
