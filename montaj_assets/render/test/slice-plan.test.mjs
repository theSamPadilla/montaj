// montaj_assets/render/test/slice-plan.test.mjs
//
// The slice planner (§434): where a sliced render cuts its timeline, and what
// budget it can afford. Pure functions, no I/O.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SLICE_BUDGET_BYTES,
  MIN_SLICE_FRAMES,
  sliceBytes,
  planSlices,
  fitBudget,
  parseSliceBudget,
} from '../slice-plan.js'
import { FFV1_SPARSE_BYTES_PER_PIXEL } from '../disk-space.js'

const FPS = 60
const PX = 1920 * 1080
const DENSE_FRAME = PX * 0.2
const CAP_FRAME = PX * 0.015

// n groups of `len` seconds from 0.
const groupsOf = (n, len) => Array.from({ length: n }, (_, i) => ({ start: i * len, end: (i + 1) * len }))
const dense = (startSeconds, endSeconds) => ({ id: 'd', startSeconds, endSeconds })

test('sliceBytes counts the frames inside the window at each rate', () => {
  const ov = [dense(0, 10), { id: 'c', startSeconds: 0, endSeconds: 10, sparse: true }]
  assert.equal(sliceBytes(ov, 2, 3, FPS, PX), 60 * DENSE_FRAME + 60 * CAP_FRAME)
  assert.equal(sliceBytes(ov, 20, 30, FPS, PX), 0)
  assert.equal(sliceBytes([dense(5, 6)], 0, 10, FPS, PX), 60 * DENSE_FRAME)
})

test('unsliced when the whole timeline fits', () => {
  const plan = planSlices({ groups: groupsOf(4, 5), overlays: [dense(0, 20)], fps: FPS, px: PX })
  assert.equal(plan.sliced, false)
  assert.equal(plan.slices.length, 1)
  assert.deepEqual([plan.slices[0].from, plan.slices[0].to], [0, 4])
  assert.equal(plan.oversize, false)
})

test('sliced greedy edges land on group boundaries', () => {
  // 8 groups of 5 s, dense whole span: 300 frames per group.
  const groups = groupsOf(8, 5)
  const budget = 700 * DENSE_FRAME // two groups fit, three do not
  const plan = planSlices({ groups, overlays: [dense(0, 40)], fps: FPS, px: PX, budgetBytes: budget })
  assert.equal(plan.sliced, true)
  assert.deepEqual(plan.slices.map((s) => [s.from, s.to]), [[0, 2], [2, 4], [4, 6], [6, 8]])
  for (const s of plan.slices) {
    assert.equal(s.start, groups[s.from].start)
    assert.equal(s.end, groups[s.to - 1].end)
    assert.ok(s.bytes <= budget)
  }
  assert.equal(plan.oversize, false)
})

test('peakBytes equals the largest slice', () => {
  const groups = groupsOf(6, 5)
  const ov = [dense(0, 10), dense(5, 30)]
  const plan = planSlices({ groups, overlays: ov, fps: FPS, px: PX, budgetBytes: 900 * DENSE_FRAME })
  assert.equal(plan.peakBytes, Math.max(...plan.slices.map((s) => s.bytes)))
  assert.equal(plan.budgetBytes, 900 * DENSE_FRAME)
})

test('a long group alone in its slice is oversize', () => {
  const groups = [{ start: 0, end: 5 }, { start: 5, end: 25 }, { start: 25, end: 30 }]
  const budget = 400 * DENSE_FRAME // the 20 s group alone is 1200 frames
  const plan = planSlices({ groups, overlays: [dense(0, 30)], fps: FPS, px: PX, budgetBytes: budget })
  const long = plan.slices.find((s) => s.from <= 1 && s.to > 1)
  assert.deepEqual([long.from, long.to], [1, 2])
  assert.equal(plan.oversize, true)
  assert.equal(plan.peakBytes, 1200 * DENSE_FRAME)
})

test('slices below the minimum frames keep growing, even over budget', () => {
  const groups = groupsOf(10, 1) // 60 frames per group
  const plan = planSlices({ groups, overlays: [dense(0, 10)], fps: FPS, px: PX, budgetBytes: 1 })
  assert.equal(MIN_SLICE_FRAMES, 240)
  assert.deepEqual(plan.slices.map((s) => s.frames), [240, 240, 120])
  assert.equal(plan.oversize, true)
  // a tiny forced budget still slices a small project
  assert.equal(plan.sliced, true)
})

test('a budget below one group makes each group its own slice at the minimum', () => {
  const groups = groupsOf(4, 5) // 300 frames each, above the minimum
  const plan = planSlices({ groups, overlays: [dense(0, 20)], fps: FPS, px: PX, budgetBytes: 1 })
  assert.deepEqual(plan.slices.map((s) => [s.from, s.to]), [[0, 1], [1, 2], [2, 3], [3, 4]])
})

test('extraEdges restricts where slices may cut', () => {
  const groups = groupsOf(8, 5)
  const budget = 700 * DENSE_FRAME
  const plan = planSlices({
    groups, overlays: [dense(0, 40)], fps: FPS, px: PX, budgetBytes: budget,
    extraEdges: [15, 30],
  })
  assert.deepEqual(plan.slices.map((s) => [s.from, s.to]), [[0, 3], [3, 6], [6, 8]])
  assert.deepEqual(plan.slices.map((s) => s.end), [15, 30, 40])
})

test('budget validation and clamping', () => {
  const base = { groups: groupsOf(2, 5), overlays: [dense(0, 10)], fps: FPS, px: PX }
  for (const bad of [0, -1, NaN, Infinity, '5', null]) {
    assert.throws(() => planSlices({ ...base, budgetBytes: bad }), RangeError)
  }
  assert.equal(planSlices({ ...base, budgetBytes: 9e12 }).budgetBytes, SLICE_BUDGET_BYTES)
  assert.equal(SLICE_BUDGET_BYTES, 2e9)
})

test('fitBudget keeps the wanted budget when it fits, and stays unsliced when everything fits', () => {
  const base = { groups: groupsOf(4, 5), overlays: [dense(0, 20)], fps: FPS, px: PX }
  const r = fitBudget({ ...base, fixedBytes: 0, freeBytes: 50e9 })
  assert.equal(r.refused, false)
  assert.equal(r.budgetBytes, SLICE_BUDGET_BYTES)
  assert.equal(r.plan.sliced, false)
})

test('fitBudget shrinks when free space is short', () => {
  const groups = groupsOf(20, 5)
  const base = { groups, overlays: [dense(0, 100)], fps: FPS, px: PX, fixedBytes: 1e9 }
  const wide = fitBudget({ ...base, freeBytes: 50e9 })
  assert.equal(wide.budgetBytes, SLICE_BUDGET_BYTES)
  const freeBytes = 1e9 + 1e9 + 1.2e9 // room 1.2 GB
  const r = fitBudget({ ...base, freeBytes })
  assert.equal(r.refused, false)
  assert.ok(r.budgetBytes < SLICE_BUDGET_BYTES)
  assert.ok(r.plan.peakBytes <= 1.2e9)
  assert.ok(r.plan.peakBytes > 0.5e9)
})

test('fitBudget refuses with the bytes needed when the minimum slice cannot fit', () => {
  const groups = groupsOf(4, 5) // minimum slice: one 300-frame group
  const base = { groups, overlays: [dense(0, 20)], fps: FPS, px: PX, fixedBytes: 2e9, lowerFixedBytes: 2e9, floorBytes: 1e9 }
  const lowerSlice = 300 * PX * FFV1_SPARSE_BYTES_PER_PIXEL
  const r = fitBudget({ ...base, freeBytes: 2e9 + lowerSlice - 1 })
  assert.equal(r.refused, true)
  assert.equal(r.needBytes, lowerSlice + 2e9)
  assert.equal(r.freeBytes, 2e9 + lowerSlice - 1)
})

test('fitBudget never refuses on expected figures: lower bounds hold, so it runs at the minimum plan', () => {
  const groups = groupsOf(4, 5)
  const base = { groups, overlays: [dense(0, 20)], fps: FPS, px: PX, fixedBytes: 2e9, lowerFixedBytes: 0.1e9, floorBytes: 1e9 }
  // Expected need (300 dense frames + 3 GB) is far over 3.1 GB; the lower bound is far under it.
  const r = fitBudget({ ...base, freeBytes: 3.1e9 })
  assert.equal(r.refused, false)
  assert.equal(r.plan.slices.length, 4)
})

test('fitBudget never exceeds 2 GB', () => {
  const base = { groups: groupsOf(20, 5), overlays: [dense(0, 100)], fps: FPS, px: PX }
  assert.equal(fitBudget({ ...base, wantedBytes: 9e12, freeBytes: 1e12 }).budgetBytes, SLICE_BUDGET_BYTES)
  assert.throws(() => fitBudget({ ...base, wantedBytes: -5, freeBytes: 1e12 }), RangeError)
})

test('parseSliceBudget', () => {
  assert.equal(parseSliceBudget('500'), 500e6)
  assert.equal(parseSliceBudget('0.5'), 0.5e6)
  assert.equal(parseSliceBudget(' 64 '), 64e6)
  assert.equal(parseSliceBudget('99999'), SLICE_BUDGET_BYTES)
  for (const bad of [undefined, null, '', '  ', 'abc', '0', '-3', 'Infinity', 'NaN']) {
    assert.equal(parseSliceBudget(bad), null)
  }
})

test('worked example: 178 s 1920x1080 60 fps, 12 overlays', () => {
  // Contiguous groups of ~8.9 s (20 groups), 12 overlays: one caption track
  // over the whole span, 8 dense overlays of 20 s spread through the timeline,
  // and 3 dense full-span overlays.
  const groups = Array.from({ length: 20 }, (_, i) => ({ start: i * 8.9, end: (i + 1) * 8.9 }))
  const overlays = [{ id: 'cap', startSeconds: 0, endSeconds: 178, sparse: true }]
  for (let i = 0; i < 8; i++) overlays.push(dense(i * 20, i * 20 + 20))
  for (let i = 0; i < 3; i++) overlays.push(dense(0, 178))
  assert.equal(overlays.length, 12)
  const total = sliceBytes(overlays, 0, 178, FPS, PX)
  // 10680 frames: 3 full dense = 32040 dense frames, 8 x 1200 = 9600, captions 10680.
  assert.equal(total, (32040 + 9600) * DENSE_FRAME + 10680 * CAP_FRAME)
  assert.ok(total > 17e9 && total < 18e9) // ~17.4 GB held at once today
  const plan = planSlices({ groups, overlays, fps: FPS, px: PX })
  assert.equal(plan.sliced, true)
  assert.ok(plan.slices.length >= 9 && plan.slices.length <= 13)
  assert.ok(plan.peakBytes <= SLICE_BUDGET_BYTES)
  assert.equal(plan.oversize, false)
  console.log(
    `worked example: total ${(total / 1e9).toFixed(2)} GB, ${plan.slices.length} slices, ` +
      `peak ${(plan.peakBytes / 1e9).toFixed(2)} GB, slice frames ${plan.slices.map((s) => s.frames).join(',')}`,
  )
})
