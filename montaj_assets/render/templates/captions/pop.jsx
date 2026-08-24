import { interpolate, spring, captionOuterStyle, captionInnerStyle } from 'montaj/render'

/**
 * Each word scales in with a spring bounce, then fades out as the next word starts.
 * segments: caption track segments array from project.json
 *
 * Captions have LANES (rows), so more than one segment can be active at the
 * same instant. Every active one is drawn — see activeSegments below.
 */
export default function Pop({
  frame, fps,
  segments    = [],
  color       = '#ffffff',
  activeColor = '#ffe600',
  fontSize    = 68,
  fontFamily    = 'system-ui, -apple-system, sans-serif',
  fontWeight    = 800,
  textAlign     = 'center',
  letterSpacing = '-0.02em',
  lineHeight,
  textTransform,
}) {
  const t = frame / fps

  const active = activeSegments(segments, t)
  if (!active.length) return null

  return <>{active.map((seg, i) => renderSegment(seg, seg.id ?? i, { fps, t, activeColor, fontSize, fontFamily, fontWeight, textAlign, letterSpacing, lineHeight, textTransform }))}</>
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
 * TWO load-bearing guards live in here and must survive any restructuring of
 * this file: the entry envelope's non-zero floor, and the `wordDuration > 6`
 * wrapper around the exit fade. Both exist so a short word is visible at all;
 * see their own comments below and test/caption-short-words.test.mjs.
 *
 * `data-caption-id` marks the subtree so the editor preview can measure ONE
 * caption's rect instead of the union of everything on screen (see
 * measureCaptionContentRect in editor/src/video/preview/captionDragState.ts).
 */
function renderSegment(seg, key, { fps, t, activeColor, fontSize, fontFamily, fontWeight, textAlign, letterSpacing, lineHeight, textTransform }) {
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
  // the measurements. A generation-time floor (steps/lyrics/caption.py's
  // floor_word_durations) now rescues most sub-frame words before they ever
  // reach render — but it is deliberately partial, and word-by-word.jsx
  // documents the three sources that still survive it. This opacity floor
  // is what catches the ones that do, so it must NOT be removed as
  // redundant with the generation-time one: the two are jointly necessary,
  // and dropping either brings the invisible-word bug back for a subset of
  // captions rather than all of them. Regression coverage:
  // test/caption-short-words.test.mjs.
  const entryOpacity = interpolate(wordFrame, [0, 2], [0.55, 1])
  const opacity = Math.min(entryOpacity, exitOpacity)

  return (
    <div key={key} style={captionOuterStyle(seg)} data-caption-id={seg.id}>
      {/* Segment scale lives on this middle anchor box, not the word <span> below —
          that span already carries its own spring pop-in `transform: scale(...)`, and
          merging the two transforms would corrupt the pop animation. */}
      <div style={captionInnerStyle(seg, {
        bottom: '18%',
        left: 0,
        right: 0,
        textAlign,
        padding: '0 8%',
      })}>
        <span style={{
          display: 'inline-block',
          fontSize,
          fontWeight,
          fontFamily,
          color: activeColor,
          textShadow: '0 0 30px rgba(255,230,0,0.4), 0 2px 12px rgba(0,0,0,0.85)',
          letterSpacing,
          lineHeight,
          textTransform,
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
