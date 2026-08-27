import test from 'node:test'
import assert from 'node:assert/strict'
import { transitionPairs, transitionProgress, fadeShape } from '../index.js'

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
