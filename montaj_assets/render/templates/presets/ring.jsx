/**
 * ring.jsx: a ring on a subject, pulsing (PL89c, place's `ring` preset): something live, calling, listening or
 * sending, or the one thing to look at in the shot. A ring pops on around the point and rings keep spreading out of
 * it while it holds; an optional short label sits centred under it (or over it). Out over its last 120 ms.
 *
 * Props (strings, as the editor's properties panel writes them):
 *   x, y        the subject's centre as shares of the frame's width and height (default '0.5', '0.42')
 *   size        the ring's radius in px at the 1080 design canvas (default '110')
 *   label       a short word by the ring, e.g. 'LIVE' (default none)
 *   side        'below' (default) or 'above': where the label sits, off the subject
 *   fontSize    the label's size in px (default '44', 36 at least)
 *   fontFamily  default 'Inter, system-ui, sans-serif'
 *   fontWeight  default '800'
 *   color       the ring and the label (default '#ffffff', with a soft shadow when it is light)
 *   accent      the spreading rings (default: color)
 *   period      seconds between rings (default '1.4')
 *   canvasW, canvasH  the design canvas in px; place sets them (default 1080 x 1920)
 */
export default function Ring() {
  const p = props || {}
  const W = Number(p.canvasW) > 0 ? Number(p.canvasW) : 1080
  const H = Number(p.canvasH) > 0 ? Number(p.canvasH) : 1920
  const share = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1 && v !== '' && v != null ? Number(v) : d)
  const x = share(p.x, 0.5) * W, y = share(p.y, 0.42) * H
  const r = Number(p.size) > 0 ? Number(p.size) : 110
  const color = p.color || '#ffffff', accent = p.accent || color
  const light = /^#?([0-9a-f]{6})$/i.test(color) && parseInt(color.replace('#', '').slice(0, 2), 16) + parseInt(color.replace('#', '').slice(2, 4), 16) + parseInt(color.replace('#', '').slice(4, 6), 16) > 480
  const shadow = light ? 'drop-shadow(0 2px 8px rgba(0,0,0,0.5))' : 'none'
  const period = Number(p.period) > 0 ? Number(p.period) : 1.4
  const m = Motion.motion(frame, fps, duration)
  const label = String(p.label || '').trim()
  const size = Math.max(36, Number(p.fontSize) > 0 ? Number(p.fontSize) : 44)
  // the label stays 48 px inside the frame
  const half = label.length * size * 0.33
  const lx = Math.min(W - 48 - half, Math.max(48 + half, x))
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: m.opacity }}>
      <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', filter: shadow }}>
        {[0, 1].map((k) => {
          const start = 0.25 + (k * period) / 2
          if (frame / fps < start) return null
          const q = Motion.pulse(frame, fps, { period, start })
          return <circle key={k} cx={x} cy={y} r={r * (1 + 0.9 * Motion.ease.out(q))} fill="none" stroke={accent} strokeWidth={4} opacity={0.85 * (1 - q)} />
        })}
        <circle cx={x} cy={y} r={r * m.scale} fill="none" stroke={color} strokeWidth={6} />
      </svg>
      {label ? (
        <div style={{ position: 'absolute', left: lx, top: p.side === 'above' ? y - r - 24 : y + r + 24, transform: `translate(-50%, ${p.side === 'above' ? '-100%' : '0'}) ${m.style.transform}`, transformOrigin: 'center',
          fontFamily: p.fontFamily || 'Inter, system-ui, sans-serif', fontWeight: p.fontWeight || '800', fontSize: size, letterSpacing: '0.06em',
          color, whiteSpace: 'nowrap', textShadow: light ? '0 2px 12px rgba(0,0,0,0.55)' : 'none' }}>{label}</div>
      ) : null}
    </div>
  )
}
