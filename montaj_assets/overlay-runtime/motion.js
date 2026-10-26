// montaj_assets/overlay-runtime/motion.js
//
// Motion an overlay gets in one line (PL89b). The paid ucla run's overlays faded and rose in linearly, held dead still
// and vanished with the cut; a hand-made edit pops graphics in (70% to 100% in about 180 ms), draws lines on eased,
// keeps them alive while they hold and fades them out. They are one overlay global, `Motion` (index.js
// makeOverlayGlobals; one name, so none collides with an overlay's own helpers), pure functions of the frame they are
// given, so they read the same in the render, the preview and a motion-blur sub-frame:
//
//   const m = Motion.motion(frame, fps, duration)       // whole-overlay enter, hold and exit: <div style={m.style}>
//   Motion.motion(frame, fps, duration, {enter: 'rise', delay: Motion.stagger(i)})   // one element, after the others
//   Motion.draw(frame, fps, {start, dur})                // 0..1, a line's drawn share (scaleX, strokeDashoffset)
//   Motion.progress(frame, fps, start, dur, 'out')       // 0..1 eased, for anything else
//   Motion.pulse(frame, fps, {period})                   // 0..1, repeating: a ping ring's spread
//   Motion.ease.out(t), .inOut(t), .back(t), ...          // the curves
//
// `frame`, `fps` and `duration` are the overlay's own globals, passed in (a module cannot read them). Seconds
// everywhere else.

const clamp01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t)

/** Easing curves on t in [0, 1], each 0 at 0 and 1 at 1. */
export const ease = Object.freeze({
  linear: (t) => t,
  out: (t) => 1 - (1 - t) ** 3,
  in: (t) => t ** 3,
  inOut: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  // a little past 1 and back: a pop
  back: (t) => {
    const c1 = 1.70158, c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
  },
  expoOut: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
})

const curveOf = (c) => {
  const f = typeof c === 'function' ? c : ease[c]
  if (typeof f !== 'function') throw new Error(`motion: curve is a function or one of ${Object.keys(ease).join(', ')}`)
  return f
}

/** 0 before `start` seconds, then eased to 1 over `dur` seconds (`curve`: a name in ease, or a function). */
export function progress(frame, fps, start = 0, dur = 0.3, curve = 'out') {
  const t = frame / fps - start
  if (t <= 0) return 0
  if (!(dur > 0) || t >= dur) return 1
  return curveOf(curve)(t / dur)
}

/** A line's drawn share, 0..1: eased out over dur seconds from start. */
export function draw(frame, fps, { start = 0, dur = 0.45, curve = 'out' } = {}) {
  return progress(frame, fps, start, dur, curve)
}

/** The start, in seconds, of item i of a set coming in one after another. */
export function stagger(i, step = 0.08, start = 0) {
  return start + i * step
}

/** 0..1 every `period` seconds from `start` (0 before it): a ping ring's spread, its opacity being 1 - pulse. */
export function pulse(frame, fps, { period = 1.1, start = 0 } = {}) {
  const t = frame / fps - start
  if (t < 0 || !(period > 0)) return 0
  return (t % period) / period
}

/**
 * The enters, exits and holds. An enter: its seconds `in`, its start scale, its start offset in px, its curve and how
 * long its fade takes (a pop shows at once and scales; a rise fades over its whole move). An exit: its seconds `out`,
 * its end scale and offset. A hold: a gentle life between the two (a breath of scale, or a drift of a few px).
 */
const ENTERS = Object.freeze({
  pop: { in: 0.18, scale: 0.7, x: 0, y: 0, curve: 'back', fade: 0.08 },
  rise: { in: 0.35, scale: 1, x: 0, y: 24, curve: 'out', fade: 0.35 },
  'slide-left': { in: 0.35, scale: 1, x: -48, y: 0, curve: 'out', fade: 0.25 },
  'slide-right': { in: 0.35, scale: 1, x: 48, y: 0, curve: 'out', fade: 0.25 },
  fade: { in: 0.25, scale: 1, x: 0, y: 0, curve: 'out', fade: 0.25 },
  none: { in: 0, scale: 1, x: 0, y: 0, curve: 'linear', fade: 0 },
})
const EXITS = Object.freeze({
  fade: { out: 0.12, scale: 1, y: 0 },
  pop: { out: 0.12, scale: 0.92, y: 0 },
  sink: { out: 0.18, scale: 1, y: 16 },
  none: { out: 0, scale: 1, y: 0 },
})
const HOLDS = Object.freeze({ breathe: { scale: 0.012, period: 2.6 }, drift: { y: 4, period: 3.2 }, none: {} })
const SETTLE = 0.3   // seconds the hold takes to come in after the enter, so it never jolts

/**
 * One overlay's (or one element's) motion at `frame`: {opacity, scale, x, y, style}, `style` ready to spread on the
 * element ({opacity, transform}). opts: enter ('pop' | 'rise' | 'slide-left' | 'slide-right' | 'fade' | 'none', default
 * 'pop'), exit ('fade' | 'pop' | 'sink' | 'none', default 'fade'), hold ('breathe' | 'drift' | 'none', default
 * 'breathe'), delay (seconds before it enters), in and out (seconds, to override the enter's and the exit's), amount (a
 * factor on the enter's distance or scale change). A beat too short for its in and out gets both shrunk to fit, so it
 * is always gone at its last frame unless exit is 'none'.
 */
export function motion(frame, fps, duration, opts = {}) {
  const { enter = 'pop', exit = 'fade', hold = 'breathe', delay = 0, amount = 1 } = opts || {}
  const E = ENTERS[enter], X = EXITS[exit], H = HOLDS[hold]
  if (!E) throw new Error(`motion: enter is one of ${Object.keys(ENTERS).join(', ')}`)
  if (!X) throw new Error(`motion: exit is one of ${Object.keys(EXITS).join(', ')}`)
  if (!H) throw new Error(`motion: hold is one of ${Object.keys(HOLDS).join(', ')}`)
  const t = frame / fps, end = duration / fps
  let tin = opts.in ?? E.in, tout = opts.out ?? X.out
  const room = Math.max(0, end - delay)
  if (tin + tout > room) {   // a short beat: both shrink to fit
    const k = room > 0 && tin + tout > 0 ? room / (tin + tout) : 0
    tin *= k
    tout *= k
  }
  const fadeIn = Math.min(E.fade, tin)
  // enter
  const pIn = tin > 0 ? progress(frame, fps, delay, tin, E.curve) : t >= delay ? 1 : 0
  let opacity = t < delay ? 0 : fadeIn > 0 ? clamp01((t - delay) / fadeIn) : 1
  let scale = 1 + (E.scale - 1) * amount * (1 - pIn)
  let x = E.x * amount * (1 - pIn), y = E.y * amount * (1 - pIn)
  // exit
  const pOut = tout > 0 ? clamp01((t - (end - tout)) / tout) : 0
  if (pOut > 0) {
    const o = ease.in(pOut)
    opacity *= 1 - o
    scale *= 1 + (X.scale - 1) * o
    y += X.y * o
  }
  // hold: comes in over SETTLE after the enter, goes with the exit
  const w = clamp01((t - delay - tin) / SETTLE) * (1 - pOut)
  if (w > 0 && H.period) {
    const s = Math.sin((2 * Math.PI * (t - delay - tin)) / H.period)
    if (H.scale) scale *= 1 + H.scale * w * s
    if (H.y) y += H.y * w * s
  }
  const r = (v) => Math.round(v * 1e4) / 1e4 + 0
  opacity = r(opacity); scale = r(scale); x = r(x); y = r(y)
  return { opacity, scale, x, y, style: { opacity, transform: `translate(${x}px, ${y}px) scale(${scale})` } }
}

/** The overlay global: every helper above under one name. */
export const Motion = Object.freeze({ motion, ease, progress, draw, stagger, pulse })
