import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { compileTrackExpr, sampleTrack } from '../index.js'
import { evalExpr } from './helpers/eval-expr.mjs'

/**
 * Cross-check the test-side evaluator against the REAL ffmpeg binary.
 *
 * `test/helpers/eval-expr.mjs` is an independent interpreter, not a mirror of
 * the compiler — but an evaluator that only ever agrees with itself proves
 * nothing about what ffmpeg will actually do with the string we hand it. These
 * tests run compiled expressions through ffmpeg and assert the numbers match.
 *
 * Skips cleanly when no ffmpeg is on PATH so a CI box without one stays green.
 */

function ffmpegVersion() {
  try {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\n')[0].trim()
  } catch {
    return null
  }
}

const VERSION = ffmpegVersion()
const skip = VERSION ? false : 'ffmpeg not on PATH'

/**
 * `geq` names its time variable `T`, not `t`. The substitution is mechanical
 * and only touches the standalone identifier — `between` keeps its letters.
 */
function toGeq(expr) {
  return expr.replace(/(^|[^A-Za-z_0-9])t(?![A-Za-z_0-9])/g, '$1T')
}

/**
 * Evaluate `expr` inside ffmpeg at each frame instant, by mapping its value
 * onto a 16-bit luma plane and reading the pixels back. Precision is 1/GAIN.
 *
 * `geq` WRAPS rather than clips, so `gain`/`bias` must keep every mapped value
 * inside [0, 65535] — overflowing silently returns a plausible-looking number
 * from the other end of the range.
 */
function ffmpegSamples(expr, { frames, fps = 30, gain = 2000, bias = 5000 }) {
  const lum = `(${toGeq(expr)})*${gain}+${bias}`
  const raw = execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', `color=black:s=2x2:r=${fps}:d=${(frames / fps).toFixed(6)}`,
    '-vf', `format=gray16le,geq=lum='${lum}'`,
    '-frames:v', String(frames), '-f', 'rawvideo', '-pix_fmt', 'gray16le', '-',
  ], { maxBuffer: 1 << 26 })

  const out = []
  for (let k = 0; k < frames; k++) {
    // 2x2 gray16le = 8 bytes per frame; the first pixel is representative
    // because geq's expression here does not depend on X or Y.
    const px = raw.readUInt16LE(k * 8)
    out.push((px - bias) / gain)
  }
  return out
}

describe(`compileTrackExpr — cross-checked against real ffmpeg${VERSION ? ` (${VERSION})` : ''}`, () => {
  const track = (points) => ({ prop: 'offsetX', points })

  const CASES = [
    {
      name: 'linear ramp',
      tr: track([{ t: 0, value: 0 }, { t: 2, value: 25 }]),
    },
    {
      name: 'ease-in-out (the adaptive-subdivision case)',
      tr: track([{ t: 0, value: 0, easing: 'ease-in-out' }, { t: 2, value: 25 }]),
    },
    {
      name: 'hold then ramp (the step case)',
      tr: track([{ t: 0, value: 5, easing: 'hold' }, { t: 1, value: 20 }, { t: 2, value: 0 }]),
    },
  ]

  for (const c of CASES) {
    test(c.name, { skip }, () => {
      const expr = compileTrackExpr(c.tr, { pixelTolerance: 0.25, unitsPerPixel: 1 / 19.2 })
      const frames = 60
      const got = ffmpegSamples(expr, { frames })

      for (let k = 0; k < frames; k++) {
        const t = k / 30
        const mine = evalExpr(expr, t)
        const curve = sampleTrack(c.tr, t)
        // ffmpeg vs the test evaluator: the same string, so this is the claim
        // that actually matters. 1e-3 covers geq's integer quantisation.
        assert.ok(Math.abs(got[k] - mine) < 1e-3,
          `t=${t.toFixed(4)}: ffmpeg ${got[k]} vs evaluator ${mine}`)
        // ...and both still track the curve the preview will draw.
        assert.ok(Math.abs(got[k] - curve) < 0.02,
          `t=${t.toFixed(4)}: ffmpeg ${got[k]} vs sampleTrack ${curve}`)
      }
    })
  }

  test('the real `t` identifier works in a production filter (overlay x)', { skip }, () => {
    // The geq cases above substitute `t` for `T`. This one goes through the
    // actual surface encode-segment.js uses, so the identifier itself is
    // covered and not just the arithmetic.
    //
    // The expression is wrapped in `round(...)` deliberately: ffmpeg TRUNCATES
    // a pixel option's expression toward zero, while the JS geometry
    // (`toPixelBox`) uses Math.round. Left bare, an expression landing a hair
    // under an integer — 300*(22/30)/2 evaluates to 109.99999999999999 — costs
    // a whole pixel against the preview. encode-segment.js must emit the same
    // `round()` for the same reason; this test pins that it closes the gap.
    //
    // `format=yuv444` matters to the MEASUREMENT, not to the feature: under
    // the default yuv420 the 2px probe at an ODD x reads a pixel off, because
    // chroma is subsampled horizontally. That confound looks exactly like an
    // arithmetic bug and is not one.
    const tr = track([{ t: 0, value: 0 }, { t: 2, value: 300 }])
    const inner = compileTrackExpr(tr, { pixelTolerance: 0.25, unitsPerPixel: 1 })
    const expr = `round(${inner})`

    const raw = execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'lavfi', '-i', 'color=black:s=400x8:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=white:s=2x8:r=30:d=2',
      '-filter_complex', `[0:v][1:v]overlay=x='${expr}':y=0:format=yuv444:shortest=1[v]`,
      '-map', '[v]', '-frames:v', '48', '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ], { maxBuffer: 1 << 26 })

    for (let k = 0; k < 48; k++) {
      const row = raw.subarray(k * 400 * 8, k * 400 * 8 + 400)
      const at = row.findIndex((v) => v > 128)
      const want = Math.round(evalExpr(inner, k / 30))
      assert.equal(at, want, `frame ${k}: overlay landed at x=${at}, expression says ${want}`)
    }
  })

  test('WITHOUT round(), ffmpeg truncates — the gap Task 3 has to close', { skip }, () => {
    // Documents the behaviour the test above defends against, so a future
    // reader does not "simplify" the round() away.
    const tr = track([{ t: 0, value: 0 }, { t: 2, value: 300 }])
    const expr = compileTrackExpr(tr, { pixelTolerance: 0.25, unitsPerPixel: 1 })
    const raw = execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'lavfi', '-i', 'color=black:s=400x8:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=white:s=2x8:r=30:d=2',
      '-filter_complex', `[0:v][1:v]overlay=x='${expr}':y=0:format=yuv444:shortest=1[v]`,
      '-map', '[v]', '-frames:v', '48', '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ], { maxBuffer: 1 << 26 })
    let sawDivergence = false
    for (let k = 0; k < 48; k++) {
      const row = raw.subarray(k * 400 * 8, k * 400 * 8 + 400)
      const at = row.findIndex((v) => v > 128)
      const want = Math.round(evalExpr(expr, k / 30))
      // Bare, the result lands EITHER on the right pixel or exactly one short,
      // never past it. Truncation toward zero is the mechanism; whether a given
      // frame trips it also depends on ffmpeg's last-bit result differing from
      // V8's for the same arithmetic, which is not ours to freeze — asserting
      // the exact truncated value pins a platform detail and fails on frames
      // where the two engines round the final ulp differently.
      assert.ok(at === want || at === want - 1,
        `frame ${k}: bare expression landed at ${at}, expected ${want} or ${want - 1}`)
      if (at !== want) sawDivergence = true
    }
    assert.ok(sawDivergence,
      'the fixture must actually exercise the divergence, or it defends nothing')
  })
})
