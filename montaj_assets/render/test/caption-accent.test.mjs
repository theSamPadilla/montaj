// montaj_assets/render/test/caption-accent.test.mjs
//
// The Accent caption style (PL41): running captions in windows of at most
// three words, hard cuts; hero blocks (`seg.hero`) at the running size on two
// staggered lines, each word cutting on when spoken with the layout fixed;
// a word's optional `accent` ('serif' | 'sans' | 'script') picks its
// treatment, and consecutive script words form one script run. Both tiers
// centre on 59.5% of the frame height. Plus render.js: the 'accent' style
// resolves to accent.jsx and always loads its three Google fonts, merged with
// the caller's list, identical to the editor's copy of that list.
//
// The default values (size 168, weight 700, Playfair Display italic 700
// accent, the scales, indents and anchor) were matched to the reference by
// measurement in PL41 T6.
//
// Harness: the same esbuild + 'montaj/render' shim trick as
// captions-font.test.mjs (copied, that file does not export its helpers).
// The template is compiled and its default export called AS A PLAIN
// FUNCTION; JSX under the automatic runtime builds plain `{ type, props }`
// element trees with real style objects on `.props.style`.

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'
import { collectPuppeteerSegments } from '../render.js'

const __dirname           = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR       = join(__dirname, '..', 'templates', 'captions')
const OVERLAY_RUNTIME_DIR = join(__dirname, '..', '..', 'overlay-runtime')

/** Same shim as caption-position.test.mjs: resolve 'montaj/render' to the
 *  real interpolate/spring/captionOuterStyle/captionInnerStyle. */
function montajRenderShimPlugin() {
  return {
    name: 'montaj-render-shim',
    setup(build) {
      build.onResolve({ filter: /^montaj\/render$/ }, () => ({
        path: 'montaj-render-shim', namespace: 'shim',
      }))
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

/** Compile templates/captions/<name>.jsx and return its default export,
 *  called directly as a plain function below (no hooks in these templates). */
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
  const tmpPath = join(__dirname, `__tmp-caption-accent-tpl-${name}.mjs`)
  writeFileSync(tmpPath, result.outputFiles[0].text)
  try {
    return (await import(pathToFileURL(tmpPath).href)).default
  } finally {
    unlinkSync(tmpPath)
  }
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function kidsOf(node) {
  const kids = node?.props?.children
  if (kids == null) return []
  return Array.isArray(kids) ? kids : [kids]
}

/** Every string child, concatenated in document order. */
function textOf(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return kidsOf(node).map(textOf).join('')
}

/** Depth-first visit of every element (objects with a `type`). */
function walk(node, fn) {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(n => walk(n, fn)); return }
  if (node.type !== undefined) fn(node)
  kidsOf(node).forEach(n => walk(n, fn))
}

/** The span whose own text (leading join-space trimmed) is `word`. */
function spanFor(el, word) {
  let found
  walk(el, (n) => { if (n.type === 'span' && textOf(n).trim() === word) found ??= n })
  assert.ok(found, `expected a span for "${word}"`)
  return found
}

/** Line divs: divs whose children are all spans (at least one). */
function lineDivs(el) {
  const out = []
  walk(el, (n) => {
    if (n.type !== 'div') return
    const kids = kidsOf(n)
    if (kids.length && kids.every(k => k && typeof k === 'object' && k.type === 'span')) out.push(n)
  })
  return out
}

const SCRIPT_FONT = '"Caveat", cursive'
const isScriptSpan = (s) => s.props.style.fontFamily === SCRIPT_FONT
/** Main line divs: line divs that are not script-only lines. */
const mainLineDivs = (el) => lineDivs(el).filter(d => !kidsOf(d).every(isScriptSpan))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FPS = 30
const at = (t) => Math.round(t * FPS)
const BASE_COLOR = '#FBFBFB'
const ACCENT_COLOR = '#F00000'
const RUNNING_FONT = '"Inter Tight", system-ui, sans-serif'
const SERIF_FONT = '"Playfair Display", Georgia, serif'
const SIZE = 168
const SHADOW = '0 1px 3px rgba(0,0,0,0.25)'

const WORDS = [
  { word: 'i',     start: 1,   end: 1.2 },
  { word: 'build', start: 1.2, end: 1.5 },
  { word: 'this',  start: 1.5, end: 1.7 },
  { word: 'drone', start: 1.7, end: 2.2, accent: 'serif' },
]
const seg = (extra = {}, words = WORDS) => ({ start: 1, end: 2.4, text: words.map(w => w.word).join(' '), words, ...extra })

let Accent
before(async () => { Accent = await loadTemplate('accent') })

test('accent.jsx exists in the captions templates dir', () => {
  assert.ok(existsSync(join(TEMPLATES_DIR, 'accent.jsx')))
})

// ---------------------------------------------------------------------------
// 1. Running windows
// ---------------------------------------------------------------------------

describe('running windows', () => {
  test('t=1.25: window 1, all three words cut on together', () => {
    const el = Accent({ frame: at(1.25), fps: FPS, segments: [seg()] })
    assert.equal(textOf(el), 'i build this')
  })

  test('t=1.8: window 2', () => {
    const el = Accent({ frame: at(1.8), fps: FPS, segments: [seg()] })
    assert.equal(textOf(el), 'drone')
  })

  test('a window closes once it would pass the line budget (168 px): everything | you need is', () => {
    const words = [
      { word: 'everything', start: 1,   end: 1.3 },
      { word: 'you',        start: 1.3, end: 1.5 },
      { word: 'need',       start: 1.5, end: 1.7 },
      { word: 'is',         start: 1.7, end: 1.9 },
    ]
    assert.equal(textOf(Accent({ frame: at(1.1), fps: FPS, segments: [seg({}, words)] })), 'everything')
    assert.equal(textOf(Accent({ frame: at(1.4), fps: FPS, segments: [seg({}, words)] })), 'you need is')
  })

  test('a smaller font keeps three words in one window: everything you need at 84', () => {
    const words = [
      { word: 'everything', start: 1,   end: 1.3 },
      { word: 'you',        start: 1.3, end: 1.5 },
      { word: 'need',       start: 1.5, end: 1.7 },
    ]
    assert.equal(textOf(Accent({ frame: at(1.1), fps: FPS, fontSize: 84, segments: [seg({}, words)] })), 'everything you need')
  })

  test('t=0.9: before the segment -> null', () => {
    assert.equal(Accent({ frame: at(0.9), fps: FPS, segments: [seg()] }), null)
  })
})

// ---------------------------------------------------------------------------
// 2. Running accent
// ---------------------------------------------------------------------------

test('running accent serif: red Playfair Display italic 700, 1.2x, -0.02em', () => {
  const el = Accent({ frame: at(1.8), fps: FPS, segments: [seg()] })
  const s = spanFor(el, 'drone').props.style
  assert.equal(s.color, ACCENT_COLOR)
  assert.equal(s.fontStyle, 'italic')
  assert.equal(s.fontFamily, SERIF_FONT)
  assert.equal(s.fontWeight, 700)
  assert.equal(s.fontSize, SIZE * 1.2)
  assert.equal(s.letterSpacing, '-0.02em')
})

test('running defaults: 168px Inter Tight 700, -0.03em, line-height 0.76, #FBFBFB, a light shadow', () => {
  const el = Accent({ frame: at(1.25), fps: FPS, segments: [seg()] })
  const s = spanFor(el, 'build').props.style
  assert.equal(s.fontSize, SIZE)
  assert.equal(s.fontFamily, RUNNING_FONT)
  assert.equal(s.fontWeight, 700)
  assert.equal(s.letterSpacing, '-0.03em')
  assert.equal(s.lineHeight, 0.76)
  assert.equal(s.color, BASE_COLOR)
  assert.equal(s.textShadow, SHADOW)
})

test('running accent uses a custom accentColor', () => {
  const el = Accent({ frame: at(1.8), fps: FPS, segments: [seg()], accentColor: '#00FF00' })
  assert.equal(spanFor(el, 'drone').props.style.color, '#00FF00')
})

// ---------------------------------------------------------------------------
// 3. Hero build-up keeps its layout
// ---------------------------------------------------------------------------

describe('hero build-up keeps its layout', () => {
  test('t=1.25: spoken words visible, unspoken hidden, all four present', () => {
    const el = Accent({ frame: at(1.25), fps: FPS, segments: [seg({ hero: true })] })
    assert.equal(spanFor(el, 'i').props.style.visibility, 'visible')
    assert.equal(spanFor(el, 'build').props.style.visibility, 'visible')
    assert.equal(spanFor(el, 'this').props.style.visibility, 'hidden')
    assert.equal(spanFor(el, 'drone').props.style.visibility, 'hidden')
  })

  test('hero sizes: the running size (1.0x), serif 1.2x on top', () => {
    const el = Accent({ frame: at(1.25), fps: FPS, segments: [seg({ hero: true })] })
    for (const w of ['i', 'build', 'this']) assert.equal(spanFor(el, w).props.style.fontSize, SIZE, w)
    assert.equal(spanFor(el, 'drone').props.style.fontSize, SIZE * 1.2)
  })
})

// ---------------------------------------------------------------------------
// 4. Hero lines
// ---------------------------------------------------------------------------

test('hero: two balanced main lines', () => {
  const el = Accent({ frame: at(2.0), fps: FPS, segments: [seg({ hero: true })] })
  const lines = mainLineDivs(el).map(textOf)
  assert.deepEqual(lines, ['i build', 'this drone'])
})

test('hero: staggered lines, line 1 flush left, line 2 indented 0.45 of the hero size', () => {
  const el = Accent({ frame: at(2.0), fps: FPS, segments: [seg({ hero: true })] })
  const [l1, l2] = mainLineDivs(el)
  assert.equal(l1.props.style.paddingLeft, 0)
  assert.equal(l2.props.style.paddingLeft, SIZE * 0.45)
})

test('hero: the lines sit in a left-aligned inline block, centred as a whole', () => {
  const el = Accent({ frame: at(2.0), fps: FPS, segments: [seg({ hero: true })] })
  let block
  walk(el, (n) => { if (n.type === 'div' && n.props.style?.display === 'inline-block') block ??= n })
  assert.ok(block, 'expected an inline-block wrapping the lines')
  assert.equal(block.props.style.textAlign, 'left')
  assert.deepEqual(kidsOf(block).map(textOf), ['i build', 'this drone'])
})

// ---------------------------------------------------------------------------
// 4b. Anchor: both tiers centre on 59.5%, and a segment scale keeps it
// ---------------------------------------------------------------------------

describe('anchor: centred on 59.5% of the frame height', () => {
  const anchorOf = (el) => kidsOf(kidsOf(el)[0])[0]
  for (const hero of [false, true]) {
    test(`${hero ? 'hero' : 'running'}: a zero-height anchor at top 59.5%, a nested translateY(-50%)`, () => {
      const el = Accent({ frame: at(2.0), fps: FPS, segments: [seg({ hero })] })
      const anchor = anchorOf(el)
      assert.equal(anchor.props.style.top, '59.5%')
      assert.equal(anchor.props.style.height, 0)
      assert.ok(!('bottom' in anchor.props.style))
      assert.ok(!('transform' in anchor.props.style), 'no transform on the anchor without a segment scale')
      assert.equal(kidsOf(anchor)[0].props.style.transform, 'translateY(-50%)')
    })

    test(`${hero ? 'hero' : 'running'}: a segment scale goes on the anchor and the nested centring survives`, () => {
      const el = Accent({ frame: at(2.0), fps: FPS, segments: [seg({ hero, scale: 1.5 })] })
      const anchor = anchorOf(el)
      assert.equal(anchor.props.style.transform, 'scale(1.5)')
      assert.equal(anchor.props.style.transformOrigin, 'center center')
      assert.equal(kidsOf(anchor)[0].props.style.transform, 'translateY(-50%)')
    })
  }
})

// ---------------------------------------------------------------------------
// 5. Script
// ---------------------------------------------------------------------------

const SCRIPT_WORDS = [
  { word: 'full',     start: 1,   end: 1.3 },
  { word: 'time',     start: 1.3, end: 1.6, accent: 'script' },
  { word: 'position', start: 1.6, end: 2.2 },
]

describe('script accent', () => {
  test('hero: white Caveat line directly before the line holding the next word', () => {
    const el = Accent({ frame: at(2.0), fps: FPS, segments: [seg({ hero: true }, SCRIPT_WORDS)] })
    const lines = lineDivs(el)
    const timeIdx = lines.findIndex(d => textOf(d) === 'time')
    const posIdx = lines.findIndex(d => textOf(d).includes('position'))
    assert.ok(timeIdx >= 0, `expected a line div holding only "time", got ${JSON.stringify(lines.map(textOf))}`)
    assert.equal(posIdx, timeIdx + 1, 'the script line comes directly before the line holding "position"')
    assert.ok(!textOf(lines[posIdx]).includes('time'), '"time" is not in the main line')
    const s = spanFor(el, 'time').props.style
    assert.ok(s.fontFamily.startsWith('"Caveat"'), s.fontFamily)
    assert.equal(s.color, BASE_COLOR)
    assert.equal(s.fontSize, SIZE * 0.8)
    assert.equal(s.fontWeight, 700)
    assert.equal(s.letterSpacing, '-0.08em')
    assert.ok(!('transform' in s), 'the script is not rotated')
  })

  test('hero: the script line starts at the block left and overlaps the next by 0.07 of the size; its word line is indented 0.66', () => {
    const el = Accent({ frame: at(2.0), fps: FPS, segments: [seg({ hero: true }, SCRIPT_WORDS)] })
    const lines = lineDivs(el)
    const script = lines.find(d => textOf(d) === 'time')
    const main = lines.find(d => textOf(d) === 'position')
    assert.deepEqual(script.props.style, { marginBottom: -SIZE * 0.07 })
    assert.equal(main.props.style.paddingLeft, SIZE * 0.66)
  })

  test('hero: script line color follows the color prop, not accentColor', () => {
    const el = Accent({ frame: at(2.0), fps: FPS, color: '#123456', segments: [seg({ hero: true }, SCRIPT_WORDS)] })
    assert.equal(spanFor(el, 'time').props.style.color, '#123456')
  })

  test('hero: the script line follows the segment colour', () => {
    const el = Accent({ frame: at(2.0), fps: FPS, segments: [seg({ hero: true, color: '#123456' }, SCRIPT_WORDS)] })
    assert.equal(spanFor(el, 'time').props.style.color, '#123456')
  })

  test('hero: a long 5-word hero is drawn smaller so its widest line fits; the 4-word one keeps 168', () => {
    const w5 = 'the hardest thing i have done'.split(' ').map((word, i) => ({ word, start: 1 + i * 0.1, end: 1.1 + i * 0.1 }))
    const el = Accent({ frame: at(2.0), fps: FPS, segments: [seg({ hero: true }, w5)] })
    const sz = spanFor(el, 'hardest').props.style.fontSize
    assert.ok(sz >= SIZE * 0.6 && sz < SIZE, `size ${sz}`)
    const el4 = Accent({ frame: at(2.0), fps: FPS, segments: [seg({ hero: true })] })
    assert.equal(spanFor(el4, 'i').props.style.fontSize, SIZE)
  })

  test('hero: the script word does not count as a main line', () => {
    const el = Accent({ frame: at(2.0), fps: FPS, segments: [seg({ hero: true }, SCRIPT_WORDS)] })
    assert.deepEqual(mainLineDivs(el).map(textOf), ['full', 'position'])
  })

  test('running: a script word draws as serif (red italic)', () => {
    const el = Accent({ frame: at(1.4), fps: FPS, segments: [seg({}, SCRIPT_WORDS)] })
    assert.equal(textOf(el), 'full time')
    const s = spanFor(el, 'time').props.style
    assert.equal(s.color, ACCENT_COLOR)
    assert.equal(s.fontStyle, 'italic')
    assert.equal(s.fontFamily, SERIF_FONT)
  })
})

describe('script runs', () => {
  // The reference's "full time / position": two script words over one sans word.
  const TWO_SCRIPT = [
    { word: 'full',     start: 1,   end: 1.3, accent: 'script' },
    { word: 'time',     start: 1.3, end: 1.6, accent: 'script' },
    { word: 'position', start: 1.6, end: 2.2, accent: 'sans' },
  ]

  test('two consecutive script words form ONE script line above the word they qualify', () => {
    const el = Accent({ frame: at(2.0), fps: FPS, segments: [seg({ hero: true }, TWO_SCRIPT)] })
    const lines = lineDivs(el)
    assert.deepEqual(lines.map(textOf), ['full time', 'position'])
    assert.ok(kidsOf(lines[0]).every(isScriptSpan), 'line 1 is the script run')
    assert.equal(kidsOf(lines[0]).length, 2)
    assert.deepEqual(mainLineDivs(el).map(textOf), ['position'])
    assert.equal(spanFor(el, 'position').props.style.color, ACCENT_COLOR)
    assert.equal(lines[1].props.style.paddingLeft, SIZE * 0.66)
  })

  test('each script word still cuts on when spoken', () => {
    const el = Accent({ frame: at(1.35), fps: FPS, segments: [seg({ hero: true }, TWO_SCRIPT)] })
    assert.equal(spanFor(el, 'full').props.style.visibility, 'visible')
    assert.equal(spanFor(el, 'time').props.style.visibility, 'visible')
    assert.equal(spanFor(el, 'position').props.style.visibility, 'hidden')
  })

  test('a run qualifying a later word starts line 2, directly above that word', () => {
    const words = ['i', 'got', 'a'].map((w, i) => ({ word: w, start: 1 + i * 0.1, end: 1.1 + i * 0.1 }))
      .concat(TWO_SCRIPT.map(w => ({ ...w, start: w.start + 0.3, end: w.end + 0.3 })))
    const el = Accent({ frame: at(2.3), fps: FPS, segments: [seg({ hero: true, end: 3 }, words)] })
    assert.deepEqual(lineDivs(el).map(textOf), ['i got a', 'full time', 'position'])
    const [l1, l2] = mainLineDivs(el)
    assert.equal(l1.props.style.paddingLeft, 0)
    assert.equal(l2.props.style.paddingLeft, SIZE * 0.66)
  })

  test('a trailing script run with no word after it still renders, as a script line', () => {
    const words = [
      { word: 'so',   start: 1,   end: 1.2 },
      { word: 'much', start: 1.2, end: 1.5, accent: 'script' },
    ]
    const el = Accent({ frame: at(2.0), fps: FPS, segments: [seg({ hero: true }, words)] })
    assert.deepEqual(lineDivs(el).map(textOf), ['so', 'much'])
    assert.ok(isScriptSpan(spanFor(el, 'much')))
  })
})

// ---------------------------------------------------------------------------
// 6. Accent sans
// ---------------------------------------------------------------------------

describe('accent sans', () => {
  const SANS_WORDS = WORDS.map(w => (w.word === 'drone' ? { ...w, accent: 'sans' } : w))
  const CUSTOM_FONT = '"Baloo 2", system-ui, sans-serif'

  test('running: red, not italic, the running font', () => {
    const el = Accent({ frame: at(1.8), fps: FPS, fontFamily: CUSTOM_FONT, segments: [seg({}, SANS_WORDS)] })
    const s = spanFor(el, 'drone').props.style
    assert.equal(s.color, ACCENT_COLOR)
    assert.notEqual(s.fontStyle, 'italic')
    assert.equal(s.fontFamily, CUSTOM_FONT)
  })

  test('hero: red, not italic, the running font', () => {
    const el = Accent({ frame: at(2.0), fps: FPS, fontFamily: CUSTOM_FONT, segments: [seg({ hero: true }, SANS_WORDS)] })
    const s = spanFor(el, 'drone').props.style
    assert.equal(s.color, ACCENT_COLOR)
    assert.notEqual(s.fontStyle, 'italic')
    assert.equal(s.fontFamily, CUSTOM_FONT)
  })
})

// ---------------------------------------------------------------------------
// 7. Old segments
// ---------------------------------------------------------------------------

describe('old segments', () => {
  test('a segment with no words returns null (running and hero)', () => {
    assert.equal(Accent({ frame: at(1.5), fps: FPS, segments: [{ start: 1, end: 2.4, text: 'hi' }] }), null)
    assert.equal(Accent({ frame: at(1.5), fps: FPS, segments: [{ start: 1, end: 2.4, text: 'hi', hero: true }] }), null)
  })

  test('an unknown accent value renders as a plain word', () => {
    const BOLD_WORDS = WORDS.map(w => (w.word === 'drone' ? { ...w, accent: 'bold' } : w))
    for (const hero of [false, true]) {
      const el = Accent({ frame: at(2.0), fps: FPS, segments: [seg({ hero }, BOLD_WORDS)] })
      const s = spanFor(el, 'drone').props.style
      assert.equal(s.color, BASE_COLOR, `hero=${hero}`)
      assert.equal(s.fontFamily, RUNNING_FONT, `hero=${hero}`)
      assert.notEqual(s.fontStyle, 'italic', `hero=${hero}`)
    }
  })
})

// ---------------------------------------------------------------------------
// render.js: style registration and fonts
// ---------------------------------------------------------------------------

const ACCENT_FONTS = ['Inter+Tight:wght@700', 'Playfair+Display:ital,wght@1,700', 'Caveat:wght@700']

function captionSpecFor(captions) {
  const project = {
    tracks: [[{ id: 'clip1', type: 'video', src: '/foo.mp4', start: 0, end: 5 }]],
    captions: { style: 'accent', segments: [{ text: 'hi', start: 0, end: 1 }], ...captions },
    settings: { fps: 30 },
  }
  const spec = collectPuppeteerSegments(project, 30, 1080, 1920, '/tmp/seg').find(s => s.id === 'captions')
  assert.ok(spec, 'expected a captions spec')
  return spec
}

describe('render.js: accent style', () => {
  test("style 'accent' resolves to accent.jsx", () => {
    assert.equal(captionSpecFor({}).componentPath, join(TEMPLATES_DIR, 'accent.jsx'))
  })

  test('no caller fonts: loads the three accent fonts, spaces as +', () => {
    const fonts = captionSpecFor({}).googleFonts
    assert.deepEqual(fonts, ACCENT_FONTS)
    for (const f of fonts) assert.ok(!f.includes(' '), `font spec must not contain a space: ${f}`)
  })

  test('caller fonts are kept, accent fonts merged in, no duplicates', () => {
    const fonts = captionSpecFor({ googleFonts: ['Baloo+2:wght@700', 'Caveat:wght@700'] }).googleFonts
    assert.deepEqual(fonts, ['Baloo+2:wght@700', 'Caveat:wght@700', 'Inter+Tight:wght@700', 'Playfair+Display:ital,wght@1,700'])
  })

  test('a bare-string googleFonts is kept whole', () => {
    const fonts = captionSpecFor({ googleFonts: 'Roboto:wght@400;700' }).googleFonts
    assert.deepEqual(fonts, ['Roboto:wght@400;700', ...ACCENT_FONTS])
  })

  test('accent fonts load even with a caller fontFamily', () => {
    const fonts = captionSpecFor({ fontFamily: '"Baloo 2", sans-serif' }).googleFonts
    assert.deepEqual(fonts, ACCENT_FONTS)
  })

  test("the editor's ACCENT_CAPTION_FONTS is the same list", () => {
    const src = readFileSync(join(__dirname, '..', '..', 'editor', 'src', 'video', 'captionStyleDefaults.ts'), 'utf8')
    const m = src.match(/export const ACCENT_CAPTION_FONTS = (\[[^\]]*\])/)
    assert.ok(m, 'expected the ACCENT_CAPTION_FONTS literal in captionStyleDefaults.ts')
    assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), ACCENT_FONTS)
  })
})
