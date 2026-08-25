// montaj_assets/render/test/captions-font.test.mjs
//
// Caption templates accept text-styling props (fontFamily, fontWeight,
// textAlign, letterSpacing, lineHeight, textTransform) instead of hardcoding them.
// render.js already forwards every unrecognised field on `project.captions`
// straight into the template's props (see render.js ~line 763), so a
// template that merely destructures a new prop starts honouring
// `captions.<field>` with zero plumbing changes — this file proves each of
// the seven templates actually does that destructuring, and that the
// defaults reproduce today's hardcoded literals exactly (a no-change gate,
// same spirit as caption-position.test.mjs).
//
// Harness: identical esbuild + 'montaj/render' shim trick as
// caption-position.test.mjs (copied here rather than imported — that file
// does not export its helpers). Templates are compiled and their default
// export is called AS A PLAIN FUNCTION; JSX under the automatic runtime
// builds plain `{ type, props }` element trees with real style OBJECTS
// attached to `.props.style`, so no react-dom/server is needed.

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

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
  const tmpPath = join(__dirname, `__tmp-captions-font-${name}.mjs`)
  writeFileSync(tmpPath, result.outputFiles[0].text)
  try {
    return (await import(pathToFileURL(tmpPath).href)).default
  } finally {
    unlinkSync(tmpPath)
  }
}

// A literal list of all seven templates — deliberately not derived from a
// directory listing, so a template that goes missing (renamed, deleted)
// fails this test instead of silently shrinking the coverage.
const STYLE_NAMES = ['clean', 'subtitle', 'karaoke', 'outline', 'highlight-box', 'word-by-word', 'pop']

test('STYLE_NAMES names exactly the seven caption templates that exist on disk', () => {
  assert.equal(STYLE_NAMES.length, 7)
  for (const name of STYLE_NAMES) {
    assert.ok(existsSync(join(TEMPLATES_DIR, `${name}.jsx`)), `${name}.jsx must exist in ${TEMPLATES_DIR}`)
  }
})

const templates = {}
before(async () => {
  for (const name of STYLE_NAMES) templates[name] = await loadTemplate(name)
})

// Shared timing, same values as caption-position.test.mjs: seg.start=1,
// seg.end=5, fps=30, frame=40 -> t≈1.333s, past every template's fade-in.
const FPS = 30
const FRAME = 40
const SEG_BASE = { start: 1, end: 5 }
const WORDS = [{ word: 'hi', start: 1, end: 2 }] // active at t≈1.333

// word-by-word/pop have no no-words fallback (they return null with zero
// words), so they always need `words: WORDS`. karaoke/highlight-box/outline
// have a fallback branch AND a words branch — see segmentFor below for which
// one each uses for the single-style tests.
const NEEDS_WORDS = new Set(['karaoke', 'outline', 'highlight-box', 'word-by-word', 'pop'])

// outline's words branch hardcodes `textTransform: textTransform ?? 'uppercase'`
// — the deliberate all-caps stencil look documented in outline.jsx — so it
// shows a textTransform even with no prop passed. Its no-words fallback
// branch carries no such literal, matching every other template, so that is
// the branch used for the single-style fontFamily/textTransform tests below.
// (highlight-box's two branches differ only in `lineHeight`, which this file
// does not test, so either branch is fine there — the words branch is used
// for consistency with karaoke.)
function segmentFor(name) {
  if (name === 'outline') return { ...SEG_BASE, text: 'hi', words: [] }
  if (NEEDS_WORDS.has(name)) return { ...SEG_BASE, text: 'hi', words: WORDS }
  return { ...SEG_BASE, text: 'hi' }
}

/** Render `name` with one active segment and the given track-level props,
 *  returning the raw element (a Fragment wrapping one block). */
function renderOne(name, trackProps = {}) {
  const el = templates[name]({ frame: FRAME, fps: FPS, segments: [segmentFor(name)], ...trackProps })
  assert.ok(el, `${name}: expected an element (segment/frame out of range?)`)
  return el
}

/** Depth-first walk of the element tree; `visit(style)` is called for every
 *  style object found along the way that carries a `fontFamily` key — which
 *  is, by construction (see the task), the same node every template was
 *  given the new textAlign/letterSpacing/lineHeight/textTransform props on. */
function walkFontFamilyStyles(el, visit) {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    const style = node.props?.style
    if (style && 'fontFamily' in style) visit(style)
    const kids = node.props?.children
    if (Array.isArray(kids)) kids.forEach(walk)
    else if (kids) walk(kids)
  }
  walk(el)
}

/** The first (and, for every single-segment/single-branch render in this
 *  file, only) style object carrying fontFamily — "the caption text style". */
function findFontFamilyStyle(el) {
  let found
  walkFontFamilyStyles(el, (style) => { found ??= style })
  return found
}

/** Every fontFamily value found anywhere in the tree, in document order. */
function collectFontFamilies(el) {
  const found = []
  walkFontFamilyStyles(el, (style) => found.push(style.fontFamily))
  return found
}

// ---------------------------------------------------------------------------
// 1. No fontFamily prop -> today's hardcoded literal, per template.
// ---------------------------------------------------------------------------

const DEFAULT_FONT_FAMILY = {
  clean:            '"Figtree", system-ui, sans-serif',
  subtitle:         'system-ui, -apple-system, sans-serif',
  karaoke:          'system-ui, -apple-system, sans-serif',
  outline:          'system-ui, -apple-system, sans-serif',
  'highlight-box':  'system-ui, -apple-system, sans-serif',
  'word-by-word':   'system-ui, -apple-system, sans-serif',
  pop:              'system-ui, -apple-system, sans-serif',
}

describe('fontFamily — no prop keeps each template\'s current default literal', () => {
  for (const name of STYLE_NAMES) {
    test(`${name}`, () => {
      const style = findFontFamilyStyle(renderOne(name))
      assert.ok(style, `${name}: expected a style object carrying fontFamily`)
      assert.equal(style.fontFamily, DEFAULT_FONT_FAMILY[name])
    })
  }
})

// ---------------------------------------------------------------------------
// 2. A custom fontFamily prop reaches the caption text style.
// ---------------------------------------------------------------------------

const CUSTOM_FONT = '"Baloo 2", system-ui, sans-serif'

describe('fontFamily — a custom value overrides the default', () => {
  for (const name of STYLE_NAMES) {
    test(`${name}`, () => {
      const style = findFontFamilyStyle(renderOne(name, { fontFamily: CUSTOM_FONT }))
      assert.equal(style.fontFamily, CUSTOM_FONT)
    })
  }
})

// ---------------------------------------------------------------------------
// 3. Multi-site templates (karaoke, highlight-box, outline) apply a custom
// fontFamily at EVERY site, not just one. Each template's no-words fallback
// and main (words) branches are mutually exclusive per segment, so two
// segments in different lanes — one with words: [], one with words: WORDS —
// both active on the same frame force both branches to render in the same
// call, producing two separate fontFamily-bearing nodes in one element tree.
// ---------------------------------------------------------------------------

const MULTI_SITE = ['karaoke', 'highlight-box', 'outline']

function twoBranchSegments() {
  return [
    { ...SEG_BASE, text: 'hi', words: [],    lane: 0 }, // no-words fallback branch
    { ...SEG_BASE, text: 'hi', words: WORDS, lane: 1 }, // main (words) branch
  ]
}

describe('fontFamily — multi-site templates apply a custom value at every site', () => {
  for (const name of MULTI_SITE) {
    test(`${name}: both the fallback and words-branch sites read the custom fontFamily`, () => {
      const el = templates[name]({
        frame: FRAME, fps: FPS,
        segments: twoBranchSegments(),
        fontFamily: CUSTOM_FONT,
      })
      assert.ok(el, `${name}: expected an element`)
      const families = collectFontFamilies(el)
      assert.ok(families.length > 1, `${name}: expected more than one fontFamily site, got ${families.length}`)
      assert.deepEqual(new Set(families), new Set([CUSTOM_FONT]), `${name}: every site must read the custom value`)
    })
  }
})

// ---------------------------------------------------------------------------
// 4. textTransform: absent by default, 'uppercase' reaches the caption text
// style when passed — for all seven templates.
// ---------------------------------------------------------------------------

describe('textTransform — absent by default, applied when passed', () => {
  for (const name of STYLE_NAMES) {
    test(`${name}: no prop -> no textTransform key (or undefined)`, () => {
      const style = findFontFamilyStyle(renderOne(name))
      assert.ok(
        !('textTransform' in style) || style.textTransform === undefined,
        `${name}: expected no textTransform, got ${JSON.stringify(style.textTransform)}`,
      )
    })

    test(`${name}: textTransform: 'uppercase' reaches the caption text style`, () => {
      const style = findFontFamilyStyle(renderOne(name, { textTransform: 'uppercase' }))
      assert.equal(style.textTransform, 'uppercase')
    })
  }
})

// ---------------------------------------------------------------------------
// 4b. outline.jsx has a deliberate PER-BRANCH textTransform default: its
// no-words fallback branch renders a bare `textTransform` (like every other
// template), while its WORDS branch reads
// `textTransform: textTransform ?? 'uppercase'` — the all-caps stencil look
// documented in outline.jsx. Section 4 above routes outline through its
// fallback branch only (see segmentFor, which forces `words: []` for
// outline specifically), so nothing above proves the WORDS branch still
// defaults to 'uppercase', or that an explicit value still overrides it.
// Deleting the `?? 'uppercase'` would break outline's designed look with a
// fully green suite otherwise — guard it here.
//
// Reuses the existing twoBranchSegments() fixture (fallback lane 0 + words
// lane 1, both active) and the existing walkFontFamilyStyles recursive walk
// from the multi-site fontFamily test above, rather than building new
// fixture/walk machinery. activeSegments sorts by lane ascending (see every
// template's own comment on this), so the fallback (lane 0) is always the
// first fontFamily-bearing style found and the words branch (lane 1) is
// always the last — the same ordering the MULTI_SITE test above depends on.
// ---------------------------------------------------------------------------

function outlineWordsBranchTextTransform(el) {
  const styles = []
  walkFontFamilyStyles(el, (style) => styles.push(style))
  return styles[styles.length - 1]?.textTransform
}

describe('outline — words branch keeps its deliberate per-branch textTransform default', () => {
  test(`no textTransform prop -> words branch still renders 'uppercase' (the stencil look)`, () => {
    const el = templates.outline({ frame: FRAME, fps: FPS, segments: twoBranchSegments() })
    assert.equal(outlineWordsBranchTextTransform(el), 'uppercase')
  })

  test(`an explicit textTransform overrides the 'uppercase' default in the words branch`, () => {
    const el = templates.outline({
      frame: FRAME, fps: FPS,
      segments: twoBranchSegments(),
      textTransform: 'lowercase',
    })
    assert.equal(outlineWordsBranchTextTransform(el), 'lowercase')
  })
})

// ---------------------------------------------------------------------------
// 5. fontWeight: no prop -> today's hardcoded literal, per template. Same
// "hardcoded expectation vs. live-executed current source" strategy as
// DEFAULT_FONT_FAMILY above. `fontWeight` sits in the same style object as
// `fontFamily` at every site in all seven templates, so findFontFamilyStyle
// (which locates that node) doubles as "the caption text style" here too.
// ---------------------------------------------------------------------------

const DEFAULT_FONT_WEIGHT = {
  clean:            700,
  subtitle:         600,
  karaoke:          700,
  outline:          900,
  'highlight-box':  900,
  'word-by-word':   800,
  pop:              800,
}

describe('fontWeight — no prop keeps each template\'s current default literal', () => {
  for (const name of STYLE_NAMES) {
    test(`${name}`, () => {
      const style = findFontFamilyStyle(renderOne(name))
      assert.equal(style.fontWeight, DEFAULT_FONT_WEIGHT[name])
    })
  }
})

// ---------------------------------------------------------------------------
// 6. A custom fontWeight prop reaches the caption text style.
// ---------------------------------------------------------------------------

const CUSTOM_WEIGHT = 400

describe('fontWeight — a custom value overrides the default', () => {
  for (const name of STYLE_NAMES) {
    test(`${name}`, () => {
      const style = findFontFamilyStyle(renderOne(name, { fontWeight: CUSTOM_WEIGHT }))
      assert.equal(style.fontWeight, CUSTOM_WEIGHT)
    })
  }
})

// ---------------------------------------------------------------------------
// 7. Multi-site templates (karaoke, highlight-box, outline) apply a custom
// fontWeight at EVERY site, not just one — same twoBranchSegments fixture and
// recursive walk as the fontFamily multi-site test above.
// ---------------------------------------------------------------------------

/** Every fontWeight value found anywhere in the tree, in document order. */
function collectFontWeights(el) {
  const found = []
  walkFontFamilyStyles(el, (style) => found.push(style.fontWeight))
  return found
}

describe('fontWeight — multi-site templates apply a custom value at every site', () => {
  for (const name of MULTI_SITE) {
    test(`${name}: both the fallback and words-branch sites read the custom fontWeight`, () => {
      const el = templates[name]({
        frame: FRAME, fps: FPS,
        segments: twoBranchSegments(),
        fontWeight: CUSTOM_WEIGHT,
      })
      assert.ok(el, `${name}: expected an element`)
      const weights = collectFontWeights(el)
      assert.ok(weights.length > 1, `${name}: expected more than one fontWeight site, got ${weights.length}`)
      assert.deepEqual(new Set(weights), new Set([CUSTOM_WEIGHT]), `${name}: every site must read the custom value`)
    })
  }
})
