/**
 * stat.jsx: numerals one after another (place's `stat` preset, PL89 round 9): "4 lb", then "$400", each popping in on
 * its word and the one before it going, centred across the frame, clear of the top slot and the captions. The number
 * is big, its unit small beside it, an optional line under it. Out over its last 120 ms.
 *
 * Props (JSON, as place takes them):
 *   stats       [{value, unit?, sub?, at}]: `at` the seconds into the item of the word that says it
 *   top         the numeral's centre as a share of the frame height (default '0.22')
 *   fontFamily  default 'Inter, system-ui, sans-serif'
 *   fontSize    the numeral's size in px (default 150; the unit 56, the line under 40)
 *   color       default '#ffffff', with a soft shadow when it is light
 *   canvasW, canvasH  the design canvas in px; place sets them (default 1080 x 1920)
 */
// A face it is given ends in a generic family, so a face that does not load falls back to its kind, never to serif.
const withGeneric = (f, d) => {
  const s = String(f || '').trim()
  if (!s) return d
  return /(^|,)\s*(serif|sans-serif|monospace|system-ui|cursive|fantasy|ui-[a-z-]+)\s*$/i.test(s) ? s : `${s}, ${/mono|code|courier/i.test(s) ? 'ui-monospace, monospace' : 'system-ui, sans-serif'}`
}

export default function Stat() {
  const p = props || {}
  const W = Number(p.canvasW) > 0 ? Number(p.canvasW) : 1080
  const H = Number(p.canvasH) > 0 ? Number(p.canvasH) : 1920
  const parse = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return null } }
  const stats = (Array.isArray(parse(p.stats)) ? parse(p.stats) : []).filter((s) => s && s.value !== undefined)
  const top = Number(p.top) > 0 && Number(p.top) < 1 ? Number(p.top) : 0.22
  const size = Number(p.fontSize) > 0 ? Number(p.fontSize) : 150
  const color = p.color || '#ffffff'
  const light = /^#?([0-9a-f]{6})$/i.test(color) && parseInt(color.replace('#', '').slice(0, 2), 16) + parseInt(color.replace('#', '').slice(2, 4), 16) + parseInt(color.replace('#', '').slice(4, 6), 16) > 480
  const font = withGeneric(p.fontFamily, 'Inter, system-ui, sans-serif')
  const all = Motion.motion(frame, fps, duration, { enter: 'none', hold: 'none' })
  const t = frame / fps
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: all.opacity }}>
      {stats.map((s, i) => {
        const at = Number(s.at) || 0, next = i + 1 < stats.length ? Number(stats[i + 1].at) || 0 : Infinity
        if (t < at - 0.05 || t > next + 0.2) return null
        const m = Motion.motion(frame, fps, duration, { delay: at, exit: 'none' })
        const gone = 1 - Motion.progress(frame, fps, next, 0.15)
        const k = Math.min(1, (W * 0.9) / Math.max(1, String(s.value).length * size * 0.6 + (s.unit ? String(s.unit).length * 56 * 0.6 + 14 : 0)))
        return (
          <div key={i} style={{ position: 'absolute', left: W * 0.05, width: W * 0.9, top: H * top - size * k * 0.6, textAlign: 'center', whiteSpace: 'nowrap',
            fontFamily: font, color, opacity: m.opacity * gone, transform: m.style.transform, textShadow: light ? '0 2px 14px rgba(0,0,0,0.55)' : 'none' }}>
            <span style={{ fontSize: size * k, fontWeight: 800, lineHeight: 1 }}>{s.value}</span>
            {s.unit ? <span style={{ fontSize: Math.max(36, 56 * k), fontWeight: 700, marginLeft: 14 }}>{s.unit}</span> : null}
            {s.sub ? <div style={{ fontSize: 40, fontWeight: 600, marginTop: 12 }}>{s.sub}</div> : null}
          </div>
        )
      })}
    </div>
  )
}
