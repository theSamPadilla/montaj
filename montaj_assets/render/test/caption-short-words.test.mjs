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
