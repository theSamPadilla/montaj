/**
 * static-text.jsx — Static text overlay for carousel slides.
 *
 * No animation. Ignores frame/fps/duration. Renders one styled string,
 * sized to fill the overlay's element box. The slide.jsx wrapper provides
 * the position/size box; this template fills inset:0.
 *
 * Props (all values stored as strings for round-trip through PropertyPanel):
 *   text         — string to render (default 'Your text here')
 *   fontSize     — CSS px (default '80'; coerced via Number(), NaN→80)
 *   color        — text color   (default '#111111')
 *   fontFamily   — CSS font-family string (default system-ui stack)
 *   fontWeight   — CSS font-weight (default '400'; numeric or named OK)
 *   textAlign    — 'left' | 'center' | 'right' (default 'center')
 *   bgColor      — backdrop color or 'transparent' (default 'transparent')
 */
export default function StaticText({
  text       = 'Your text here',
  fontSize   = '80',
  color      = '#111111',
  fontFamily = 'system-ui, -apple-system, "Helvetica Neue", sans-serif',
  fontWeight = '400',
  textAlign  = 'center',
  bgColor    = 'transparent',
}) {
  const sizeNum = Number(fontSize)
  const safeSize = Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : 80

  return (
    <div style={{
      position:       'absolute',
      inset:          0,
      display:        'flex',
      alignItems:     'center',
      justifyContent: textAlign === 'left' ? 'flex-start' : textAlign === 'right' ? 'flex-end' : 'center',
      background:     bgColor,
      padding:        '6% 8%',
      boxSizing:      'border-box',
      overflow:       'hidden',
    }}>
      <p style={{
        margin:        0,
        color,
        fontFamily,
        fontWeight,
        fontSize:      safeSize,
        textAlign,
        lineHeight:    1.2,
        letterSpacing: '-0.01em',
        width:         '100%',
        whiteSpace:    'pre-wrap',
        wordBreak:     'normal',
        overflowWrap:  'break-word',
      }}>{text}</p>
    </div>
  )
}
