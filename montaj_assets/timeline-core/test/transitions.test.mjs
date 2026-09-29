import test from 'node:test'
import assert from 'node:assert/strict'
import { transitionPairs, transitionProgress, fadeShape, TRANSITION_EPSILON_S } from '../index.js'

const item = (id, start, end, extra = {}) => ({ id, start, end, ...extra })

test('transitionPairs finds a partial overlap between neighbours', () => {
  const pairs = transitionPairs([item('a', 0, 4), item('b', 3, 8)])
  assert.equal(pairs.length, 1)
  assert.deepEqual(
    { from: pairs[0].from.id, to: pairs[0].to.id, start: pairs[0].start, end: pairs[0].end },
    { from: 'a', to: 'b', start: 3, end: 4 },
  )
})

test('transitionPairs ignores butt-joined items', () => {
  assert.deepEqual(transitionPairs([item('a', 0, 4), item('b', 4, 8)]), [])
})

test('transitionPairs ignores a gap', () => {
  assert.deepEqual(transitionPairs([item('a', 0, 4), item('b', 5, 8)]), [])
})

test('transitionPairs ignores containment — that is a validator error, not a transition', () => {
  assert.deepEqual(transitionPairs([item('a', 0, 9), item('b', 3, 5)]), [])
})

test('transitionPairs ignores identical spans — mutual containment, not pinned elsewhere', () => {
  // Falls out of the containment check today (`num(to.end) <= end`, with
  // `to.end === from.end`), but nothing exercised the identical-span case
  // directly until now — a reviewer finding, not a code change.
  assert.deepEqual(transitionPairs([item('a', 0, 4), item('b', 0, 4)]), [])
})

test('transitionPairs ignores a float-noise overlap — two clips that merely touch', () => {
  // The operator's project, verbatim: 30.355900000000002 - 30.3559 is a
  // 3.6e-15 s "overlap" left by arithmetic on timeline seconds, not a
  // transition anyone asked for.
  const a = item('IMG_0706-speech-0', 20, 30.355900000000002)
  const b = item('IMG_0708-speech-0', 30.3559, 40)
  assert.ok(a.end > b.start, 'the fixture must really overlap, or this test proves nothing')
  assert.deepEqual(transitionPairs([a, b]), [])
})

test('transitionPairs still pairs a real overlap next to a float-noise one', () => {
  const pairs = transitionPairs([
    item('a', 0, 30.355900000000002),
    item('b', 30.3559, 40),
    item('c', 39.5, 50),
  ])
  assert.deepEqual(pairs.map(p => [p.from.id, p.to.id, p.start, p.end]), [['b', 'c', 39.5, 40]])
})

test('TRANSITION_EPSILON_S is the exact threshold: at or under it touches, over it is a crossfade', () => {
  const at = (overlap) => transitionPairs([item('a', 0, 10), item('b', 10 - overlap, 20)]).length
  assert.equal(at(TRANSITION_EPSILON_S / 2), 0)
  assert.equal(at(TRANSITION_EPSILON_S * 2), 1)
})

test('TRANSITION_EPSILON_S is positive and well under one frame at any output rate', () => {
  assert.ok(TRANSITION_EPSILON_S > 0)
  assert.ok(TRANSITION_EPSILON_S <= (1 / 240) / 4)
})

test('transitionPairs is order-independent — it sorts by start', () => {
  const pairs = transitionPairs([item('b', 3, 8), item('a', 0, 4)])
  assert.equal(pairs[0].from.id, 'a')
})

test('transitionPairs finds two consecutive transitions', () => {
  const pairs = transitionPairs([item('a', 0, 4), item('b', 3, 8), item('c', 7, 12)])
  assert.deepEqual(pairs.map(p => [p.from.id, p.to.id]), [['a', 'b'], ['b', 'c']])
})

test('transitionProgress ramps 0 to 1 across the span and clamps outside it', () => {
  const [pair] = transitionPairs([item('a', 0, 4), item('b', 3, 8)])
  assert.equal(transitionProgress(pair, 3), 0)
  assert.equal(transitionProgress(pair, 3.5), 0.5)
  assert.equal(transitionProgress(pair, 4), 1)
  assert.equal(transitionProgress(pair, 2), 0)
  assert.equal(transitionProgress(pair, 9), 1)
})

test('transitionProgress returns 0 for a zero-length span rather than NaN', () => {
  assert.equal(transitionProgress({ start: 3, end: 3 }, 3), 0)
})

test('fadeShape is symmetric for a transparent pair', () => {
  const [pair] = transitionPairs([item('a', 0, 4), item('b', 3, 8)])
  assert.deepEqual(fadeShape(pair, 0.25), { from: 0.75, to: 0.25 })
})

test('fadeShape holds the outgoing side when it is opaque', () => {
  const [pair] = transitionPairs([item('a', 0, 4, { opaque: true }), item('b', 3, 8, { opaque: true })])
  assert.deepEqual(fadeShape(pair, 0.25), { from: 1, to: 0.25 })
})

test('fadeShape keys off the OUTGOING side only — an opaque incoming over a transparent outgoing is symmetric', () => {
  const [pair] = transitionPairs([item('a', 0, 4), item('b', 3, 8, { opaque: true })])
  assert.deepEqual(fadeShape(pair, 0.25), { from: 0.75, to: 0.25 })
})
