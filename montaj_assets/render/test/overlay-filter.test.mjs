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

// ---------------------------------------------------------------------------
// Keyframed overlays (SP9b T2.3)
//
// An animated overlay's geometry is baked into its CAPTURE, per frame, by the
// Puppeteer shim (bundle.js `generateShim`) — because this filter graph places
// an overlay ONCE for a whole segment and has no per-frame hook to animate
// through. So the composite's whole job for a keyframed overlay is to NOT
// position it: drop the design-canvas frame onto the output canvas untouched.
//
// The failure this guards is double application: geometry in the pixels AND in
// the filter graph, which quarter-sizes a half-scaled animated overlay and
// double-turns a rotated one.
// ---------------------------------------------------------------------------

const TRACKS = [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 2, value: 40 }] }]

test('(l) a keyframed overlay composites full-canvas at the origin', () => {
  const s = callOv({ keyframes: TRACKS, offsetX: 30, offsetY: -20, scale: 0.4 }, { fps: 30 })
    .filterParts.join('\n')
  assert.match(s, /scale=1080:1920/,
    'the capture already carries the scale — the composite must not apply it again')
  assert.match(s, /overlay=x=0:y=0:/,
    'the capture already carries the offsets — the composite must not apply them again')
  assert.doesNotMatch(s, /overlay=x=(?!0:y=0:)/)
})

test('(m) rotation is NOT re-applied to a keyframed overlay', () => {
  // The subtle one. `rotation` is still on the descriptor (render.js stamps it
  // for every overlay), and it is legitimately non-zero — the shim baked it. A
  // `rotate=` step here would turn the pixels a SECOND time, and unlike the
  // scale/offset cases the result is not merely misplaced but visibly smeared,
  // since rotate resamples.
  for (const rotation of [90, 180, 270, -45]) {
    const s = callOv({ keyframes: TRACKS, rotation }, { fps: 30 }).filterParts.join('\n')
    assert.doesNotMatch(s, /rotate=/, `rotation ${rotation}: already baked, must not turn again`)
    assert.match(s, /scale=1080:1920\[ovsc1\]/, `rotation ${rotation}: scale step must stay bare`)
    assert.match(s, /overlay=x=0:y=0:/, `rotation ${rotation}: and composite at the origin`)
  }
})

test('(n) a keyframed overlay is indistinguishable from an identity static one', () => {
  // Not a restatement of (l): this pins WHAT the keyframed branch agrees with.
  // Its output must be exactly the graph a plain, unpositioned overlay
  // produces — which is what makes "the capture IS the canvas" true rather
  // than just plausible.
  const identity = callOv({}, { fps: 30 })
  const keyframed = callOv(
    { keyframes: TRACKS, offsetX: 30, offsetY: -20, scale: 0.4, rotation: 90 }, { fps: 30 })
  assert.deepEqual(keyframed.filterParts, identity.filterParts)
  assert.deepEqual(keyframed.inputArgs, identity.inputArgs)
})

test('(o) the even-pixel rounding still applies on an odd output canvas', () => {
  // The keyframed target is spelled as the IDENTITY GEOMETRY, not as a literal
  // `scale=${vw}:${vh}`, precisely so it inherits `round(vw/2)*2`. yuva420
  // encoders reject odd dimensions, so a 1081-wide output must still land on an
  // even scale target — 1082, the nearest even, exactly as the static path at
  // scale 1 already lands there. Being one pixel over the canvas is the
  // pre-existing convention on every path here, not a keyframe-specific choice.
  const kf = buildOverlayFilterParts(
    { ...OV, keyframes: TRACKS }, 1081, 1921, 1, '[base]', 0, 2, { fps: 30 })
  const s = kf.filterParts.join('\n')
  assert.match(s, /scale=1082:1922/, 'odd canvas dims must round to even, as every other path does')
  assert.match(s, /overlay=x=0:y=0:/)

  // And it lands on the SAME even numbers the static scale-1 path does.
  const staticIdentity = buildOverlayFilterParts(OV, 1081, 1921, 1, '[base]', 0, 2, { fps: 30 })
  assert.deepEqual(kf.filterParts, staticIdentity.filterParts)
})

test('(p) an EMPTY keyframes array takes the ordinary static path', () => {
  // The editor can leave `keyframes: []` behind after the last key is deleted.
  // Such an item animates nothing, so nothing was baked, and treating it as
  // baked would drop its position on the floor. Same rule the shim applies.
  const s = callOv({ keyframes: [], offsetX: 25, scale: 0.5 }, { fps: 30 }).filterParts.join('\n')
  const noKf = callOv({ offsetX: 25, scale: 0.5 }, { fps: 30 }).filterParts.join('\n')
  assert.equal(s, noKf, 'an empty track list is not an animation')
  assert.match(s, /scale=540:960/)
  assert.doesNotMatch(s, /overlay=x=0:y=0:/)
})

test('(q) STATIC overlays are byte-identical to the pre-keyframes filter graph', () => {
  // The hard acceptance criterion for T2.3. These are the exact strings this
  // function emitted before the keyframed branch existed, transcribed by hand
  // rather than captured from a re-run — a golden regenerated from today's code
  // would pass no matter what the branch did to the static path.
  const { inputArgs, filterParts, newVideoLabel } = callOv({ offsetX: 10, scale: 0.5 }, { fps: 30 })
  assert.deepEqual(inputArgs, ['-ss', '0', '-t', '2', '-i', '/tmp/ov.mkv'])
  assert.deepEqual(filterParts, [
    '[1:v]format=yuva420p,setpts=N/(30*TB)[ovfmt1]',
    '[ovfmt1]scale=540:960[ovsc1]',
    '[base][ovsc1]overlay=x=378:y=480:format=yuv420:shortest=0[vov1]',
  ])
  assert.equal(newVideoLabel, '[vov1]')
})

// ---------------------------------------------------------------------------
// Item-level opacity (SP9b, decided mid-task)
//
// A pre-existing gap, unrelated to keyframes: images applied item opacity, videos
// applied item opacity, overlays applied nothing — so a translucent overlay looked
// translucent in the editor preview and exported fully opaque. It was missing at
// BOTH ends (no filter term here, and render.js never stamped `opacity` onto the
// descriptor), which is why nothing caught it.
//
// The epsilon guard is what keeps this safe to land: opacity 1 and opacity absent
// must emit NOTHING, so every project that does not set overlay opacity keeps a
// byte-identical filter graph.
// ---------------------------------------------------------------------------

test('(r) opacity absent or 1 emits no opacity step at all', () => {
  const absent = callOv({}, { fps: 30 })
  for (const [label, patch] of [['1', { opacity: 1 }], ['0.9999', { opacity: 0.9999 }]]) {
    const got = callOv(patch, { fps: 30 })
    assert.deepEqual(got.filterParts, absent.filterParts,
      `opacity ${label}: must be a strict no-op — this is what keeps the goldens valid`)
    assert.deepEqual(got.inputArgs, absent.inputArgs)
  }
  assert.doesNotMatch(absent.filterParts.join('\n'), /colorchannelmixer/)
})

test('(s) a translucent overlay gets colorchannelmixer, between geometry and composite', () => {
  const { filterParts } = callOv({ opacity: 0.5 }, { fps: 30 })
  // Position in the chain matters as much as presence: it must consume the
  // SCALED/rotated label and hand its own label to the composite, exactly as the
  // image and video paths sequence it.
  assert.deepEqual(filterParts, [
    '[1:v]format=yuva420p,setpts=N/(30*TB)[ovfmt1]',
    '[ovfmt1]scale=1080:1920[ovsc1]',
    '[ovsc1]colorchannelmixer=aa=0.5[ovop1]',
    '[base][ovop1]overlay=x=0:y=0:format=yuv420:shortest=0[vov1]',
  ])
})

test('(t) opacity 0 is a real value, not a falsy no-op', () => {
  // `?? 1` in the guard, never `|| 1` — a fully transparent overlay is a
  // legitimate authored state (and the end state of every fade-out).
  const s = callOv({ opacity: 0 }, { fps: 30 }).filterParts.join('\n')
  assert.match(s, /colorchannelmixer=aa=0\[ovop1\]/)
})

test('(u) opacity composes with rotation without disturbing either', () => {
  const s = callOv({ opacity: 0.25, rotation: 90 }, { fps: 30 }).filterParts.join('\n')
  assert.match(s, /scale=1080:1920,rotate=90\*PI\/180:ow=1920:oh=1080:c=black@0\.0\[ovsc1\]/)
  assert.match(s, /\[ovsc1\]colorchannelmixer=aa=0\.25\[ovop1\]/,
    'opacity follows the geometry chain, so it multiplies the already-turned frame')
  assert.match(s, /\[base\]\[ovop1\]overlay=x=-420:y=420:/)
})

test('(v) a KEYFRAMED overlay never gets colorchannelmixer — opacity is baked', () => {
  // The mutual-exclusion pin. The shim applied opacity as CSS on the transform
  // layer, so a second multiply here would SQUARE it: 0.5 would export at 0.25.
  for (const opacity of [0.5, 0, 0.25]) {
    const s = callOv({ keyframes: TRACKS, opacity }, { fps: 30 }).filterParts.join('\n')
    assert.doesNotMatch(s, /colorchannelmixer/,
      `opacity ${opacity}: already in the pixels — applying it again would square it`)
  }
  // And the whole chain still collapses to the identity graph, opacity included.
  assert.deepEqual(
    callOv({ keyframes: TRACKS, opacity: 0.5, scale: 0.4, rotation: 90 }, { fps: 30 }).filterParts,
    callOv({}, { fps: 30 }).filterParts)
})

test('(w) an overlay with an EMPTY keyframes array still gets its opacity applied', () => {
  // The empty-array case is static everywhere else, so it must be static here
  // too — nothing was baked, so the compositor owns the opacity.
  const s = callOv({ keyframes: [], opacity: 0.5 }, { fps: 30 }).filterParts.join('\n')
  assert.match(s, /colorchannelmixer=aa=0\.5/)
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
