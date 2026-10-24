// filter-number.js: project.json numbers that go into an ffmpeg graph as text pass unchanged or are refused (§563).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finiteNumber, positiveNumber, pixelCount, frameSize } from '../filter-number.js'

test('valid values pass through unchanged', () => {
  assert.equal(finiteNumber(-0.25, 'f'), -0.25)
  assert.equal(positiveNumber(29.97, 'f'), 29.97)
  assert.equal(pixelCount(1080, 'f'), 1080)
  assert.equal(frameSize(1080, 1920), '1080x1920')
})

test('anything else is refused, naming the field', () => {
  for (const v of ['1', '1,x', NaN, Infinity, null, undefined, [1], true]) {
    assert.throws(() => finiteNumber(v, 'the.field'), /the\.field/)
  }
  for (const v of [0, -1, '2']) assert.throws(() => positiveNumber(v, 'the.fps'), /the\.fps/)
  for (const v of [0, 1.5, '1080', -2]) assert.throws(() => pixelCount(v, 'the.px'), /the\.px/)
  assert.throws(() => frameSize('1080:x', 1920), /settings\.resolution\[0\]/)
  assert.throws(() => frameSize(1080, null), /settings\.resolution\[1\]/)
})
