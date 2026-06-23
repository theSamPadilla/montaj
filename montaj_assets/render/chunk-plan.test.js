import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adaptiveChunkSize, workerCap, MIN_CHUNK_FRAMES } from './chunk-plan.js'

test('adaptiveChunkSize splits the longest segment into ~workers chunks', () => {
  const cs = adaptiveChunkSize(2040, 16)
  assert.ok(cs <= Math.ceil(2040 / 16) + 1 && cs >= MIN_CHUNK_FRAMES)
  assert.ok(Math.ceil(2040 / cs) >= 12)
})
test('adaptiveChunkSize honors the MIN floor (no tiny chunks)', () => {
  assert.equal(adaptiveChunkSize(300, 64), MIN_CHUNK_FRAMES)
})
test('adaptiveChunkSize on a small box stays coarse', () => {
  assert.equal(Math.ceil(2040 / adaptiveChunkSize(2040, 4)), 4)
})
test('workerCap binds on low RAM, not on big RAM', () => {
  assert.equal(workerCap(16, 64 * 1e9), 16)
  assert.equal(workerCap(16, 4 * 1e9), 2)          // 4GB / 1.5GB-per-worker → floor 2
  assert.ok(workerCap(16, 4 * 1e9) < 16)
})
test('frame-coverage invariant: chunks tile [0, frameCount) exactly', () => {
  for (const [frames, workers] of [[2040,16],[300,4],[1,8],[999,3],[10000,12],[480,4],[0,8]]) {
    const cs = adaptiveChunkSize(frames, workers)
    const n = frames > cs ? Math.ceil(frames / cs) : 1
    let covered = 0
    for (let i = 0; i < n; i++) {
      const start = i * cs, end = Math.min(start + cs, frames)
      assert.equal(start, covered)
      covered = end
    }
    assert.equal(covered, frames)
  }
})
