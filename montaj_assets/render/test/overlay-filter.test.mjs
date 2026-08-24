// render/test/overlay-filter.test.mjs
//
// buildOverlayFilterParts had zero test coverage until SP7. That absence is a
// direct cause of the four-and-a-half-month overlay cadence regression: the
// function emits a filter string, nothing asserted on it, and a container
// timebase change silently broke every animated overlay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOverlayFilterParts } from '../encode-segment.js'
import { geometryFor, toPixelBox, toRotatedPixelBox } from '@bycrux/timeline-core'

const OV = { webmPath: '/tmp/ov.mkv', startSeconds: 0, scale: 1 }
const call = (opts) => buildOverlayFilterParts(OV, 1080, 1920, 1, '[base]', 0, 2, opts)
/** Same harness, but with fields patched onto the overlay descriptor itself. */
const callOv = (ovPatch, opts) =>
  buildOverlayFilterParts({ ...OV, ...ovPatch }, 1080, 1920, 1, '[base]', 0, 2, opts)

test('(a) a stream overlay is pinned to the segment fps grid', () => {
  const { filterParts } = call({ fps: 30 })
  const fmt = filterParts.find(p => p.includes('format='))
  assert.match(fmt, /setpts=N\/\(30\*TB\)/,
    'overlay input must be re-stamped onto the exact frame grid')
})

test('(b) the pin uses the project fps, not a hardcoded 30', () => {
  for (const fps of [24, 60]) {
    const { filterParts } = call({ fps })
    assert.match(filterParts.find(p => p.includes('format=')),
      new RegExp(`setpts=N/\\(${fps}\\*TB\\)`))
  }
})

test('(c) a missing fps throws rather than silently defaulting', () => {
  assert.throws(() => call({}), /fps is required/,
    'a silent 30 would re-break 24 and 60 fps projects exactly as before')
  assert.throws(() => call({ fps: 0 }), /fps is required/)
})

test('(d) looped single-frame PNG inputs are not pinned', () => {
  const { filterParts } = call({
    loopedInput: true, inputFormatFlag: 'rgba', compositeFormatFlag: 'auto',
  })
  assert.doesNotMatch(filterParts.join('\n'), /setpts=/,
    'sample-frame.js feeds stills, which have no cadence to correct')
})

test('(e) the pin does not disturb sizing or positioning', () => {
  const { filterParts } = call({ fps: 30 })
  const s = filterParts.join('\n')
  assert.match(s, /scale=1080:1920/)
  assert.match(s, /overlay=x=0:y=0:/)
})

test('(f) explicit caller formats still win over the defaults', () => {
  const { filterParts } = call({
    loopedInput: true, inputFormatFlag: 'rgba', compositeFormatFlag: 'auto',
  })
  const s = filterParts.join('\n')
  assert.match(s, /format=rgba/)
  assert.match(s, /overlay=[^\n]*format=auto/)
})

// ---------------------------------------------------------------------------
// Rotation (SP9a-2 T2)
//
// timeline-core owns the NUMBERS (toRotatedPixelBox); encode-segment.js owns
// the SYNTAX. As on the image and video paths, the property that matters most
// is the NO-OP — an unrotated overlay must emit exactly what it emitted before
// rotation existed, byte for byte.
// ---------------------------------------------------------------------------

test('(g) rotation absent/0/360 produce byte-identical overlay chains (strict no-op)', () => {
  // 0 and 360 reach the identity by different routes: 0 trivially, 360 only
  // because toRotatedPixelBox normalizes into [0, 360) first.
  const absent = callOv({}, { fps: 30 })
  for (const [label, patch] of [['0', { rotation: 0 }], ['360', { rotation: 360 }]]) {
    const got = callOv(patch, { fps: 30 })
    assert.deepEqual(got.inputArgs, absent.inputArgs, `rotation ${label}: inputArgs must not move`)
    assert.deepEqual(got.filterParts, absent.filterParts, `rotation ${label}: filterParts must not move`)
  }

  const s = absent.filterParts.join('\n')
  assert.doesNotMatch(s, /rotate=/, 'an unrotated overlay must emit no rotate step at all')
  // NOTE: unlike the image and video paths, a blanket "no format=yuva" cannot
  // be asserted here — the overlay path legitimately carries ONE, the input
  // pin that stops VP9 decoders dropping the alpha plane (test (f) above).
  // What the rotation work must not do is add a SECOND: the helper's alpha pin
  // is video-path-only.
  assert.equal(s.match(/format=yuva420p/g).length, 1,
    'rotation must not add an alpha pin to a path that already has one')

  // Deep-equality across the three cases would also be satisfied by three
  // equally WRONG numbers, so pin the placement against the unrotated box:
  // switching the composite to the grown box's top-left must be invisible when
  // there is no growth.
  const { x, y } = toPixelBox(geometryFor(OV, 'overlay'), 1080, 1920)
  assert.ok(s.includes(`overlay=x=${x}:y=${y}:`),
    `an unrotated overlay must still composite at the unrotated top-left (${x}, ${y})`)
})

test('(h) a rotated overlay turns after the design→output scale, at the grown top-left', () => {
  const { filterParts } = callOv({ rotation: 90 }, { fps: 30 })
  const s = filterParts.join('\n')

  // 1080×1920 canvas, scale 1 → a 1080×1920 box at (0, 0). At 90° the bounding
  // box swaps to 1920×1080 and the top-left moves to (-420, 420), preserving
  // the centre: -420 + 1920/2 === 0 + 1080/2 === 540. Numbers read off
  // toRotatedPixelBox, not hand-derived.
  //
  // The scale is what establishes the box rotation turns within, so rotate
  // follows it.
  assert.match(s, /scale=1080:1920,rotate=90\*PI\/180:ow=1920:oh=1080:c=black@0\.0\[ovsc1\]/)
  // overlay accepts NEGATIVE coordinates, and a rotated overlay whose grown box
  // runs past the canvas edge legitimately produces them. Clamping would
  // translate the content instead of turning it in place.
  assert.match(s, /overlay=x=-420:y=420:format=yuv420:shortest=0/)
  assert.doesNotMatch(s, /format=yuva420p,rotate=/,
    'the alpha pin is video-path-only — this input is already yuva420p')
})

test('(i) 180° is not identity: the box does not grow, but the pixels still turn', () => {
  // Easy to mistake for a no-op, because outW/outH and the top-left all come
  // back unchanged. Dropping the rotate step here would export a half-turned
  // overlay the right way up.
  const s = callOv({ rotation: 180 }, { fps: 30 }).filterParts.join('\n')
  assert.match(s, /rotate=180\*PI\/180:ow=1080:oh=1920:c=black@0\.0/)
  assert.match(s, /overlay=x=0:y=0:/, 'a half turn preserves the top-left exactly')
})

test('(j) rotation is normalized, and emitted as degrees rather than a float radian', () => {
  // -90 and 270 are the same turn; toRotatedPixelBox normalizes into [0, 360)
  // so the emitted string cannot carry a negative angle. Degrees keep the
  // authored value legible in filter strings, render logs and goldens —
  // ffmpeg evaluates `270*PI/180` to the identical double.
  for (const rotation of [-90, 270]) {
    const s = callOv({ rotation }, { fps: 30 }).filterParts.join('\n')
    assert.match(s, /rotate=270\*PI\/180:ow=1920:oh=1080:/,
      `rotation ${rotation} must normalize to 270`)
    assert.doesNotMatch(s, /rotate=-/, 'a negative angle must never reach the filter string')
  }
})

test('(k) not rotated: the overlay grown box IS the unrotated box (x === xPx, y === yPx)', () => {
  // The counterpart of the image and video tests in encode-segment.test.mjs.
  // Test (g) proves absent/0/360 agree with each other; this proves what they
  // agree ON is the unrotated placement — which is the only reason moving the
  // composite onto the grown box's top-left is free for every overlay that
  // carries no rotation.
  for (const [label, patch] of [['absent', {}], ['0', { rotation: 0 }], ['360', { rotation: 360 }]]) {
    const ov = { ...OV, ...patch }
    const box = toRotatedPixelBox(geometryFor(ov, 'overlay'), 1080, 1920)
    assert.ok(box.isIdentity, `rotation ${label}: must be the identity box`)
    assert.equal(box.x, box.xPx, `rotation ${label}: grown-box x must equal the unrotated x`)
    assert.equal(box.y, box.yPx, `rotation ${label}: grown-box y must equal the unrotated y`)

    const s = callOv(patch, { fps: 30 }).filterParts.join('\n')
    assert.ok(s.includes(`overlay=x=${box.xPx}:y=${box.yPx}:`),
      `rotation ${label}: the composite must spend the unrotated top-left`)
  }
})
