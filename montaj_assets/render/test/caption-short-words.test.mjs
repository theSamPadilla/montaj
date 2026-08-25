// montaj_assets/render/test/caption-short-words.test.mjs
//
// Short caption words must actually be visible on the frames they occupy.
//
// The per-word templates (`word-by-word`, `pop`) fade each word in over a
// 2-frame envelope. While that envelope started at opacity 0, a word that
// occupied only one frame was rendered at opacity 0 on its single frame and
// then replaced — present in the element tree, invisible in the output. It
// read to a viewer as a skipped word.
//
// Measured on real projects on 2026-08-23: ~1 caption word in 20 lasts under
// two frames on a word-by-word project (robotics-ban 14/287, ai-safety 15/278,
// token-savings 11/305). The five segment-level templates fade the whole
// segment rather than each word, so they were never affected and are not
// covered here.
//
// This file pins the floor. It does NOT cover sub-one-frame words: a word
// shorter than a frame interval can fail to contain any frame's timestamp at
// all, so no opacity curve can rescue it — that is a transcription-time
// minimum-duration problem, tracked separately.

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import * as esbuild from 'esbuild'

const __dirname           = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR       = join(__dirname, '..', 'templates', 'captions')
const OVERLAY_RUNTIME_DIR = join(__dirname, '..', '..', 'overlay-runtime')

/** The same shim the caption-position suite uses. Note it pulls the REAL
 *  `interpolate`/`spring` out of overlay-runtime rather than stubbing them —
 *  the opacity curve is what is under test here, so a stubbed interpolate
 *  would test nothing. */
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
  const tmpPath = join(__dirname, `__tmp-shortword-${name}.mjs`)
  writeFileSync(tmpPath, result.outputFiles[0].text)
  try {
    return (await import(pathToFileURL(tmpPath).href)).default
  } finally {
    unlinkSync(tmpPath)
  }
}

const PER_WORD = ['word-by-word', 'pop']
const templates = {}
before(async () => {
  for (const name of PER_WORD) templates[name] = await loadTemplate(name)
})

const FPS = 30
/** A word that starts exactly on a frame boundary and lasts one frame. */
const ONE_FRAME = 1 / FPS

/** Find the deepest style object carrying an `opacity`, i.e. the word span. */
function wordOpacity(el) {
  let found
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    const style = node.props?.style
    if (style && typeof style.opacity === 'number') found = style.opacity
    const kids = node.props?.children
    if (Array.isArray(kids)) kids.forEach(walk)
    else if (kids) walk(kids)
  }
  walk(el)
  return found
}

/** Render `name` at the frame on which `wordIndex` is the active word. */
function opacityOnWordsFirstFrame(name, words, wordIndex) {
  const seg = {
    start: 0,
    end: words[words.length - 1].end + 1,
    text: words.map(w => w.word).join(' '),
    words,
  }
  const frame = Math.round(words[wordIndex].start * FPS)
  const el = templates[name]({ frame, fps: FPS, segments: [seg] })
  assert.ok(el, `${name}: expected an element at frame ${frame}`)
  const op = wordOpacity(el)
  assert.equal(typeof op, 'number', `${name}: no opacity found in the element tree`)
  return op
}

describe('per-word caption templates — short words are visible', () => {
  // A one-frame word gets exactly one frame on screen, at wordFrame 0. With a
  // zero-start envelope that frame renders at opacity 0 and the word is simply
  // never seen. This is the regression the floor exists to prevent.
  for (const name of PER_WORD) {
    test(`${name}: a one-frame word is visible on its only frame`, () => {
      const words = [
        { word: 'the', start: 0,            end: 0.5 },
        { word: 'a',   start: 0.5,          end: 0.5 + ONE_FRAME },  // one frame
        { word: 'cat', start: 0.5 + ONE_FRAME, end: 1.5 },
      ]
      const op = opacityOnWordsFirstFrame(name, words, 1)
      assert.ok(
        op >= 0.5,
        `${name}: one-frame word rendered at opacity ${op}; it gets no second ` +
        `frame, so anything near 0 means the word never appears on screen`,
      )
    })
  }

  // Two-frame words were already partly visible (50% on their second frame)
  // but still opened at 0. The floor should lift their first frame too.
  for (const name of PER_WORD) {
    test(`${name}: a two-frame word is visible on its first frame`, () => {
      const words = [
        { word: 'the', start: 0,   end: 0.5 },
        { word: 'a',   start: 0.5, end: 0.5 + 2 * ONE_FRAME },
        { word: 'cat', start: 0.5 + 2 * ONE_FRAME, end: 1.5 },
      ]
      assert.ok(opacityOnWordsFirstFrame(name, words, 1) >= 0.5)
    })
  }

  // The floor must not break the top of the curve: a word with room to breathe
  // still reaches full opacity, so ordinary captions are unchanged past frame 2.
  for (const name of PER_WORD) {
    test(`${name}: a long word still reaches full opacity`, () => {
      const words = [{ word: 'hello', start: 0, end: 1 }]
      const seg = { start: 0, end: 2, text: 'hello', words }
      const el = templates[name]({ frame: 10, fps: FPS, segments: [seg] })
      assert.equal(wordOpacity(el), 1)
    })
  }
})

// ---------------------------------------------------------------------------
// Single-segment guard for the multi-lane conversion.
//
// The templates now draw EVERY active caption (lanes), which meant replacing
// each one's `segments.find(...)` with a filter + lane sort and moving the
// per-segment body into a helper. Nothing above this line changed — but the
// assertions above are deliberately INEQUALITIES (`>= 0.5`), so they would
// still pass if the move had quietly perturbed the envelope. These pin the
// EXACT numbers a single-segment project produces, and the exact block count,
// so the conversion is provably a no-op for every project that exists today
// (no project can have overlapping captions until rows are reachable in the
// UI).
// ---------------------------------------------------------------------------

/** The per-segment blocks a template returned — one outer <div> per active segment. */
function captionBlocks(el) {
  const kids = el.props.children
  return Array.isArray(kids) ? kids : [kids]
}

describe('per-word caption templates — the multi-lane conversion is a no-op for one segment', () => {
  // interpolate(wordFrame, [0, 2], [0.55, 1]) at wordFrame 0, 1, 2. A 30-frame
  // word, so `pop`'s exit fade (the last 6 frames) cannot reach these and both
  // templates are showing the entry envelope alone.
  const ENTRY_ENVELOPE = [0.55, 0.775, 1]
  const LONG_WORD = [{ word: 'hello', start: 0, end: 1 }]
  const LONG_SEG  = { start: 0, end: 2, text: 'hello', words: LONG_WORD }

  for (const name of PER_WORD) {
    test(`${name}: one active segment renders exactly one block`, () => {
      const blocks = captionBlocks(templates[name]({ frame: 10, fps: FPS, segments: [LONG_SEG] }))
      assert.equal(blocks.length, 1)
      assert.equal(blocks[0].type, 'div', 'the block is still the template\'s own outer wrapper')
    })

    test(`${name}: the entry envelope is exactly 0.55 -> 0.775 -> 1 over its first three frames`, () => {
      ENTRY_ENVELOPE.forEach((expected, wordFrame) => {
        const el = templates[name]({ frame: wordFrame, fps: FPS, segments: [LONG_SEG] })
        assert.equal(
          wordOpacity(el), expected,
          `${name}: wordFrame ${wordFrame} — the floor is 0.55, NOT 0`,
        )
      })
    })
  }

  // `pop` alone carries a second guard: its exit fade is wrapped in
  // `wordDuration > 6`, because `interpolate` returns the END of its output
  // range on a degenerate input range — without the wrapper a short word
  // renders already faded OUT at 0.3. A 5-frame word is comfortably inside the
  // guard (the exact 6-frame boundary is not asserted: `(end - start) * fps`
  // lands within a float epsilon of 6 for a 6-frame word, so a test sitting on
  // it would pin rounding, not behaviour).
  test('pop: a 5-frame word never enters the exit fade — it holds full opacity to its last frame', () => {
    const words = [
      { word: 'a',   start: 30 / FPS, end: 35 / FPS },   // 5 frames
      { word: 'cat', start: 35 / FPS, end: 60 / FPS },
    ]
    const seg = { start: 0, end: 3, text: 'a cat', words }
    for (const frame of [32, 33, 34]) {          // wordFrame 2..4, past the entry envelope
      const el = templates.pop({ frame, fps: FPS, segments: [seg] })
      assert.equal(
        wordOpacity(el), 1,
        `pop: frame ${frame} — a short word must not be pre-faded to 0.3`,
      )
    }
  })

  test('pop: a long word DOES still fade out over its last 6 frames (the guard is not inverted)', () => {
    // 30-frame word: the fade runs from wordFrame 24 to 30, ending at 0.3.
    const el = templates.pop({ frame: 30, fps: FPS, segments: [LONG_SEG] })
    assert.equal(wordOpacity(el), undefined, 'sanity: frame 30 is past this word, nothing rendered')
    assert.ok(wordOpacity(templates.pop({ frame: 27, fps: FPS, segments: [LONG_SEG] })) < 1)
    assert.ok(wordOpacity(templates.pop({ frame: 20, fps: FPS, segments: [LONG_SEG] })) === 1)
  })
})

// ---------------------------------------------------------------------------
// The word-duration floor's render-side consequence.
//
// steps/lyrics/caption.py's `floor_word_durations` (25 unit tests in
// tests/steps/test_caption.py) proves the TIMING algebra: a sub-floor word
// either gets its shared boundary donated forward to 50ms, or -- when the
// donation would starve its successor -- is left completely unchanged. That
// suite is Python and never touches a template. What it does NOT prove is
// the thing this file exists for: that a word the floor rescues to 50ms
// actually lands on a drawn frame at 30fps, and that a word the floor
// deliberately refuses to rescue is the one that still doesn't. These three
// blocks are that render-side proof; they hardcode `floor_word_durations`'s
// OUTPUT as fixture input (never call the Python function from JS) and
// cross-reference the exact Python test whose numbers they reuse, so nobody
// mistakes this for redundant coverage of the timing algebra itself.
// ---------------------------------------------------------------------------

/** The word text drawn on the same span that carries the opacity -- both
 *  templates render `{activeWord.word}` as that span's only child. Mirrors
 *  wordOpacity's walk so the two agree on which node is "the word". */
function activeWordText(el) {
  let found
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    const style = node.props?.style
    if (style && typeof style.opacity === 'number') found = node.props.children
    const kids = node.props?.children
    if (Array.isArray(kids)) kids.forEach(walk)
    else if (kids) walk(kids)
  }
  walk(el)
  return found
}

describe('per-word caption templates — a floor-rescued word renders at 30fps', () => {
  // Exactly tests/steps/test_caption.py::test_floor_donation_accepted's input
  // and output: floor_word_durations([_w(0, 0.02), _w(0.02, 0.40)], 0.05)
  // donates the shared boundary forward because the successor keeps 0.35s,
  // comfortably over the 0.05s floor. This is that call's OUTPUT, hardcoded
  // as fixture input -- the Python suite proves the transformation, this
  // proves the rendered consequence.
  const RESCUED_WORDS = [
    { word: 'a',   start: 0,    end: 0.05 },
    { word: 'cat', start: 0.05, end: 0.40 },
  ]
  const RESCUED_SEG = { start: 0, end: 1.4, text: 'a cat', words: RESCUED_WORDS }

  for (const name of PER_WORD) {
    test(`${name}: the rescued word is the active, visibly-opaque word on frame 0`, () => {
      // [0, 0.05) spans t=0 (frame 0) and t=0.0333 (frame 1) at 30fps -- frame
      // 0 is enough to prove "at least one frame", so that's what is pinned.
      const el = templates[name]({ frame: 0, fps: FPS, segments: [RESCUED_SEG] })
      assert.equal(activeWordText(el), 'a', `${name}: frame 0 should show the rescued word 'a'`)
      const op = wordOpacity(el)
      assert.ok(
        op >= 0.5,
        `${name}: rescued word rendered at opacity ${op} on a frame inside its floored span`,
      )
    })
  }
})

describe('per-word caption templates — a fully-starved run is left unchanged, by design, and the render cost of that is honest', () => {
  // Exactly tests/steps/test_caption.py::test_floor_starved_run_entirely_unchanged's
  // input: floor_word_durations([_w(0,0.02), _w(0.02,0.04), _w(0.04,0.06), _w(0.06,0.11)], 0.05)
  // returns these four words byte-for-byte identical -- every donation in the
  // run is refused (each successor would drop below the floor), and the
  // fourth word is already AT the floor so the "short" branch never fires for
  // it. This is NOT the floor failing to do its job: the donation-gate
  // contract is that a refused donation confers no immunity, and a run where
  // every boundary refuses comes back exactly as it went in. What follows
  // documents what "unchanged" costs at 30fps -- it must NOT be read as a
  // rescue that fell short.
  const STARVED_WORDS = [
    { word: 'one',   start: 0,    end: 0.02 },
    { word: 'two',   start: 0.02, end: 0.04 },
    { word: 'three', start: 0.04, end: 0.06 },
    { word: 'four',  start: 0.06, end: 0.11 },
  ]
  const STARVED_SEG = { start: 0, end: 1.11, text: 'one two three four', words: STARVED_WORDS }

  for (const name of PER_WORD) {
    test(`${name}: 'three', the one starved word with no 30fps frame timestamp inside it, never draws`, () => {
      const seen = new Set()
      for (let frame = 0; frame <= 4; frame++) {
        const text = activeWordText(templates[name]({ frame, fps: FPS, segments: [STARVED_SEG] }))
        if (text != null) seen.add(text)
      }
      // 'three' spans [0.04, 0.06); no integer frame at 30fps (t = 0, 0.0333,
      // 0.0667, 0.1, 0.1333, ...) falls inside that half-open interval, and
      // the floor left it exactly there BY DESIGN (donation refused on both
      // sides) -- this must NOT be asserted as something the floor rescues.
      assert.ok(!seen.has('three'),
        `${name}: 'three' must never be the active word -- it is sub-frame and the floor ` +
        `deliberately did not touch it`)
      // Sanity: the harness itself isn't just rendering nothing -- its
      // starved neighbours 'one', 'two', and 'four' DO land on a frame each,
      // which is what makes 'three' the one real exception, not an artifact
      // of an empty loop.
      assert.ok([...seen].sort().join() === ['four', 'one', 'two'].join(),
        `${name}: expected exactly one/two/four to render across frames 0-4, got ${[...seen]}`)
    })
  }
})

describe('per-word caption templates — an already-floor-clean stream renders exactly as before the floor existed', () => {
  // Analogous to tests/steps/test_caption.py::test_floor_already_long_words_untouched:
  // every word here is already comfortably above the 50ms floor, so
  // floor_word_durations is a no-op on it (the `dur >= floor_s: continue`
  // fast path). Nothing in the render path calls the floor at all -- this
  // pins the render-side half of "no-op": a normal stream shows each word in
  // turn, once, in order, none dropped, none overlapping, exactly as it did
  // before the floor was ever added.
  const CLEAN_WORDS = [
    { word: 'the',   start: 0,   end: 0.3 },
    { word: 'quick', start: 0.3, end: 0.6 },
    { word: 'fox',   start: 0.6, end: 0.9 },
  ]
  const CLEAN_SEG = { start: 0, end: 1.9, text: 'the quick fox', words: CLEAN_WORDS }

  for (const name of PER_WORD) {
    test(`${name}: each word in an ordinary stream renders once, in order`, () => {
      const seenOrder = []
      for (let frame = 0; frame <= 26; frame++) {
        const text = activeWordText(templates[name]({ frame, fps: FPS, segments: [CLEAN_SEG] }))
        if (text != null && seenOrder[seenOrder.length - 1] !== text) seenOrder.push(text)
      }
      assert.deepEqual(seenOrder, ['the', 'quick', 'fox'],
        `${name}: expected each word to appear once, in order, with none skipped or repeated out of order`)
    })
  }
})
