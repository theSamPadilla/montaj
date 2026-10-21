// render/test/export-editor.test.mjs
/** export-editor.js without ffmpeg or a browser: the package's name, moving it into place, and where it lands. */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renameIntoPlace, RENAME_TRIES, checkInside } from '../export-editor.js'
import { cleanFileName } from '../nle/file-name.js'
import { ExportError } from '../nle/export-error.js'

const fsError = (code) => Object.assign(new Error(code), { code })

/** A rename that fails with `codes` in turn, then succeeds; records every call. */
function fakeRename(codes) {
  const calls = []
  const rename = (from, to) => {
    calls.push(to)
    const code = codes[calls.length - 1]
    if (code) throw fsError(code)
  }
  return { rename, calls }
}

describe('renameIntoPlace', () => {
  test('the first free name: one rename', () => {
    const { rename, calls } = fakeRename([])
    assert.equal(renameIntoPlace('/t', '/a', { repick: () => assert.fail('no repick'), rename }), '/a')
    assert.deepEqual(calls, ['/a'])
  })

  test('a name taken meanwhile is re-picked', () => {
    const { rename, calls } = fakeRename(['ENOTEMPTY', 'EEXIST'])
    let n = 1
    assert.equal(renameIntoPlace('/t', '/a', { repick: () => `/a ${++n}`, rename }), '/a 3')
    assert.deepEqual(calls, ['/a', '/a 2', '/a 3'])
  })

  test(`gives up after ${RENAME_TRIES} tries with the last error`, () => {
    const { rename, calls } = fakeRename(Array(1000).fill('ENOTEMPTY'))
    let repicks = 0
    assert.throws(() => renameIntoPlace('/t', '/a', { repick: () => `/a ${++repicks}`, rename }), { code: 'ENOTEMPTY' })
    assert.equal(calls.length, RENAME_TRIES)
    assert.equal(repicks, RENAME_TRIES - 1)
    assert.equal(RENAME_TRIES, 50)
  })

  test('Windows: a busy folder is retried after 100 ms, on the same name', () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      const { rename, calls } = fakeRename([code, code])
      const waits = []
      const dest = renameIntoPlace('/t', '/a', {
        repick: () => assert.fail('no repick'), rename, platform: 'win32', wait: (ms) => waits.push(ms), exists: () => false,
      })
      assert.equal(dest, '/a')
      assert.deepEqual(calls, ['/a', '/a', '/a'])
      assert.deepEqual(waits, [100, 100])
    }
  })

  test('Windows: EPERM onto a folder that is there is a taken name', () => {
    const { rename } = fakeRename(['EPERM'])
    const dest = renameIntoPlace('/t', '/a', { repick: () => '/a 2', rename, platform: 'win32', wait: () => assert.fail('no wait'), exists: (p) => p === '/a' })
    assert.equal(dest, '/a 2')
  })

  test('Windows: a folder busy for good still stops at the bound', () => {
    const { rename, calls } = fakeRename(Array(1000).fill('EBUSY'))
    let waits = 0
    assert.throws(() => renameIntoPlace('/t', '/a', { repick: () => '/b', rename, platform: 'win32', wait: () => { waits++ }, exists: () => false }), { code: 'EBUSY' })
    assert.equal(calls.length, RENAME_TRIES)
    assert.equal(waits, RENAME_TRIES - 1)
  })

  test('elsewhere, EPERM and any other error are thrown at once', () => {
    for (const code of ['EPERM', 'EBUSY', 'EXDEV']) {
      const { rename, calls } = fakeRename([code])
      assert.throws(() => renameIntoPlace('/t', '/a', { repick: () => '/b', rename, platform: 'darwin', wait: () => assert.fail('no wait') }), { code })
      assert.equal(calls.length, 1)
    }
  })

  test('the real wait sleeps about 100 ms', () => {
    const { rename } = fakeRename(['EBUSY'])
    const t0 = Date.now()
    renameIntoPlace('/t', '/a', { repick: () => '/b', rename, platform: 'win32', exists: () => false })
    const ms = Date.now() - t0
    assert.ok(ms >= 90 && ms < 1000, `${ms} ms`)
  })
})

describe('the package name cannot leave --out', () => {
  test('separators, . and .., and control characters are replaced', () => {
    const cases = {
      '../x': '.._x', 'a/b': 'a_b', 'a\\b': 'a_b', '..': '_', '.': '_', '...': '_',
      'a\x00b': 'a_b', 'a\x01b': 'a_b', 'tab\there': 'tab_here', 'a\x7fb': 'a_b', 'a\x85b': 'a_b', 'C:\\x': 'C__x',
    }
    for (const [name, want] of Object.entries(cases)) {
      const clean = cleanFileName(name)
      assert.equal(clean, want, JSON.stringify(name))
      assert.ok(!/[\/\\\x00-\x1f\x7f-\x9f]/.test(clean) && clean !== '.' && clean !== '..', JSON.stringify(name))
    }
    assert.equal(cleanFileName('My Cut'), 'My Cut')
    assert.equal(cleanFileName('caf\u00e9 \u{1F600}'), 'caf\u00e9 \u{1F600}')
  })
})

describe('checkInside', () => {
  const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'montaj-check-inside-')))

  test('a package directly in out, with its file directly in it, passes', () => {
    const d = scratch()
    try {
      mkdirSync(join(d, 'out', 'p'), { recursive: true })
      writeFileSync(join(d, 'out', 'p', 'p.xml'), 'x')
      assert.doesNotThrow(() => checkInside(join(d, 'out'), join(d, 'out', 'p'), join(d, 'out', 'p', 'p.xml')))
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  test('a package deeper in, or a link that leads elsewhere, is invalid_args', () => {
    const d = scratch()
    const isInvalid = (e) => e instanceof ExportError && e.code === 'invalid_args'
    try {
      mkdirSync(join(d, 'out', 'a', 'p'), { recursive: true })
      writeFileSync(join(d, 'out', 'a', 'p', 'p.xml'), 'x')
      assert.throws(() => checkInside(join(d, 'out'), join(d, 'out', 'a', 'p'), join(d, 'out', 'a', 'p', 'p.xml')), isInvalid)
      mkdirSync(join(d, 'elsewhere'))
      writeFileSync(join(d, 'elsewhere', 'p.xml'), 'x')
      symlinkSync(join(d, 'elsewhere'), join(d, 'out', 'linked'))
      assert.throws(() => checkInside(join(d, 'out'), join(d, 'out', 'linked'), join(d, 'out', 'linked', 'p.xml')), isInvalid)
      mkdirSync(join(d, 'out', 'q'))
      symlinkSync(join(d, 'elsewhere', 'p.xml'), join(d, 'out', 'q', 'q.xml'))
      assert.throws(() => checkInside(join(d, 'out'), join(d, 'out', 'q'), join(d, 'out', 'q', 'q.xml')), isInvalid)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})
