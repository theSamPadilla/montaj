// montaj_assets/timeline-core/test/smoke.test.mjs
//
// First trivial test: the barrel imports cleanly and RESOLVER_VERSION is a
// real, non-empty value with no import-time side effects. T2-T5 added the
// real suites (source-window, activation, geometry, corpus goldens); this
// file stays as the one deliberately trivial smoke test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as timelineCore from '../index.js'

test('barrel exports a non-empty RESOLVER_VERSION string', () => {
  assert.equal(typeof timelineCore.RESOLVER_VERSION, 'string')
  assert.ok(timelineCore.RESOLVER_VERSION.length > 0)
})

test('importing the barrel again returns the same module namespace (no import-time side effects)', async () => {
  const again = await import('../index.js')
  assert.equal(again, timelineCore)
})
