import { interpolate, spring, captionOuterStyle, captionInnerStyle } from 'montaj/render'

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

  // How close to the next word (for exit fade). The 6-frame fade only applies
  // when the word is long enough to have room for one.
  //
  // The previous `Math.max(1, wordDuration - 6)` guard looked like it was
  // preventing a degenerate range but was creating one: on a one-frame word it
  // produced [1, 1], and `interpolate` returns the END of the output range when
  // inHi === inLo (helpers.js:29), so exitOpacity came out 0.3 — the word was
  // rendered fully faded-OUT on the only frame it had. That, not the entry
  // envelope, is why a one-frame `pop` word stayed invisible even after the
  // entry floor landed. Any word of 6 frames or fewer hit some version of it.
  const wordDuration = (activeWord.end - activeWord.start) * fps
  const exitOpacity = wordDuration > 6
    ? interpolate(wordFrame, [wordDuration - 6, wordDuration], [1, 0.3])
    : 1

  const sc = spring({ frame: wordFrame, fps, stiffness: 500, damping: 24 })
  // 2-frame entry envelope with a non-zero floor, matching word-by-word.jsx —
  // `pop` is the other per-word template and shared the same defect: a word
  // shorter than the envelope was replaced before its fade reached visibility,
  // and a one-frame word rendered once at opacity 0 and was never seen.
  // Starting at 0.55 makes the first frame legible; see word-by-word.jsx for
  // the measurements and the sub-one-frame case this still does not cover.
  // Regression coverage: test/caption-short-words.test.mjs.
  const entryOpacity = interpolate(wordFrame, [0, 2], [0.55, 1])
  const opacity = Math.min(entryOpacity, exitOpacity)

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
    </div>
  )
}
