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
  // Entry envelope with a NON-ZERO FLOOR. History, because the floor looks
  // arbitrary without it: a 4-frame fade from 0 meant any word shorter than
  // ~130ms was replaced before its fade reached visibility; shrinking to 2
  // frames helped two-frame words but still opened at 0, so a one-frame word
  // rendered once, at opacity 0, and was simply never seen. Measured on real
  // projects, about 1 caption word in 20 lasts under two frames on a
  // word-by-word project (robotics-ban 14/287, ai-safety 15/278).
  //
  // Starting at 0.55 means a word is legible on its very first frame, which is
  // the only frame some words get. The spring `sc` still carries the entrance,
  // so this reads as a snappier pop rather than a missing fade — and every word
  // past frame 2 is unchanged at full opacity.
  //
  // STILL NOT FIXED HERE: a word shorter than one frame interval can fail to
  // contain any frame's timestamp, so `activeWord` never selects it and no
  // opacity curve can help. That needs a minimum-duration floor at
  // transcription time. Regression coverage: test/caption-short-words.test.mjs.
  const opacity = interpolate(wordFrame, [0, 2], [0.55, 1])

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
