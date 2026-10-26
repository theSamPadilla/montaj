// montaj_assets/render/test/caption-ink.test.mjs
//
// Caption ink. A caption segment with `ink: "dark"` is drawn as dark ink on paper by every template that draws plain
// text over the picture (accent, clean, highlight-box, karaoke, outline, pop, word-by-word): the base text takes
// #1c1c1e and loses its outline and dark shadow, while the accents (the spoken word, a word's own colour, highlight-box's
// box) stay. A translation stacked under a dark caption is dark too. plate and subtitle draw their own box and ignore
// `ink`. No `ink`, or "light", renders exactly as before.
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
  const tmpPath = join(__dirname, `__tmp-caption-ink-${name}.mjs`)
  writeFileSync(tmpPath, result.outputFiles[0].text)
  try {
    return (await import(pathToFileURL(tmpPath).href)).default
  } finally {
    unlinkSync(tmpPath)
  }
}


const INK = '#1c1c1e'
const INKED = ['accent', 'clean', 'highlight-box', 'karaoke', 'outline', 'pop', 'word-by-word']
const BOXED = ['plate', 'subtitle']
const templates = {}
before(async () => {
  for (const name of [...INKED, ...BOXED]) templates[name] = await loadTemplate(name)
})

const FPS = 30
const MAGENTA = '#ff00ff'
const CYAN = '#00ffff'
const TRACK = { color: '#ffffff', accentColor: MAGENTA, highlightColor: MAGENTA, activeColor: MAGENTA }
const SEG = {
  id: 'a', text: 'cut the pauses best', start: 1, end: 3,
  words: [{ word: 'cut', start: 1, end: 1.4 }, { word: 'the', start: 1.4, end: 1.7 },
          { word: 'pauses', start: 1.7, end: 2.3, color: CYAN }, { word: 'best', start: 2.3, end: 3 }],
}
const ES = { id: 'a-es', text: 'corta las pausas', start: 1, end: 3, lang: 'es', translationOf: ['a'] }
const at = (s) => Math.round(s * FPS)
const render = (name, t, segments, extra = {}) => templates[name]({ frame: at(t), fps: FPS, segments, ...TRACK, ...extra })

/** Every host element's text (its string children, joined) with its colour (own, else the nearest ancestor's). */
function textsOf(node, inherited = null, out = []) {
  if (Array.isArray(node)) { for (const n of node) textsOf(n, inherited, out); return out }
  if (!node || typeof node !== 'object') return out
  const own = node.props?.style?.color ?? inherited
  const kids = node.props?.children
  const text = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === 'string' || typeof k === 'number').join('').trim()
  if (text) out.push({ text, color: own })
  textsOf(kids, own, out)
  return out
}
const colorOf = (tree, text) => textsOf(tree).find((e) => e.text === text)?.color

/** Every style object in the tree. */
function stylesOf(node, out = []) {
  if (Array.isArray(node)) { for (const n of node) stylesOf(n, out); return out }
  if (!node || typeof node !== 'object') return out
  if (node.props?.style) out.push(node.props.style)
  stylesOf(node.props?.children, out)
  return out
}

// What each style shows at 1.2 s (the word "cut" is being spoken): a base word, and the accent on the spoken word.
const BASE = {
  accent: 'the', clean: SEG.text, 'highlight-box': 'the', karaoke: 'the', outline: 'the', pop: null, 'word-by-word': 'cut',
}
const SPOKEN = { karaoke: 'cut', outline: 'cut', pop: 'cut', 'highlight-box': 'cut' }

describe('ink: "dark"', () => {
  const dark = [{ ...SEG, ink: 'dark' }]
  for (const name of INKED) {
    test(`${name}: base text is dark ink, no outline, no dark shadow`, () => {
      const tree = render(name, 1.2, dark)
      if (BASE[name]) assert.equal(colorOf(tree, BASE[name]), INK, `${name}: ${JSON.stringify(textsOf(tree))}`)
      for (const s of stylesOf(tree)) {
        assert.equal(s.WebkitTextStroke, undefined, `${name}: outline`)
        assert.equal(s.paintOrder, undefined, `${name}: paintOrder`)
        if (s.textShadow !== undefined) assert.ok(s.textShadow === 'none' || !s.textShadow.includes('rgba(0,0,0'), `${name}: ${s.textShadow}`)
      }
      assert.ok(!JSON.stringify(tree).includes('rgba(0,0,0'), `${name}: a dark shadow is left`)
    })
  }
  for (const name of Object.keys(SPOKEN)) {
    test(`${name}: the spoken word keeps its accent`, () => {
      const tree = render(name, 1.2, dark)
      const spoken = colorOf(tree, SPOKEN[name])
      if (name === 'highlight-box') {
        assert.ok(JSON.stringify(tree).includes(`"background":"${MAGENTA}"`), 'the box keeps its accent colour')
      } else {
        assert.equal(spoken, MAGENTA, `${name}: ${JSON.stringify(textsOf(tree))}`)
      }
    })
  }
  for (const name of ['accent', 'highlight-box', 'karaoke', 'outline', 'word-by-word', 'pop']) {
    test(`${name}: a word with its own colour keeps it`, () => {
      const t = ['word-by-word', 'pop', 'accent'].includes(name) ? 2.0 : 1.2
      assert.equal(colorOf(render(name, t, dark), 'pauses'), CYAN)
    })
  }
  test('a segment colour is not the base fill of a dark caption', () => {
    const tree = render('outline', 1.2, [{ ...SEG, ink: 'dark', color: '#ff0000' }])
    assert.equal(colorOf(tree, 'the'), INK)
  })
})

describe('ink absent or "light" is exactly as before', () => {
  for (const name of [...INKED, ...BOXED]) {
    test(`${name}`, () => {
      for (const t of [1.2, 2.0, 2.6]) {
        const plain = JSON.stringify(render(name, t, [SEG]))
        assert.equal(JSON.stringify(render(name, t, [{ ...SEG, ink: 'light' }])), plain, `${name} light at ${t}s`)
        assert.equal(JSON.stringify(render(name, t, [{ ...SEG, ink: 'light', inkAuto: { card: 'card-1', ink: 'light' } }])), plain, `${name} inkAuto at ${t}s`)
      }
    })
  }
  for (const name of INKED) {
    test(`${name}: light ink keeps the outline or shadow it had`, () => {
      assert.ok(JSON.stringify(render(name, 1.2, [SEG])).includes('rgba(0,0,0'), name)
    })
  }
})

describe('plate and subtitle ignore ink', () => {
  for (const name of BOXED) {
    test(`${name}`, () => {
      for (const t of [1.2, 2.0]) {
        assert.equal(JSON.stringify(render(name, t, [{ ...SEG, ink: 'dark' }])), JSON.stringify(render(name, t, [SEG])), `${name} at ${t}s`)
      }
    })
  }
})

describe('a translation takes the ink of the caption it is stacked under', () => {
  for (const name of INKED) {
    test(`${name}: dark caption, dark translation`, () => {
      const tree = render(name, 1.2, [{ ...SEG, ink: 'dark' }, ES])
      assert.equal(colorOf(tree, ES.text), INK, `${name}: ${JSON.stringify(textsOf(tree))}`)
      assert.ok(!JSON.stringify(tree).includes('rgba(0,0,0'), `${name}: a dark shadow is left`)
      assert.ok(!JSON.stringify(tree).includes('WebkitTextStroke'), `${name}: outline`)
    })
    test(`${name}: light caption, light translation`, () => {
      const tree = render(name, 1.2, [SEG, { ...ES, ink: 'dark' }])
      assert.notEqual(colorOf(tree, ES.text), INK, name)
    })
  }
  test('a translation drawn alone uses its own ink', () => {
    const alone = { ...ES, translationOf: ['gone'], ink: 'dark' }
    for (const name of INKED) assert.equal(colorOf(render(name, 1.2, [alone]), ES.text), INK, name)
  })
})
