// file-url.js — filesystem path <-> file:// URL, portable to Windows.
//
// The posix half is pinned to today's exact strings ('file://' + encodeURI(p))
// so macOS output stays byte-identical; the win32 half is exercised on any host
// by passing { windows: true }, never by touching process.platform.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { toFileHref, fromFileHref, isAbsPath, fontsCssHref, assetResolverSource } from '../file-url.js'

const WIN = { windows: true }
const POSIX = { windows: false }

describe('toFileHref (posix)', () => {
  for (const p of ['/a b/c.png', '/Users/sam/Montaj/p1/assets/x.png', '/var/folders/ab/T/montaj-1/index.html',
                   '/a/Screenshot 2026 at 12.44.47\u202fPM.png', '/a/[1]^|.png', "/a/it's(1).png"]) {
    test(`identical to today's 'file://' + encodeURI(p) for ${JSON.stringify(p)}`, () => {
      assert.equal(toFileHref(p, POSIX), 'file://' + encodeURI(p))
    })
  }
  test("'/a b/c.png' -> file:///a%20b/c.png", () => {
    assert.equal(toFileHref('/a b/c.png', POSIX), 'file:///a%20b/c.png')
  })
  // Intended change: encodeURI leaves # and ? alone, so today's URL for such a
  // path cuts at the fragment/query and names a different (missing) file.
  test('# and ? are now escaped (intended change); % stays %25 as before', () => {
    assert.equal(toFileHref('/a/#1?.png', POSIX), 'file:///a/%231%3F.png')
    assert.notEqual(toFileHref('/a/#1?.png', POSIX), 'file://' + encodeURI('/a/#1?.png'))
    assert.equal(toFileHref('/a/100%.png', POSIX), 'file:///a/100%25.png')
  })
})

describe('toFileHref / fromFileHref (win32)', () => {
  test('drive path -> file:///C:/...', () => {
    assert.equal(toFileHref('C:\\Users\\a\\x.png', WIN), 'file:///C:/Users/a/x.png')
  })
  test('spaces are encoded the same way as posix', () => {
    assert.equal(toFileHref('C:\\Users\\a b\\x.png', WIN), 'file:///C:/Users/a%20b/x.png')
  })
  test('file:///C:/... -> C:\\...', () => {
    assert.equal(fromFileHref('file:///C:/Users/a/x.png', WIN), 'C:\\Users\\a\\x.png')
    assert.equal(fromFileHref('file:///C:/Users/a%20b/x.png', WIN), 'C:\\Users\\a b\\x.png')
  })
  test('round-trips', () => {
    for (const p of ['C:\\Users\\a\\x.png', 'D:\\p #1\\?x%.png']) {
      assert.equal(fromFileHref(toFileHref(p, WIN), WIN), p)
    }
  })
})

describe('fromFileHref (posix)', () => {
  test("identical to today's decodeURIComponent(url.replace(/^file:\\/\\//, ''))", () => {
    for (const u of ['file:///a%20b/c.png', 'file:///a/b.png', 'file:///a/%E2%80%AF.png']) {
      assert.equal(fromFileHref(u, POSIX), decodeURIComponent(u.replace(/^file:\/\//, '')))
    }
  })
  test('round-trips #, ? and %', () => {
    assert.equal(fromFileHref(toFileHref('/a/#1?%.png', POSIX), POSIX), '/a/#1?%.png')
  })
  test('never yields /C:/ on win32 (the bug)', () => {
    assert.ok(!fromFileHref('file:///C:/x.png', WIN).startsWith('/'))
  })
})

describe('isAbsPath', () => {
  test('posix: exactly startsWith("/")', () => {
    assert.equal(isAbsPath('/x', POSIX), true)
    assert.equal(isAbsPath('//host/x', POSIX), true)
    assert.equal(isAbsPath('x/y', POSIX), false)
    assert.equal(isAbsPath('C:\\x', POSIX), false)
  })
  test('win32: drive letter is absolute; relative and UNC are not', () => {
    assert.equal(isAbsPath('C:\\x', WIN), true)
    assert.equal(isAbsPath('c:/x', WIN), true)
    assert.equal(isAbsPath('x/y', WIN), false)
    assert.equal(isAbsPath('x\\y', WIN), false)
    assert.equal(isAbsPath('C:x', WIN), false)
    assert.equal(isAbsPath('\\\\server\\share\\x', WIN), false)
  })
})

describe('fontsCssHref (the logic behind both vendoredFontsHref copies)', () => {
  const today = (b) => (typeof b !== 'string' || !b.startsWith('/') || b.startsWith('//'))
    ? '' : 'file://' + encodeURI(b.replace(/\/+$/, '')) + '/fonts.css'
  for (const b of ['/abs/dir', '/abs/dir/', '/a b/fonts', '/', '', '//host/share', '//evil.test/fonts',
                   'fonts/editor', './fonts', 'https://evil.test/f', 'file:///x/fonts', 42, null, undefined, {}]) {
    test(`posix: ${JSON.stringify(b)} matches today's output`, () => {
      assert.equal(fontsCssHref(b, POSIX), today(b))
    })
  }
  test('posix: /abs/dir accepted', () => {
    assert.equal(fontsCssHref('/abs/dir', POSIX), 'file:///abs/dir/fonts.css')
  })
  test('win32: C:\\fonts accepted', () => {
    assert.equal(fontsCssHref('C:\\fonts', WIN), 'file:///C:/fonts/fonts.css')
    assert.equal(fontsCssHref('C:\\fonts\\', WIN), 'file:///C:/fonts/fonts.css')
  })
  test('win32: UNC is refused in both spellings', () => {
    assert.equal(fontsCssHref('\\\\server\\share\\fonts', WIN), '')
    assert.equal(fontsCssHref('//server/share/fonts', WIN), '')
  })
  test('win32: relative is refused', () => {
    assert.equal(fontsCssHref('fonts\\editor', WIN), '')
  })
})

describe('assetResolverSource (render-carousel page shim)', () => {
  const TODAY = `function resolveAsset(p) {
  if (!p) return p
  if (p.startsWith('http://') || p.startsWith('https://') || p.startsWith('data:')) return p
  if (p.startsWith('/')) return 'file://' + p
  return 'file://' + projectDir + '/' + p
}`
  const load = (src, projectDir) => new Function('projectDir', `${src}\nreturn resolveAsset`)(projectDir)

  test('posix: emits today\'s shim text byte-for-byte', () => {
    assert.equal(assetResolverSource('/Users/sam/proj', POSIX), TODAY)
  })
  test('posix: behaviour unchanged', () => {
    const r = load(assetResolverSource('/p', POSIX), '/p')
    assert.equal(r('/abs/x.png'), 'file:///abs/x.png')
    assert.equal(r('img/x.png'), 'file:///p/img/x.png')
    assert.equal(r('https://x/y.png'), 'https://x/y.png')
    assert.equal(r(''), '')
  })
  test('win32: drive-letter asset and a relative asset under a drive-letter project', () => {
    const r = load(assetResolverSource('C:\\Users\\a b\\proj', WIN), 'C:\\Users\\a b\\proj')
    assert.equal(r('C:\\Users\\a\\x.png'), 'file:///C:/Users/a/x.png')
    assert.equal(r('D:/y.png'), 'file:///D:/y.png')
    assert.equal(r('img\\x.png'), 'file:///C:/Users/a%20b/proj/img/x.png')
    assert.equal(r('data:image/png;base64,AA'), 'data:image/png;base64,AA')
  })
})
