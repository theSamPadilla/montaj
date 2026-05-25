// montaj_assets/overlay-runtime/test.js
//
// Contract-symmetry test. The whole reason this package exists is to be a
// single source of truth for "what globals exist inside overlay JSX." This
// test fails fast if anyone in the future adds a global to one context but
// not the other.
//
// Run via `npm test` from the package directory, or directly via `node test.js`.
import assert from 'node:assert/strict'
import { makeOverlayGlobals } from './index.js'

const renderGlobals  = makeOverlayGlobals('render')
const previewGlobals = makeOverlayGlobals('preview')

const renderKeys  = Object.keys(renderGlobals).sort()
const previewKeys = Object.keys(previewGlobals).sort()

assert.deepEqual(
  renderKeys, previewKeys,
  `render and preview contexts must expose the same set of overlay globals.
render:  ${renderKeys.join(', ')}
preview: ${previewKeys.join(', ')}`,
)

// Per-global checks: every name must resolve to a defined value AND to a
// usable shape across contexts. We can't use strict `typeof` equality on
// React components because forwardRef-wrapped components (r3f's Canvas,
// FontAwesomeIcon) are `typeof "object"` while plain function components
// are `typeof "function"`. Both are valid React components. Use
// `isComponentLike` for components and strict `typeof` equality elsewhere.
const COMPONENT_GLOBALS = new Set(['Canvas', 'FaIcon'])

function isComponentLike(v) {
  return typeof v === 'function' || (typeof v === 'object' && v !== null)
}

for (const name of renderKeys) {
  assert.ok(renderGlobals[name]  !== undefined, `render.${name} is undefined`)
  assert.ok(previewGlobals[name] !== undefined, `preview.${name} is undefined`)
  if (COMPONENT_GLOBALS.has(name)) {
    assert.ok(isComponentLike(renderGlobals[name]),  `render.${name} must be component-like (function or forwardRef object)`)
    assert.ok(isComponentLike(previewGlobals[name]), `preview.${name} must be component-like (function or forwardRef object)`)
  } else {
    assert.equal(
      typeof renderGlobals[name],
      typeof previewGlobals[name],
      `typeof mismatch on ${name}: render=${typeof renderGlobals[name]} preview=${typeof previewGlobals[name]}`,
    )
  }
}

// Specific structural checks for the two primitives that have context-aware
// implementations — the most likely drift surface.
assert.equal(typeof renderGlobals.useThreeFrame,  'function', 'render.useThreeFrame must be a hook')
assert.equal(typeof previewGlobals.useThreeFrame, 'function', 'preview.useThreeFrame must be a hook (no-op)')
assert.ok(isComponentLike(renderGlobals.Canvas),  'render.Canvas must be component-like (r3f Canvas is a forwardRef object)')
assert.ok(isComponentLike(previewGlobals.Canvas), 'preview.Canvas must be component-like (preview wrapper is a function component)')

// Sanity — unknown contexts must throw.
assert.throws(() => makeOverlayGlobals('bogus'), /unknown context/)

console.log('overlay-runtime: contract symmetry OK')
console.log(`  globals: ${renderKeys.join(', ')}`)
