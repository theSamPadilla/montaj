// montaj_assets/overlay-runtime/motion.test.js
//
// Tests for the motion helpers (motion.js): an overlay's enter, hold and exit in one call, eased; lines that draw on;
// staggered starts; a repeating ping. PL89b's overlays faded and rose in linearly, held dead still and never left;
// these give an overlay that motion in one line. Run through `npm test` (test.js imports this file) or directly via
// `node motion.test.js`.
import assert from 'node:assert/strict'
import { motion, ease, progress, draw, stagger, pulse, Motion } from './motion.js'

const fps = 30, near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol
const at = (s) => s * fps

// ── ease ─────────────────────────────────────────────────────────────────────────────────────────────────────────
for (const [name, f] of Object.entries(ease)) {
  assert.ok(near(f(0), 0) && near(f(1), 1), `ease.${name} runs 0 to 1`)
}
assert.ok(ease.out(0.5) > 0.5, 'ease.out is ahead at the middle')
assert.ok(ease.in(0.5) < 0.5, 'ease.in is behind at the middle')
assert.ok(near(ease.inOut(0.5), 0.5), 'ease.inOut is halfway at the middle')
assert.ok([0.6, 0.7, 0.8, 0.9].some((t) => ease.back(t) > 1), 'ease.back overshoots before it settles')

// ── progress, draw, stagger, pulse ───────────────────────────────────────────────────────────────────────────────
assert.equal(progress(at(1), fps, 1, 0.4), 0, 'progress is 0 at its start')
assert.equal(progress(at(1.4), fps, 1, 0.4), 1, 'and 1 at its end')
assert.equal(progress(at(0.5), fps, 1, 0.4), 0, 'and 0 before it')
assert.ok(progress(at(1.2), fps, 1, 0.4) > 0.5, 'eased out by default')
assert.ok(near(progress(at(1.2), fps, 1, 0.4, 'linear'), 0.5), 'a curve by name')
assert.equal(draw(0, fps), 0, 'a line starts undrawn')
assert.equal(draw(at(0.45), fps), 1, 'and is drawn by 0.45 s')
assert.ok(draw(at(0.2), fps, { start: 0.1, dur: 0.2 }) > 0.5, 'draw takes start and dur')
assert.deepEqual([0, 1, 2].map((i) => stagger(i)), [0, 0.08, 0.16])
assert.ok(near(stagger(2, 0.1, 0.5), 0.7))
assert.ok(near(pulse(at(0.55), fps), 0.5) && near(pulse(at(1.65), fps), 0.5), 'pulse repeats every 1.1 s')
assert.equal(pulse(at(0.2), fps, { start: 0.5 }), 0, 'and is 0 before its start')

// ── motion: enter, hold, exit ────────────────────────────────────────────────────────────────────────────────────
const D = at(4) // a 4 s overlay
{
  const a = motion(0, fps, D)
  assert.equal(a.opacity, 0, 'pop: invisible at its first frame')
  assert.ok(near(a.scale, 0.7), 'pop: from 70%')
  const b = motion(at(0.18), fps, D)
  assert.equal(b.opacity, 1, 'pop: in by 180 ms')
  assert.ok(Math.abs(b.scale - 1) < 0.02, `pop: at full size by 180 ms (${b.scale})`)
  const peak = Math.max(...Array.from({ length: 6 }, (_, k) => motion(at(0.18 * (k + 1) / 7), fps, D).scale))
  assert.ok(peak > 1, 'pop: overshoots a little on the way in')
  assert.equal(b.style.opacity, b.opacity)
  assert.match(b.style.transform, /^translate\(-?[\d.]+px, -?[\d.]+px\) scale\([\d.]+\)$/)
}
{
  // hold: alive, gently, between the enter and the exit
  const scales = Array.from({ length: 20 }, (_, k) => motion(at(0.6 + k * 0.12), fps, D).scale)
  assert.ok(Math.max(...scales) - Math.min(...scales) > 0.004, 'hold: breathes')
  assert.ok(scales.every((s) => Math.abs(s - 1) <= 0.0125), 'hold: by at most 1.2%')
  assert.ok(Array.from({ length: 20 }, (_, k) => motion(at(0.6 + k * 0.12), fps, D, { hold: 'none' }).scale).every((s) => s === 1), 'hold none: still')
}
{
  // exit: fades over the last 120 ms, gone at the last frame drawn. An item of D frames draws frames 0 to D - 1
  // (render.js: frameCount = round((end - start) * fps)); timed to frame D, the exit stopped at 62% and hard-cut (PL89 review)
  assert.equal(motion(D - 1 - at(0.12), fps, D).opacity, 1, 'exit: whole until its last 120 ms')
  assert.equal(motion(D - 1, fps, D).opacity, 0, 'exit: gone on the last frame drawn')
  assert.ok(motion(D - 1 - at(0.06), fps, D).opacity < 1, 'exit: on its way out')
  assert.equal(motion(D - 1, fps, D, { exit: 'none' }).opacity, 1, 'exit none: holds to the cut')
}
{
  // rise and slides move, and land at 0
  const r0 = motion(0, fps, D, { enter: 'rise' }), r1 = motion(at(0.5), fps, D, { enter: 'rise', hold: 'none' })
  assert.ok(r0.y > 10 && r1.y === 0 && r1.scale === 1, 'rise: from below to its place')
  assert.ok(motion(0, fps, D, { enter: 'slide-left' }).x < -10, 'slide-left comes from the left')
  assert.ok(motion(0, fps, D, { enter: 'slide-right' }).x > 10, 'slide-right from the right')
  assert.ok(motion(D - 1, fps, D, { exit: 'sink' }).y > 0, 'sink: drops as it goes')
}
{
  // delay: nothing before it, then the same enter
  assert.equal(motion(at(0.3), fps, D, { delay: 0.5 }).opacity, 0)
  assert.equal(motion(at(0.5 + 0.18), fps, D, { delay: 0.5 }).opacity, 1)
}
{
  // a beat too short for the default in and out: both shrink to fit, and it is still gone at its end
  const d = at(0.2)
  assert.equal(motion(0, fps, d).opacity, 0)
  assert.equal(motion(d, fps, d).opacity, 0)
  assert.ok(Math.max(...Array.from({ length: 7 }, (_, k) => motion(k, fps, d).opacity)) === 1, 'reaches full opacity between')
}
{
  // a fractional frame (motion blur's sub-frames) gives a value between its neighbours
  const a = motion(3, fps, D).opacity, b = motion(4, fps, D).opacity, m = motion(3.5, fps, D).opacity
  assert.ok(m >= Math.min(a, b) - 1e-9 && m <= Math.max(a, b) + 1e-9)
}
assert.throws(() => motion(0, fps, D, { enter: 'spin' }), /enter is one of/)

// ── follow: a label riding direct_scene mark's track ─────────────────────────────────────────────────────────────
{
  const part = (x, y) => ({ cast: 0, part: 'screen', pixel: [x, y], box: [x - 40, y - 80, x + 40, y + 80], inView: true,
    leader: { side: 'right', from: [x + 40, y], to: [x + 300, y], align: 'start' } })
  const cast = (x) => ({ cast: 0, top: [x, 400], bottom: [x, 1600], box: [x - 200, 400, x + 200, 1600], metres: 0.48, inView: true,
    rule: { side: 'right', x: x + 300, top: 400, bottom: 1600, label: [x + 340, 1000], align: 'start' } })
  // a 2160 x 3840 project: mark's pixels are in its frame, the overlay draws on the 1080 canvas (half)
  const mark = { kind: 'mark', at: 0, size: { width: 2160, height: 3840 },
    track: [{ t: 0, parts: [part(1000, 1000)], casts: [cast(1000)] }, { t: 0.5, parts: [part(1200, 1100)], casts: [cast(1200)] }, { t: 1, parts: [part(1200, 1100)], casts: [cast(1200)] }] }
  const f0 = Motion.follow(mark, 0, fps)
  assert.deepEqual(f0.parts.screen.pixel, [500, 500], 'the first row, halved to the 1080 canvas')
  const f = Motion.follow(mark, at(0.25), fps)
  assert.deepEqual(f.parts.screen.pixel, [550, 525], 'between rows, linear')
  assert.deepEqual(f.parts.screen.leader.from, [570, 525])
  assert.deepEqual(f.parts.screen.leader.to, [700, 525])
  assert.equal(f.parts.screen.leader.side, 'right')
  assert.deepEqual(f.casts[0].rule.label, [720, 500])
  assert.equal(f.casts[0].metres, 0.48)
  assert.deepEqual(Motion.follow(mark, at(5), fps).parts.screen.pixel, [600, 550], 'held at the last row after it')
  // from: the scene's seconds at the overlay's frame 0 (the scene item's inPoint, when they start together)
  assert.deepEqual(Motion.follow(mark, 0, fps, { from: 0.25 }).parts.screen.pixel, [550, 525])
  // a mark with no track (one time) is its own single row
  assert.deepEqual(Motion.follow({ size: { width: 1080, height: 1920 }, parts: [part(300, 400)], casts: [] }, 99, fps).parts.screen.pixel, [300, 400])
  assert.equal(Motion.follow(null, 0, fps), null, 'nothing to follow is null, never a throw')
}
console.log('overlay-runtime: motion OK')
