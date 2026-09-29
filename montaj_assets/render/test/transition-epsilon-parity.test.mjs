// render/test/transition-epsilon-parity.test.mjs
/**
 * PREVIEW / EXPORT PARITY for "is this overlap a crossfade?".
 *
 * Every consumer gets its pairs from `@bycrux/timeline-core`'s
 * `transitionPairs`, which treats an overlap of `TRANSITION_EPSILON_S` or less
 * as two items that merely touch. This file runs ONE fixture per overlap size
 * through every path that decides a crossfade and requires them all to flip at
 * that same threshold:
 *
 *   - preview:  `resolveAt`'s `crossfade` stamp, which the editor's engine
 *               scheduler, the legacy `OverlayItemsLayer` and sample_frame read;
 *   - export:   `collectAllItems`'s clip `crossfade` span (what
 *               encode-segment.js blends) and `collectPuppeteerSegments`'
 *               `transitionTo` flag on an opaque incoming overlay.
 *
 * A path that grew its own overlap test, or its own epsilon, disagrees with the
 * others at EPS/2 or 2*EPS and fails here. The editor-side consumers
 * (`engineRequiredReason`, `computeVisualCrossfade`) are pinned to the same
 * constant in the editor's vitest suite.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAt, TRANSITION_EPSILON_S } from '@bycrux/timeline-core'
import { collectAllItems, collectPuppeteerSegments } from '../render.js'

/** `from` ends at `fromEnd`, `to` starts at `toStart`; the overlap is the difference. */
const CASES = [
  // The operator's project, verbatim: a 3.6e-15 s float-noise "overlap".
  { name: 'float noise (30.355900000000002 vs 30.3559)', fromEnd: 30.355900000000002, toStart: 30.3559, crossfade: false },
  { name: 'half the epsilon',  fromEnd: 30 + TRANSITION_EPSILON_S / 2, toStart: 30, crossfade: false },
  { name: 'exactly touching',  fromEnd: 30, toStart: 30, crossfade: false },
  { name: 'twice the epsilon', fromEnd: 30 + TRANSITION_EPSILON_S * 2, toStart: 30, crossfade: true },
  { name: 'a real 0.5 s overlap', fromEnd: 30.5, toStart: 30, crossfade: true },
]

function clipProject(c) {
  return {
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [[
      { id: 'from', type: 'video', src: '/a.mp4', start: 20, end: c.fromEnd, inPoint: 0, outPoint: c.fromEnd - 20 },
      { id: 'to',   type: 'video', src: '/b.mp4', start: c.toStart, end: 40, inPoint: 0, outPoint: 40 - c.toStart },
    ]],
  }
}

function overlayProject(c) {
  return {
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [
      [],
      [
        { id: 'from', type: 'overlay', src: '/a.jsx', start: 20, end: c.fromEnd, opaque: true },
        { id: 'to',   type: 'overlay', src: '/b.jsx', start: c.toStart, end: 40, opaque: true },
      ],
    ],
  }
}

for (const c of CASES) {
  test(`${c.name}: preview and export agree it is ${c.crossfade ? '' : 'NOT '}a crossfade`, () => {
    const project = clipProject(c)

    // Preview: the resolver's stamp at `to.start`, the first instant of the
    // overlap (half-open, so it is inside any overlap there is), or the cut.
    const t = c.toStart
    const scene = resolveAt(project, t, { variant: 'preview' })
    const previewSaysCrossfade = scene.items.some((r) => r.crossfade != null)

    // Export: the span collectAllItems stamps for encode-segment.js.
    const { videoItems } = collectAllItems(project)
    const exportSaysCrossfade = videoItems.some((it) => it.crossfade != null)

    // Export, overlay side: the opaque incoming overlay's alpha-capture flag.
    const specs = collectPuppeteerSegments(overlayProject(c), 30, 1080, 1920, '/nonexistent/seg')
    const overlaySaysCrossfade = specs.some((s) => s.transitionTo === true)

    assert.deepEqual(
      { preview: previewSaysCrossfade, exportClips: exportSaysCrossfade, exportOverlays: overlaySaysCrossfade },
      { preview: c.crossfade, exportClips: c.crossfade, exportOverlays: c.crossfade },
    )
  })
}

test('the float-noise fixture really overlaps, so the parity above is not vacuous', () => {
  assert.ok(30.355900000000002 > 30.3559)
})
