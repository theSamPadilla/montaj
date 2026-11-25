// montaj_assets/render/test/caption-phrase.test.mjs
//
// The `phrase` caption style: one phrase laid out whole from its first frame and built word by word as it is
// spoken (each word fades in from its own start), one key word in an accent face and colour, a short rule above
// the block, anchored bottom-left. Every look is a prop with a fallback default.
//
// Harness: the esbuild + 'montaj/render' shim from captions-font.test.mjs (copied, as that file does not export it).

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'
import { captionOverlayFields, captionTemplatePath } from '../caption-spec.js'

const __dirname           = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR       = join(__dirname, '..', 'templates', 'captions')
const OVERLAY_RUNTIME_DIR = join(__dirname, '..', '..', 'overlay-runtime')

function shim() {
  return {
    name: 'montaj-render-shim',
    setup(build) {
      build.onResolve({ filter: /^montaj\/render$/ }, () => ({ path: 'montaj-render-shim', namespace: 'shim' }))
      build.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({
        resolveDir: OVERLAY_RUNTIME_DIR,
        contents: `export { interpolate, spring } from './helpers.js'\nexport { captionOuterStyle, captionInnerStyle } from './position.js'`,
      }))
    },
  }
}

let Phrase
before(async () => {
  const result = await esbuild.build({
    entryPoints: [join(TEMPLATES_DIR, 'phrase.jsx')], bundle: true, format: 'esm', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server'], plugins: [shim()], write: false, logLevel: 'silent',
  })
  const tmp = join(__dirname, '__tmp-caption-phrase.mjs')
  writeFileSync(tmp, result.outputFiles[0].text)
  try { Phrase = (await import(pathToFileURL(tmp).href)).default } finally { unlinkSync(tmp) }
})

const FPS = 30
const INK = '#1c1c1e'
const WORDS = [
  { word: 'The', start: 1, end: 1.4 },
  { word: 'quiet', start: 1.4, end: 2, accent: 'serif' },
  { word: 'machine', start: 2, end: 3 },
]
const SEG = { id: 'a', text: 'The quiet machine', start: 1, end: 3, words: WORDS }
const at = (t) => t * FPS

/** Depth-first: every element, in order. */
function all(node, out = []) {
  if (Array.isArray(node)) { for (const n of node) all(n, out); return out }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  all(node.props?.children, out)
  return out
}
const wordSpans = (el) => all(el).filter((n) => n.type === 'span')
const span = (el, word) => wordSpans(el).find((n) => n.props.children === word)
const ruleOf = (el) => all(el).find((n) => n.key === 'rule')
const outerOf = (el) => (Array.isArray(el.props.children) ? el.props.children[0] : el.props.children)
const innerOf = (el) => outerOf(el).props.children
const textBoxOf = (el) => all(el).find((n) => n.props?.style && 'fontFamily' in n.props.style)
/** Render at a time in seconds (fractional frames allowed). */
const render = (props = {}, segments = [SEG], t = 2.5) => Phrase({ frame: at(t), fps: FPS, segments, ...props })
const close = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-9, `${label}: ${a} vs ${b}`)

describe('phrase: registered', () => {
  test('the style maps to phrase.jsx, and the export carries the track\'s props', () => {
    assert.ok(captionTemplatePath('phrase').endsWith('phrase.jsx'))
    const f = captionOverlayFields({ style: 'phrase', segments: [SEG], ruleColor: '#ff0000', wordFade: 0.2, maxWidth: 900 })
    assert.ok(f.componentPath.endsWith('phrase.jsx'))
    assert.deepEqual([f.props.ruleColor, f.props.wordFade, f.props.maxWidth], ['#ff0000', 0.2, 900])
  })

  test('a phrase track with no googleFonts still loads the accent face; the track\'s own come first', () => {
    assert.deepEqual(captionOverlayFields({ style: 'phrase', segments: [SEG] }).googleFonts, ['Playfair+Display:ital,wght@1,500'])
    assert.deepEqual(captionOverlayFields({ style: 'phrase', segments: [SEG], googleFonts: ['Inter:wght@600'] }).googleFonts,
      ['Inter:wght@600', 'Playfair+Display:ital,wght@1,500'])
  })
})

describe('phrase: the build', () => {
  test('the whole phrase is laid out from the first frame: every word is there, the unspoken ones at opacity 0', () => {
    const el = render({}, [SEG], 1)
    assert.deepEqual(wordSpans(el).map((s) => s.props.children), ['The', 'quiet', 'machine'])
    assert.equal(span(el, 'quiet').props.style.opacity, 0)
    assert.equal(span(el, 'machine').props.style.opacity, 0)
  })

  test('a word is hidden before its start and fully visible from start + wordFade', () => {
    assert.equal(span(render({}, [SEG], 1.99), 'machine').props.style.opacity, 0)
    assert.equal(span(render({}, [SEG], 2.1), 'machine').props.style.opacity, 1)
    assert.equal(span(render({}, [SEG], 2.5), 'machine').props.style.opacity, 1)
  })

  test('mid-fade it is partly visible, on a smoothstep curve', () => {
    // a quarter of the 0.1 s fade: x = 0.25, x*x*(3-2x) = 0.15625; halfway: 0.5
    close(span(render({}, [SEG], 2.025), 'machine').props.style.opacity, 0.15625, 'quarter')
    close(span(render({}, [SEG], 2.05), 'machine').props.style.opacity, 0.5, 'half')
  })

  test('the fade reads the fractional frame (motion blur), never a whole frame', () => {
    const a = span(Phrase({ frame: 60.6, fps: FPS, segments: [SEG] }), 'machine').props.style.opacity
    const b = span(Phrase({ frame: 61.2, fps: FPS, segments: [SEG] }), 'machine').props.style.opacity
    assert.ok(a > 0 && a < b && b < 1, `${a} then ${b}`)
  })

  test('wordFade sets the fade\'s length; 0 cuts each word on', () => {
    close(span(render({ wordFade: 0.4 }, [SEG], 2.2), 'machine').props.style.opacity, 0.5, 'half of 0.4 s')
    assert.equal(span(render({ wordFade: 0 }, [SEG], 2), 'machine').props.style.opacity, 1)
    assert.equal(span(render({ wordFade: 0 }, [SEG], 1.99), 'machine').props.style.opacity, 0)
  })

  test('the block fades out over its last 4 frames', () => {
    assert.equal(innerOf(render({}, [SEG], 2.5)).props.style.opacity, 1)
    close(innerOf(Phrase({ frame: 88, fps: FPS, segments: [SEG] })).props.style.opacity, 0.5, '2 frames from the end')
    assert.ok(innerOf(Phrase({ frame: 89.5, fps: FPS, segments: [SEG] })).props.style.opacity < 0.2)
  })

  test('nothing draws outside the caption\'s own time', () => {
    assert.equal(render({}, [SEG], 0.5), null)
    assert.equal(render({}, [SEG], 3.5), null)
  })

  test('a caption without word timestamps fades its text in whole', () => {
    const plain = { id: 'n', text: 'plain words', start: 1, end: 3 }
    const holder = (el) => all(el).find((n) => n.props?.children === 'plain words')
    close(holder(render({}, [plain], 1.05)).props.style.opacity, 0.5, 'half')
    assert.equal(holder(render({}, [plain], 1.5)).props.style.opacity, 1)
    assert.equal(wordSpans(render({}, [plain], 1.5)).length, 0)
  })
})

describe('phrase: the accent word', () => {
  test('serif: the accent face at accentScale, in accentColor; the other words keep the running font and colour', () => {
    const el = render({ accentColor: '#00ff00' })
    assert.deepEqual(span(el, 'quiet').props.style, {
      opacity: 1, fontFamily: '"Playfair Display", Georgia, serif', fontStyle: 'italic', fontWeight: 500, fontSize: '1.08em', color: '#00ff00',
    })
    assert.deepEqual(span(el, 'The').props.style, { opacity: 1 })
    assert.equal(textBoxOf(el).props.style.color, '#ffffff')
    assert.equal(textBoxOf(el).props.style.fontFamily, 'system-ui, -apple-system, sans-serif')
  })

  test('the accent face, style, weight and scale come from the track', () => {
    const s = span(render({ accentFontFamily: '"Lora", serif', accentFontStyle: 'normal', accentFontWeight: 700, accentScale: 1.3 }), 'quiet').props.style
    assert.deepEqual([s.fontFamily, s.fontStyle, s.fontWeight, s.fontSize], ['"Lora", serif', 'normal', 700, '1.3em'])
  })

  test('sans keeps the running font, in accentColor; script takes the accent face', () => {
    const words = WORDS.map((w) => (w.word === 'quiet' ? { ...w, accent: 'sans' } : w.word === 'machine' ? { ...w, accent: 'script' } : w))
    const el = render({}, [{ ...SEG, words }])
    assert.deepEqual(span(el, 'quiet').props.style, { opacity: 1, color: '#fbbf24' })
    assert.equal(span(el, 'machine').props.style.fontFamily, '"Playfair Display", Georgia, serif')
    assert.equal(span(el, 'machine').props.style.color, '#fbbf24')
  })

  test('a word\'s own colour wins over the accent colour', () => {
    const words = WORDS.map((w) => (w.word === 'quiet' ? { ...w, color: '#00ffff' } : w))
    assert.equal(span(render({}, [{ ...SEG, words }]), 'quiet').props.style.color, '#00ffff')
  })

  test('an unknown accent value is a plain word', () => {
    const words = WORDS.map((w) => (w.word === 'quiet' ? { ...w, accent: 'loud' } : w))
    assert.deepEqual(span(render({}, [{ ...SEG, words }]), 'quiet').props.style, { opacity: 1 })
  })
})

describe('phrase: the rule', () => {
  test('sits above the text by default: 336 x 4 px, 40 px over it, solid for 55% in the accent colour, then fading', () => {
    const r = ruleOf(render())
    assert.ok(r, 'a rule')
    const box = textBoxOf(render())
    assert.equal(box.props.children[0].key, 'rule', 'the rule comes before the text')
    assert.equal(r.props.style.width, 336)
    assert.equal(r.props.style.height, 4)
    assert.equal(r.props.style.marginBottom, 40)
    assert.equal(r.props.style.background, 'linear-gradient(to right, #fbbf24 0%, #fbbf24 55%, transparent 100%)')
  })

  test('follows ruleColor, else the accent colour in force (the track\'s or the caption\'s own)', () => {
    assert.match(ruleOf(render({ ruleColor: '#ff0000' })).props.style.background, /^linear-gradient\(to right, #ff0000 0%/)
    assert.match(ruleOf(render({ accentColor: '#123456' })).props.style.background, /#123456 55%/)
    assert.match(ruleOf(render({ accentColor: '#123456' }, [{ ...SEG, accentColor: '#abcdef' }])).props.style.background, /#abcdef 55%/)
  })

  test('its size, gap and solid share come from the track', () => {
    const s = ruleOf(render({ ruleWidth: 6, ruleLength: 200, ruleGap: 24, ruleSolid: 0.3 })).props.style
    assert.deepEqual([s.width, s.height, s.marginBottom], [200, 6, 24])
    assert.match(s.background, / 30%, transparent 100%\)$/)
  })

  test('showRule false draws none', () => {
    assert.equal(ruleOf(render({ showRule: false })), undefined)
  })

  test('appears with the first word, on the same fade', () => {
    assert.equal(ruleOf(render({}, [SEG], 1)).props.style.opacity, 0)
    close(ruleOf(render({}, [SEG], 1.05)).props.style.opacity, 0.5, 'half')
    assert.equal(ruleOf(render({}, [SEG], 1.2)).props.style.opacity, 1)
  })
})

describe('phrase: the layout', () => {
  test('left by default: the box hugs the text, 6% in from the left, its bottom 13% up, at most 75% of the frame', () => {
    const outer = outerOf(render())
    assert.deepEqual(outer.props.style, { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none' })
    assert.deepEqual(innerOf(render()).props.style, {
      position: 'absolute', bottom: '13%', left: '6%', maxWidth: '75%', textAlign: 'left', opacity: 1,
    })
    const box = textBoxOf(render()).props.style
    assert.deepEqual([box.fontSize, box.fontWeight, box.lineHeight, box.letterSpacing], [64, 600, 1.18, '-0.01em'])
    assert.equal(box.textShadow, '0 2px 12px rgba(0,0,0,0.6)')
  })

  test('the insets and the width are props (a CSS length or px)', () => {
    assert.deepEqual(innerOf(render({ insetX: 120, insetBottom: '20%', maxWidth: 900 })).props.style, {
      position: 'absolute', bottom: '20%', left: 120, maxWidth: 900, textAlign: 'left', opacity: 1,
    })
  })

  test('right: anchored to the right edge, the rule flush right and fading leftward', () => {
    const el = render({ textAlign: 'right' })
    assert.deepEqual(innerOf(el).props.style, { position: 'absolute', bottom: '13%', right: '6%', maxWidth: '75%', textAlign: 'right', opacity: 1 })
    const r = ruleOf(el).props.style
    assert.deepEqual([r.marginLeft, r.marginRight], ['auto', 0])
    assert.match(r.background, /^linear-gradient\(to left,/)
  })

  test('centre: the box is centred and hugs its text; the rule is centred, fading out to both ends', () => {
    const el = render({ textAlign: 'center' })
    assert.deepEqual(innerOf(el).props.style, {
      position: 'absolute', bottom: '13%', left: 0, right: 0, marginLeft: 'auto', marginRight: 'auto', width: 'fit-content',
      maxWidth: '75%', textAlign: 'center', opacity: 1,
    })
    const r = ruleOf(el).props.style
    assert.deepEqual([r.marginLeft, r.marginRight], ['auto', 'auto'])
    assert.equal(r.background, 'linear-gradient(to right, transparent 0%, #fbbf24 22.5%, #fbbf24 77.5%, transparent 100%)')
  })

  test('a caption\'s offsetX/offsetY move it (outer) and its scale grows the box in place (inner)', () => {
    const el = render({}, [{ ...SEG, offsetX: 10, offsetY: -20, scale: 1.5 }])
    assert.equal(outerOf(el).props.style.transform, 'translate(10%, -20%)')
    assert.equal(innerOf(el).props.style.transform, 'scale(1.5)')
    assert.equal(innerOf(el).props.style.left, '6%')
    assert.equal(outerOf(el).props['data-caption-id'], 'a')
  })
})

describe('phrase: translations and ink', () => {
  const ES = { id: 'a-es', text: 'La máquina silenciosa', start: 1, end: 3, lane: 1, lang: 'es', translationOf: ['a'] }

  test('a translation is a plain line under the caption, in one column, no build and no accent', () => {
    const el = render({}, [SEG, ES], 1.5)
    const column = all(el).find((n) => n.props?.style?.flexDirection === 'column')
    assert.ok(column, 'a column')
    assert.equal(column.props.style.alignItems, 'flex-start', 'aligned like the caption')
    const line = all(column).find((n) => n.props?.['data-caption-id'] === 'a-es')
    assert.equal(line.props.children, 'La máquina silenciosa')
    assert.equal(line.props.style.color, '#ffffff')
    assert.equal(line.props.style.fontFamily, 'system-ui, -apple-system, sans-serif')
    assert.equal(line.props.style.opacity, 1)
    assert.equal(all(line).filter((n) => n.type === 'span').length, 0)
  })

  test('dark ink: the text is INK with no shadow; the accent word and the rule are darkened in their hue', () => {
    const el = render({}, [{ ...SEG, ink: 'dark' }])
    const box = textBoxOf(el).props.style
    assert.equal(box.color, INK)
    assert.equal(box.textShadow, 'none')
    const accent = span(el, 'quiet').props.style.color
    assert.match(accent, /^#[0-9a-f]{6}$/)
    assert.notEqual(accent, '#fbbf24')
    assert.ok(ruleOf(el).props.style.background.includes(accent), 'the rule takes the same darkened accent')
    assert.ok(!JSON.stringify(el).includes('rgba(0,0,0'))
  })
})

test("the editor's PHRASE_CAPTION_FONTS is caption-spec's list", () => {
  const src = readFileSync(join(__dirname, '..', '..', 'editor', 'src', 'video', 'captionStyleDefaults.ts'), 'utf8')
  const m = src.match(/export const PHRASE_CAPTION_FONTS = (\[[^\]]*\])/)
  assert.ok(m, 'expected the PHRASE_CAPTION_FONTS literal in captionStyleDefaults.ts')
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), captionOverlayFields({ style: 'phrase', segments: [SEG] }).googleFonts)
})
