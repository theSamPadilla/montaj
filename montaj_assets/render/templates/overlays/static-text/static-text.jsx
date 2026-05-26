/**
 * static-text.jsx — Static text overlay for carousel slides.
 *
 * No animation. Ignores frame/fps/duration. Renders one styled string,
 * sized to fill the overlay's element box. The slide.jsx wrapper provides
 * the position/size box; this template fills inset:0.
 *
 * Props (all values stored as strings for round-trip through PropertyPanel):
 *   text          — string to render (default 'Your text here')
 *   fontSize      — CSS px (default '80'; coerced via Number(), NaN→80)
 *   fontFamily    — CSS font-family string (default system-ui stack)
 *   fontWeight    — CSS font-weight (default '400'; numeric or named OK)
 *   fontStyle     — CSS font-style: 'normal' | 'italic' (default 'normal')
 *   color         — text color (default '#111111')
 *   textAlign     — 'left' | 'center' | 'right' (default 'center')
 *   textTransform — CSS text-transform: 'none' | 'uppercase' | 'lowercase' | 'capitalize' (default 'none')
 *   bgColor       — backdrop color or 'transparent' (default 'transparent')
 */
export default function StaticText({
  text          = 'Your text here',
  fontSize      = '80',
  fontFamily    = 'system-ui, -apple-system, "Helvetica Neue", sans-serif',
  fontWeight    = '400',
  fontStyle     = 'normal',
  color         = '#111111',
  textAlign     = 'center',
  textTransform = 'none',
  bgColor       = 'transparent',
}) {
  // parseFloat (not Number) so we tolerate both "64" (legacy unit-less) and
  // "64px" (the canonical FontSizePicker storage format). Number("64px") = NaN
  // would otherwise fall back to the default 80 and ignore the operator's
  // chosen size — the symptom would be "fontSize edits do nothing in render."
  const sizeNum = parseFloat(String(fontSize))
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
        fontFamily,
        fontWeight,
        fontStyle,
        color,
        fontSize:      safeSize,
        textAlign,
        textTransform,
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
