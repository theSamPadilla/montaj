// render/test/export-editor.test.mjs
/** export-editor.js without ffmpeg or a browser: moving the package into place (`renameIntoPlace`). */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renameIntoPlace, RENAME_TRIES } from '../export-editor.js'

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
