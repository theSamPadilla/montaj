/**
 * lower-third.jsx: a name card (§558, place's `lower_third` preset). Name on top, a smaller second line under it,
 * an accent bar on the left, on a soft dark plate. Placed bottom-left above the bottom 420px (portrait captions and
 * the apps' controls live in the bottom ~350px) and clear of the right 200px (the apps' buttons); in a landscape or
 * square frame it sits 8% up from the bottom. Slides in over ~0.35 s and fades out over the last ~0.3 s, both done
 * before the item ends (its last frame is held).
 *
 * Props (strings, as the editor's properties panel writes them):
 *   text        the name (default 'Name Surname')
 *   subtitle    the second line, '' for none (default 'Title')
 *   fontSize    the name's px size at the 1080 design canvas (default '64'; the second line is 0.55 of it)
 *   fontFamily  default 'Inter, system-ui, sans-serif'
 *   fontWeight  the name's weight (default '800')
 *   fontStyle   default 'normal'
 *   color       the text colour (default '#ffffff')
 *   textAlign   default 'left'
 *   textTransform default 'none'
 *   bgColor     the plate (default 'rgba(0, 0, 0, 0.55)'; 'transparent' for none)
 *   accent      the bar's colour (default '#00b4d8')
 *   canvasW, canvasH  the design canvas in px; place sets them (default 1080 x 1920)
 *   anim        'slide' | 'fade' | 'pop' (default 'slide')
 */
export default function LowerThird() {
  const p = props || {}
  // the design canvas (1080 on the short edge): place writes it as canvasW / canvasH; no global carries it
  const W = Number(p.canvasW) > 0 ? Number(p.canvasW) : 1080
  const H = Number(p.canvasH) > 0 ? Number(p.canvasH) : 1920
  const size = Number(p.fontSize) > 0 ? Number(p.fontSize) : 64
  const anim = ['slide', 'fade', 'pop'].includes(p.anim) ? p.anim : 'slide'
  const inF = Math.max(1, Math.round(fps * 0.35))
  const outF = Math.max(1, Math.round(fps * 0.3))
  const last = Math.max(inF + outF, (duration || fps * 3) - 1)
  const enter = spring({ frame, fps, damping: 16, stiffness: 120 })
  const fadeIn = interpolate(frame, [0, inF], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const fadeOut = interpolate(frame, [last - outF, last], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const x = anim === 'slide' ? (1 - enter) * -80 : 0
  const scale = anim === 'pop' ? 0.85 + 0.15 * enter : 1
  const portrait = H > W
  const bottom = portrait ? 420 : Math.round(H * 0.08)
  const subtitle = p.subtitle === undefined ? 'Title' : String(p.subtitle)
  const text = {
    fontFamily: p.fontFamily || 'Inter, system-ui, sans-serif',
    fontStyle: p.fontStyle || 'normal',
    color: p.color || '#ffffff',
    textAlign: p.textAlign || 'left',
    textTransform: p.textTransform || 'none',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  }
  return (
    <div style={{
      position: 'absolute', left: 64, bottom, maxWidth: W - 64 - 220,
      display: 'flex', alignItems: 'stretch', gap: 20, padding: '22px 30px 22px 22px', borderRadius: 18,
      background: p.bgColor || 'rgba(0, 0, 0, 0.55)', opacity: fadeIn * fadeOut,
      transform: `translateX(${x}px) scale(${scale})`, transformOrigin: 'left bottom',
    }}>
      <div style={{ width: 8, borderRadius: 4, background: p.accent || '#00b4d8', flex: '0 0 auto' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <div style={{ ...text, fontSize: size, fontWeight: p.fontWeight || '800', lineHeight: 1.05 }}>{p.text || 'Name Surname'}</div>
        {subtitle ? <div style={{ ...text, fontSize: Math.round(size * 0.55), fontWeight: 500, opacity: 0.85, lineHeight: 1.15 }}>{subtitle}</div> : null}
      </div>
    </div>
  )
}
