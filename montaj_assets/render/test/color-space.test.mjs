// render/test/color-space.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isHdr } from '../color-space.js'

test('isHdr: returns true for hdr_hlg and hdr_pq, false otherwise', () => {
  assert.equal(isHdr('hdr_hlg'), true)
  assert.equal(isHdr('hdr_pq'), true)
  assert.equal(isHdr('sdr'), false)
  assert.equal(isHdr(null), false)
  assert.equal(isHdr(undefined), false)
  assert.equal(isHdr(''), false)
})
