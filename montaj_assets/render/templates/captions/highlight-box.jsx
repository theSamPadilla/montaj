import { interpolate, captionOuterStyle, captionInnerStyle } from 'montaj/render'

/**
 * Full segment text visible at once. The currently-spoken word is highlighted
 * inside a rounded accent-colour box that hops from word to word — no
 * gradual sweep, the box just appears on whichever word is active.
 * segments: caption track segments array from project.json
 */
export default function HighlightBox({
  frame, fps,
  segments    = [],
  color       = '#ffffff',
  accentColor = '#fbbf24',
  fontSize    = 68,
}) {
  const t = frame / fps

  const seg = segments.find(s => t >= s.start && t < s.end)
  if (!seg) return null

  const words = seg.words || []
  if (!words.length) {
    // No word timestamps — fall back to plain text with a short fade-in
    const segStartFrame = Math.round(seg.start * fps)
    const opacity = interpolate(frame, [segStartFrame, segStartFrame + 5], [0, 1])
    return (
      <div style={captionOuterStyle(seg)}>
        <div style={captionInnerStyle(seg, {
          bottom: '18%',
          left: 0,
          right: 0,
          textAlign: 'center',
          padding: '0 6%',
          opacity,
        })}>
          <span style={{
            fontSize,
            fontWeight: 900,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            color: seg.color ?? color,
            textShadow: '0 2px 12px rgba(0,0,0,0.85)',
          }}>
            {seg.text}
          </span>
        </div>
      </div>
    )
  }

  // Active word: the one being spoken right now, or (between words) the
  // last word that has already started — the box jumps whole-word, never
  // sweeps mid-word.
  let activeIndex = words.findIndex(w => t >= w.start && t < w.end)
  if (activeIndex === -1) {
    for (let i = words.length - 1; i >= 0; i--) {
      if (words[i].start <= t) { activeIndex = i; break }
    }
  }

  return (
    <div style={captionOuterStyle(seg)}>
      <div style={captionInnerStyle(seg, {
        bottom: '18%',
        left: 0,
        right: 0,
        textAlign: 'center',
        padding: '0 6%',
      })}>
        <div style={{
          display: 'inline-flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'center',
          gap: '0.3em',
          fontSize,
          fontWeight: 900,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          lineHeight: 1.25,
        }}>
          {words.map((w, i) => {
            const active = i === activeIndex
            return (
              <span
                key={i}
                style={active ? {
                  background: accentColor,
                  color: '#111111',
                  borderRadius: 14,
                  padding: '4px 18px',
                  transform: 'scale(1.08)',
                } : {
                  color: seg.color ?? color,
                  textShadow: '0 2px 12px rgba(0,0,0,0.85)',
                }}
              >
                {w.word}
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}
