import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTotalDuration } from '../compose.js'

test('computeTotalDuration: uses max end from primary clips', () => {
  const result = computeTotalDuration(
    [{ start: 0, end: 10.0 }, { start: 10.0, end: 22.5 }],
    [], [], []
  )
  assert.equal(result, 22.5)
})

test('computeTotalDuration: canvas project — max end from overlay and puppeteer items', () => {
  const result = computeTotalDuration(
    [],
    [{ end: 5.0 }],
    [{ end: 8.0 }],
    [{ endSeconds: 12.0 }]
  )
  assert.equal(result, 12.0)
})

test('computeTotalDuration: mixed — primary clips + overlay items', () => {
  const result = computeTotalDuration(
    [{ start: 0, end: 10.0 }],
    [{ end: 15.0 }],
    [],
    []
  )
  assert.equal(result, 15.0)
})

test('computeTotalDuration: returns 0 when all empty', () => {
  assert.equal(computeTotalDuration([], [], [], []), 0)
})

test('computeTotalDuration: clips missing end field default to 0', () => {
  // ?? 0 guards prevent NaN/undefined propagating into Math.max
  const result = computeTotalDuration(
    [{ start: 0 }],  // no end field
    [],
    [],
    []
  )
  assert.equal(result, 0)
})
