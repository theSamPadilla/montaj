// render/test/overlay-transform-parity.test.mjs
//
// SP9b T4.1 — the headline parity claim, at the ENGINE seam rather than the
// ADAPTER seam. timeline-core/test/geometry.test.mjs already cross-checks
// `toCssBoxPct` against `toRotatedPixelBox` at several `localT`s (the ADAPTER
// seam: one `geometryAt` result, two different consumers of ITS OUTPUT — see
// that file's "geometryAt: PARITY" describe block, which this file does not
// repeat). What is NOT covered anywhere else:
//
//   1. The editor PREVIEW and the Puppeteer RENDER build the same CSS
//      transform STRING from a `geometryAt` result — not just geometrically
//      equivalent numbers, the literal string two different files each emit.
//   2. The two engines sample `geometryAt` at the same WALL-CLOCK instant —
//      frame n of the render's capture must correspond to the preview's
//      `currentTime` at `item.start + n/fps`, modulo the one documented,
//      deliberate nuance: render.js quantizes an overlay's `start` to the
//      frame grid before frame 0 of its capture, so the two clocks can differ
//      by up to half a frame. This file asserts that bound, not merely that
//      the clocks "roughly agree".
//
// A keyframe-less overlay's end-to-end identity (geometryAt == geometryFor,
// un-baked shim, byte-identical filter graph) is already fully pinned in three
// places — geometry.test.mjs's "NO-KEYFRAME IDENTITY" describe block,
// shim-bake.test.mjs tests (a)/(b)/(c)/(i), and overlay-filter.test.mjs tests
// (p)/(q) — so it is deliberately not restated here.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { geometryAt } from '@bycrux/timeline-core'
import { generateShim } from '../bundle.js'
import { collectPuppeteerSegments } from '../render.js'

// ---------------------------------------------------------------------------
// 1. Transform string parity
//
// The PREVIEW side below is hand-mirrored from OverlayItemsLayer.tsx's own
// wrapper style (~:517-521, the interactive-tracks branch that samples
// `geometryAt` for overlays). Mirroring rather than importing the component is
// deliberate: pulling a .tsx React component into this package's plain
// node:test runner would need jsdom/React wired into a suite that has
// neither. OverlayItemsLayer's own suite
// (editor/src/video/preview/__tests__/OverlayItemsLayer.keyframes.test.tsx)
// already proves the REAL component renders this exact template into the DOM.
//
// What that suite does NOT prove — and this one does — is that the RENDER
// side matches it, because the render side here is executed for real:
// `generateShim`'s actual output is sliced out and run with `Function`, not
// hand-copied a second time. So of the two template literals this test
// compares, only one is a transcription (cited above); the other is
// production code running unmodified. A drift in bundle.js's template breaks
// this test directly; a drift in the preview's real template would surface as
// this test's transcription going stale against OverlayItemsLayer's own DOM
// assertions, which is the best a single suite can do without crossing the
// node:test/vitest boundary.
// ---------------------------------------------------------------------------

// PARITY-CRITICAL, KEEP IN SYNC WITH OverlayItemsLayer.tsx's `wrapperStyle`
// (interactive-tracks branch, ~:516-521 — that file carries a matching
// comment pointing back here). This file cannot see a drift in the REAL
// component (it hand-transcribes rather than importing React/.tsx into a
// plain node:test runner — see the file header above); the editor's own
// OverlayItemsLayer.keyframes.test.tsx pins this SAME literal template
// against what the real component renders, so a drift there is what catches
// a change here that this file's transcription missed.
//
// NOTE ON THE TWO-ARGUMENT `scale(sx, sy)`: it is emitted UNCONDITIONALLY on
// both sides, uniform items included. `scale(2)` and `scale(2, 2)` are
// CSS-equivalent but NOT string-equal, and this suite compares strings — so a
// `sx === sy → scale(s)` shortcut on either side would fail every legacy
// uniform overlay here while changing nothing about the rendered pixels.
/** OverlayItemsLayer.tsx ~:517-521, verbatim. */
function previewStyle(g) {
  return {
    transform: `translate(${g.offsetX}%, ${g.offsetY}%) rotate(${g.rotation}deg) scale(${g.scaleX}, ${g.scaleY})`,
    transformOrigin: 'center center',
    opacity: g.opacity,
  }
}

/**
 * Slice the `__bakeItem`/`__bakeStyle` declarations out of a generated shim
 * and execute them for real, with the SAME `geometryAt` this file imports —
 * so the render side of the comparison is the actual generated source, not a
 * second hand copy of the formula.
 */
function renderBakeStyleFn(shimSource) {
  const start = shimSource.indexOf('const __bakeItem')
  const end = shimSource.indexOf('let __setFrame')
  assert.ok(start >= 0 && end > start, 'shim must carry a bake block — call this only for baked shims')
  const code = shimSource.slice(start, end)
  const factory = new Function('geometryAt', `${code}\nreturn __bakeStyle`)
  return factory(geometryAt)
}

describe('T4.1: preview transform string == render bake transform string, for the same geometryAt result', () => {
  const FPS = 30
  // All five props animated, with a mix of easings including `hold` (step-end)
  // — not just the linear middle every prop shares in shim-bake.test.mjs's
  // simpler TRACKS fixture.
  const ITEM = {
    offsetX: -3, offsetY: 8, scale: 1, rotation: 0, opacity: 1,
    keyframes: [
      { prop: 'offsetX', points: [{ t: 0, value: -20, easing: 'ease-in-out' }, { t: 2, value: 20 }] },
      { prop: 'offsetY', points: [{ t: 0, value: 10 }, { t: 1, value: -30, easing: 'ease-out' }, { t: 2, value: 5 }] },
      { prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 2, value: 1.5, easing: 'ease-in' }] },
      { prop: 'rotation', points: [{ t: 0, value: -45 }, { t: 2, value: 90 }] },
      { prop: 'opacity', points: [{ t: 0, value: 0, easing: 'hold' }, { t: 1, value: 1 }, { t: 2, value: 0.4 }] },
    ],
  }
  const shim = generateShim('/abs/overlay.jsx', {}, FPS, 60, {
    offsetX: ITEM.offsetX, offsetY: ITEM.offsetY, scale: ITEM.scale,
    rotation: ITEM.rotation, opacity: ITEM.opacity, keyframes: ITEM.keyframes,
  })
  const bakeStyle = renderBakeStyleFn(shim)

  // Frames, not seconds: `localT = frame / FPS` is computed identically on
  // both sides of every assertion below (once here, once inside the executed
  // `__bakeStyle`), so the two `geometryAt` calls always receive bit-identical
  // arguments — no float round-trip through a chosen-then-reconstructed
  // `localT` to introduce spurious last-digit string drift. The set covers
  // both endpoints, either side of the opacity hold's jump at t=1 (frames 29
  // and 30), and ordinary eased midpoints.
  for (const frame of [0, 9, 29, 30, 45, 59, 60]) {
    test(`frame=${frame} (localT=${frame / FPS})`, () => {
      const localT = frame / FPS
      const g = geometryAt(ITEM, 'overlay', localT)
      const want = previewStyle(g)
      const got = bakeStyle(frame)

      assert.equal(got.transform, want.transform, `frame=${frame}: transform string`)
      assert.equal(got.transformOrigin, want.transformOrigin, `frame=${frame}: transformOrigin`)
      assert.equal(got.opacity, want.opacity, `frame=${frame}: opacity`)
    })
  }

  test('the item actually animates, so equal strings above cannot be two frozen sides', () => {
    const t0 = bakeStyle(0)
    const t60 = bakeStyle(60)
    assert.notEqual(t0.transform, t60.transform)
    assert.notEqual(t0.opacity, t60.opacity)
  })

  test('the opacity hold really does jump exactly between frame 29 and frame 30', () => {
    // A property test on the fixture itself: if this stopped being true the
    // frame set above would silently stop exercising the hold-adjacent case
    // the comment above claims it does.
    assert.equal(bakeStyle(29).opacity, 0)
    assert.equal(bakeStyle(30).opacity, 1)
  })
})

// ---------------------------------------------------------------------------
// 1b. Transform string parity — NON-UNIFORM scale
//
// The block above animates the legacy uniform `scale`, where `scaleX` and
// `scaleY` resolve to the SAME number every frame — so a one-argument
// `scale(s)` on both sides would have satisfied it. This block is what
// actually pins the per-axis half: the two axes differ at every instant, so a
// shim (or a preview transcription) that still read `g.scale` would print one
// number where two are needed and fail immediately.
//
// The string-equality assertions cannot, on their own, catch BOTH sides
// regressing together — they compare one transcription against one generated
// source. The literal-shape assertion below is the guard for that case: it
// pins the emitted text itself, not just the agreement between the two.
// ---------------------------------------------------------------------------

describe('T5: preview transform string == render bake transform string, for a NON-UNIFORM item', () => {
  const FPS = 30
  const FRAMES = [0, 9, 29, 30, 45, 59, 60]
  // Deliberately carries NO uniform `scale` key: this item was authored
  // per-axis, which is exactly the shape the `?? scale ?? 1` fallback chain
  // must not quietly flatten back to a square box.
  const ITEM = {
    offsetX: 4, offsetY: -6, scaleX: 1.8, scaleY: 0.4, rotation: 15, opacity: 1,
    // Different curves AND different endpoints per axis, so neither track is a
    // copy of the other and the two never coincide.
    keyframes: [
      { prop: 'scaleX', points: [{ t: 0, value: 0.25, easing: 'ease-in' }, { t: 2, value: 2 }] },
      { prop: 'scaleY', points: [{ t: 0, value: 1.75 }, { t: 1, value: 0.6, easing: 'ease-out' }, { t: 2, value: 1.1 }] },
      { prop: 'offsetX', points: [{ t: 0, value: -10 }, { t: 2, value: 10 }] },
    ],
  }
  // Exactly the object bundleComponent now builds for this item: the uniform
  // fallback AND both axes. `scale` stays in the bake because `geometryAt`
  // resolves an axis as `<track> ?? item.scaleX ?? <resolved scale>` — the
  // uniform value is still the last link of that chain.
  const shim = generateShim('/abs/overlay.jsx', {}, FPS, 60, {
    offsetX: ITEM.offsetX, offsetY: ITEM.offsetY,
    scale: ITEM.scale ?? 1, scaleX: ITEM.scaleX, scaleY: ITEM.scaleY,
    rotation: ITEM.rotation, opacity: ITEM.opacity, keyframes: ITEM.keyframes,
  })
  const bakeStyle = renderBakeStyleFn(shim)

  for (const frame of FRAMES) {
    test(`frame=${frame} (localT=${frame / FPS})`, () => {
      const g = geometryAt(ITEM, 'overlay', frame / FPS)
      const want = previewStyle(g)
      const got = bakeStyle(frame)

      assert.equal(got.transform, want.transform, `frame=${frame}: transform string`)
      assert.equal(got.transformOrigin, want.transformOrigin, `frame=${frame}: transformOrigin`)
      assert.equal(got.opacity, want.opacity, `frame=${frame}: opacity`)
    })
  }

  test('the fixture is genuinely non-uniform at every frame asserted above', () => {
    // Without this, a fixture that drifted into uniformity would leave the
    // whole block passing for the wrong reason — it would be testing the
    // uniform case a second time.
    for (const frame of FRAMES) {
      const g = geometryAt(ITEM, 'overlay', frame / FPS)
      assert.notEqual(g.scaleX, g.scaleY, `frame=${frame}: axes must differ`)
    }
  })

  test('the emitted text is a two-argument scale carrying both axes', () => {
    // Frame 0 sits exactly on both scale tracks' first point, so the expected
    // numbers are the authored ones — no float formatting to reason about.
    assert.match(bakeStyle(0).transform, /\bscale\(0\.25, 1\.75\)$/)
    assert.match(bakeStyle(0).transform, /^translate\(-10%, -6%\) rotate\(15deg\) /)
  })

  test('a legacy uniform item emits the TWO-argument form too, never scale(s)', () => {
    // The back-compat half of the string contract: the preview emits
    // `scale(sx, sy)` unconditionally, so the shim must as well. An
    // `sx === sy → scale(s)` shortcut here would be CSS-equivalent and would
    // still break parity for every overlay authored before per-axis scale.
    const uniform = {
      scale: 0.5,
      keyframes: [{ prop: 'opacity', points: [{ t: 0, value: 0 }, { t: 1, value: 1 }] }],
    }
    const uniformStyle = renderBakeStyleFn(generateShim('/abs/overlay.jsx', {}, FPS, 30, {
      offsetX: 0, offsetY: 0, scale: 0.5, scaleX: 0.5, scaleY: 0.5,
      rotation: 0, opacity: 1, keyframes: uniform.keyframes,
    }))(0)

    assert.match(uniformStyle.transform, /\bscale\(0\.5, 0\.5\)$/)
    assert.equal(uniformStyle.transform, previewStyle(geometryAt(uniform, 'overlay', 0)).transform)
  })
})

// ---------------------------------------------------------------------------
// 2. Clock parity
//
// render.js quantizes an overlay's `start`/`end` to the frame grid
// (`collectPuppeteerSegments`, ~render.js:742) so the overlay's segment
// boundaries agree with segment-plan.js's own quantization — pre-existing and
// deliberate (see the comment at that call site). That means the render's
// frame 0 is `quantize(item.start)`, not `item.start` itself, while the
// preview's clock (`currentTime - item.start`, OverlayItemsLayer.tsx) uses the
// UNQUANTIZED start. The two clocks therefore agree only up to the
// quantization error — never worse than half a frame, because
// `quantize(t) = round(t*fps)/fps` and rounding to the nearest grid point
// can never be off by more than half a grid step: `|quantize(t) - t| <= 1/(2*fps)`.
// ---------------------------------------------------------------------------

describe('T4.1: render clock vs preview clock agree up to the documented half-frame quantization bound', () => {
  const CASES = [
    { fps: 30, start: 5.4474 },
    { fps: 30, start: 0 },
    { fps: 24, start: 1.01 / 24 },
    { fps: 60, start: 12.3333 },
    { fps: 25, start: 100.001 },
  ]

  for (const { fps, start } of CASES) {
    test(`fps=${fps} start=${start}`, () => {
      const project = {
        tracks: [[], [{ id: 'ov1', type: 'overlay', src: '/abs/o.jsx', start, end: start + 2 }]],
        settings: { fps },
      }
      const [spec] = collectPuppeteerSegments(project, fps, 1080, 1920, '/tmp/seg')
      const halfFrame = 1 / (2 * fps)
      // Float slop only — negligible next to halfFrame at every fps tested here.
      const eps = 1e-9

      assert.ok(
        Math.abs(spec.startSeconds - start) <= halfFrame + eps,
        `quantize(${start}) = ${spec.startSeconds} must land within ${halfFrame}s of the authored start`,
      )

      // The clock-agreement claim itself: reconstruct the wall-clock instant
      // frame n's capture represents — spec.startSeconds + n/fps, the render's
      // own arithmetic (collectPuppeteerSegments' quantized start plus the
      // shim's `f / fps`, bundle.js's __bakeStyle) — and ask what localT the
      // PREVIEW would compute for that SAME wall-clock instant using the
      // unquantized `start`. The render's own localT for that frame is n/fps.
      for (const n of [0, 1, 13, 47]) {
        const wallClockInstant = spec.startSeconds + n / fps
        const localTRender = n / fps
        const localTPreview = wallClockInstant - start
        assert.ok(
          Math.abs(localTPreview - localTRender) <= halfFrame + eps,
          `fps=${fps} start=${start} n=${n}: render/preview clocks disagree by more than half a frame`,
        )
      }
    })
  }
})
