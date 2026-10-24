/**
 * callout.jsx: a short punchy line (§558, place's `callout` preset), e.g. "3x faster". Centred across the frame in
 * the upper third (clear of the captions and of the apps' right-side buttons, which start at 45% of a tall frame's
 * height), on an accent plate. The text shrinks to fit one line inside the 5% title-safe width, or wraps to two
 * lines when one would be smaller than 48 px. Enters over ~0.3 s ('pop' springs in, 'slide' rises,
 * 'fade' fades) and fades out over the last ~0.25 s, done before the item ends (its last frame is held).
 *
 * Props (strings, as the editor's properties panel writes them):
 *   text        the line (default '3x faster')
 *   fontSize    the largest px size at the 1080 design canvas (default '120'; shrunk to fit)
 *   fontFamily  default 'Inter, system-ui, sans-serif'
 *   fontWeight  default '900'
 *   fontStyle   default 'normal'
 *   color       the text colour (default '#1c1c1e')
 *   textAlign   default 'center'
 *   textTransform default 'none'
 *   bgColor     the plate (default '#00b4d8'; 'transparent' for none)
 *   canvasW, canvasH  the design canvas in px; place sets them (default 1080 x 1920)
 *   anim        'pop' | 'slide' | 'fade' (default 'pop')
 *   top         the plate's top as a share of the frame height (default '0.28')
 */
export default function Callout() {
  const p = props || {}
  // the design canvas (1080 on the short edge): place writes it as canvasW / canvasH; no global carries it
  const W = Number(p.canvasW) > 0 ? Number(p.canvasW) : 1080
  const H = Number(p.canvasH) > 0 ? Number(p.canvasH) : 1920
  const text = String(p.text || '3x faster')
  const anim = ['pop', 'slide', 'fade'].includes(p.anim) ? p.anim : 'pop'
  // inside the 5% title-safe margins (it sits above the apps' right-side buttons, which start at 45% of the height)
  const safeW = Math.round(W * 0.9)
  const want = Number(p.fontSize) > 0 ? Number(p.fontSize) : 120
  // about 0.6 em per character at a heavy weight, plus the plate's padding: one line inside the safe width, or,
  // when that would go below MIN_ONE_LINE px, two lines at the size they fit
  const MIN_ONE_LINE = 48
  const perLine = (lines) => Math.floor((safeW - 80) * lines / Math.max(1, text.length * 0.6))
  const wraps = perLine(1) < MIN_ONE_LINE
  const size = Math.max(36, Math.min(want, perLine(wraps ? 2 : 1)))
  const inF = Math.max(1, Math.round(fps * 0.3))
  const outF = Math.max(1, Math.round(fps * 0.25))
  const last = Math.max(inF + outF, (duration || fps * 3) - 1)
  const s = spring({ frame, fps, damping: 11, stiffness: 160 })
  const fadeIn = interpolate(frame, [0, inF], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const fadeOut = interpolate(frame, [last - outF, last], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const scale = anim === 'pop' ? 0.6 + 0.4 * s : 1
  const y = anim === 'slide' ? (1 - s) * 60 : 0
  const topShare = Number(p.top) > 0 && Number(p.top) < 0.8 ? Number(p.top) : 0.28
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: Math.round(H * topShare), display: 'flex', justifyContent: 'center' }}>
      <div style={{
        maxWidth: safeW, padding: '18px 40px', borderRadius: 24, background: p.bgColor || '#00b4d8',
        opacity: fadeIn * fadeOut, transform: `translateY(${y}px) scale(${scale})`,
        fontFamily: p.fontFamily || 'Inter, system-ui, sans-serif', fontSize: size, fontWeight: p.fontWeight || '900',
        fontStyle: p.fontStyle || 'normal', color: p.color || '#1c1c1e', textAlign: p.textAlign || 'center',
        textTransform: p.textTransform || 'none', whiteSpace: wraps ? 'normal' : 'nowrap', lineHeight: 1.1,
      }}>{text}</div>
    </div>
  )
}
