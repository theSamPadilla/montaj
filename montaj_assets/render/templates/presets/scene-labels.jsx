/**
 * scene-labels.jsx: labels on a moving 3D shot (place's `scene_labels` preset, PL89 round 9): each label comes out of
 * its part on its word, on a leader from a small ring on the part, and rides the camera; a height rule with its numeral
 * draws beside the model. Everything is read from the scene's mark file (direct_scene's mark, overlays/_marks/<scene>.json),
 * which place puts in the import below, so the overlay is configured, never written. Earlier labels dim to 60% as the
 * next lands; each label is one line, shrunk to fit 48 px inside the frame; out over the last 120 ms.
 *
 * Props (JSON, as place takes them):
 *   marks       the scene id whose marks this reads (place's own; it names the file)
 *   labels      [{part, text, at}]: `part` a marked part, `at` the scene second of the word that names it
 *   rule        {text, at}: the height rule beside the first cast with its text ("19 in": the number big, the unit small)
 *   from        the scene second at the item's start (the 3D item's inPoint; default 0)
 *   fontFamily  default 'Inter, system-ui, sans-serif'
 *   fontSize    a label's size in px (default 46; numerals 3.3x)
 *   color       the text (default '#16181c')
 *   accent      the rings (default '#3a7bff')
 *   canvasW, canvasH  the design canvas in px; place sets them (default 1080 x 1920)
 */
import mark from './_marks/__SCENE__.json'

// A face it is given ends in a generic family, so a face that does not load falls back to its kind, never to serif.
const withGeneric = (f, d) => {
  const s = String(f || '').trim()
  if (!s) return d
  return /(^|,)\s*(serif|sans-serif|monospace|system-ui|cursive|fantasy|ui-[a-z-]+)\s*$/i.test(s) ? s : `${s}, ${/mono|code|courier/i.test(s) ? 'ui-monospace, monospace' : 'system-ui, sans-serif'}`
}

export default function SceneLabels() {
  const p = props || {}
  const W = Number(p.canvasW) > 0 ? Number(p.canvasW) : 1080
  const parse = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v) } catch { return null } }
  const labels = (Array.isArray(parse(p.labels)) ? parse(p.labels) : []).filter((l) => l && l.part && l.text)
  const rule = parse(p.rule)
  const from = Number(p.from) || 0
  const f = Motion.follow(mark, frame, fps, { from })
  if (!f) return null
  const size = Number(p.fontSize) > 0 ? Number(p.fontSize) : 46
  const font = withGeneric(p.fontFamily, 'Inter, system-ui, sans-serif')
  const ink = p.color || '#16181c', accent = p.accent || '#3a7bff', margin = 48
  const all = Motion.motion(frame, fps, duration, { enter: 'none', hold: 'none' })
  const starts = labels.map((l) => (Number(l.at) || 0) - from - 0.05)   // item seconds: the word's start, a touch early
  const out = labels.map((l, i) => {
    const pt = f.parts[l.part]
    if (!pt || !pt.leader) return null
    const s = starts[i]
    const m = Motion.motion(frame, fps, duration, { delay: s, exit: 'none' })
    const ring = 9 * Motion.progress(frame, fps, s - 0.3, 0.2)
    const d = Motion.draw(frame, fps, { start: s - 0.25, dur: 0.3 })
    const dim = i + 1 < labels.length ? 1 - 0.4 * Motion.progress(frame, fps, starts[i + 1], 0.18) : 1
    const { from: a, to: b, align } = pt.leader
    const end = [a[0] + (b[0] - a[0]) * d, a[1] + (b[1] - a[1]) * d]
    const right = align !== 'end'
    // one line, shrunk to fit the room from `to` to the margin on its side (about 0.62 em a character)
    const text = String(l.text)
    const em = text.length * size * 0.62
    const room = right ? W - margin - (b[0] + 18) : b[0] - 18 - margin
    const k = Math.max(Math.min(1, room / em), Math.min(1, 28 / size))
    const left = Math.min(W - margin - em * k, Math.max(margin, right ? b[0] + 18 : b[0] - 18 - em * k))
    return (
      <div key={`l${i}`} style={{ position: 'absolute', inset: 0, opacity: dim * (frame / fps >= s - 0.3 ? 1 : 0) }}>
        <svg width={W} height={Number(p.canvasH) > 0 ? Number(p.canvasH) : 1920} style={{ position: 'absolute', left: 0, top: 0 }}>
          <circle cx={a[0]} cy={a[1]} r={ring} fill={accent} />
          <line x1={a[0]} y1={a[1]} x2={end[0]} y2={end[1]} stroke={ink} strokeWidth={3} />
        </svg>
        <div style={{ position: 'absolute', ...(right ? { left } : { right: W - (left + em * k) }), top: b[1] - size * k * 0.6, whiteSpace: 'nowrap',
          fontFamily: font, fontSize: size * k, fontWeight: 800, color: ink, opacity: m.opacity, transform: m.style.transform,
          transformOrigin: right ? 'left center' : 'right center' }}>{text}</div>
      </div>
    )
  })
  let ruled = null
  const r = f.casts[0] && f.casts[0].rule
  if (rule && rule.text && r) {
    const s = (Number(rule.at) || 0) - from - 0.05
    const d = Motion.draw(frame, fps, { start: s - 0.3, dur: 0.5 })
    const m = Motion.motion(frame, fps, duration, { delay: s, exit: 'none' })
    const [num, ...unit] = String(rule.text).split(' ')
    const mid = (r.top + r.bottom) / 2, half = ((r.bottom - r.top) / 2) * d
    const right = r.align !== 'end'
    ruled = (
      <div key="rule" style={{ position: 'absolute', inset: 0 }}>
        <svg width={W} height={Number(p.canvasH) > 0 ? Number(p.canvasH) : 1920} style={{ position: 'absolute', left: 0, top: 0 }}>
          <line x1={r.x} y1={mid - half} x2={r.x} y2={mid + half} stroke={ink} strokeWidth={4} />
          {d >= 1 ? [r.top, r.bottom].map((y) => <line key={y} x1={r.x - 14} y1={y} x2={r.x + 14} y2={y} stroke={ink} strokeWidth={4} />) : null}
        </svg>
        <div style={{ position: 'absolute', top: r.label[1] - size * 1.9, ...(right ? { left: Math.min(r.label[0], W - margin - size * 4) } : { right: Math.max(margin, W - r.label[0]) }),
          whiteSpace: 'nowrap', fontFamily: font, color: ink, opacity: m.opacity, transform: m.style.transform, transformOrigin: right ? 'left center' : 'right center' }}>
          <span style={{ fontSize: size * 3.3, fontWeight: 800, lineHeight: 1 }}>{num}</span>
          {unit.length ? <span style={{ fontSize: Math.max(36, size * 1.2), fontWeight: 700, marginLeft: 10 }}>{unit.join(' ')}</span> : null}
        </div>
      </div>
    )
  }
  return <div style={{ position: 'absolute', inset: 0, opacity: all.opacity }}>{ruled}{out}</div>
}
