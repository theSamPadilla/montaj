// §244: a translated caption segment (`lang` + `translationOf`) is drawn in
// every one of the nine caption styles, as a plain line stacked under the
// caption it translates, inside that caption's block (so the browser lays the
// two out and they never collide). The templates are compiled exactly as
// captions-font.test.mjs does and called as plain functions; these tests read
// the returned element tree.
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const __dirname           = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR       = join(__dirname, '..', 'templates', 'captions')
const OVERLAY_RUNTIME_DIR = join(__dirname, '..', '..', 'overlay-runtime')

function montajRenderShimPlugin() {
  return {
    name: 'montaj-render-shim',
    setup(build) {
      build.onResolve({ filter: /^montaj\/render$/ }, () => ({ path: 'montaj-render-shim', namespace: 'shim' }))
      build.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({
        resolveDir: OVERLAY_RUNTIME_DIR,
        contents: `
          export { interpolate, spring } from './helpers.js'
          export { captionOuterStyle, captionInnerStyle } from './position.js'
        `,
      }))
    },
  }
}

async function loadTemplate(name) {
  const result = await esbuild.build({
    entryPoints: [join(TEMPLATES_DIR, `${name}.jsx`)],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server'],
    plugins: [montajRenderShimPlugin()],
    write: false,
    logLevel: 'silent',
  })
  const tmpPath = join(__dirname, `__tmp-caption-translation-${name}.mjs`)
  writeFileSync(tmpPath, result.outputFiles[0].text)
  try {
    return (await import(pathToFileURL(tmpPath).href)).default
  } finally {
    unlinkSync(tmpPath)
  }
}

const STYLE_NAMES = ['clean', 'subtitle', 'karaoke', 'outline', 'highlight-box', 'word-by-word', 'pop', 'accent', 'plate']
const templates = {}
before(async () => {
  for (const name of STYLE_NAMES) templates[name] = await loadTemplate(name)
})

// ── element-tree helpers ────────────────────────────────────────────────────
const isElement = n => n && typeof n === 'object' && 'props' in n && 'type' in n
function children(el) {
  const c = el.props?.children
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(x => x != null && x !== false)
}
function* walk(node) {
  if (Array.isArray(node)) { for (const n of node) yield* walk(n); return }
  if (!isElement(node)) return
  yield node
  for (const c of children(node)) yield* walk(c)
}
function text(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  return isElement(node) ? children(node).map(text).join('') : ''
}
/** The top-level blocks a template returned (its fragment's non-null children). */
function blocks(out) {
  if (out == null) return []
  return children(out).filter(isElement)
}
const byCaptionId = (node, id) => [...walk(node)].filter(el => el.props['data-caption-id'] === id)

// ── fixtures ────────────────────────────────────────────────────────────────
const FPS = 30
const SRC = {
  id: 'cap-0', text: 'hello there world', start: 1, end: 5,
  words: [{ word: 'hello', start: 1, end: 2 }, { word: 'there', start: 3, end: 3.5 }, { word: 'world', start: 3.5, end: 4.5 }],
}
const ES = { id: 'cap-1', text: 'hola a todos', start: 1, end: 5, lane: 1, lang: 'es', translationOf: ['cap-0'] }
const render = (name, segments, frame) => templates[name]({ frame, fps: FPS, segments })

for (const name of STYLE_NAMES) {
  describe(name, () => {
    test('draws the translation under its caption, inside the caption\'s own block', () => {
      const out = render(name, [SRC, ES], 45)
      const bs = blocks(out)
      assert.equal(bs.length, 1, 'one block: the translation is not a caption of its own')
      assert.equal(bs[0].props['data-caption-id'], 'cap-0')
      const [line] = byCaptionId(bs[0], 'cap-1')
      assert.ok(line, 'the translation line is inside the caption block')
      assert.equal(text(line), 'hola a todos')
    })

    test('the caption and its translation share one column, caption first', () => {
      const out = render(name, [ES, SRC], 45)
      const column = [...walk(out)].find(el => el.props.style?.flexDirection === 'column')
      assert.ok(column, 'a column holds the caption and its translation')
      const ids = [...walk(column)].map(el => el.props['data-caption-id']).filter(Boolean)
      assert.deepEqual(ids, ['cap-1'], 'the only marked line in the column is the translation')
      assert.equal(text(children(column).at(-1)), 'hola a todos', 'the translation comes last')
    })

    test('a translation that carries words (the editor fills them in) is still one plain line', () => {
      const withWords = { ...ES, words: [{ word: 'hola', start: 1, end: 2 }, { word: 'a', start: 2, end: 3 }, { word: 'todos', start: 3, end: 4 }] }
      const [line] = byCaptionId(render(name, [SRC, withWords], 45), 'cap-1')
      assert.equal(text(line), 'hola a todos')
      assert.equal(children(line).filter(isElement).length, 0, 'no per-word elements')
    })

    test('the line stays up while no word of the caption is being spoken', () => {
      // t = 2.5 s: between "hello" (ends 2) and "there" (starts 3).
      const [line] = byCaptionId(render(name, [SRC, ES], 75), 'cap-1')
      assert.ok(line, 'the translation is drawn in the gap')
      assert.equal(text(line), 'hola a todos')
    })

    test('a translation whose caption is not on screen draws alone', () => {
      const out = render(name, [{ ...SRC, start: 6, end: 8 }, ES], 45)
      const bs = blocks(out)
      assert.equal(bs.length, 1)
      assert.equal(bs[0].props['data-caption-id'], 'cap-1')
      assert.equal(text(bs[0]), 'hola a todos')
    })

    test('two languages stack in row order under the caption', () => {
      const FR = { ...ES, id: 'cap-2', lane: 2, lang: 'fr', text: 'bonjour à tous' }
      const out = render(name, [FR, SRC, ES], 45)
      assert.equal(blocks(out).length, 1)
      const ids = [...walk(out)].map(el => el.props['data-caption-id']).filter(id => id && id !== 'cap-0')
      assert.deepEqual(ids, ['cap-1', 'cap-2'])
    })

    test('with no translation there is no column: the caption renders as before', () => {
      const out = render(name, [SRC], 45)
      assert.equal([...walk(out)].some(el => el.props.style?.flexDirection === 'column'), false)
    })
  })
}

test('a translation of a caption that is not on screen draws alone, never under another caption', () => {
  for (const name of STYLE_NAMES) {
    // The next caption is on screen; the translation names cap-0, which is not.
    const next = { ...SRC, id: 'cap-5' }
    const out = render(name, [next, ES], 45)
    const bs = blocks(out)
    assert.equal(bs.length, 2, name)
    assert.equal(byCaptionId(bs.find(b => b.props['data-caption-id'] === 'cap-5'), 'cap-1').length, 0, name)
  }
})

test('accent: a hero caption stacks its translation too', () => {
  const out = render('accent', [{ ...SRC, hero: true }, ES], 45)
  assert.equal(blocks(out).length, 1)
  assert.equal(text(byCaptionId(out, 'cap-1')[0]), 'hola a todos')
})

test('a hand-made second row that is not a translation still draws on its own', () => {
  for (const name of STYLE_NAMES) {
    const other = { id: 'cap-9', text: 'note', start: 1, end: 5, lane: 1, words: [{ word: 'note', start: 1, end: 4 }] }
    assert.equal(blocks(render(name, [SRC, other], 45)).length, 2, name)
  }
})

test('plate: the translation is a row INSIDE the one plate, which holds both and keeps the caption\'s theme', () => {
  const out = render('plate', [SRC, ES], 45)
  const plates = [...walk(out)].filter(el => el.props.style && 'borderRadius' in el.props.style)
  assert.equal(plates.length, 1, 'one plate around both rows')
  assert.equal(byCaptionId(plates[0], 'cap-1').length, 1, 'the translation is inside it')
  const tr = byCaptionId(plates[0], 'cap-1')[0]
  assert.equal(tr.props.style.fontSize, plates[0].props.style.fontSize, 'same face as the caption')
})
