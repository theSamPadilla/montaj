/**
 * rule.jsx: a line drawn under a subject with a word (PL89c, place's `rule` preset): a limit, a measure or a
 * condition shown on the thing ("flat ground only" under a walking robot, "19 in" across a part). The line draws out
 * from its centre, small end ticks land, then the text rises in centred under it (or over it). Out over its last
 * 120 ms.
 *
 * Props (strings, as the editor's properties panel writes them):
 *   text        the word or phrase (default 'flat ground only')
 *   y           the line's height as a share of the frame height (default '0.5'): just under the subject
 *   x           its centre as a share of the frame width (default '0.5')
 *   width       its length as a share of the frame width (default '0.6')
 *   side        'below' (default) or 'above': where the text sits
 *   fontSize    the largest text size in px at the 1080 design canvas (default '64'; shrunk to fit, 36 at least)
 *   fontFamily  default 'Inter, system-ui, sans-serif'
 *   fontWeight  default '800'
 *   color       the text (default '#ffffff', with a soft shadow when it is light)
 *   accent      the line and its ticks (default '#00b4d8')
 *   canvasW, canvasH  the design canvas in px; place sets them (default 1080 x 1920)
 */
// A face it is given ends in a generic family, so a face that does not load falls back to its kind, never to serif.
const withGeneric = (f, d) => {
  const s = String(f || '').trim()
  if (!s) return d
  return /(^|,)\s*(serif|sans-serif|monospace|system-ui|cursive|fantasy|ui-[a-z-]+)\s*$/i.test(s) ? s : `${s}, ${/mono|code|courier/i.test(s) ? 'ui-monospace, monospace' : 'system-ui, sans-serif'}`
}

export default function Rule() {
  const p = props || {}
  const W = Number(p.canvasW) > 0 ? Number(p.canvasW) : 1080
  const H = Number(p.canvasH) > 0 ? Number(p.canvasH) : 1920
  const share = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1 && v !== '' && v != null ? Number(v) : d)
  const y = share(p.y, 0.5) * H, len = Math.max(0.1, share(p.width, 0.6)) * W
  const cx = Math.min(W - len / 2, Math.max(len / 2, share(p.x, 0.5) * W))
  const text = String(p.text || 'flat ground only')
  const color = p.color || '#ffffff', accent = p.accent || '#00b4d8'
  const light = /^#?([0-9a-f]{6})$/i.test(color) && parseInt(color.replace('#', '').slice(0, 2), 16) + parseInt(color.replace('#', '').slice(2, 4), 16) + parseInt(color.replace('#', '').slice(4, 6), 16) > 480
  const want = Number(p.fontSize) > 0 ? Number(p.fontSize) : 64
  const size = Math.max(36, Math.round(Math.min(want, (W * 0.9) / Math.max(1, text.length * 0.58))))
  const above = p.side === 'above'
  const all = Motion.motion(frame, fps, duration, { enter: 'none', hold: 'none' })
  const d = Motion.draw(frame, fps, { start: 0, dur: 0.5 })
  const tick = Motion.progress(frame, fps, 0.45, 0.2)
  const m = Motion.motion(frame, fps, duration, { enter: 'rise', delay: 0.3, exit: 'none' })
  const half = (len / 2) * d
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: all.opacity }}>
      <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', filter: light ? 'drop-shadow(0 2px 8px rgba(0,0,0,0.45))' : 'none' }}>
        <line x1={cx - half} y1={y} x2={cx + half} y2={y} stroke={accent} strokeWidth={6} strokeLinecap="round" />
        {[-1, 1].map((s) => <line key={s} x1={cx + (s * len) / 2} y1={y - 14 * tick} x2={cx + (s * len) / 2} y2={y + 14 * tick} stroke={accent} strokeWidth={6} strokeLinecap="round" opacity={tick} />)}
      </svg>
      <div style={{ position: 'absolute', left: cx, top: above ? y - 24 : y + 28, transform: `translate(-50%, ${above ? '-100%' : '0'}) ${m.style.transform}`, opacity: m.opacity,
        fontFamily: withGeneric(p.fontFamily, 'Inter, system-ui, sans-serif'), fontWeight: p.fontWeight || '800', fontSize: size, lineHeight: 1.1,
        color, whiteSpace: 'nowrap', textAlign: 'center', textShadow: light ? '0 2px 12px rgba(0,0,0,0.55)' : 'none' }}>{text}</div>
    </div>
  )
}
