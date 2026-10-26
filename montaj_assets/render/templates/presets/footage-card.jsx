/**
 * footage-card.jsx: a landscape clip in a vertical frame, inset as a card (PL89, frame_broll's `card`). The
 * clip itself is the video item under this overlay, scaled into `box`; this draws everything around it: paper over
 * the rest of the frame, thin corner brackets on the subject (or the footage's corners when none was tracked), and
 * a credit line under the footage. The paper cuts in and out with the clip (it frames the video item exactly, so it
 * never moves); the brackets pop in on the subject and the credit rises in after them, and both fade out before the
 * end (Motion.motion, PL89b: look says an overlay that vanishes with the cut or moves linearly).
 *
 * Props (strings, as the editor's properties panel writes them):
 *   box         the footage on screen, "x,y,w,h" as shares of the frame (frame_broll sets it from the clip)
 *   credit      the line under the footage, e.g. 'Footage: PhoneBot project video' ('' for none)
 *   paper       the card's colour (default '#efeee8')
 *   ink         the credit's colour (default '#1c1c1e')
 *   accent      the brackets' colour (default '#1c1c1e')
 *   subject     the tracked subject: a JSON list of [t, x, y, w, h] (t seconds into the item; x..h shares of the
 *               footage), followed between keys; '' for brackets on the footage's corners
 *   fontFamily  the credit's font (default 'JetBrains Mono, ui-monospace, monospace')
 *   canvasW, canvasH  the design canvas in px; frame_broll sets them (default 1080 x 1920)
 */
export default function FootageCard() {
  const p = props || {}
  const W = Number(p.canvasW) > 0 ? Number(p.canvasW) : 1080
  const H = Number(p.canvasH) > 0 ? Number(p.canvasH) : 1920
  const nums = String(p.box || '0.06,0.26,0.88,0.28').split(',').map(Number)
  const [bx, by, bw, bh] = nums.length === 4 && nums.every((n) => Number.isFinite(n)) ? nums : [0.06, 0.26, 0.88, 0.28]
  const L = Math.round(W * bx), T = Math.round(H * by), BW = Math.round(W * bw), BH = Math.round(H * bh)
  const paper = p.paper || '#efeee8'
  const ink = p.ink || '#1c1c1e'
  const accent = p.accent || '#1c1c1e'

  // the subject's box now, between its keys (shares of the footage), or the footage's own corners
  let keys = []
  try { keys = p.subject ? JSON.parse(p.subject) : [] } catch { keys = [] }
  const t = frame / fps
  let sub = [0.04, 0.06, 0.92, 0.88]
  if (Array.isArray(keys) && keys.length) {
    let k = 0
    while (k < keys.length - 1 && keys[k + 1][0] <= t) k++
    const a = keys[k], b = keys[Math.min(k + 1, keys.length - 1)]
    const f = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0
    sub = [1, 2, 3, 4].map((i) => a[i] + (b[i] - a[i]) * f)
    // a margin round the subject, kept inside the footage
    const m = 0.04
    sub = [Math.max(0, sub[0] - m), Math.max(0, sub[1] - m), Math.min(1 - Math.max(0, sub[0] - m), sub[2] + 2 * m), Math.min(1 - Math.max(0, sub[1] - m), sub[3] + 2 * m)]
  }
  const sx = L + sub[0] * BW, sy = T + sub[1] * BH, sw = sub[2] * BW, sh = sub[3] * BH
  const arm = Math.round(Math.min(sw, sh) * 0.18 + 8)
  const line = Math.max(3, Math.round(W / 360))
  // each bracket pops in from its own corner, one after another; the credit rises in after them
  const corner = (x, y, dx, dy, i) => {
    const m = Motion.motion(frame, fps, duration, { delay: Motion.stagger(i, 0.05) })
    return (
      <div style={{ position: 'absolute', left: dx > 0 ? x : x - arm, top: dy > 0 ? y : y - arm, width: arm, height: arm,
        borderLeft: dx > 0 ? `${line}px solid ${accent}` : 'none', borderRight: dx < 0 ? `${line}px solid ${accent}` : 'none',
        borderTop: dy > 0 ? `${line}px solid ${accent}` : 'none', borderBottom: dy < 0 ? `${line}px solid ${accent}` : 'none',
        opacity: m.opacity, transform: `scale(${m.scale})`, transformOrigin: `${dx > 0 ? 'left' : 'right'} ${dy > 0 ? 'top' : 'bottom'}` }} />
    )
  }
  const credit = Motion.motion(frame, fps, duration, { enter: 'rise', delay: Motion.stagger(4, 0.05) })
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {/* paper over everything but the footage: one box whose shadow is the card */}
      <div style={{ position: 'absolute', left: L, top: T, width: BW, height: BH, boxShadow: `0 0 0 ${W + H}px ${paper}` }} />
      {corner(sx, sy, 1, 1, 0)}
      {corner(sx + sw, sy, -1, 1, 1)}
      {corner(sx + sw, sy + sh, -1, -1, 2)}
      {corner(sx, sy + sh, 1, -1, 3)}
      {p.credit ? (
        <div style={{ position: 'absolute', left: L, top: T + BH + Math.round(H * 0.012), width: BW,
          fontFamily: p.fontFamily || 'JetBrains Mono, ui-monospace, monospace', fontSize: Math.max(36, Math.round(W * 0.034)),
          color: ink, opacity: 0.6 * credit.opacity, transform: credit.style.transform, letterSpacing: '0.02em' }}>{String(p.credit)}</div>
      ) : null}
    </div>
  )
}
