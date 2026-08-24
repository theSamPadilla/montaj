// render/test/rotation.integration.test.mjs
//
// The guard for the SP9a-2 rotation-DIRECTION regression. Every other test in
// this feature (geometry.test.mjs, encode-segment.test.mjs, the encode-args
// goldens) asserts filter STRINGS: `rotate=90*PI/180:ow=320:oh=180:...`. A
// sign flip — ffmpeg's rotate direction backwards from what
// toRotatedPixelBox/rotateFilterStep intend — produces a PERFECTLY PLAUSIBLE
// string. Every string test would still pass and every rotated export would
// come out mirrored. This file is the only thing that actually decodes
// pixels and checks which one is white.
//
// Method: run the item's REAL filter chain (buildImageItemFilterParts, the
// same function encode-segment.js calls in production) through real ffmpeg,
// then probe individual output pixels with
// `format=gray,crop=1:1:x:y:exact=1,signalstats` and read the printed stat
// (`metadata=mode=print:file=-`, stdout) rather than writing any rendered
// video/image file to disk. The only file this test writes is the tiny
// half-white/half-blue PNG fed in as the item's source image — an INPUT
// fixture, not a probed output.
//
// The scene (empirically confirmed against ffmpeg 8.1.2 — see geometry.js's
// rotation section for the formula this pins):
//   - canvas 360×640
//   - item 180×320 (scale=0.5 on a 360×640 canvas), left half white / right
//     half blue so orientation is unambiguous
//   - rotation=90 (degrees, clockwise-positive — same sense as CSS)
//   - expected box: outW=320, outH=180, x=20, y=230 → box centre (180,320)
//     is exactly the canvas centre (360/2, 640/2)
//
// Verified empirically (see the T4 handoff) that flipping ONLY the filter's
// sign (rotate=-90 instead of +90, leaving box.x/box.y/outW/outH untouched —
// exactly what a sign-flip bug would produce, since cos/sin enter outW/outH
// as absolute values) swaps every orientation probe below. That is the whole
// reason this file exists instead of one more string assertion.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildImageItemFilterParts } from '../encode-segment.js'

const FFMPEG = process.env.MONTAJ_FFMPEG || 'ffmpeg'

function haveTools() {
  return spawnSync(FFMPEG, ['-version']).status === 0
}

// ── the verified scene ───────────────────────────────────────────────────
const CANVAS_W = 360
const CANVAS_H = 640
const ITEM_GEOMETRY = { scale: 0.5, rotation: 90 } // src is filled in per-run with the tmp fixture

// Canvas background: solid green. Chosen (not black, which production
// actually uses) so a probe OUTSIDE the rotated box is unambiguously
// distinguishable from both item colors under BT.601/BT.709 gray conversion
// — measured Y≈149, vs. white≈253 and blue≈29, comfortable margins either
// direction. The item's own colors, not the canvas color, are what this test
// is actually about.
const BG_LAVFI_COLOR = '0x00FF00'
const WHITE_MIN = 200 // white measures ~253
const BLUE_MAX = 60 // blue measures ~29
const BG_LO = 120 // green background measures ~149
const BG_HI = 180

/** Build the 180×320 half-white (left) / half-blue (right) source fixture. */
function makeHalfWhiteHalfBluePng(dir) {
  const out = join(dir, 'half-white-half-blue.png')
  const r = spawnSync(FFMPEG, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=white:size=90x320',
    '-f', 'lavfi', '-i', 'color=blue:size=90x320',
    '-filter_complex', '[0:v][1:v]hstack=inputs=2,format=rgba[out]',
    '-map', '[out]', '-frames:v', '1', out,
  ], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`fixture PNG build failed:\n${r.stderr}`)
  return out
}

/**
 * Sample one output pixel's grayscale luma (0-255) after compositing
 * `srcPng` onto a CANVAS_W×CANVAS_H canvas through the REAL production
 * filter chain (buildImageItemFilterParts — the same code path
 * encode-segment.js uses for every image item, rotation included).
 *
 * Writes no output file: the probe is appended directly onto the same
 * filter graph and read via `metadata=mode=print:file=-`, which prints the
 * signalstats frame metadata to ffmpeg's own stdout instead of a media file.
 *
 * @param {object} [geometry] — defaults to the module's verified 90° scene;
 *   pass a different geometry (e.g. rotation: 45) to probe another scene.
 */
function probeY(srcPng, x, y, geometry = ITEM_GEOMETRY) {
  const { inputArgs, filterParts, newVideoLabel } =
    buildImageItemFilterParts({ ...geometry, src: srcPng }, CANVAS_W, CANVAS_H, 1, '[canvas]', 1)

  const filterComplex = [
    '[0:v]format=rgba[canvas]',
    ...filterParts,
    `${newVideoLabel}format=gray,crop=1:1:${x}:${y}:exact=1,signalstats,metadata=mode=print:file=-`,
  ].join(';')

  const args = [
    '-y', '-v', 'info',
    '-f', 'lavfi', '-i', `color=${BG_LAVFI_COLOR}:size=${CANVAS_W}x${CANVAS_H}`,
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-frames:v', '1',
    '-f', 'null', '-',
  ]
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffmpeg probe failed at (${x},${y}):\n${r.stderr}`)
  const m = /lavfi\.signalstats\.YAVG=(\d+)/.exec(r.stdout)
  if (!m) throw new Error(`no YAVG printed for probe at (${x},${y}):\n${r.stdout}\n${r.stderr}`)
  return Number(m[1])
}

test('rotation=90 composites clockwise (CSS/ffmpeg semantics) at the geometry-predicted canvas position', { timeout: 60_000 }, (t) => {
  if (!haveTools()) { t.skip('ffmpeg not available'); return }

  const dir = mkdtempSync(join(tmpdir(), 'montaj-rotation-'))
  try {
    const srcPng = makeHalfWhiteHalfBluePng(dir)

    // ── orientation probes — discriminate a sign flip ──────────────────────
    // The rotated box occupies canvas x∈[20,340), y∈[230,410). Clockwise-90
    // carries the item's LEFT edge (white) to the TOP of the rotated box
    // (y∈[230,320)) and the RIGHT edge (blue) to the BOTTOM (y∈[320,410)) —
    // physically: rotating a card clockwise swings its left edge up to
    // become the top edge. A counterclockwise (-90, i.e. sign-flipped) bug
    // would swap top and bottom while leaving outW/outH/x/y (and therefore
    // every filter-string assertion) completely unchanged — verified by
    // running this exact scene with the sign flipped: all four values below
    // invert. Sampled near BOTH the left and right edges of the box (not
    // just its centre column) so a transpose-shaped bug, not just a mirrored
    // one, would also be caught.
    const topLeft = probeY(srcPng, 40, 250)
    const topRight = probeY(srcPng, 320, 250)
    const bottomLeft = probeY(srcPng, 40, 390)
    const bottomRight = probeY(srcPng, 320, 390)

    assert.ok(topLeft >= WHITE_MIN,
      `top of the rotated box should be white (clockwise-90 carries the item's left/white half to the top), got Y=${topLeft}`)
    assert.ok(topRight >= WHITE_MIN,
      `top of the rotated box should be white across its full width, got Y=${topRight}`)
    assert.ok(bottomLeft <= BLUE_MAX,
      `bottom of the rotated box should be blue (item's right/blue half), got Y=${bottomLeft}`)
    assert.ok(bottomRight <= BLUE_MAX,
      `bottom of the rotated box should be blue across its full width, got Y=${bottomRight}`)

    // ── boundary probes — confirm the box centre sits at the canvas centre ─
    // Each point sits a few px OUTSIDE one of the box's four edges
    // (x=20/340, y=230/410) and must read as background. Passing on all four
    // pins the box at exactly x=20,y=230,outW=320,outH=180 — and since that
    // box is symmetric (20+320+20=360, 230+180+230=640), its centre
    // (180,320) is necessarily the canvas centre. This is what a
    // mistranslated (but correctly-oriented) rotated frame would fail —
    // orientation alone doesn't prove placement.
    const outsideLeft = probeY(srcPng, 15, 320)
    const outsideRight = probeY(srcPng, 345, 320)
    const outsideTop = probeY(srcPng, 180, 225)
    const outsideBottom = probeY(srcPng, 180, 415)

    for (const [edge, v] of [
      ['left', outsideLeft], ['right', outsideRight],
      ['top', outsideTop], ['bottom', outsideBottom],
    ]) {
      assert.ok(v >= BG_LO && v <= BG_HI,
        `just outside the box's ${edge} edge should still be canvas background, got Y=${v} ` +
        `(box expected at x=20,y=230,outW=320,outH=180)`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rotation=45 (grown box ≠ rotated content): a corner outside the rotated rectangle reads canvas background, not the black fill colour', { timeout: 60_000 }, (t) => {
  if (!haveTools()) { t.skip('ffmpeg not available'); return }

  // At 90° the grown (axis-aligned) box happens to exactly equal the rotated
  // rectangle (outW=320, outH=180 — the same item, just with width/height
  // swapped), so `c=black@0.0` is never composited: every pixel in the box is
  // covered by the rotated item. 45° is where the two genuinely diverge — the
  // grown box (outW=outH=354, x=3, y=143) is a square that circumscribes the
  // rotated rectangle, leaving four triangular corners the item never
  // reaches. Those corners are exactly what the fill colour exists for.
  const dir = mkdtempSync(join(tmpdir(), 'montaj-rotation45-'))
  try {
    const srcPng = makeHalfWhiteHalfBluePng(dir)
    const geometry45 = { scale: 0.5, rotation: 45 }

    // Probe near the grown box's top-left corner (3,143) — 27px in on both
    // axes, comfortably clear of both the box edge and the rotated
    // rectangle's own boundary (which, along this exact diagonal from the
    // shared centre (180,320), only reaches 90px out).
    const corner = probeY(srcPng, 30, 170, geometry45)
    assert.ok(corner >= BG_LO && corner <= BG_HI,
      `a grown-box corner the rotated rectangle never covers should show canvas background ` +
      `through the transparent fill, got Y=${corner}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
