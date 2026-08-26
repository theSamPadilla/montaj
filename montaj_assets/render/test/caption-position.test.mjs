// render/test/caption-position.test.mjs
//
// Tests the shared caption positioner (montaj_assets/overlay-runtime/position.js)
// and the "no-offset equivalence" gate that is the whole point of this feature:
// a caption segment that never touches offsetX/offsetY/scale must render
// pixel-identically to the pre-feature templates (see plan task 2 — the
// original wrapper style, minus `position: 'fixed'`, is now built by
// captionInnerStyle/captionOuterStyle instead of being inlined per template).
//
// Two parts:
//   1. Direct unit tests of captionOuterStyle/captionInnerStyle — the maths,
//      key presence/absence, and seg?. null-safety.
//   2. Anchor fidelity, per real template. Each of the 7 templates under
//      render/templates/captions/ is compiled with esbuild (same alias trick
//      bundle.js uses for the real render pipeline: 'montaj/render' resolves
//      to the actual captionOuterStyle/captionInnerStyle in overlay-runtime)
//      and its default-exported component is called AS A PLAIN FUNCTION — no
//      react-dom/server needed, since JSX under the automatic runtime just
//      builds plain `{ type, props }` element objects, and none of these
//      templates use hooks. That gives direct access to the exact style
//      OBJECTS (not serialized CSS text) the template hands to
//      captionOuterStyle/captionInnerStyle.
//
// Templates render EVERY active segment, not just the first, so what a
// template returns is a Fragment holding one outer <div> per active segment,
// lane-ascending. `captionBlocks` below unwraps that; a single-segment project
// yields exactly one block, and that block is the element the template used to
// return directly — which is what keeps every historical assertion below
// meaningful as a no-change gate.
//
// Anchor-assertion strategy (see the task report for the fuller version):
// the EXPECTED anchor for each template/branch is hardcoded here (verified
// against `git diff HEAD` when this feature was implemented — the previous
// wrapper's inline style, minus `position: 'fixed'`). But the ACTUAL value
// under test is read off a genuine execution of the CURRENT template source
// via the esbuild pipeline above — not a re-typed copy, and not a text-level
// parse of the .jsx file. So this is neither pure "hardcode" nor pure
// "extract-and-eval": if a template's anchor object literal changes, the next
// `node --test` run recompiles and re-executes the CHANGED source, producing
// a different actual value, which fails against the still-hardcoded
// expectation below. That's strictly more faithful than hardcoding alone
// (which never touches the .jsx files at all) and avoids the brittleness of
// regexing/evaling an object literal out of source text (anchors embed live
// variables like `opacity` that don't exist standalone).

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'
import { captionOuterStyle, captionInnerStyle } from '../../overlay-runtime/position.js'

const __dirname       = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR   = join(__dirname, '..', 'templates', 'captions')
const OVERLAY_RUNTIME_DIR = join(__dirname, '..', '..', 'overlay-runtime')

// ---------------------------------------------------------------------------
// Part 1 — captionOuterStyle / captionInnerStyle: direct unit tests
// ---------------------------------------------------------------------------

describe('captionOuterStyle', () => {
  test('no offsets: frame-sized wrapper with no transform key at all', () => {
    const style = captionOuterStyle({ offsetX: 0, offsetY: 0 })
    assert.deepEqual(style, {
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none',
    })
    assert.ok(!('transform' in style), 'a 0/0 offset must not add even an identity transform')
  })

  test('absent offsets (undefined seg) default to 0/0, no transform', () => {
    for (const seg of [undefined, null, {}]) {
      const style = captionOuterStyle(seg)
      assert.ok(!('transform' in style), `seg=${JSON.stringify(seg)} must not carry transform`)
    }
  })

  test('both offsets set: translate(ox%, oy%)', () => {
    const style = captionOuterStyle({ offsetX: 12.5, offsetY: -4 })
    assert.equal(style.transform, 'translate(12.5%, -4%)')
  })

  test('only offsetX set: offsetY defaults to 0 in the transform', () => {
    const style = captionOuterStyle({ offsetX: 7 })
    assert.equal(style.transform, 'translate(7%, 0%)')
  })

  test('only offsetY set: offsetX defaults to 0 in the transform', () => {
    const style = captionOuterStyle({ offsetY: -9 })
    assert.equal(style.transform, 'translate(0%, -9%)')
  })

  test('a negative-zero-shaped offset (explicit 0) still counts as "no offset"', () => {
    // -0 is falsy just like 0 — captionOuterStyle's `ox || oy` guard must not
    // add a transform for either.
    const style = captionOuterStyle({ offsetX: -0, offsetY: 0 })
    assert.ok(!('transform' in style))
  })
})

describe('captionInnerStyle', () => {
  const anchor = { bottom: '10%', left: 0, right: 0, padding: '0 7%' }

  test('scale 1 (explicit or defaulted): anchor preserved verbatim, no transform keys', () => {
    for (const seg of [undefined, null, {}, { scale: 1 }]) {
      const style = captionInnerStyle(seg, anchor)
      assert.deepEqual(style, { position: 'absolute', ...anchor })
      assert.ok(!('transform' in style), `seg=${JSON.stringify(seg)}`)
      assert.ok(!('transformOrigin' in style), `seg=${JSON.stringify(seg)}`)
    }
  })

  test('scale !== 1 produces scale(sc) + transformOrigin center center', () => {
    const style = captionInnerStyle({ scale: 1.5 }, anchor)
    assert.equal(style.transform, 'scale(1.5)')
    assert.equal(style.transformOrigin, 'center center')
  })

  test('a fractional scale renders verbatim (no rounding)', () => {
    const style = captionInnerStyle({ scale: 0.333 }, anchor)
    assert.equal(style.transform, 'scale(0.333)')
  })

  test('key order: position, then the anchor as given, then transform/transformOrigin last', () => {
    const style = captionInnerStyle({ scale: 2 }, anchor)
    assert.deepEqual(Object.keys(style), [
      'position', 'bottom', 'left', 'right', 'padding', 'transform', 'transformOrigin',
    ])
  })

  test('seg?. null-safety: undefined/null does not throw and behaves like scale 1', () => {
    assert.doesNotThrow(() => captionInnerStyle(undefined, anchor))
    assert.doesNotThrow(() => captionInnerStyle(null, anchor))
    assert.deepEqual(captionInnerStyle(undefined, anchor), { position: 'absolute', ...anchor })
    assert.deepEqual(captionInnerStyle(null, anchor), { position: 'absolute', ...anchor })
  })

  test('an empty anchor object still gets position: absolute', () => {
    assert.deepEqual(captionInnerStyle({}, {}), { position: 'absolute' })
  })
})

// ---------------------------------------------------------------------------
// Part 2 — anchor fidelity against the real, compiled template source
// ---------------------------------------------------------------------------

/**
 * esbuild plugin: resolve the templates' `from 'montaj/render'` import to a
 * tiny virtual module that re-exports the REAL interpolate/spring/
 * captionOuterStyle/captionInnerStyle straight from overlay-runtime — the
 * exact same functions the production render/preview pipelines use (see
 * render/core/index.js and montaj_assets/overlay-runtime/index.js). Deliberately
 * bypasses overlay-runtime's index.js (which also pulls in three/recharts for
 * unrelated globals) — captions only ever need these four exports.
 */
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

/**
 * Compile templates/captions/<name>.jsx with esbuild — bundled exactly like
 * bundle.js compiles it for the real Puppeteer render (jsx: 'automatic',
 * 'montaj/render' resolved to the real positioner) — then write the output to
 * a throwaway .mjs file inside this test dir (so the bare `react`/
 * `react/jsx-runtime` imports the automatic JSX runtime injects resolve
 * against render's own node_modules) and import it. Returns the
 * default-exported component function.
 *
 * The component is called directly as a plain function below (not via
 * React.createElement/react-dom) — none of the caption templates use hooks,
 * so invoking them outside a React render pass is safe, and it hands back
 * the exact `{ type, props }` element objects the JSX produced, with real
 * style OBJECTS (not serialized CSS text) attached to `.props.style`.
 */
async function loadTemplate(name) {
  const entry = join(TEMPLATES_DIR, `${name}.jsx`)
  // esbuild plugins are only supported by the async `build()` API, not `buildSync`.
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server'],
    plugins: [montajRenderShimPlugin()],
    write: false,
    logLevel: 'silent',
  })
  const tmpPath = join(__dirname, `__tmp-caption-${name}.mjs`)
  writeFileSync(tmpPath, result.outputFiles[0].text)
  try {
    const mod = await import(pathToFileURL(tmpPath).href)
    return mod.default
  } finally {
    unlinkSync(tmpPath)
  }
}

const STYLE_NAMES = ['clean', 'subtitle', 'karaoke', 'outline', 'highlight-box', 'word-by-word', 'pop']

const templates = {}
before(async () => {
  for (const name of STYLE_NAMES) templates[name] = await loadTemplate(name)
})

// Shared timing: seg.start=1, seg.end=5, fps=30, frame=40 → t≈1.333s, well
// past every template's fade-in window (checked per template below) so every
// opacity that exists clamps to a fixed, known value (1) — the anchor shape
// is what's under test here, not the fade curve.
const FPS = 30
const FRAME = 40
const SEG_BASE = { start: 1, end: 5 }
const WORDS = [{ word: 'hi', start: 1, end: 2 }] // active at t≈1.333

/**
 * Unwrap a template's return value into its per-segment blocks — one outer
 * <div> per active segment, in paint order (lane ascending). The templates
 * return `<>{active.map(...)}</>`, so `props.children` is that array; the
 * single-child case is normalized to a one-element array so callers never
 * branch.
 */
function captionBlocks(el, name) {
  assert.ok(el, `${name}: expected an element, got ${el} (segment/frame out of range?)`)
  const kids = el.props.children
  return Array.isArray(kids) ? kids : [kids]
}

/** Render `templates[name]` with a no-offset, scale-1 segment and return { outerEl, innerEl }. */
function renderNoOffset(name, extraSeg = {}) {
  const seg = { ...SEG_BASE, text: 'hi', ...extraSeg }
  const blocks = captionBlocks(templates[name]({ frame: FRAME, fps: FPS, segments: [seg] }), name)
  // One active segment must still produce exactly one block — the single-row
  // no-change gate this whole file exists to hold.
  assert.equal(blocks.length, 1, `${name}: one active segment must render exactly one block`)
  const outerEl = blocks[0]
  assert.ok(outerEl, `${name}: expected an element, got ${outerEl} (segment/frame out of range?)`)
  const innerEl = outerEl.props.children
  assert.ok(innerEl, `${name}: expected an inner element`)
  return { outerEl, innerEl }
}

// word-by-word/pop return null with zero words (no fallback branch); the
// others render fine either way, but pass words here too for uniformity.
const NEEDS_WORDS = new Set(['karaoke', 'outline', 'highlight-box', 'word-by-word', 'pop'])

describe('no-offset equivalence gate — outer wrapper (all 7 templates)', () => {
  for (const name of STYLE_NAMES) {
    test(`${name}: outer wrapper is frame-sized with no transform key`, () => {
      const { outerEl } = renderNoOffset(name, NEEDS_WORDS.has(name) ? { words: WORDS } : {})
      assert.equal(outerEl.type, 'div')
      assert.deepEqual(outerEl.props.style, {
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none',
      })
      assert.ok(!('transform' in outerEl.props.style))
    })
  }
})

describe('no-offset equivalence gate — inner anchor, historical values (10 wrapper blocks)', () => {
  test('clean: bottom 26%, padding 0 7%, flex+justifyContent, opacity', () => {
    const { innerEl } = renderNoOffset('clean')
    assert.equal(innerEl.type, 'div')
    assert.deepEqual(innerEl.props.style, {
      position: 'absolute',
      bottom: '26%', left: 0, right: 0,
      display: 'flex', justifyContent: 'center',
      padding: '0 7%',
      opacity: 1,
    })
  })

  test('subtitle: bottom 25%, padding 0 6%, flex+justifyContent, opacity', () => {
    const { innerEl } = renderNoOffset('subtitle')
    assert.deepEqual(innerEl.props.style, {
      position: 'absolute',
      bottom: '25%', left: 0, right: 0,
      display: 'flex', justifyContent: 'center',
      padding: '0 6%',
      opacity: 1,
    })
  })

  test('karaoke — no-words fallback branch: bottom 25%, padding 0 8%, textAlign center, opacity', () => {
    const { innerEl } = renderNoOffset('karaoke', { words: [] })
    assert.deepEqual(innerEl.props.style, {
      position: 'absolute',
      bottom: '25%', left: 0, right: 0,
      textAlign: 'center', padding: '0 8%',
      opacity: 1,
    })
  })

  test('karaoke — main (words) branch: bottom 25%, padding 0 8%, textAlign center, opacity: fadeOpacity', () => {
    const { innerEl } = renderNoOffset('karaoke', { words: WORDS })
    assert.deepEqual(innerEl.props.style, {
      position: 'absolute',
      bottom: '25%', left: 0, right: 0,
      textAlign: 'center', padding: '0 8%',
      opacity: 1,
    })
  })

  test('outline — no-words fallback branch: bottom 25%, padding 0 6%, textAlign center, opacity', () => {
    const { innerEl } = renderNoOffset('outline', { words: [] })
    assert.deepEqual(innerEl.props.style, {
      position: 'absolute',
      bottom: '25%', left: 0, right: 0,
      textAlign: 'center', padding: '0 6%',
      opacity: 1,
    })
  })

  // Asymmetry preserved on purpose (per the plan): the outline MAIN branch's
  // anchor never carried an opacity key, unlike its own fallback branch above
  // and unlike every other template's main branch. Do not "fix" this here.
  test('outline — main (words) branch: bottom 25%, padding 0 6%, textAlign center, NO opacity key', () => {
    const { innerEl } = renderNoOffset('outline', { words: WORDS })
    assert.deepEqual(innerEl.props.style, {
      position: 'absolute',
      bottom: '25%', left: 0, right: 0,
      textAlign: 'center', padding: '0 6%',
    })
    assert.ok(!('opacity' in innerEl.props.style))
  })

  test('highlight-box — no-words fallback branch: bottom 25%, padding 0 6%, textAlign center, opacity', () => {
    const { innerEl } = renderNoOffset('highlight-box', { words: [] })
    assert.deepEqual(innerEl.props.style, {
      position: 'absolute',
      bottom: '25%', left: 0, right: 0,
      textAlign: 'center', padding: '0 6%',
      opacity: 1,
    })
  })

  // Same asymmetry as outline — main branch never had an opacity key.
  test('highlight-box — main (words) branch: bottom 25%, padding 0 6%, textAlign center, NO opacity key', () => {
    const { innerEl } = renderNoOffset('highlight-box', { words: WORDS })
    assert.deepEqual(innerEl.props.style, {
      position: 'absolute',
      bottom: '25%', left: 0, right: 0,
      textAlign: 'center', padding: '0 6%',
    })
    assert.ok(!('opacity' in innerEl.props.style))
  })

  test('word-by-word: bottom 24%, padding 0 8%, textAlign center, no wrapper opacity', () => {
    const { innerEl } = renderNoOffset('word-by-word', { words: WORDS })
    assert.deepEqual(innerEl.props.style, {
      position: 'absolute',
      bottom: '24%', left: 0, right: 0,
      textAlign: 'center', padding: '0 8%',
    })
  })

  test('pop: bottom 24%, padding 0 8%, textAlign center, no wrapper opacity', () => {
    const { innerEl } = renderNoOffset('pop', { words: WORDS })
    assert.deepEqual(innerEl.props.style, {
      position: 'absolute',
      bottom: '24%', left: 0, right: 0,
      textAlign: 'center', padding: '0 8%',
    })
  })
})

// ---------------------------------------------------------------------------
// Wiring sanity — every template threads the ACTUAL active segment (not a
// stray reference) into captionOuterStyle/captionInnerStyle, so a real
// offset/scale on a real segment shows up in what the template renders. The
// maths itself is Part 1's job; this only guards the plumbing between
// `segments.find(...)` and the two calls.
// ---------------------------------------------------------------------------

describe('offset/scale wiring — real segment reaches the positioner (all 7 templates)', () => {
  for (const name of STYLE_NAMES) {
    test(`${name}: a segment with offsetX/offsetY/scale set reaches both style calls`, () => {
      const { outerEl, innerEl } = renderNoOffset(name, {
        offsetX: 15, offsetY: -8, scale: 2,
        ...(NEEDS_WORDS.has(name) ? { words: WORDS } : {}),
      })
      assert.equal(outerEl.props.style.transform, 'translate(15%, -8%)', `${name}: outer transform`)
      assert.equal(innerEl.props.style.transform, 'scale(2)', `${name}: inner transform`)
      assert.equal(innerEl.props.style.transformOrigin, 'center center', `${name}: inner transformOrigin`)
    })
  }
})

// ---------------------------------------------------------------------------
// Part 3 — per-segment color override: `seg.color ?? color`, BASE text color
// only. Mirrors the offset/scale sections above: real segments through the
// real compiled template source, reading the actual style object handed to
// the DOM node that carries the base text color (never the per-style accent
// field — karaoke's highlightColor, highlight-box/outline's accentColor —
// which stays wired to the track-level accent prop untouched by this feature).
// ---------------------------------------------------------------------------

/**
 * Render `templates[name]` with an optional per-segment `color`, an optional
 * track-level `color` prop, and an optional `words` array, returning the same
 * { outerEl, innerEl } shape as renderNoOffset.
 */
function renderForColor(name, { segColor, trackColor, words } = {}) {
  const seg = {
    ...SEG_BASE, text: 'hi',
    ...(words ? { words } : {}),
    ...(segColor !== undefined ? { color: segColor } : {}),
  }
  const props = { frame: FRAME, fps: FPS, segments: [seg] }
  if (trackColor !== undefined) props.color = trackColor
  const blocks = captionBlocks(templates[name](props), name)
  assert.equal(blocks.length, 1, `${name}: one active segment must render exactly one block`)
  const outerEl = blocks[0]
  assert.ok(outerEl, `${name}: expected an element, got ${outerEl}`)
  const innerEl = outerEl.props.children
  assert.ok(innerEl, `${name}: expected an inner element`)
  return { outerEl, innerEl }
}

// word-by-word/subtitle/clean, and the no-words fallback of highlight-box/
// outline, all render ONE styled node directly under the inner anchor box.
const directColor = (innerEl) => innerEl.props.children.props.style.color

// karaoke/highlight-box/outline's main (words) branch renders a wrapping div
// whose children are the per-word spans — index 1 is never the active/spoken
// word for WORDS2 below, so it's always styled with the base color.
const WORDS2 = [
  { word: 'hi',    start: 1, end: 2 }, // active/spoken at t≈1.333
  { word: 'there', start: 2, end: 3 }, // not yet started — base color applies
]
const secondWordColor = (innerEl) => innerEl.props.children.props.children[1].props.style.color

describe('per-segment color override — seg.color ?? color (base text color)', () => {
  // { name, words, extract, default }: templates whose base text color is a
  // single directly-styled node (no active/spoken split to worry about).
  const DIRECT_CASES = [
    { name: 'word-by-word', words: WORDS, extract: directColor, def: '#ffffff' },
    { name: 'subtitle',     words: null,  extract: directColor, def: '#ffffff' },
    { name: 'clean',        words: null,  extract: directColor, def: '#ffffff' },
    // no-words fallback branch — a single span with no active/spoken word.
    { name: 'highlight-box', words: [], extract: directColor, def: '#ffffff' },
    { name: 'outline',       words: [], extract: directColor, def: '#ffffff' },
  ]

  for (const { name, words, extract, def } of DIRECT_CASES) {
    describe(name, () => {
      test('a segment with color renders its base text with that color', () => {
        const { innerEl } = renderForColor(name, { segColor: '#123456', words })
        assert.equal(extract(innerEl), '#123456')
      })
      test('a segment without color uses the track-level color prop', () => {
        const { innerEl } = renderForColor(name, { trackColor: '#abcdef', words })
        assert.equal(extract(innerEl), '#abcdef')
      })
      test('with neither set, the template default is unchanged', () => {
        const { innerEl } = renderForColor(name, { words })
        assert.equal(extract(innerEl), def)
      })
    })
  }

  // karaoke/highlight-box/outline's main (words) branch: the active/spoken
  // word keeps its own accent color (highlightColor/accentColor) — untouched
  // by this feature — while every other word is the one that must honor
  // seg.color ?? color.
  const WORD_BRANCH_CASES = [
    { name: 'karaoke',       def: 'rgba(255,255,255,0.55)' },
    { name: 'highlight-box', def: '#ffffff' },
    { name: 'outline',       def: '#ffffff' },
  ]

  for (const { name, def } of WORD_BRANCH_CASES) {
    describe(`${name} (words branch, unspoken word)`, () => {
      test('a segment with color renders the unspoken word with that color', () => {
        const { innerEl } = renderForColor(name, { segColor: '#123456', words: WORDS2 })
        assert.equal(secondWordColor(innerEl), '#123456')
      })
      test('a segment without color uses the track-level color prop', () => {
        const { innerEl } = renderForColor(name, { trackColor: '#abcdef', words: WORDS2 })
        assert.equal(secondWordColor(innerEl), '#abcdef')
      })
      test('with neither set, the template default is unchanged', () => {
        const { innerEl } = renderForColor(name, { words: WORDS2 })
        assert.equal(secondWordColor(innerEl), def)
      })
    })
  }

  // pop is the one style with no rendered "base" text color: only the active
  // word is ever shown, and it is always styled with `activeColor` (an accent
  // field, matching karaoke/highlight-box/outline's naming) — the `color`
  // prop is destructured but never applied anywhere in the template, same as
  // before this feature. seg.color is therefore correctly a no-op here: it
  // would be inconsistent to make the per-segment override reach a place the
  // track-level color has never reached.
  test('pop: base color has no rendered effect (only activeColor is used) — seg.color is a no-op, matching track-level color today', () => {
    const withoutSegColor = renderForColor('pop', { words: WORDS })
    const withSegColor    = renderForColor('pop', { segColor: '#123456', words: WORDS })
    assert.equal(directColor(withSegColor.innerEl), directColor(withoutSegColor.innerEl))
  })
})

// ---------------------------------------------------------------------------
// Part 4 — lanes: EVERY active segment renders, lane-ascending.
//
// Captions gained a `lane` (row) field, so two segments can be active at the
// same instant. Lane ascending is the paint order and therefore the z-order —
// a higher lane paints later and lands on top. It is the ONLY stacking rule:
// there is deliberately no automatic vertical offset per row, so two
// simultaneous captions draw at their own offsets and may overlap.
//
// Every fixture below stores the HIGH lane FIRST, so a template that merely
// preserved document order (or that still used `segments.find`) fails here.
// ---------------------------------------------------------------------------

/** Render `templates[name]` with the given segments and return the blocks. */
function renderSegments(name, segments) {
  return captionBlocks(templates[name]({ frame: FRAME, fps: FPS, segments }), name)
}

/** Two simultaneous segments with distinct lanes and distinct geometry. */
function laneFixture(name) {
  const words = NEEDS_WORDS.has(name) ? { words: WORDS } : {}
  return [
    { ...SEG_BASE, id: 'top',    text: 'top',    lane: 1, offsetX: 20, offsetY: -30, scale: 2,   ...words },
    { ...SEG_BASE, id: 'bottom', text: 'bottom', lane: 0, offsetX: -5, offsetY: 4,   scale: 0.5, ...words },
  ]
}

describe('lanes — two simultaneous segments both render, lane-ascending (all 7 templates)', () => {
  for (const name of STYLE_NAMES) {
    test(`${name}: both segments are present, higher lane later in document order`, () => {
      const blocks = renderSegments(name, laneFixture(name))
      assert.equal(blocks.length, 2, `${name}: both active segments must render`)
      assert.deepEqual(
        blocks.map(b => b.props['data-caption-id']),
        ['bottom', 'top'],
        `${name}: lane 0 paints first, lane 1 last (= on top)`,
      )
    })

    test(`${name}: each segment carries its OWN offsetX/offsetY/scale`, () => {
      const [bottom, top] = renderSegments(name, laneFixture(name))
      // Outer wrapper carries the offsets, inner anchor box the scale — the
      // same split Part 1/Part 2 pin for the single-segment case.
      assert.equal(bottom.props.style.transform, 'translate(-5%, 4%)', `${name}: lane 0 offsets`)
      assert.equal(top.props.style.transform,    'translate(20%, -30%)', `${name}: lane 1 offsets`)
      assert.equal(bottom.props.children.props.style.transform, 'scale(0.5)', `${name}: lane 0 scale`)
      assert.equal(top.props.children.props.style.transform,    'scale(2)',   `${name}: lane 1 scale`)
    })

    test(`${name}: a lane-less segment is treated as lane 0 and paints under lane 1`, () => {
      const [top, bottom] = laneFixture(name)
      delete bottom.lane
      assert.deepEqual(
        renderSegments(name, [top, bottom]).map(b => b.props['data-caption-id']),
        ['bottom', 'top'],
      )
    })

    test(`${name}: segments sharing a lane keep document order (stable sort)`, () => {
      const [a, b] = laneFixture(name)
      a.lane = 0
      assert.deepEqual(
        renderSegments(name, [a, b]).map(b2 => b2.props['data-caption-id']),
        ['top', 'bottom'],
        `${name}: same lane -> stored order wins, no reshuffle`,
      )
    })

    test(`${name}: a segment active in another lane but not at this instant is not drawn`, () => {
      const [top, bottom] = laneFixture(name)
      top.start = 20; top.end = 25   // well past FRAME/FPS ≈ 1.333s
      const blocks = renderSegments(name, [top, bottom])
      assert.equal(blocks.length, 1)
      assert.equal(blocks[0].props['data-caption-id'], 'bottom')
    })
  }
})

describe('lanes — data-caption-id marks each block for the preview measurer', () => {
  for (const name of STYLE_NAMES) {
    test(`${name}: the outer wrapper carries the segment's own id`, () => {
      const { outerEl } = renderNoOffset(name, {
        id: 'cap-7',
        ...(NEEDS_WORDS.has(name) ? { words: WORDS } : {}),
      })
      assert.equal(outerEl.props['data-caption-id'], 'cap-7')
    })
  }
})
