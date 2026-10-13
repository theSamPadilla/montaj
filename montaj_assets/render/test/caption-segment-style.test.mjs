// montaj_assets/render/test/caption-segment-style.test.mjs
//
// Per-caption text styling. A caption segment may carry the same styling
// fields as the track (fontSize, fontFamily, fontWeight, color, ...). Each
// template resolves them per segment through its `segmentTheme`: the
// segment's value, else the track's prop, else the template's default.
//
//   1. A project with no per-caption styling renders exactly as before: every
//      template's element tree matches a golden captured from the templates
//      as they were before per-caption styling existed.
//   2. A segment's own value wins over the track's, and reaches the same
//      places a track value does: the segment renders exactly as it would
//      with that value set on the track.
//   3. It never leaks: a second caption on screen at the same instant keeps
//      the track's values.
//   4. The export fetches every caption's own Google Fonts.
//
// Harness: the esbuild + 'montaj/render' shim from captions-font.test.mjs
// (copied, as that file does not export it).

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'
import { captionOverlayFields } from '../caption-spec.js'

const __dirname           = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR       = join(__dirname, '..', 'templates', 'captions')
const OVERLAY_RUNTIME_DIR = join(__dirname, '..', '..', 'overlay-runtime')
const GOLDEN_PATH         = join(__dirname, 'fixtures', 'caption-segment-style-golden.json')

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
  const tmpPath = join(__dirname, `__tmp-caption-segment-style-${name}.mjs`)
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

/** An element tree as plain data: type, key and props, children recursed.
 *  Functions (a component type) are named; symbols (Fragment) are labelled. */
function plain(node) {
  if (Array.isArray(node)) return node.map(plain)
  if (!node || typeof node !== 'object') return node ?? null
  const type = typeof node.type === 'symbol' ? String(node.type) : typeof node.type === 'function' ? `fn:${node.type.name}` : node.type
  const props = {}
  for (const [k, v] of Object.entries(node.props ?? {})) props[k] = k === 'children' ? plain(v) : v
  return { type, key: node.key ?? null, props }
}

const FPS = 30
// Two rows, on screen together from 1.2 s to 3 s. Words on both, so every
// template's words branch draws; `hero` on the second for accent.
const SEG_A = {
  id: 'a', text: 'hi there friend', start: 1, end: 3, lane: 0, offsetX: 5,
  words: [{ word: 'hi', start: 1, end: 1.5 }, { word: 'there', start: 1.5, end: 2.2 }, { word: 'friend', start: 2.2, end: 3 }],
}
const SEG_B = {
  id: 'b', text: 'second row here', start: 1.2, end: 4, lane: 1, color: '#00ff00', hero: true,
  words: [{ word: 'second', start: 1.2, end: 2 }, { word: 'row', start: 2, end: 3, accent: 'serif' }, { word: 'here', start: 3, end: 4 }],
}
const FRAMES = [35, 40, 60, 75, 100]
const TRACK_PROPS = {
  color: '#ff0000', fontSize: 60, fontFamily: '"Baloo 2", system-ui, sans-serif', fontWeight: 400,
  textTransform: 'lowercase', textAlign: 'left', letterSpacing: '0.1em', lineHeight: 1.5,
  accentColor: '#0000ff', highlightColor: '#111111', activeColor: '#222222', backgroundColor: '#333333',
  plateOpacity: 0.3, platePadding: 30, plateRadius: 40,
}
const OVERRIDES = {
  color: '#abcdef', fontSize: 90, fontFamily: '"Caveat", cursive', fontWeight: 900,
  textTransform: 'uppercase', textAlign: 'right', letterSpacing: '0.3em', lineHeight: 2,
  accentColor: '#fedcba', highlightColor: '#444444', activeColor: '#555555', backgroundColor: '#666666',
  plateOpacity: 0.9, platePadding: 8, plateRadius: 4,
}
// The cases the golden covers: no track styling, and every track field set.
const GOLDEN_CASES = [['default', {}], ['track', TRACK_PROPS]]

function render(name, frame, segments, trackProps) {
  return templates[name]({ frame, fps: FPS, segments, ...trackProps })
}

/** The rendered blocks, one per caption on screen (accent and the others all
 *  return a fragment whose children are the blocks). */
function blocks(el) {
  if (!el) return []
  const kids = el.props?.children
  return (Array.isArray(kids) ? kids : [kids]).filter(Boolean)
}

describe('a project with no per-caption styling renders exactly as before (golden)', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'))
  // A NEW style has no golden yet: MONTAJ_WRITE_GOLDEN=<style> captures its two cases into the fixture (for a style
  // whose look is final, never for one that already has an entry: that would bless a change).
  const toWrite = process.env.MONTAJ_WRITE_GOLDEN
  if (toWrite) {
    test(`writes the golden for ${toWrite}`, () => {
      assert.ok(!golden[toWrite], `${toWrite} already has a golden; remove it deliberately first`)
      golden[toWrite] = {}
      for (const [label, props] of GOLDEN_CASES) {
        golden[toWrite][label] = {}
        for (const frame of FRAMES) golden[toWrite][label][frame] = JSON.parse(JSON.stringify(plain(render(toWrite, frame, [SEG_A, SEG_B], props))))
      }
      writeFileSync(GOLDEN_PATH, JSON.stringify(golden) + '\n')
    })
  }
  for (const name of STYLE_NAMES) {
    test(name, () => {
      for (const [label, props] of GOLDEN_CASES) {
        for (const frame of FRAMES) {
          // Through JSON, as the golden was: a style key whose value is
          // undefined is dropped on both sides (React draws it as absent).
          const got = JSON.parse(JSON.stringify(plain(render(name, frame, [SEG_A, SEG_B], props))))
          assert.deepEqual(got, golden[name][label][frame], `${name} ${label} frame ${frame}`)
        }
      }
    })
  }
})

describe('a caption\'s own styling wins over the track\'s, and stays on that caption', () => {
  for (const name of STYLE_NAMES) {
    for (const [label, trackProps] of GOLDEN_CASES) {
      test(`${name}, track ${label}`, () => {
        const segA = { ...SEG_A, ...OVERRIDES }
        let compared = 0
        for (const frame of FRAMES) {
          const both = blocks(render(name, frame, [segA, SEG_B], trackProps))
          // The overridden caption renders exactly as it would with those
          // values on the track.
          const asTrack = blocks(render(name, frame, [SEG_A, SEG_B], { ...trackProps, ...OVERRIDES }))
          // The other caption renders exactly as it would with no override
          // anywhere.
          const plainTrack = blocks(render(name, frame, [SEG_A, SEG_B], trackProps))
          for (const b of both) {
            const want = (b.key === 'a' ? asTrack : plainTrack).find(x => x.key === b.key)
            assert.deepEqual(plain(b), plain(want), `${name} frame ${frame} block ${b.key}`)
            if (b.key === 'a') compared++
          }
        }
        assert.ok(compared > 0, `${name}: the overridden caption was never on screen`)
      })
    }
  }

  test('an override actually changes what is drawn (the comparison above can say no)', () => {
    const segA = { ...SEG_A, ...OVERRIDES }
    for (const name of STYLE_NAMES) {
      const a = blocks(render(name, 40, [segA, SEG_B], {})).find(b => b.key === 'a')
      const before = blocks(render(name, 40, [SEG_A, SEG_B], {})).find(b => b.key === 'a')
      assert.ok(a && before, `${name}: caption a on screen at frame 40`)
      assert.notDeepEqual(plain(a), plain(before), `${name}: overrides changed nothing`)
    }
  })
})

describe('the export fetches every caption\'s own Google Fonts', () => {
  test('no caption fonts: the track\'s fonts, unchanged', () => {
    assert.deepEqual(captionOverlayFields({ style: 'pop', googleFonts: ['A:wght@700'], segments: [SEG_A] }).googleFonts, ['A:wght@700'])
    assert.deepEqual(captionOverlayFields({ style: 'clean', segments: [SEG_A] }).googleFonts, ['Figtree:wght@700'])
    assert.deepEqual(captionOverlayFields({ style: 'pop', segments: [SEG_A] }).googleFonts, [])
  })

  test('caption fonts are added after the track\'s, once each, and the style default still loads', () => {
    const segments = [{ ...SEG_A, googleFonts: ['B:wght@400', 'A:wght@700'] }, { ...SEG_B, googleFonts: ['B:wght@400'] }]
    assert.deepEqual(captionOverlayFields({ style: 'pop', googleFonts: ['A:wght@700'], segments }).googleFonts, ['A:wght@700', 'B:wght@400'])
    assert.deepEqual(captionOverlayFields({ style: 'clean', segments }).googleFonts, ['Figtree:wght@700', 'B:wght@400', 'A:wght@700'])
  })

  test('the segments reach the template with their styling fields', () => {
    const seg = { ...SEG_A, fontSize: 90 }
    assert.equal(captionOverlayFields({ style: 'pop', segments: [seg] }).props.segments[0].fontSize, 90)
  })
})
