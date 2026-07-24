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
import { spring } from './helpers.js'

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

// Recharts globals are exposed for both render and preview contexts.
// Some Recharts components are forwardRef-wrapped (typeof 'object'); use
// isComponentLike() consistent with the Canvas/FaIcon checks above.
const requiredChartGlobals = [
  'BarChart', 'Bar',
  'LineChart', 'Line',
  'PieChart', 'Pie',
  'Cell',
  'XAxis', 'YAxis',
  'CartesianGrid',
  'Tooltip', 'Legend',
  'ResponsiveContainer',
]
for (const name of requiredChartGlobals) {
  assert.ok(isComponentLike(renderGlobals[name]),  `render context: missing ${name}`)
  assert.ok(isComponentLike(previewGlobals[name]), `preview context: missing ${name}`)
}

console.log('overlay-runtime: contract symmetry OK')
console.log(`  globals: ${renderKeys.join(', ')}`)

// spring() parity — the memoized implementation must be bit-identical to the
// original O(frame) Euler-integration loop it replaced.
// Reference implementation: the original O(frame) loop, for parity checks.
function springReference({ frame, fps, mass = 1, stiffness = 100, damping = 10, initialVelocity = 0 }) {
  const dt = 1 / fps
  let x = 0, v = initialVelocity
  for (let f = 0; f < frame; f++) {
    const force = -stiffness * (x - 1) - damping * v
    v += (force / mass) * dt
    x += v * dt
  }
  return x
}

const springCases = [0, 1, 7, 30, 7, 300, 2.5, 299]
for (const params of [{ fps: 30 }, { fps: 60, stiffness: 220, damping: 16 }]) {
  for (const frame of springCases) {
    const got = spring({ frame, ...params })
    const want = springReference({ frame, ...params })
    assert.ok(Object.is(got, want), `spring(${frame}, ${JSON.stringify(params)}): ${got} !== ${want}`)
  }
}

// Perf sanity: after one priming call, repeated calls at a large frame are
// memoized (O(1)). Timing ONLY the repeats isolates the amortized property:
// unmemoized, each repeat would re-integrate ~500k Euler steps and blow far
// past the (deliberately generous) budget; memoized, they are array lookups.
{
  const params = { frame: 500_000, fps: 30 }
  spring(params) // prime: the single O(frame) integration
  const want = springReference(params)
  const start = process.hrtime.bigint()
  let got
  for (let i = 0; i < 2000; i++) got = spring(params)
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
  assert.ok(Object.is(got, want), `spring(500_000): ${got} !== ${want}`)
  assert.ok(elapsedMs < 100, `spring() not amortizing repeated calls: ${elapsedMs}ms for 2000 memoized calls`)
}

console.log('overlay-runtime: spring() parity OK')
