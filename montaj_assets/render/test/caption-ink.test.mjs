// montaj_assets/render/test/caption-ink.test.mjs
//
// Caption ink. A caption segment with `ink: "dark"` is drawn as dark ink on paper by every template that draws plain
// text over the picture (accent, clean, highlight-box, karaoke, outline, pop, word-by-word): the base text takes
// #1c1c1e and loses its outline and dark shadow, while the accents (the spoken word, a word's own colour) are darkened in their hue to 4.5:1 against the
// backdrop; highlight-box's box stays. A translation stacked under a dark caption is dark too. plate and subtitle draw their own box and ignore
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

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const lumOf = (hex) => { const [r, g, b] = rgbOf(hex).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const ratio = (hex, backdrop) => (backdrop + 0.05) / (lumOf(hex) + 0.05)
const hueOf = (hex) => {
  const [r, g, b] = rgbOf(hex).map((c) => c / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  if (!d) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}
const hueGap = (a, b) => { const d = Math.abs(hueOf(a) - hueOf(b)) % 360; return Math.min(d, 360 - d) }
/** `got` is `orig` darkened: a different colour, >= 4.5:1 on the backdrop, the same hue. */
function assertSafe(got, orig, backdrop, label) {
  assert.match(got, /^#[0-9a-f]{6}$/, label)
  assert.notEqual(got, orig, `${label}: not darkened`)
  assert.ok(ratio(got, backdrop) >= 4.5, `${label}: ${got} is ${ratio(got, backdrop).toFixed(2)}:1 on ${backdrop}`)
  assert.ok(hueGap(got, orig) <= 3, `${label}: hue ${hueOf(got)} vs ${hueOf(orig)}`)
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
    test(`${name}: the spoken word is darkened in its hue`, () => {
      const tree = render(name, 1.2, dark)
      if (name === 'highlight-box') {
        assert.ok(JSON.stringify(tree).includes(`"background":"${MAGENTA}"`), 'the box keeps its accent colour')
      } else {
        assertSafe(colorOf(tree, SPOKEN[name]), MAGENTA, 0.5, name)
      }
    })
  }
  for (const name of ['accent', 'highlight-box', 'karaoke', 'outline', 'word-by-word', 'pop']) {
    test(`${name}: a word with its own colour is darkened in its hue`, () => {
      const t = ['word-by-word', 'pop', 'accent'].includes(name) ? 2.0 : 1.2
      assertSafe(colorOf(render(name, t, dark), 'pauses'), CYAN, 0.5, name)
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

describe('dark ink darkens keyword colours to 4.5:1 against the backdrop', () => {
  const YELLOW = '#fbbf24'
  const yellow = { ...TRACK, accentColor: YELLOW, highlightColor: YELLOW, activeColor: YELLOW }
  const seg = (extra = {}) => [{ ...SEG, ink: 'dark', ...extra }]
  const paper = { card: 'c1', ink: 'dark', backdrop: 0.84 }
  const spoken = (name, segments, track = yellow) => colorOf(templates[name]({ frame: at(1.2), fps: FPS, segments, ...track }), SPOKEN[name])

  for (const name of ['karaoke', 'outline', 'pop']) {
    test(`${name}: yellow on paper (0.84) and on the 0.5 default`, () => {
      assertSafe(spoken(name, seg({ inkAuto: paper })), YELLOW, 0.84, name)
      const onDefault = spoken(name, seg())
      assertSafe(onDefault, YELLOW, 0.5, name)
      assert.ok(lumOf(onDefault) < lumOf(spoken(name, seg({ inkAuto: paper }))), `${name}: darker on the 0.5 default`)
    })
    test(`${name}: the segment's own accent is the one darkened`, () => {
      assertSafe(spoken(name, seg({ accentColor: CYAN, highlightColor: CYAN, activeColor: CYAN, inkAuto: paper }), TRACK), CYAN, 0.84, name)
    })
    test(`${name}: an accent that already passes is unchanged, INK too, a non-hex falls back to INK`, () => {
      assert.equal(spoken(name, seg(), { ...TRACK, highlightColor: '#7a1010', accentColor: '#7a1010', activeColor: '#7a1010' }), '#7a1010')
      assert.equal(spoken(name, seg(), { ...TRACK, highlightColor: INK, accentColor: INK, activeColor: INK }), INK)
      for (const c of ['red', 'hsl(40, 90%, 50%)', 'var(--x)']) {
        assert.equal(spoken(name, seg(), { ...TRACK, highlightColor: c, accentColor: c, activeColor: c }), INK, c)
      }
    })
    test(`${name}: without ink nothing is darkened`, () => {
      assert.equal(colorOf(templates[name]({ frame: at(1.2), fps: FPS, segments: [SEG], ...yellow }), SPOKEN[name]), YELLOW)
    })
  }
  test('rgb() and alpha hex forms parse', () => {
    for (const c of ['rgb(251, 191, 36)', 'rgba(251,191,36,0.9)', '#fbbf24ff']) {
      const got = spoken('karaoke', seg({ inkAuto: paper }), { ...TRACK, highlightColor: c })
      assert.match(got, /^#[0-9a-f]{6}$/, c)
      assert.ok(ratio(got, 0.84) >= 4.5, c)
    }
  })
  test('a non-finite or out-of-range backdrop counts as 0.5', () => {
    const want = spoken('karaoke', seg())
    for (const backdrop of ['x', 2, -1, null]) assert.equal(spoken('karaoke', seg({ inkAuto: { backdrop } })), want, String(backdrop))
  })
  test('word-by-word: the active word with a colour of its own', () => {
    const segs = [{ ...SEG, ink: 'dark', inkAuto: paper, words: SEG.words.map((w) => (w.word === 'cut' ? { ...w, color: YELLOW } : w)) }]
    assertSafe(colorOf(render('word-by-word', 1.2, segs), 'cut'), YELLOW, 0.84, 'word-by-word')
  })
  test('accent: accent words and a hero word take the darkened accent', () => {
    const words = [{ word: 'cut', start: 1, end: 1.4, accent: 'sans' }, { word: 'pauses', start: 1.4, end: 2, accent: 'serif' }]
    const segs = [{ id: 'a', text: 'cut pauses', start: 1, end: 3, ink: 'dark', inkAuto: paper, words }]
    const tree = templates.accent({ frame: at(2.0), fps: FPS, segments: segs, ...yellow })
    assertSafe(colorOf(tree, 'cut'), YELLOW, 0.84, 'accent sans')
    assertSafe(colorOf(tree, 'pauses'), YELLOW, 0.84, 'accent serif')
    const hero = templates.accent({ frame: at(2.0), fps: FPS, segments: [{ ...segs[0], hero: true }], ...yellow })
    assertSafe(colorOf(hero, 'cut'), YELLOW, 0.84, 'accent hero')
  })
  test('highlight-box: the box keeps its colour and its text stays #111111', () => {
    const json = JSON.stringify(templates['highlight-box']({ frame: at(1.2), fps: FPS, segments: seg({ inkAuto: paper }), ...yellow }))
    assert.ok(json.includes(`"background":"${YELLOW}"`))
    assert.ok(json.includes('"color":"#111111"'))
  })
})
