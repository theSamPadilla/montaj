import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REMOVE_BG_SCRIPT } from '../render.js'

test('REMOVE_BG_SCRIPT points at the real step file', () => {
  assert.ok(
    REMOVE_BG_SCRIPT.endsWith(join('steps', 'transform', 'remove_bg.py')),
    `unexpected path: ${REMOVE_BG_SCRIPT}`,
  )
  // When MONTAJ_ROOT is not injected, the __dirname fallback must resolve to
  // the repo root so the file actually exists on disk.
  if (!process.env.MONTAJ_ROOT) {
    assert.ok(existsSync(REMOVE_BG_SCRIPT), `missing on disk: ${REMOVE_BG_SCRIPT}`)
  }
})
