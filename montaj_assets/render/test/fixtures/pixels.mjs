// render/test/fixtures/pixels.mjs: read one pixel of a rendered frame, for the
// solid-colour layering tests (layering.integration, layering-parity.integration).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { FFMPEG } from '../../ffmpeg-bin.js'

/** RGB of the pixel at fractional (fx, fy) of frame `n` of a video or a still. */
export function pixel(path, n, fx = 0.5, fy = 0.5) {
  // RGB before the crop: a 1x1 crop of 4:2:0 has no chroma plane left.
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', path, '-map', '0:v:0',
    '-vf', `select=eq(n\\,${n}),format=rgb24,crop=1:1:iw*${fx}:ih*${fy}`,
    '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })
  if (r.status !== 0 || r.stdout.length < 3) throw new Error(`pixel read failed: ${r.stderr}`)
  return [r.stdout[0], r.stdout[1], r.stdout[2]]
}

export function near(rgb, want, why, tol = 40) {
  assert.ok(rgb.every((v, i) => Math.abs(v - want[i]) <= tol), `${why}: got ${rgb}, want about ${want}`)
}
