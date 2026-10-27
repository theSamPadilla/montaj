// render/test/carousel-font-escaping.test.mjs
//
// §587 r3: an overlay element's `fontFiles` comes from the AI as well as the
// editor. Whatever family or src it carries, the @font-face rule the page gets
// must stay one CSS string: no quote, backslash, angle bracket, brace, newline
// or other control character breaks out of it, and a comma never reaches the
// family name (it would split a font-family list). slideFontFaces and the
// @font-face line are taken from the source, as render-carousel.js runs its CLI
// when imported.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toFileHref, isAbsPath } from '../file-url.js'

const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'render-carousel.js'), 'utf8')
const start = SRC.indexOf('function slideFontFaces(')
const end = SRC.indexOf('\nfunction generateHtml(')
assert.ok(start > 0 && end > start, 'slideFontFaces found')
const slideFontFaces = new Function('join', 'isAbsPath', 'toFileHref', `${SRC.slice(start, end)}\nreturn slideFontFaces`)(join, isAbsPath, toFileHref)
const rule = (f) => `@font-face { font-family: "${f.family}"; src: url("${f.href}"); font-display: block; }`
// the generateHtml line builds exactly this rule
assert.ok(SRC.includes('`@font-face { font-family: "${f.family}"; src: url("${f.href}"); font-display: block; }\\n`'))

const faces = (...fontFiles) => slideFontFaces([{ fontFiles }], '/proj')

test('a family with a quote, a closing style tag, a newline or a comma stays one clean CSS string', () => {
  for (const family of ['A"B', 'A</style><script>x</script>', 'A\nB', 'A,B', 'A\\"; } body { x: y', 'A\u2028B']) {
    const out = faces({ family, src: 'f.ttf' })
    assert.equal(out.length, 1, family)
    assert.doesNotMatch(out[0].family, /["\\<>{};,\u0000-\u001f\u007f]/, family)
    assert.match(rule(out[0]), /^@font-face \{ font-family: "[^"]+"; src: url\("[^"]+"\); font-display: block; \}$/)
  }
})

test('an http(s) href with a quote, a space, a newline or a control character is skipped', () => {
  for (const src of ['https://x.test/a".ttf', 'https://x.test/a b.ttf', 'https://x.test/a\nb.ttf', 'https://x.test/a\u0000.ttf', 'https://x.test/a\tb.ttf', 'https://x.test/a<b.ttf', 'https://x.test/a\u2028b.ttf']) {
    assert.deepEqual(faces({ family: 'Ok', src }), [], JSON.stringify(src))
  }
  assert.equal(faces({ family: 'Ok', src: 'https://x.test/a.ttf' }).length, 1)
})

test('a relative file in a directory with a space still becomes a face', () => {
  const out = slideFontFaces([{ fontFiles: [{ family: 'Ok', src: 'my font.ttf' }] }], '/my proj')
  assert.equal(out.length, 1)
  assert.match(out[0].href, /^file:\/\/\/my%20proj\/my%20font\.ttf$/)
})
