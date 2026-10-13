// montaj_assets/render/test/caption-plate.test.mjs
//
// The `plate` caption style: the whole phrase on one rounded plate, the spoken word recoloured on top. Its plate
// colour, opacity, padding and radius come from the track (or a brand kit's defaults for it) and each can be
// overridden by one caption; the spoken word takes accentColor, never a second box.
//
// Harness: the esbuild + 'montaj/render' shim from captions-font.test.mjs (copied, as that file does not export it).

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync } from 'node:fs'
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

let Plate
before(async () => {
  const result = await esbuild.build({
    entryPoints: [join(TEMPLATES_DIR, 'plate.jsx')], bundle: true, format: 'esm', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server'], plugins: [shim()], write: false, logLevel: 'silent',
  })
  const tmp = join(__dirname, '__tmp-caption-plate.mjs')
  writeFileSync(tmp, result.outputFiles[0].text)
  try { Plate = (await import(pathToFileURL(tmp).href)).default } finally { unlinkSync(tmp) }
})

const FPS = 30
const WORDS = [{ word: 'hi', start: 1, end: 1.5 }, { word: 'there', start: 1.5, end: 2.2 }, { word: 'friend', start: 2.2, end: 3 }]
const SEG = { id: 'a', text: 'hi there friend', start: 1, end: 3, words: WORDS }
const frameAt = (t) => Math.round(t * FPS)

/** Depth-first: every element, in order. */
function all(node, out = []) {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  const kids = node.props?.children
  for (const k of Array.isArray(kids) ? kids : [kids]) all(k, out)
  return out
}
const plateOf = (el) => all(el).find((n) => n.props?.style && 'borderRadius' in n.props.style)?.props.style
const wordSpans = (el) => all(el).filter((n) => n.type === 'span')
const render = (props = {}, seg = SEG, t = 1.8) => Plate({ frame: frameAt(t), fps: FPS, segments: [seg], ...props })

describe('plate: the plate', () => {
  test('is registered, and draws a black plate at 60% with a 16px radius by default', () => {
    assert.ok(captionTemplatePath('plate').endsWith('plate.jsx'))
    const s = plateOf(render())
    assert.equal(s.background, 'rgba(0, 0, 0, 0.6)')
    assert.equal(s.borderRadius, 16)
    assert.equal(s.padding, '14px 22px')
  })

  test('colour, opacity, padding and radius come from the track', () => {
    const s = plateOf(render({ backgroundColor: '#1d4ed8', plateOpacity: 0.85, platePadding: 20, plateRadius: 40 }))
    assert.equal(s.background, 'rgba(29, 78, 216, 0.85)')
    assert.equal(s.padding, '20px 32px')
    assert.equal(s.borderRadius, 40)
  })

  test('a colour that is not #rrggbb is used as it is (its own alpha)', () => {
    assert.equal(plateOf(render({ backgroundColor: 'rgba(10,20,30,0.4)', plateOpacity: 0.9 })).background, 'rgba(10,20,30,0.4)')
  })

  test('a caption\'s own plate fields win over the track and stay on that caption', () => {
    const own = { ...SEG, id: 'own', backgroundColor: '#ff0000', plateOpacity: 1, platePadding: 4, plateRadius: 2 }
    const other = { ...SEG, id: 'other' }
    const el = Plate({ frame: frameAt(1.8), fps: FPS, segments: [own, other], backgroundColor: '#00ff00', plateOpacity: 0.5 })
    const plates = el.props.children.map((b) => plateOf(b))
    assert.equal(plates[0].background, 'rgba(255, 0, 0, 1)')
    assert.equal(plates[0].borderRadius, 2)
    assert.equal(plates[1].background, 'rgba(0, 255, 0, 0.5)')
    assert.equal(plates[1].borderRadius, 16)
  })

  test('the captionOverlayFields path carries the plate fields to the template as props', () => {
    const f = captionOverlayFields({ style: 'plate', segments: [SEG], backgroundColor: '#222222', plateOpacity: 0.7, platePadding: 18, plateRadius: 30 })
    assert.ok(f.componentPath.endsWith('plate.jsx'))
    assert.deepEqual([f.props.backgroundColor, f.props.plateOpacity, f.props.platePadding, f.props.plateRadius], ['#222222', 0.7, 18, 30])
  })
})

describe('plate: the word on top', () => {
  test('exactly the spoken word takes accentColor; the others keep the text colour; one plate holds them all', () => {
    const el = render({ accentColor: '#ff00aa', color: '#ffffff' }, SEG, 1.8) // "there" is speaking
    const spans = wordSpans(el)
    assert.equal(spans.length, 3)
    const accented = spans.filter((n) => n.props.style?.color === '#ff00aa')
    assert.equal(accented.length, 1)
    assert.equal(accented[0].props.children, 'there')
    assert.equal(all(el).filter((n) => n.props?.style && 'borderRadius' in n.props.style).length, 1)
  })

  test('between words the last started word stays lit; before the first word the first is lit', () => {
    const gap = { ...SEG, words: [{ word: 'a', start: 1, end: 1.2 }, { word: 'b', start: 2, end: 2.5 }] }
    const lit = (t) => wordSpans(render({ accentColor: '#abcdef' }, gap, t)).findIndex((n) => n.props.style?.color === '#abcdef')
    assert.equal(lit(1.5), 0)
    assert.equal(lit(2.2), 1)
  })

  test('a caption without word timestamps shows its text on the plate, no highlight', () => {
    const el = render({}, { id: 'n', text: 'plain words', start: 1, end: 3 })
    assert.equal(wordSpans(el).length, 0)
    assert.ok(all(el).some((n) => n.props?.children === 'plain words'))
    assert.ok(plateOf(el))
  })

  test('nothing draws outside the caption\'s own time', () => {
    assert.equal(render({}, SEG, 0.5), null)
    assert.equal(render({}, SEG, 3.5), null)
  })
})

describe('plate: hugging the text', () => {
  // The plate's ref measures the laid-out lines. No layout here, so a fake element stands in: its range reports the rects.
  const hugOf = (el) => all(el).map((n) => n.ref ?? n.props?.ref).find((r) => typeof r === 'function')
  const fakeEl = (rects, { offsetWidth = 800, boxWidth = 800 } = {}) => ({
    style: { width: 'stale' },
    offsetWidth,
    getBoundingClientRect: () => ({ width: boxWidth }),
    ownerDocument: { createRange: () => ({ selectNodeContents() {}, getClientRects: () => rects }) },
  })
  const rect = (left, right, top) => ({ left, right, top, width: right - left })

  test('the plate has a ref that sets its width to the widest line (the padding is the box\'s own)', () => {
    const hug = hugOf(render())
    assert.equal(typeof hug, 'function')
    // two lines: 300 and 520 wide (a line may come as several rects, one per word span)
    const el = fakeEl([rect(100, 250, 10), rect(250, 400, 10), rect(100, 300, 90), rect(300, 620, 90)])
    hug(el)
    assert.equal(el.style.width, '522px')
  })

  test('a transformed ancestor is divided out: a frame shown at half size measures half', () => {
    const hug = hugOf(render())
    const el = fakeEl([rect(0, 260, 10)], { offsetWidth: 800, boxWidth: 400 })
    hug(el)
    assert.equal(el.style.width, '522px')
  })

  test('a border-box plate gets the padding added to the widest line', () => {
    const hug = hugOf(render())
    const el = fakeEl([rect(0, 300, 10)])
    el.ownerDocument.defaultView = { getComputedStyle: () => ({ boxSizing: 'border-box', paddingLeft: '22px', paddingRight: '22px' }) }
    hug(el)
    assert.equal(el.style.width, '346px')
  })

  test('nothing measured (no layout) leaves the width unset, and never throws', () => {
    const hug = hugOf(render())
    const none = fakeEl([])
    hug(none)
    assert.equal(none.style.width, '')
    const zero = fakeEl([rect(5, 5, 0)])
    hug(zero)
    assert.equal(zero.style.width, '')
    const broken = { style: { width: 'x' }, get ownerDocument() { throw new Error('no dom') } }
    assert.doesNotThrow(() => hug(broken))
    assert.doesNotThrow(() => hug(null))
  })
})
