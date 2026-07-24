// render/test/p-map.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pMap } from '../p-map.js'

test('pMap preserves input order in results', async () => {
  const out = await pMap([30, 10, 20], async (ms) => {
    await new Promise(r => setTimeout(r, ms))
    return ms
  }, 3)
  assert.deepEqual(out, [30, 10, 20])
})

test('pMap caps concurrency', async () => {
  let live = 0, peak = 0
  await pMap(Array.from({ length: 8 }, (_, i) => i), async () => {
    live++; peak = Math.max(peak, live)
    await new Promise(r => setTimeout(r, 10))
    live--
  }, 2)
  assert.ok(peak <= 2, `peak concurrency ${peak}`)
})
