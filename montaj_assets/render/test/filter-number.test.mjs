// filter-number.js: project.json numbers that go into an ffmpeg graph as text pass unchanged or are refused (§563).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finiteNumber, positiveNumber, pixelCount, frameSize } from '../filter-number.js'

test('valid values pass through unchanged', () => {
  assert.equal(finiteNumber(-0.25, 'f'), -0.25)
  assert.equal(finiteNumber(0, 'f', 0), 0)
  assert.equal(positiveNumber(29.97, 'f'), 29.97)
  assert.equal(pixelCount(1080, 'f'), 1080)
  assert.equal(frameSize(1080, 1920), '1080x1920')
})

test('a numeric string, which older projects hold and which always rendered, becomes its number', () => {
  assert.equal(finiteNumber('-0.25', 'f'), -0.25)
  assert.equal(finiteNumber(' 0.8 ', 'f', 0), 0.8)
  assert.equal(finiteNumber('.5', 'f'), 0.5)
  assert.equal(finiteNumber('1e-3', 'f'), 0.001)
  assert.equal(positiveNumber('30', 'f'), 30)
  assert.equal(positiveNumber('29.97', 'f'), 29.97)
  assert.equal(positiveNumber('1.5', 'f'), 1.5)
  assert.equal(pixelCount('320', 'f'), 320)
  assert.equal(frameSize('320', '568'), frameSize(320, 568))
})

test('anything else is refused, naming the field', () => {
  for (const v of ['1,x', '', ' ', '0x10', 'Infinity', '1e999', '30fps', '1 2', NaN, Infinity, null, undefined, [1], true]) {
    assert.throws(() => finiteNumber(v, 'the.field'), /the\.field/)
  }
  assert.throws(() => finiteNumber(-0.1, 'the.volume', 0), /the\.volume must be a number of zero or more/)
  for (const v of [0, -1, '0', '-2']) assert.throws(() => positiveNumber(v, 'the.fps'), /the\.fps/)
  for (const v of [0, 1.5, '1.5', '1080.5', -2]) assert.throws(() => pixelCount(v, 'the.px'), /the\.px/)
  assert.throws(() => frameSize('1080:x', 1920), /settings\.resolution\[0\]/)
  assert.throws(() => frameSize(1080, null), /settings\.resolution\[1\]/)
})
