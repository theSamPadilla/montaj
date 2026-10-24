// montaj_assets/render/test/caption-word-color.test.mjs
//
// §558: a caption word's own colour. A word in `words[]` may carry `color`; every per-word template draws that word
// in it, over the segment's and the track's base colour, while the spoken-word highlight still wins on the word being
// spoken (outline, karaoke, highlight-box, plate) and the one-word-at-a-time templates (word-by-word, pop) show it
// on the word itself. clean and subtitle draw phrases, not words: they ignore it, and render exactly as without it.
// A segment with no word colour renders exactly as before (the golden in caption-segment-style.test.mjs).
//
// Harness: the esbuild + 'montaj/render' shim of caption-segment-style.test.mjs (copied: that file exports nothing).

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
    entryPoints: [join(TEMPLATES_DIR, `${name}.jsx`)], bundle: true, format: 'esm', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server'], plugins: [montajRenderShimPlugin()],
    write: false, logLevel: 'silent',
  })
  const tmpPath = join(__dirname, `__tmp-caption-word-color-${name}.mjs`)
  writeFileSync(tmpPath, result.outputFiles[0].text)
  try {
    return (await import(pathToFileURL(tmpPath).href)).default
  } finally {
    unlinkSync(tmpPath)
  }
}

const PER_WORD = ['word-by-word', 'pop', 'karaoke', 'highlight-box', 'outline', 'plate', 'accent']
const PHRASE = ['clean', 'subtitle']
const templates = {}
before(async () => {
  for (const name of [...PER_WORD, ...PHRASE]) templates[name] = await loadTemplate(name)
})

const FPS = 30
const CYAN = '#00ffff'
const TRACK = { color: '#ffffff', accentColor: '#ff00ff', highlightColor: '#ff00ff', activeColor: '#ff00ff' }
// "pauses" carries its own colour; "best" and "export" do not
const SEG = {
  id: 'a', text: 'cut the pauses best', start: 1, end: 3,
  words: [{ word: 'cut', start: 1, end: 1.4 }, { word: 'the', start: 1.4, end: 1.7 },
          { word: 'pauses', start: 1.7, end: 2.3, color: CYAN }, { word: 'best', start: 2.3, end: 3 }],
}
const plainSeg = () => ({ ...SEG, words: SEG.words.map(({ color, ...w }) => w) })
const at = (s) => Math.round(s * FPS)

function render(name, t, segments = [SEG], extra = {}) {
  return templates[name]({ frame: at(t), fps: FPS, segments, ...TRACK, ...extra })
}

/** Every element whose own text (children, joined) is `word`, with the colour it ends up with: its own style's
 *  colour, else the nearest ancestor's. */
function colorsOf(node, word, inherited = null, out = []) {
  if (Array.isArray(node)) { for (const n of node) colorsOf(n, word, inherited, out); return out }
  if (!node || typeof node !== 'object') return out
  const own = node.props?.style?.color ?? inherited
  const kids = node.props?.children
  const text = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === 'string' || typeof k === 'number').join('').trim()
  if (text === word) out.push(own)
  colorsOf(kids, word, own, out)
  return out
}

describe('a word with its own colour', () => {
  test('accent (running words, no spoken-word highlight): the word shows its colour while it is up', () => {
    assert.ok(colorsOf(render('accent', 2.0), 'pauses').includes(CYAN), JSON.stringify(colorsOf(render('accent', 2.0), 'pauses')))
    assert.ok(!colorsOf(render('accent', 2.6), 'best').includes(CYAN))
  })
  for (const name of ['karaoke', 'highlight-box', 'outline', 'plate']) {
    test(`${name}: the word shows its colour while another word is spoken`, () => {
      const colors = colorsOf(render(name, 1.2), 'pauses')
      assert.ok(colors.includes(CYAN), `${name}: ${JSON.stringify(colors)}`)
      assert.ok(!colorsOf(render(name, 1.2), 'best').includes(CYAN), `${name}: "best" has no colour of its own`)
    })
  }
  for (const name of ['karaoke', 'highlight-box', 'outline', 'plate']) {
    test(`${name}: the spoken-word highlight still wins while that word is spoken`, () => {
      const colors = colorsOf(render(name, 2.0), 'pauses')
      assert.ok(colors.length > 0 && !colors.includes(CYAN), `${name}: ${JSON.stringify(colors)}`)
    })
  }
  for (const name of ['word-by-word', 'pop']) {
    test(`${name}: the word shows its colour when it is up`, () => {
      assert.deepEqual(colorsOf(render(name, 2.0), 'pauses'), [CYAN])
      assert.ok(!colorsOf(render(name, 2.6), 'best').includes(CYAN))
    })
  }
})

describe('phrase-only styles ignore it', () => {
  for (const name of PHRASE) {
    test(`${name} renders exactly as without word colours`, () => {
      for (const t of [1.2, 2.0, 2.6]) {
        assert.deepEqual(JSON.stringify(render(name, t)), JSON.stringify(render(name, t, [plainSeg()])), `${name} at ${t}s`)
      }
    })
  }
})

describe('a segment with no word colour is unchanged', () => {
  for (const name of PER_WORD) {
    test(`${name}: no word colour, no colour change`, () => {
      for (const t of [1.2, 2.0, 2.6]) assert.ok(!JSON.stringify(render(name, t, [plainSeg()])).includes(CYAN), `${name} at ${t}s`)
    })
  }
})
