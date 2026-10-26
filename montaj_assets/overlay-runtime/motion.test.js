// montaj_assets/overlay-runtime/motion.test.js
//
// Tests for the motion helpers (motion.js): an overlay's enter, hold and exit in one call, eased; lines that draw on;
// staggered starts; a repeating ping. PL89b's overlays faded and rose in linearly, held dead still and never left;
// these give an overlay that motion in one line. Run through `npm test` (test.js imports this file) or directly via
// `node motion.test.js`.
import assert from 'node:assert/strict'
import { motion, ease, progress, draw, stagger, pulse } from './motion.js'

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
  // exit: fades over the last 120 ms, gone at the last frame
  assert.equal(motion(D - at(0.12), fps, D).opacity, 1, 'exit: whole until its last 120 ms')
  assert.equal(motion(D, fps, D).opacity, 0, 'exit: gone at the end')
  assert.ok(motion(D - at(0.06), fps, D).opacity < 1, 'exit: on its way out')
  assert.equal(motion(D, fps, D, { exit: 'none' }).opacity, 1, 'exit none: holds to the cut')
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
