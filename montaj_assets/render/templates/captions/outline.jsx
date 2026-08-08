import { interpolate, captionOuterStyle, captionInnerStyle } from 'montaj/render'

/**
 * All words of the active segment visible at once, heavy black stroke,
 * all-caps stencil look. Only the currently-spoken word is filled with the
 * accent colour — whole word at once, no gradual karaoke fill, no scale/pop.
 * segments: caption track segments array from project.json
 */
export default function Outline({
  frame, fps,
  segments    = [],
  color       = '#ffffff',
  accentColor = '#fbbf24',
  fontSize    = 80,
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

  // Active word: strictly the word being spoken right now. No fallback to
  // the last-started word — between words, nothing is highlighted.
  const activeIndex = words.findIndex(w => t >= w.start && t < w.end)

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
          fontSize,
          fontWeight: 900,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          textTransform: 'uppercase',
          lineHeight: 1.15,
          WebkitTextStroke: '9px #000000',
          paintOrder: 'stroke fill',
          textShadow: '0 6px 18px rgba(0,0,0,0.55)',
        }}>
          {words.map((w, i) => (
            <span
              key={i}
              style={{
                display: 'inline-block',
                marginRight: i === words.length - 1 ? 0 : '0.35em',
                color: i === activeIndex ? accentColor : (seg.color ?? color),
              }}
            >
              {w.word}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
