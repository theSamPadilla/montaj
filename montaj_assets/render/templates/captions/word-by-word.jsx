import { interpolate, spring, captionOuterStyle, captionInnerStyle } from 'montaj/render'

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
  // A 4-frame fade meant any word shorter than ~130ms was replaced before its
  // own fade reached visibility. Measured across two real projects, 12.2% of
  // caption words are sub-100ms. A 2-frame envelope brings two-frame words to
  // 50% opacity on their second frame instead of 25%.
  //
  // KNOWN LIMIT: this still starts at opacity 0, so a one-frame word (18 of 69
  // sub-100ms words measured) never becomes visible, and a zero-frame word (11
  // of 69) has no frame to render on at all. Closing the one-frame case needs a
  // non-zero floor — interpolate(wordFrame, [0, 2], [0.55, 1]) — which changes
  // how every word enters and is a separate decision.
  const opacity = interpolate(wordFrame, [0, 2], [0, 1])

  return (
    <div style={captionOuterStyle(seg)}>
      {/* Segment scale lives on this middle anchor box, not the word <span> below —
          that span already carries its own spring pop-in `transform: scale(...)`, and
          merging the two transforms would corrupt the pop animation. */}
      <div style={captionInnerStyle(seg, {
        bottom: '18%',
        left: 0,
        right: 0,
        textAlign: 'center',
        padding: '0 8%',
      })}>
        <span style={{
          display: 'inline-block',
          fontSize,
          fontWeight: 800,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          color: seg.color ?? color,
          textShadow: '0 2px 12px rgba(0,0,0,0.85)',
          letterSpacing: '-0.02em',
          opacity,
          transform: `scale(${sc})`,
          transformOrigin: 'center bottom',
        }}>
          {activeWord.word}
        </span>
      </div>
    </div>
  )
}
