// render/test/look.test.mjs
//
// Unit tests for look.js — the JS mirror of lib/look.py. Pure filesystem/JSON
// reads against the real montaj_assets/luts/looks.json manifest, no ffmpeg.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

import { MASTER_LOOK, curveIds, lutPath } from '../look.js'

test('look.js: MASTER_LOOK matches the manifest default (natural1, PL24)', () => {
  assert.equal(MASTER_LOOK, 'natural1')
})

test('look.js: the default look is the natural1 cube; vivid1 and vivid1-neutral stay selectable', () => {
  assert.ok(lutPath().endsWith('/montaj-natural-v1.cube'), lutPath())
  assert.ok(lutPath('vivid1').endsWith('/montaj-vivid-v1.cube'))
  assert.ok(lutPath('vivid1-neutral').endsWith('/montaj-vivid-v1-neutral.cube'))
})

test('look.js: curveIds returns all registered curves, master look included', () => {
  const ids = curveIds()
  assert.ok(Array.isArray(ids))
  assert.ok(ids.includes(MASTER_LOOK))
  assert.ok(ids.length >= 1)
})

test('look.js: lutPath() with no argument resolves the master look\'s .cube file', () => {
  const p = lutPath()
  assert.ok(p.endsWith('.cube'))
  assert.ok(existsSync(p), `expected LUT file to exist at ${p}`)
})

test('look.js: lutPath(curveId) resolves a specific registered curve', () => {
  const ids = curveIds()
  for (const id of ids) {
    const p = lutPath(id)
    assert.ok(p.endsWith('.cube'))
    assert.ok(existsSync(p), `expected LUT file to exist at ${p} for curve ${id}`)
  }
})

test('look.js: lutPath(null) resolves the same file as lutPath()', () => {
  assert.equal(lutPath(null), lutPath())
})

test('look.js: lutPath throws on an unknown curve id', () => {
  assert.throws(() => lutPath('not-a-real-curve'), /Unknown look curve/)
})
