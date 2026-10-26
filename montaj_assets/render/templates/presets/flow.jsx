/**
 * flow.jsx: something travelling between labelled points (PL89c, place's `flow` preset): a command going phone ->
 * computer -> motors, data from a camera to the cloud, a signal down a chain. The labels come in one after another,
 * a line draws from each to the next with an arrowhead on its tip, and once the chain is whole a dot keeps travelling
 * along it, so the graphic shows the mechanism and stays alive while it holds. All in by the middle of the item, out
 * over its last 120 ms. Centred: a row across the frame when its labels fit at 48 px or more, else a column down it;
 * `at` puts each label on its own point instead (over the parts in the footage).
 *
 * Props (strings, as the editor's properties panel writes them):
 *   points      the labels in order, "phone > small computer > motors" (or a JSON list of strings)
 *   at          optional JSON list of [x, y] px on the design canvas, one per label (default: a centred row)
 *   layout      'row' or 'column' (default: a row when it fits at 48 px, else a column)
 *   top         the row's centre, or the column's top, as a share of the frame height (default '0.3' and '0.12')
 *   fontSize    the largest label size in px at the 1080 design canvas (default '64'; shrunk to fit, 36 at least)
 *   fontFamily  default 'Inter, system-ui, sans-serif'
 *   fontWeight  default '800'
 *   color       the labels' colour (default '#ffffff', with a soft shadow when it is light)
 *   accent      the line, arrowheads and the travelling dot (default '#00b4d8')
 *   canvasW, canvasH  the design canvas in px; place sets them (default 1080 x 1920)
 */
// A face it is given ends in a generic family, so a face that does not load falls back to its kind, never to serif.
const withGeneric = (f, d) => {
  const s = String(f || '').trim()
  if (!s) return d
  return /(^|,)\s*(serif|sans-serif|monospace|system-ui|cursive|fantasy|ui-[a-z-]+)\s*$/i.test(s) ? s : `${s}, ${/mono|code|courier/i.test(s) ? 'ui-monospace, monospace' : 'system-ui, sans-serif'}`
}

export default function Flow() {
  const p = props || {}
  const W = Number(p.canvasW) > 0 ? Number(p.canvasW) : 1080
  const H = Number(p.canvasH) > 0 ? Number(p.canvasH) : 1920
  const parse = (v) => { try { return JSON.parse(v) } catch { return null } }
  const raw = typeof p.points === 'string' && p.points.trim().startsWith('[') ? parse(p.points) : String(p.points || 'phone > computer > motors').split('>')
  const labels = (Array.isArray(raw) ? raw : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6)
  const n = Math.max(1, labels.length)
  const color = p.color || '#ffffff', accent = p.accent || '#00b4d8'
  const light = /^#?([0-9a-f]{6})$/i.test(color) && parseInt(color.replace('#', '').slice(0, 2), 16) + parseInt(color.replace('#', '').slice(2, 4), 16) + parseInt(color.replace('#', '').slice(4, 6), 16) > 480
  // where each label sits: its own point, or a centred row inside the 5% title-safe width
  const given = typeof p.at === 'string' ? parse(p.at) : null
  const custom = Array.isArray(given) && given.length === labels.length && given.every((q) => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite))
  // one size for every label: the largest that fits its room on one line (about 0.58 em a character)
  const want = Number(p.fontSize) > 0 ? Number(p.fontSize) : 64
  const slot = (W * 0.9) / n
  const fit = (room) => Math.min(...labels.map((l) => room / Math.max(1, l.length * 0.58)))
  const column = !custom && (p.layout === 'column' || (p.layout !== 'row' && Math.min(want, fit(slot - 28)) < 48))
  const size = Math.max(36, Math.round(Math.min(want, custom ? fit(W * 0.4) : column ? fit(W * 0.9) : fit(slot - 28))))
  const gap = size + 170   // a column: each label, then an arrow of about 140 px down to the next
  const top = Number(p.top) > 0 && Number(p.top) < 1 ? Number(p.top) : column ? 0.12 : 0.3
  const pts = custom ? given : column ? labels.map((_, i) => [W / 2, H * top + size * 0.55 + i * gap]) : labels.map((_, i) => [W * 0.05 + slot * (i + 0.5), H * top])
  const lines = labels.map((s) => [s])
  const halfW = labels.map((l) => (column ? size * 0.5 : l.length * size * 0.29))   // what a line stops short of
  // timing: one label after another, every one in by the middle; each line arrives as its label lands
  const dur = (duration || fps * 3) / fps
  const step = n > 1 ? Math.min(0.7, (0.45 * dur) / (n - 1)) : 0
  const leg = Math.min(0.45, step * 0.85)
  const segs = pts.slice(1).map((b, i) => {
    const a = pts[i]
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1
    const ux = dx / len, uy = dy / len
    const cut0 = custom ? 60 : halfW[i] + (column ? 10 : 18), cut1 = custom ? 60 : halfW[i + 1] + (column ? 10 : 18)
    return { a: [a[0] + ux * cut0, a[1] + uy * cut0], b: [b[0] - ux * cut1, b[1] - uy * cut1], ux, uy }
  }).filter((s) => (s.b[0] - s.a[0]) * s.ux + (s.b[1] - s.a[1]) * s.uy > 8)
  const lerp = (s, k) => [s.a[0] + (s.b[0] - s.a[0]) * k, s.a[1] + (s.b[1] - s.a[1]) * k]
  const all = Motion.motion(frame, fps, duration, { enter: 'none', hold: 'none' })
  // once the chain is whole, a dot runs along it, one leg every 0.9 s
  const whole = (n - 1) * step
  const run = segs.length ? Motion.pulse(frame, fps, { period: 0.9 * segs.length, start: whole + 0.2 }) : 0
  const runAt = frame / fps >= whole + 0.2 && segs.length ? Math.min(segs.length - 1e-6, run * segs.length) : -1
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: all.opacity }}>
      <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        {segs.map((s, i) => {
          const d = Motion.draw(frame, fps, { start: (i + 1) * step - leg, dur: leg })
          if (d <= 0) return null
          const tip = lerp(s, d), ah = 20
          const back = [tip[0] - s.ux * ah, tip[1] - s.uy * ah]
          return (
            <g key={i}>
              <line x1={s.a[0]} y1={s.a[1]} x2={tip[0]} y2={tip[1]} stroke={accent} strokeWidth={6} strokeLinecap="round" />
              <polygon points={`${tip[0]},${tip[1]} ${back[0] - s.uy * ah * 0.6},${back[1] + s.ux * ah * 0.6} ${back[0] + s.uy * ah * 0.6},${back[1] - s.ux * ah * 0.6}`} fill={accent} />
            </g>
          )
        })}
        {runAt >= 0 ? (() => { const k = Math.floor(runAt), at = lerp(segs[k], runAt - k); return <circle cx={at[0]} cy={at[1]} r={13} fill={accent} stroke={color} strokeWidth={4} /> })() : null}
      </svg>
      {lines.map((ls, i) => {
        const m = Motion.motion(frame, fps, duration, { delay: i * step, hold: 'none', exit: 'none' })
        return (
          <div key={i} style={{ position: 'absolute', left: pts[i][0], top: pts[i][1], transform: `translate(-50%, -50%) ${m.style.transform}`, opacity: m.opacity,
            fontFamily: withGeneric(p.fontFamily, 'Inter, system-ui, sans-serif'), fontWeight: p.fontWeight || '800', fontSize: size, lineHeight: 1.05,
            color, textAlign: 'center', whiteSpace: 'nowrap', textShadow: light ? '0 2px 12px rgba(0,0,0,0.55)' : 'none' }}>
            {ls.map((l, j) => <div key={j}>{l}</div>)}
          </div>
        )
      })}
    </div>
  )
}
