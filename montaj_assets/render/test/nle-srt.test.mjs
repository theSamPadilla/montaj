// render/test/nle-srt.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captionsToSrt } from '../nle/srt.js'

const withSegments = (segments) => ({ captions: { segments } })

test('numbered cues, HH:MM:SS,mmm timing, blank line between, trailing newline', () => {
  const srt = captionsToSrt(withSegments([
    { text: 'Hello', start: 0.2, end: 0.6 },
    { text: 'World', start: 0.8, end: 1.3 },
  ]))
  assert.equal(srt, '1\n00:00:00,200 --> 00:00:00,600\nHello\n\n2\n00:00:00,800 --> 00:00:01,300\nWorld\n')
})

test('times round to the millisecond', () => {
  const srt = captionsToSrt(withSegments([{ text: 'a', start: 1.0004, end: 1.0006 }, { text: 'b', start: 2.9996, end: 3.4994 }]))
  assert.match(srt, /00:00:01,000 --> 00:00:01,001\na/)
  assert.match(srt, /00:00:03,000 --> 00:00:03,499\nb/)
})

test('more than an hour', () => {
  const srt = captionsToSrt(withSegments([{ text: 'late', start: 3723.456, end: 7384.5 }]))
  assert.match(srt, /01:02:03,456 --> 02:03:04,500\nlate/)
})

test('multi-line text is kept as is', () => {
  const srt = captionsToSrt(withSegments([{ text: 'one\ntwo', start: 0, end: 1 }]))
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,000\none\ntwo\n')
})

test('cues are sorted by start (stable for ties)', () => {
  const srt = captionsToSrt(withSegments([
    { text: 'third', start: 5, end: 6 },
    { text: 'first', start: 1, end: 2 },
    { text: 'second-a', start: 3, end: 4 },
    { text: 'second-b', start: 3, end: 4.5 },
  ]))
  assert.deepEqual(srt.split('\n\n').map((c) => c.split('\n')[2]), ['first', 'second-a', 'second-b', 'third'])
  assert.ok(srt.startsWith('1\n'))
})

test('empty text and zero-length segments are skipped; numbering stays dense', () => {
  const srt = captionsToSrt(withSegments([
    { text: '', start: 0, end: 1 },
    { text: '  ', start: 0, end: 1 },
    { text: 'zero', start: 2, end: 2 },
    { text: 'sub-ms', start: 2, end: 2.0003 },
    { text: 'kept', start: 3, end: 4 },
  ]))
  assert.equal(srt, '1\n00:00:03,000 --> 00:00:04,000\nkept\n')
})

test('no captions, or nothing usable, is null', () => {
  assert.equal(captionsToSrt({}), null)
  assert.equal(captionsToSrt({ captions: {} }), null)
  assert.equal(captionsToSrt(withSegments([])), null)
  assert.equal(captionsToSrt(withSegments([{ text: '', start: 0, end: 1 }])), null)
  assert.equal(captionsToSrt(null), null)
})

test('a blank line inside a caption does not end the cue early', () => {
  const srt = captionsToSrt(withSegments([{ text: 'one\n\n  \ntwo', start: 0, end: 1 }, { text: 'next', start: 2, end: 3 }]))
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,000\none\ntwo\n\n2\n00:00:02,000 --> 00:00:03,000\nnext\n')
})
