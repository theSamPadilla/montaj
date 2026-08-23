// montaj_assets/timeline-core/test/geometry.test.mjs
//
// T4 suite for geometry.js. This is the fidelity contract for the port of the
// shared percent-of-frame formula that shipped IDENTICALLY in FOUR places
// until SP9a-1 retired the duplication on 2026-08-23:
//
//   (1) render (pixels)  — montaj_assets/render/encode-segment.js, THREE copies:
//                          buildImageItemFilterParts, buildVideoItemFilterParts
//                          and buildOverlayFilterParts (the SAME five lines; the
//                          overlay one went unrecorded by every doc until SP9a-1)
//   (2) editor (CSS %)   — montaj_assets/editor/src/video/preview/transformStyle.ts
//                          (videoTransformBoxPct / videoTransformContainerStyle)
//
// Section 1 is this package's headline test: it proves `geometryFor` +
// `toCssBoxPct` + `toPixelBox` reproduce BOTH legacy formulas from ONE shared
// primitive. Per the task, the legacy formulas are INLINED here as the
// reference — this file deliberately does not import transformStyle.ts or
// encode-segment.js, so the numbers are pinned rather than re-derived.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { geometryFor, toCssBoxPct, toPixelBox, isFullFrameCrop, designCanvas } from '../index.js'

/** Float compare. */
function closeTo(actual, expected, message) {
  assert.equal(typeof actual, 'number', `${message}: expected a number, got ${typeof actual}`)
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ~${expected}, got ${actual}`)
}

// ---------------------------------------------------------------------------
// Legacy reference formulas, inlined verbatim (NOT imported — see header).
// ---------------------------------------------------------------------------

/** transformStyle.ts's videoTransformBoxPct, inlined. */
function legacyCssBoxPct(s, ox, oy) {
  return {
    width: s * 100,
    height: s * 100,
    left: ((1 - s) / 2) * 100 + ox,
    top: ((1 - s) / 2) * 100 + oy,
  }
}

/** transformStyle.ts's videoTransformContainerStyle, inlined (the {} early return). */
function legacyContainerStyle(s, ox, oy) {
  if (s === 1 && ox === 0 && oy === 0) return {}
  return { transform: `translate(${ox}%, ${oy}%) scale(${s})`, transformOrigin: 'center center' }
}

/** The five-line pixel formula as it shipped in encode-segment.js BEFORE SP9a-1,
 *  inlined here deliberately so these numbers stay pinned rather than re-derived
 *  from the code under test. All four sites now call `toPixelBox` instead
 *  (encode-segment.js:245/305/457, transformStyle.ts:36). */
function legacyPixelBox(s, ox, oy, vw, vh) {
  return {
    scaledW: Math.round((vw * s) / 2) * 2,
    scaledH: Math.round((vh * s) / 2) * 2,
    xPx: Math.round(vw * (0.5 * (1 - s) + ox / 100)),
    yPx: Math.round(vh * (0.5 * (1 - s) + oy / 100)),
  }
}

// ---------------------------------------------------------------------------
// 1. THE CROSS-CHECK TABLE — the headline requirement.
// ---------------------------------------------------------------------------

const CROSS_CHECK_TABLE = [
  { name: 'identity: s=1, ox=0, oy=0, landscape', s: 1, ox: 0, oy: 0, vw: 1920, vh: 1080 },
  { name: 'fractional scale, mixed-sign offsets, landscape', s: 0.5, ox: 10, oy: -20, vw: 1920, vh: 1080 },
  { name: 'small scale (pip-style), portrait canvas', s: 0.3, ox: 30, oy: 30, vw: 1080, vh: 1920 },
  { name: 'zoom-in scale > 1, negative offsetX, portrait', s: 1.5, ox: -50, oy: 25, vw: 1080, vh: 1920 },
  { name: 'fractional scale, landscape, zero offsets', s: 0.75, ox: 0, oy: 0, vw: 1920, vh: 1080 },
  { name: 'identity at a NON-square, ODD canvas — even-pixel rounding actually rounds', s: 1, ox: 0, oy: 0, vw: 101, vh: 151 },
  { name: 'fractional scale forcing an odd raw pixel width', s: 0.501, ox: 0, oy: 0, vw: 1000, vh: 1000 },
  { name: 'square-ish 4K-scale canvas, small negative offsets', s: 0.9, ox: -3, oy: -7, vw: 3840, vh: 2160 },
]

describe('cross-check: geometryFor -> {toCssBoxPct, toPixelBox} reproduce both legacy formulas', () => {
  for (const { name, s, ox, oy, vw, vh } of CROSS_CHECK_TABLE) {
    test(name, () => {
      // ONE geometryFor call; both adapters derive from its single result.
      const g = geometryFor({ scale: s, offsetX: ox, offsetY: oy }, 'video')
      const cssBox = toCssBoxPct(g)
      const pixelBox = toPixelBox(g, vw, vh)

      const wantCss = legacyCssBoxPct(s, ox, oy)
      const wantPixel = legacyPixelBox(s, ox, oy, vw, vh)

      closeTo(cssBox.width, wantCss.width, `${name}: css width`)
      closeTo(cssBox.height, wantCss.height, `${name}: css height`)
      closeTo(cssBox.left, wantCss.left, `${name}: css left`)
      closeTo(cssBox.top, wantCss.top, `${name}: css top`)

      assert.equal(pixelBox.width, wantPixel.scaledW, `${name}: pixel width`)
      assert.equal(pixelBox.height, wantPixel.scaledH, `${name}: pixel height`)
      assert.equal(pixelBox.x, wantPixel.xPx, `${name}: pixel x`)
      assert.equal(pixelBox.y, wantPixel.yPx, `${name}: pixel y`)

      // The algebraic identity that is the whole point of extracting this
      // module: render's xPx equals round(vw * cssBox.left / 100), and
      // scaledW equals round(vw * cssBox.width / 100) BEFORE the even-pixel
      // rounding is reapplied on top (scaledW = round(vw*s/2)*2, which is
      // round(round(vw*cssBox.width/100)/2)*2 when cssBox.width = s*100 exactly).
      assert.equal(
        Math.round((vw * cssBox.left) / 100),
        pixelBox.x,
        `${name}: xPx == round(vw * cssBox.left / 100)`,
      )
      assert.equal(
        Math.round((vh * cssBox.top) / 100),
        pixelBox.y,
        `${name}: yPx == round(vh * cssBox.top / 100)`,
      )
    })
  }

  test('even-pixel rounding is PINNED to actually diverge from naive Math.round on the odd-canvas row', () => {
    const { s, ox, oy, vw, vh } = CROSS_CHECK_TABLE.find((r) => r.name.includes('even-pixel rounding actually rounds'))
    const g = geometryFor({ scale: s, offsetX: ox, offsetY: oy }, 'image')
    const pixelBox = toPixelBox(g, vw, vh)
    const naiveW = Math.round(vw * s)
    const naiveH = Math.round(vh * s)
    assert.notEqual(pixelBox.width, naiveW, 'scaledW via round(vw*s/2)*2 must differ from the naive Math.round(vw*s)')
    assert.notEqual(pixelBox.height, naiveH, 'scaledH via round(vh*s/2)*2 must differ from the naive Math.round(vh*s)')
    assert.equal(pixelBox.width % 2, 0, 'scaledW is always even')
    assert.equal(pixelBox.height % 2, 0, 'scaledH is always even')
    // Confirms the fixture: vw=101, vw*s=101 (odd) -> naive round is 101 (odd,
    // no-op) but the even-rounded box is 102.
    assert.equal(naiveW, 101)
    assert.equal(pixelBox.width, 102)
  })

  test("transformStyle.ts's early-return-{} identity case behaves consistently with toCssBoxPct's numbers", () => {
    // At s=1, ox=0, oy=0 the legacy CONTAINER-TRANSFORM function short-circuits
    // to {} (no CSS transform needed — the item already fills the frame
    // untransformed). toCssBoxPct has no such short-circuit (it always returns
    // numbers), but its numbers AT THAT INPUT describe exactly the untransformed
    // full-frame box: left=0, top=0, width=100, height=100. The two views of
    // "identity" agree.
    const identity = legacyContainerStyle(1, 0, 0)
    assert.deepEqual(identity, {}, 'legacy short-circuits to no transform at scale=1, offsets=0')

    const g = geometryFor({ scale: 1, offsetX: 0, offsetY: 0 }, 'video')
    const box = toCssBoxPct(g)
    assert.deepEqual(box, { width: 100, height: 100, left: 0, top: 0 }, 'the untransformed full-frame box')

    // And a non-identity input confirms the container function does NOT
    // short-circuit while the box numbers correctly move off (0,0,100,100).
    const nonIdentity = legacyContainerStyle(0.5, 10, 0)
    assert.notDeepEqual(nonIdentity, {})
    const g2 = geometryFor({ scale: 0.5, offsetX: 10, offsetY: 0 }, 'video')
    assert.notDeepEqual(toCssBoxPct(g2), { width: 100, height: 100, left: 0, top: 0 })
  })
})

// ---------------------------------------------------------------------------
// 1b. D9 switchover gate — differential sweep across a wide parameter space.
// This is ADDITIONAL coverage alongside the CROSS_CHECK_TABLE above (which
// stays as-is). The legacy reference below is the exact five lines that
// shipped in encode-segment.js before SP9a-1 swapped the call sites onto
// `toPixelBox`, inlined verbatim so the sweep pins real numbers rather than
// re-deriving them from the code under test.
// ---------------------------------------------------------------------------

// The formula as it shipped in encode-segment.js BEFORE the SP9a-1 switchover,
// inlined verbatim so the sweep pins real numbers rather than re-deriving them
// from the code under test. Those three sites now call `toPixelBox` — see
// encode-segment.js:245 (image), :305 (video), :457 (overlay). This inline copy
// is the INDEPENDENT reference the switchover was proven against; do not
// "simplify" it by importing the shared implementation, or the sweep becomes
// a tautology comparing the shared code against itself.
function legacyPixelBoxInline(item, vw, vh) {
  const s       = item.scale ?? 1
  const scaledW = Math.round(vw * s / 2) * 2
  const scaledH = Math.round(vh * s / 2) * 2
  const xPx     = Math.round(vw * (0.5 * (1 - s) + (item.offsetX ?? 0) / 100))
  const yPx     = Math.round(vh * (0.5 * (1 - s) + (item.offsetY ?? 0) / 100))
  return { x: xPx, y: yPx, width: scaledW, height: scaledH }
}

describe('D9 switchover gate — toPixelBox is byte-identical to the inline formula', () => {
  const SCALES  = [0.1, 0.25, 0.333, 0.5, 0.75, 1, 1.0001, 1.5, 2]
  const OFFSETS = [-50, -33.3, -10, -0.5, 0, 0.5, 10, 33.3, 50]
  const CANVASES = [
    [1080, 1920], [1920, 1080], [2160, 3840], [3840, 2160],
    [101, 151],   // odd both axes — the even-rounding divergence case
    [640, 480], [1440, 1440],
  ]
  const KINDS = ['image', 'video', 'overlay']

  test('every scale x offset x canvas x kind combination agrees exactly', () => {
    let checked = 0
    for (const kind of KINDS) {
      for (const [vw, vh] of CANVASES) {
        for (const scale of SCALES) {
          for (const offsetX of OFFSETS) {
            for (const offsetY of OFFSETS) {
              const item = { scale, offsetX, offsetY }
              const shared = toPixelBox(geometryFor(item, kind), vw, vh)
              const legacy = legacyPixelBoxInline(item, vw, vh)
              assert.deepEqual(
                shared, legacy,
                `MISMATCH kind=${kind} canvas=${vw}x${vh} scale=${scale} ` +
                `offset=(${offsetX},${offsetY})\n  shared=${JSON.stringify(shared)}` +
                `\n  legacy=${JSON.stringify(legacy)}`,
              )
              checked++
            }
          }
        }
      }
    }
    // Guard against a silently-empty sweep: 3 kinds x 7 canvases x 9 scales x 81 offset pairs.
    assert.equal(checked, 3 * 7 * 9 * 9 * 9)
  })

  test('absent scale/offset fields behave as the documented defaults', () => {
    for (const kind of KINDS) {
      assert.deepEqual(
        toPixelBox(geometryFor({}, kind), 1080, 1920),
        legacyPixelBoxInline({}, 1080, 1920),
      )
    }
  })

  test('the editor CSS adapter agrees with its own inline original', () => {
    // transformStyle.ts's videoTransformBoxPct as it shipped before SP9a-1, inlined verbatim.
    const legacyCss = (t) => {
      const s = t.scale ?? 1, ox = t.offsetX ?? 0, oy = t.offsetY ?? 0
      return { width: s * 100, height: s * 100, left: ((1 - s) / 2) * 100 + ox, top: ((1 - s) / 2) * 100 + oy }
    }
    for (const scale of SCALES) {
      for (const offsetX of OFFSETS) {
        for (const offsetY of OFFSETS) {
          const item = { scale, offsetX, offsetY }
          assert.deepEqual(toCssBoxPct(geometryFor(item, 'video')), legacyCss(item))
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 2. fit
// ---------------------------------------------------------------------------

describe('fit: image tri-state, default cover', () => {
  test('default (no fit field) is cover', () => {
    assert.equal(geometryFor({}, 'image').fit, 'cover')
  })

  test('explicit cover / contain / fill pass through', () => {
    assert.equal(geometryFor({ fit: 'cover' }, 'image').fit, 'cover')
    assert.equal(geometryFor({ fit: 'contain' }, 'image').fit, 'contain')
    assert.equal(geometryFor({ fit: 'fill' }, 'image').fit, 'fill')
  })
})

describe('fit: video is ALWAYS contain, even when item.fit says otherwise', () => {
  test('no fit field on a video item -> contain', () => {
    assert.equal(geometryFor({}, 'video').fit, 'contain')
  })

  test("item.fit: 'cover' on a video item is IGNORED -> still contain", () => {
    assert.equal(geometryFor({ fit: 'cover' }, 'video').fit, 'contain')
  })

  test("item.fit: 'fill' on a video item is IGNORED -> still contain", () => {
    assert.equal(geometryFor({ fit: 'fill' }, 'video').fit, 'contain')
  })
})

describe('fit: overlay has NO fit concept (undefined, not fabricated)', () => {
  test('overlay fit is undefined regardless of an item.fit field', () => {
    assert.equal(geometryFor({}, 'overlay').fit, undefined)
    assert.equal(geometryFor({ fit: 'cover' }, 'overlay').fit, undefined, 'an authored fit field is not honoured for overlays')
  })
})

// ---------------------------------------------------------------------------
// 3. sourceCrop — forwarded verbatim, reference semantics, missing-dims, short-circuit
// ---------------------------------------------------------------------------

describe('sourceCrop: forwarded verbatim, by reference', () => {
  test('sourceCrop/sourceWidth/sourceHeight are forwarded unchanged', () => {
    const crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }
    const item = { sourceCrop: crop, sourceWidth: 1920, sourceHeight: 1080 }
    const g = geometryFor(item, 'video')
    assert.deepEqual(g.sourceCrop, crop)
    assert.equal(g.sourceWidth, 1920)
    assert.equal(g.sourceHeight, 1080)
  })

  test('sourceCrop is the SAME OBJECT REFERENCE, not a copy — matching the package-wide "reference, never a copy" policy', () => {
    const crop = { x: 0, y: 0.1, w: 0.8, h: 0.9 }
    const item = { sourceCrop: crop }
    const g = geometryFor(item, 'video')
    assert.equal(g.sourceCrop, crop, 'identity equality, not deep equality')
  })

  test('absent sourceCrop stays absent (undefined), not fabricated as a default crop', () => {
    const g = geometryFor({}, 'video')
    assert.equal(g.sourceCrop, undefined)
    assert.equal(g.sourceWidth, undefined)
    assert.equal(g.sourceHeight, undefined)
  })

  test(
    'registry: KNOWN-DIVERGENCES.md "sourceCrop-missing-dims silent drop" (owner SP3/SP4) — ' +
      'geometryFor forwards sourceCrop even without sourceWidth/sourceHeight; the DROP happens ' +
      'downstream in encode-segment.js buildVideoItemFilterParts:243 (`if (sc && item.sourceWidth && item.sourceHeight)`), not here',
    () => {
      const crop = { x: 0.25, y: 0, w: 0.5, h: 1 }
      const item = { sourceCrop: crop } // no sourceWidth / sourceHeight
      const g = geometryFor(item, 'video')
      // geometryFor is honest: the crop survives even though the render
      // consumer's gate would silently skip it for lack of dims.
      assert.equal(g.sourceCrop, crop, 'geometryFor does not drop sourceCrop for missing dims')
      assert.equal(g.sourceWidth, undefined)
      assert.equal(g.sourceHeight, undefined)
      // Inlined legacy gate — demonstrates the actual drop point is downstream.
      const legacyWouldApplyCrop = !!(g.sourceCrop && g.sourceWidth && g.sourceHeight)
      assert.equal(legacyWouldApplyCrop, false, 'the render-side crop filter gate would silently skip this item')
    },
  )
})

describe('isFullFrameCrop: the (0,0,1,1) short-circuit predicate (sourceCropStyle.ts:35)', () => {
  test('(0,0,1,1) is the full-frame crop', () => {
    assert.equal(isFullFrameCrop({ x: 0, y: 0, w: 1, h: 1 }), true)
  })

  test('any deviation from (0,0,1,1) is NOT full-frame', () => {
    assert.equal(isFullFrameCrop({ x: 0.1, y: 0, w: 1, h: 1 }), false)
    assert.equal(isFullFrameCrop({ x: 0, y: 0.1, w: 1, h: 1 }), false)
    assert.equal(isFullFrameCrop({ x: 0, y: 0, w: 0.9, h: 1 }), false)
    assert.equal(isFullFrameCrop({ x: 0, y: 0, w: 1, h: 0.9 }), false)
  })

  test('null / undefined crop is not full-frame (there is nothing to short-circuit)', () => {
    assert.equal(isFullFrameCrop(null), false)
    assert.equal(isFullFrameCrop(undefined), false)
  })

  test('geometryFor + isFullFrameCrop compose: a full-frame crop forwarded by geometryFor is detected by the helper', () => {
    const item = { sourceCrop: { x: 0, y: 0, w: 1, h: 1 } }
    const g = geometryFor(item, 'video')
    assert.equal(isFullFrameCrop(g.sourceCrop), true)
  })
})

// ---------------------------------------------------------------------------
// 4. rotation — carried, pixel adapter ignores it
// ---------------------------------------------------------------------------

describe('rotation: carried on the geometry, defaults to 0', () => {
  test('absent rotation defaults to 0', () => {
    assert.equal(geometryFor({}, 'overlay').rotation, 0)
  })

  test('an explicit rotation is carried through unchanged', () => {
    assert.equal(geometryFor({ rotation: 37 }, 'overlay').rotation, 37)
    assert.equal(geometryFor({ rotation: -90 }, 'video').rotation, -90)
  })
})

describe(
  'registry: KNOWN-DIVERGENCES.md "rotation" (owner: backlog/SP7) — carried on geometry, ' +
    'the render PIXEL ADAPTER must not consume it (render never reads item.rotation anywhere in encode-segment.js)',
  () => {
    test('toPixelBox output does not change when rotation changes, and has no rotation field at all', () => {
      const base = { scale: 0.5, offsetX: 10, offsetY: -5 }
      const g0 = geometryFor({ ...base, rotation: 0 }, 'overlay')
      const g90 = geometryFor({ ...base, rotation: 90 }, 'overlay')
      const box0 = toPixelBox(g0, 1920, 1080)
      const box90 = toPixelBox(g90, 1920, 1080)
      assert.deepEqual(box0, box90, 'rotation must not affect the pixel box')
      assert.equal('rotation' in box0, false, 'toPixelBox does not even expose a rotation field')
    })

    test('toCssBoxPct also does not consume rotation (it is not a rotation-aware adapter either)', () => {
      const base = { scale: 1, offsetX: 0, offsetY: 0 }
      const g0 = geometryFor({ ...base, rotation: 0 }, 'overlay')
      const g45 = geometryFor({ ...base, rotation: 45 }, 'overlay')
      assert.deepEqual(toCssBoxPct(g0), toCssBoxPct(g45))
    })
  },
)

// ---------------------------------------------------------------------------
// 5. designCanvas
// ---------------------------------------------------------------------------

describe('designCanvas: the 1080-short-edge rule', () => {
  test('[1080, 1920] stays [1080, 1920] (already at target)', () => {
    assert.deepEqual(designCanvas([1080, 1920]), [1080, 1920])
  })

  test('a 4K vertical resolution scales down to the 1080-short-edge design canvas', () => {
    // [2160, 3840]: short edge 2160 -> ratio 1080/2160 = 0.5 -> [1080, 1920]
    assert.deepEqual(designCanvas([2160, 3840]), [1080, 1920])
  })

  test('a landscape resolution scales by its own (height) short edge', () => {
    // [1920, 1080]: short edge 1080 -> ratio 1 -> [1920, 1080]
    assert.deepEqual(designCanvas([1920, 1080]), [1920, 1080])
  })

  test('undefined resolution defaults to [1080, 1920]', () => {
    assert.deepEqual(designCanvas(undefined), [1080, 1920])
  })

  test('null resolution defaults to [1080, 1920]', () => {
    assert.deepEqual(designCanvas(null), [1080, 1920])
  })

  test('even-rounding: an odd-dimension source resolution rounds to even design-canvas pixels', () => {
    // [1081, 1921]: short edge 1081 -> ratio 1080/1081 ~ 0.99907...
    //   w*ratio = 1081 * (1080/1081) = 1080 -> round(1080/2)*2 = 1080
    //   h*ratio = 1921 * (1080/1081) ~ 1919.22 -> round(959.61)*2 = 960*2 = 1920
    const [w, h] = designCanvas([1081, 1921])
    assert.equal(w % 2, 0, 'design canvas width is always even')
    assert.equal(h % 2, 0, 'design canvas height is always even')
    assert.equal(w, 1080)
    assert.equal(h, 1920)
  })

  test('a non-16:9 odd aspect ratio still returns even dimensions', () => {
    const [w, h] = designCanvas([1333, 999])
    assert.equal(w % 2, 0)
    assert.equal(h % 2, 0)
  })
})

describe('designCanvas: editor (design-canvas.ts) agrees with render (render.js:124-130) — confirmed, not assumed', () => {
  /** render.js:124-130, inlined verbatim. */
  function renderDesignCanvas(resolution) {
    const SHORT_EDGE_TARGET = 1080
    const aspectW = resolution?.[0] ?? 1080
    const aspectH = resolution?.[1] ?? 1920
    const aspectRatio = SHORT_EDGE_TARGET / Math.min(aspectW, aspectH)
    return [Math.round((aspectW * aspectRatio) / 2) * 2, Math.round((aspectH * aspectRatio) / 2) * 2]
  }

  const RESOLUTIONS = [
    [1080, 1920],
    [1920, 1080],
    [2160, 3840],
    [3840, 2160],
    [1440, 2560],
    [1081, 1921],
    undefined,
    null,
  ]

  for (const res of RESOLUTIONS) {
    test(`agrees for resolution ${JSON.stringify(res)}`, () => {
      assert.deepEqual(designCanvas(res), renderDesignCanvas(res))
    })
  }
})

// ---------------------------------------------------------------------------
// 6. Purity + totality
// ---------------------------------------------------------------------------

const GEOMETRY_FIXTURES = [
  { item: {}, kind: 'video' },
  { item: {}, kind: 'image' },
  { item: {}, kind: 'overlay' },
  { item: { scale: 0.5, offsetX: 10, offsetY: -20, opacity: 0.8, fit: 'contain' }, kind: 'image' },
  { item: { scale: 2, offsetX: -50, offsetY: 50, rotation: 180 }, kind: 'video' },
  {
    item: { sourceCrop: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, sourceWidth: 1920, sourceHeight: 1080, rotation: 45 },
    kind: 'video',
  },
]

describe('purity', () => {
  test('geometryFor never mutates the input item or its sourceCrop', () => {
    for (const { item, kind } of GEOMETRY_FIXTURES) {
      const before = structuredClone(item)
      geometryFor(item, kind)
      assert.deepEqual(item, before)
    }
  })

  test('geometryFor is deterministic', () => {
    for (const { item, kind } of GEOMETRY_FIXTURES) {
      assert.deepEqual(geometryFor(item, kind), geometryFor(item, kind))
    }
  })

  test('toCssBoxPct / toPixelBox never mutate their geometry input', () => {
    for (const { item, kind } of GEOMETRY_FIXTURES) {
      const g = geometryFor(item, kind)
      const before = structuredClone(g)
      toCssBoxPct(g)
      toPixelBox(g, 1920, 1080)
      assert.deepEqual(g, before)
    }
  })

  test('designCanvas never mutates its input resolution', () => {
    const res = [1920, 1080]
    const before = [...res]
    designCanvas(res)
    assert.deepEqual(res, before)
  })
})

describe('totality', () => {
  test('every numeric field of geometryFor is finite for every fixture', () => {
    for (const { item, kind } of GEOMETRY_FIXTURES) {
      const g = geometryFor(item, kind)
      assert.equal(Number.isFinite(g.scale), true)
      assert.equal(Number.isFinite(g.offsetX), true)
      assert.equal(Number.isFinite(g.offsetY), true)
      assert.equal(Number.isFinite(g.opacity), true)
      assert.equal(Number.isFinite(g.rotation), true)
    }
  })

  test('every numeric field of toCssBoxPct / toPixelBox is finite across a range of canvases', () => {
    const canvases = [
      [1920, 1080],
      [1080, 1920],
      [101, 151],
      [3840, 2160],
    ]
    for (const { item, kind } of GEOMETRY_FIXTURES) {
      const g = geometryFor(item, kind)
      const box = toCssBoxPct(g)
      for (const v of Object.values(box)) assert.equal(Number.isFinite(v), true)
      for (const [vw, vh] of canvases) {
        const pixelBox = toPixelBox(g, vw, vh)
        for (const v of Object.values(pixelBox)) assert.equal(Number.isFinite(v), true)
      }
    }
  })

  test('designCanvas always returns two finite, even, positive numbers', () => {
    const inputs = [undefined, null, [1080, 1920], [1920, 1080], [2160, 3840], [1081, 1921], [1, 1]]
    for (const res of inputs) {
      const [w, h] = designCanvas(res)
      assert.equal(Number.isFinite(w), true)
      assert.equal(Number.isFinite(h), true)
      assert.equal(w % 2, 0)
      assert.equal(h % 2, 0)
      assert.ok(w > 0)
      assert.ok(h > 0)
    }
  })
})
