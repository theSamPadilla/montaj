// §569: a carousel overlay's `template` is stored as the absolute path of a shipped overlay in the maker's runtime
// (`<home>/…/render/templates/overlays/static-text/static-text.jsx`). On another Mac (another user name) that path is
// missing, so the shipped copy beside this render is used instead. Anything else resolves exactly as before.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { shippedTemplateKey, resolveTemplatePath } from '../shipped-template.js'

function runtime() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 's569-')))
  mkdirSync(join(dir, 'templates', 'overlays', 'static-text'), { recursive: true })
  writeFileSync(join(dir, 'templates', 'overlays', 'static-text', 'static-text.jsx'), 'export default () => null\n')
  writeFileSync(join(dir, 'templates', 'overlays', 'lyric-phrase.jsx'), 'export default () => null\n')
  return dir
}

test('a missing absolute path to a shipped overlay resolves to this runtime\'s copy', () => {
  const dir = runtime()
  try {
    const other = '/Users/someone-else/Library/Application Support/Montaj/runtime-home/.cache/montaj/render/templates/overlays/static-text/static-text.jsx'
    assert.equal(resolveTemplatePath(other, dir), join(dir, 'templates', 'overlays', 'static-text', 'static-text.jsx'))
    const flat = '/home/x/montaj/render/templates/overlays/lyric-phrase.jsx'
    assert.equal(resolveTemplatePath(flat, dir), join(dir, 'templates', 'overlays', 'lyric-phrase.jsx'))
    const win = 'C:\\Users\\Someone\\AppData\\Roaming\\Montaj\\runtime-home\\.cache\\montaj\\render\\templates\\overlays\\static-text\\static-text.jsx'
    assert.equal(resolveTemplatePath(win, dir), join(dir, 'templates', 'overlays', 'static-text', 'static-text.jsx'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a path that exists is used as it is, even when a shipped copy has the same name', () => {
  const dir = runtime()
  const own = realpathSync(mkdtempSync(join(tmpdir(), 's569-own-')))
  try {
    const mine = join(own, 'templates', 'overlays', 'static-text', 'static-text.jsx')
    mkdirSync(join(own, 'templates', 'overlays', 'static-text'), { recursive: true })
    writeFileSync(mine, 'export default () => "mine"\n')
    assert.equal(resolveTemplatePath(mine, dir), mine)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(own, { recursive: true, force: true })
  }
})

test('anything else resolves as before: no shipped copy of that name, another layout, a relative path', () => {
  const dir = runtime()
  try {
    const gone = '/Users/x/render/templates/overlays/no-such/no-such.jsx'
    assert.equal(resolveTemplatePath(gone, dir), resolve(gone))
    const mismatch = '/Users/x/render/templates/overlays/static-text/other.jsx'
    assert.equal(resolveTemplatePath(mismatch, dir), resolve(mismatch))
    const profile = '/Users/x/.montaj/overlays/static-text/static-text.jsx'
    assert.equal(resolveTemplatePath(profile, dir), resolve(profile))
    const climbing = '/Users/x/render/templates/overlays/../../../etc/static-text/static-text.jsx'
    assert.equal(resolveTemplatePath(climbing, dir), resolve(climbing))
    assert.equal(resolveTemplatePath('overlays/title.jsx', dir), resolve('overlays/title.jsx'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shippedTemplateKey names a shipped overlay the same on every Mac, and nothing else', () => {
  const a = '/Users/a/Library/Application Support/Montaj/runtime-home/.cache/montaj/render/templates/overlays/static-text/static-text.jsx'
  const b = 'C:\\Users\\B\\AppData\\Roaming\\Montaj\\runtime-home\\.cache\\montaj\\render\\templates\\overlays\\static-text\\static-text.jsx'
  assert.equal(shippedTemplateKey(a), 'templates/overlays/static-text/static-text.jsx')
  assert.equal(shippedTemplateKey(b), shippedTemplateKey(a))
  assert.equal(shippedTemplateKey('/x/render/templates/overlays/lyric-phrase.jsx'), 'templates/overlays/lyric-phrase.jsx')
  assert.equal(shippedTemplateKey('/Users/x/.montaj/profiles/templates/overlays/static-text/static-text.jsx'), null)
  assert.equal(shippedTemplateKey('/x/templates/overlays/static-text/static-text.jsx'), null)
  assert.equal(shippedTemplateKey('/x/.montaj/overlays/static-text/static-text.jsx'), null)
  assert.equal(shippedTemplateKey('/x/render/templates/overlays/static-text/other.jsx'), null)
  assert.equal(shippedTemplateKey(42), null)
})
