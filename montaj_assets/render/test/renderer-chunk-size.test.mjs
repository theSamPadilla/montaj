// render/test/renderer-chunk-size.test.mjs
//
// Unit tests for resolveChunkSize (renderer.js) — the chunk-size default
// renderAllSegments uses when neither `config.chunkSize` nor
// `~/.montaj/config.json`'s `render.chunkSize` override it.
//
// Motion blur multiplies per-chunk work (N sub-frame captures + temp PNGs per
// output frame). Before this fix, chunkSize was computed from output frames
// alone, so a motionBlur=4 render chunked identically to an unblurred one and
// each chunk did 4x the work and wrote 4x the temp PNGs. resolveChunkSize
// sizes on `longest * subframes` instead, then converts back to output frames.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveChunkSize } from '../renderer.js'
import { adaptiveChunkSize, MIN_CHUNK_FRAMES } from '../chunk-plan.js'

test('subframes=1 is identical to plain adaptiveChunkSize (today\'s behavior, unchanged)', () => {
  for (const [longest, workers] of [[2040, 16], [300, 4], [999, 3], [10000, 12]]) {
    assert.equal(
      resolveChunkSize(longest, workers, 1, undefined, undefined),
      adaptiveChunkSize(longest, workers),
    )
  }
})

test('an explicit config.chunkSize always wins, subframes or not', () => {
  assert.equal(resolveChunkSize(2040, 16, 1, 500, undefined), 500)
  assert.equal(resolveChunkSize(2040, 16, 4, 500, undefined), 500)
})

test('userConfig chunkSize wins when config.chunkSize is absent', () => {
  assert.equal(resolveChunkSize(2040, 16, 1, undefined, 400), 400)
  assert.equal(resolveChunkSize(2040, 16, 4, null, 400), 400)
})

test('a small segment under motion blur shrinks the output-frame chunk size, not just the un-multiplied MIN_CHUNK_FRAMES floor', () => {
  // A short segment (300 frames, plenty of workers) hits adaptiveChunkSize's
  // MIN_CHUNK_FRAMES floor either way — that floor exists to keep a chunk's
  // REAL rendered-image count from getting so small that browser-page setup +
  // concat overhead dominates. Pre-fix, the floor was applied to output frames,
  // so a motionBlur=4 chunk of "120 output frames" actually rendered 480
  // sub-frame images/PNGs — 4x the floor's intended budget. Post-fix, the floor
  // is applied to `longest * subframes`, so the OUTPUT-frame chunk size shrinks
  // to keep the real image count near the floor instead.
  const longest = 300, workers = 64, subframes = 4
  const blurred        = resolveChunkSize(longest, workers, subframes, undefined, undefined)
  const unblurred       = resolveChunkSize(longest, workers, 1, undefined, undefined)
  const oldBlurredWork  = unblurred * subframes   // what pre-fix code effectively did per chunk
  const newBlurredWork  = blurred * subframes     // what this fix does per chunk

  assert.ok(blurred < unblurred, `blurred chunk (${blurred}) should be smaller than unblurred (${unblurred})`)
  assert.ok(
    newBlurredWork < oldBlurredWork,
    `real per-chunk image count should shrink under the fix: old ${oldBlurredWork}, new ${newBlurredWork}`,
  )
  // The new real workload should sit near the un-multiplied floor (MIN_CHUNK_FRAMES),
  // not near MIN_CHUNK_FRAMES * subframes.
  assert.ok(
    newBlurredWork <= MIN_CHUNK_FRAMES * 1.5,
    `new per-chunk image count ${newBlurredWork} should stay near MIN_CHUNK_FRAMES (${MIN_CHUNK_FRAMES}), not scale by ~${subframes}x`,
  )
})

test('subframes=1 leaves a small segment at exactly the un-multiplied MIN_CHUNK_FRAMES floor', () => {
  assert.equal(resolveChunkSize(300, 64, 1, undefined, undefined), MIN_CHUNK_FRAMES)
})

test('never returns less than 1', () => {
  assert.ok(resolveChunkSize(1, 64, 8, undefined, undefined) >= 1)
})
