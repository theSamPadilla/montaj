// is-main.js — "is this module the process entry point?", compared the way
// Node itself builds the main module's URL: from the REAL path of argv[1].
//
// The old inline check (`resolve(argv[1]) === fileURLToPath(import.meta.url)`)
// compared an unresolved path against a resolved one, so any symlink or
// junction in argv[1]'s chain (macOS /var -> /private/var, a Windows junction)
// made it false and the script exited 0 having done nothing.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isMain } from '../is-main.js'

const URL_OF = (p) => pathToFileURL(p).href

describe('isMain', () => {
  test('true when realpath(argv1) is the module path', () => {
    assert.equal(isMain(URL_OF('/opt/r/render.js'), '/opt/r/render.js', { realpath: (p) => p }), true)
  })

  test('symlinked argv1: /var/x reached through /private/var/x is still main', () => {
    const realpath = (p) => p.replace(/^\/var\//, '/private/var/')
    // Node's import.meta.url is always the resolved real path.
    const url = URL_OF('/private/var/x/render.js')
    assert.equal(isMain(url, '/var/x/render.js', { realpath }), true)
  })

  test('false when argv1 names a different file', () => {
    assert.equal(isMain(URL_OF('/opt/r/render.js'), '/opt/r/other.js', { realpath: (p) => p }), false)
  })

  test('false for a missing argv1', () => {
    for (const a of [undefined, null, '']) {
      assert.equal(isMain(URL_OF('/opt/r/render.js'), a, { realpath: (p) => p }), false)
    }
  })

  test('false when realpath throws', () => {
    const realpath = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
    assert.equal(isMain(URL_OF('/opt/r/render.js'), '/opt/r/render.js', { realpath }), false)
  })

  test('default realpath is fs.realpathSync: a real symlinked directory resolves', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'is-main-')))
    try {
      mkdirSync(join(dir, 'real'))
      writeFileSync(join(dir, 'real', 'render.js'), '')
      symlinkSync(join(dir, 'real'), join(dir, 'link'))
      const url = pathToFileURL(join(dir, 'real', 'render.js')).href
      assert.equal(isMain(url, join(dir, 'link', 'render.js')), true)
      assert.equal(isMain(url, join(dir, 'link', 'missing.js')), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
