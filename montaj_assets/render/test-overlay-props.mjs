// Test for the per-overlay `window.props` mechanism in slide.jsx.
//
// Validates that when a slide hosts multiple overlay elements, each
// overlay component reads its OWN merged props from `window.props` at
// render time — i.e. the OverlayHost wrapper correctly isolates per-overlay
// global state through React's depth-first synchronous render.
//
// Run from this dir:  node test-overlay-props.mjs
// Exits non-zero on failure.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { transformSync } from 'esbuild'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// 1. Transform slide.jsx with classic JSX runtime so it uses React.createElement
//    (no `import { jsx } from 'react/jsx-runtime'` injection — keeps the test
//    self-contained against the local React install in node_modules).
const slideSrc = readFileSync(join(__dirname, 'templates', 'slide.jsx'), 'utf8')
const { code: slideJs } = transformSync(slideSrc, {
  loader: 'jsx',
  format: 'esm',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
})
// Inject the React import at the top — esbuild's classic transform expects
// `React` to be in scope but doesn't add the import.
const slideModuleSrc = `import React from 'react'\n${slideJs}`

// 2. Write the transformed module next to slide.jsx so its node_modules
//    resolves the `react` bare specifier. Clean up on exit.
const tmpPath = join(__dirname, '__test-slide-transformed.mjs')
writeFileSync(tmpPath, slideModuleSrc)

let exitCode = 0
try {
  const { Slide } = await import(pathToFileURL(tmpPath).href)

  // 3. Set up a window-shim so OverlayHost's global writes land somewhere.
  const win = {}
  globalThis.window = win

  // 4. Mock overlay components that capture `window.props` at render time.
  //    These mimic the bare-`props` pattern used by real overlay JSX.
  const captures = []
  function FaqMock(propsArg) {
    captures.push({
      name: 'faq',
      fromArg: propsArg.captureKey,
      fromGlobal: globalThis.window.props?.captureKey,
      fromGlobalFull: { ...globalThis.window.props },
    })
    return null
  }
  function HookMock(propsArg) {
    captures.push({
      name: 'hook',
      fromArg: propsArg.captureKey,
      fromGlobal: globalThis.window.props?.captureKey,
      fromGlobalFull: { ...globalThis.window.props },
    })
    return null
  }

  // 5. Build a slide with TWO overlay elements pointing at different templates.
  const slide = {
    id: 'test-slide',
    base_color: '#000000',
    elements: [
      {
        id: 'overlay-1',
        type: 'overlay',
        overlay: {
          template: '/tpl/faq.jsx',
          props: { captureKey: 'overlay-1-props', question: 'Q1', answer: 'A1' },
        },
        frame: 0,
        x: 0, y: 0, w: 1080, h: 540, rotation: 0,
      },
      {
        id: 'overlay-2',
        type: 'overlay',
        overlay: {
          template: '/tpl/hook.jsx',
          props: { captureKey: 'overlay-2-props', text: 'Hook text', eyebrow: 'EB' },
        },
        frame: 0,
        x: 0, y: 540, w: 1080, h: 540, rotation: 0,
      },
    ],
  }

  const overlayRegistry = {
    '/tpl/faq.jsx': FaqMock,
    '/tpl/hook.jsx': HookMock,
  }

  // 6. Render the slide with react-dom/server (synchronous SSR).
  const React = require('react')
  const { renderToString } = require('react-dom/server')

  renderToString(
    React.createElement(Slide, {
      slide,
      width: 1080,
      height: 1080,
      overlayRegistry,
      resolveAsset: (p) => p,
    }),
  )

  // 7. Assertions.
  const failures = []
  function assert(cond, msg) { if (!cond) failures.push(msg) }

  assert(captures.length === 2, `expected 2 overlay renders, got ${captures.length}`)

  if (captures.length >= 2) {
    const [c1, c2] = captures

    assert(c1.name === 'faq', `first capture should be FAQ, got ${c1.name}`)
    assert(c1.fromArg === 'overlay-1-props', `FAQ React arg wrong: ${c1.fromArg}`)
    assert(c1.fromGlobal === 'overlay-1-props',
      `FAQ window.props wrong (saw "${c1.fromGlobal}", expected "overlay-1-props") — ` +
      `this is the bug the fix targets`,
    )
    assert(c1.fromGlobalFull.question === 'Q1',
      `FAQ window.props missing question="Q1": ${JSON.stringify(c1.fromGlobalFull)}`,
    )

    assert(c2.name === 'hook', `second capture should be Hook, got ${c2.name}`)
    assert(c2.fromArg === 'overlay-2-props', `Hook React arg wrong: ${c2.fromArg}`)
    assert(c2.fromGlobal === 'overlay-2-props',
      `Hook window.props wrong (saw "${c2.fromGlobal}", expected "overlay-2-props") — ` +
      `OverlayHost did not isolate the global between siblings`,
    )
    assert(c2.fromGlobalFull.text === 'Hook text',
      `Hook window.props missing text="Hook text": ${JSON.stringify(c2.fromGlobalFull)}`,
    )
  }

  if (failures.length > 0) {
    console.error('FAIL — per-overlay window.props isolation broken:')
    for (const f of failures) console.error('  •', f)
    console.error('\nCaptures:')
    console.error(JSON.stringify(captures, null, 2))
    exitCode = 1
  } else {
    console.log('PASS — both overlays read their own props from window.props.')
    console.log('Captures:', JSON.stringify(captures, null, 2))
  }
} finally {
  try { unlinkSync(tmpPath) } catch {}
  process.exit(exitCode)
}
