// §244: `captions.showLangs` picks which languages the export and a sampled frame DRAW, in captionOverlayFields
// (the one copy both read). Neither `showLangs` nor the source's `lang` is a template prop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captionOverlayFields } from '../caption-spec.js'

const SRC = { id: 'cap-0', text: 'hello', start: 0, end: 2, words: [{ word: 'hello', start: 0, end: 1 }] }
const ES = { id: 'cap-1', text: 'hola', start: 0, end: 2, lane: 1, lang: 'es', translationOf: ['cap-0'] }
const base = { style: 'plate', lang: 'en', segments: [SRC, ES] }

test('no showLangs: every segment, as before', () => {
  const f = captionOverlayFields(base)
  assert.deepEqual(f.props.segments, [SRC, ES])
})

test('Spanish alone draws only the translated row', () => {
  assert.deepEqual(captionOverlayFields({ ...base, showLangs: ['es'] }).props.segments, [ES])
})

test('the source alone draws only the original', () => {
  assert.deepEqual(captionOverlayFields({ ...base, showLangs: ['en'] }).props.segments, [SRC])
})

test('both languages draw both', () => {
  assert.deepEqual(captionOverlayFields({ ...base, showLangs: ['en', 'es'] }).props.segments, [SRC, ES])
})

test('showLangs and lang never reach the template as props', () => {
  const props = captionOverlayFields({ ...base, showLangs: ['es'], color: '#fff' }).props
  assert.equal('showLangs' in props, false)
  assert.equal('lang' in props, false)
  assert.equal(props.color, '#fff')
})

test('a project with no translations and no showLangs is untouched (lang only)', () => {
  const f = captionOverlayFields({ style: 'clean', lang: 'en', segments: [SRC] })
  assert.deepEqual(f.props.segments, [SRC])
  assert.equal('lang' in f.props, false)
})
