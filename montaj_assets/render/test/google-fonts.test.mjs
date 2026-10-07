// §140: a google_fonts value from an agent arrives as a list, a JSON-array
// string or a comma list, and one bad family must never fail the overlay.
// Measured from a real call: `["DM+Serif+Display", "DM+Sans:wght@700"]` was
// split on commas into `["DM+Serif+Display"` and ` "DM+Sans:wght@700"]`, the
// stylesheet URL carried the brackets and quotes, Google answered 400 with an
// HTML page, and the refused stylesheet failed the step.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGoogleFonts, cleanFontSpec, fontLoadFailure } from '../google-fonts.js'
import { generateHtml } from '../bundle.js'

test('a JSON-array string, the call that failed, gives its two families', () => {
  assert.deepEqual(parseGoogleFonts('["DM+Serif+Display", "DM+Sans:wght@700"]').fonts, ['DM+Serif+Display', 'DM+Sans:wght@700'])
})

test('a list, a comma list and repeated values give the same families, trimmed, de-quoted, spaces as +', () => {
  const want = ['DM+Serif+Display', 'DM+Sans:wght@700']
  assert.deepEqual(parseGoogleFonts(['"DM Serif Display"', ' DM Sans:wght@700 ']).fonts, want)
  assert.deepEqual(parseGoogleFonts('DM Serif Display, DM+Sans:wght@700').fonts, want)
  assert.deepEqual(parseGoogleFonts(['DM+Serif+Display', '["DM+Sans:wght@700"]']).fonts, want)
  assert.deepEqual(parseGoogleFonts("'DM Serif Display', 'DM Sans:wght@700', DM+Serif+Display").fonts, want, 'a repeat is dropped')
})

test('a comma inside a spec (an axis list or a value tuple) does not split it', () => {
  assert.deepEqual(parseGoogleFonts('Playfair+Display:ital,wght@0,400;1,700, Anton').fonts, ['Playfair+Display:ital,wght@0,400;1,700', 'Anton'])
  assert.deepEqual(parseGoogleFonts('Roboto+Flex:opsz,wght,GRAD@8..144,400,0').fonts, ['Roboto+Flex:opsz,wght,GRAD@8..144,400,0'])
})

test('a family that cannot be a Google family is dropped and named, and the rest still load', () => {
  const r = parseGoogleFonts(['Anton', 'Bad"><script>', '', '   ', 'Syne:wght@800'])
  assert.deepEqual(r.fonts, ['Anton', 'Syne:wght@800'])
  assert.deepEqual(r.dropped, ['Bad"><script>'])
  assert.equal(cleanFontSpec('Anton:not an axis'), 'Anton', 'a bad axis list keeps the family')
  assert.equal(cleanFontSpec(42), null)
})

test('generateHtml links each family on its own, so one Google refuses cannot take the others down', () => {
  const html = generateHtml(1080, 1920, false, ['"DM Serif Display"', 'DM+Sans:wght@700', 'Bad"><script>'])
  const links = [...html.matchAll(/<link rel="stylesheet" href="(https:\/\/fonts\.googleapis\.com\/[^"]*)">/g)].map(m => m[1])
  assert.deepEqual(links, [
    'https://fonts.googleapis.com/css2?family=DM+Serif+Display&display=swap',
    'https://fonts.googleapis.com/css2?family=DM+Sans:wght@700&display=swap',
  ])
  assert.doesNotMatch(html, /Bad/, 'the entry that cannot be a family is not on the page at all')
})

test('a refused or failed Google Fonts load is a font failure naming its family; any other console error is not', () => {
  const refused = "Refused to apply style from 'https://fonts.googleapis.com/css2?family=Nope+Font&display=swap' because its MIME type ('text/html') is not a supported stylesheet MIME type, and strict MIME checking is enabled."
  assert.equal(fontLoadFailure({ type: 'error', text: refused, url: '' }), 'Nope+Font')
  assert.equal(
    fontLoadFailure({ type: 'error', text: 'Failed to load resource: the server responded with a status of 400 ()', url: 'https://fonts.googleapis.com/css2?family=Nope+Font&display=swap' }),
    'Nope+Font',
  )
  assert.equal(fontLoadFailure({ type: 'error', text: 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED', url: 'https://fonts.gstatic.com/s/anton/v25/1Ptgg87LROyAm0K08i4gS7lu.woff2' }), 'a font file')
  assert.equal(fontLoadFailure({ type: 'error', text: 'Uncaught ReferenceError: x is not defined', url: '' }), null)
  assert.equal(fontLoadFailure({ type: 'error', text: 'Failed to load resource: 404', url: 'file:///tmp/a.png' }), null)
  assert.equal(fontLoadFailure({ type: 'warning', text: refused, url: '' }), null)
})
