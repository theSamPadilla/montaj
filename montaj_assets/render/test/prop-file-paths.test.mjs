// render/test/prop-file-paths.test.mjs
//
// Which file an overlay prop makes the render page load, against the table the
// editor preview is held to as well (fixtures/overlay-prop-files.json, read by
// editor/src/video/preview/__tests__/overlayPropFilesParity.test.ts). Whatever
// the preview loads, the render must load: same file, at any depth in props.
//
// The preview treats a `/api/...` string as already served (the host answers
// it) and serve's `/api/files?path=<absolute path>` names that file. The render
// used to read every `/`-led string as a filesystem path, so a served URL became
// file:///api/files%3Fpath=... and the image drew blank, at the top level or in
// a list alike.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateShim } from '../bundle.js'
import { fromFileHref } from '../file-url.js'
import { overlayReadBoundary } from '../overlay-build.js'
import { collectPropFilePaths } from '../sample-frame.js'

const TABLE = JSON.parse(readFileSync(new URL('./fixtures/overlay-prop-files.json', import.meta.url), 'utf8'))

/** The props the render page is given, read out of the generated shim. */
function pageProps(props) {
  const m = generateShim('/W/overlays/x.jsx', props, 30, 30).match(/^window\.props\s*=\s*(.*)$/m)
  assert.ok(m, 'the shim sets window.props')
  return JSON.parse(m[1])
}

/** A page value -> the file it loads (a file:// URL), else null. Non-strings pass through. */
function fileLoaded(v) {
  if (typeof v === 'string') return v.startsWith('file://') ? fromFileHref(v) : null
  if (Array.isArray(v)) return v.map(fileLoaded)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fileLoaded(x)]))
  return v
}

for (const { value, file } of TABLE.values) {
  test(`the render page loads ${file === null ? 'no file' : file} for ${JSON.stringify(value)}`, () => {
    assert.equal(fileLoaded(pageProps({ v: value }).v), file)
  })
}

test('the same, nested: lists, lists of lists and objects inside both', () => {
  assert.deepEqual(fileLoaded(pageProps(TABLE.props)), TABLE.files)
})

test('a value that names no file reaches the page unchanged, a served URL the host alone answers too', () => {
  for (const { value, file } of TABLE.values) {
    if (file === null) assert.equal(pageProps({ v: value }).v, value)
  }
})

// The read boundary must name what the page loads, or a file outside the
// allowed folders is refused; the sample cache must record it, or an edit to
// the image serves a stale sample.
test('a served URL names its file for the read boundary and the sample cache, in a list or an object', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-prop-files-')))
  try {
    const dir = join(base, 'My Covers')
    mkdirSync(dir)
    const files = ['a #1.png', 'b.png', 'c.png'].map(n => { const p = join(dir, n); writeFileSync(p, 'x'); return p })
    const served = p => `/api/files?path=${encodeURIComponent(p)}`
    const props = { covers: [served(files[0]), [served(files[1])]], card: { image: `${served(files[2])}&v=2` }, gone: served(join(dir, 'missing.png')) }

    const boundary = overlayReadBoundary({ props })
    assert.deepEqual([...boundary.files].sort(), files)
    for (const f of files) assert.ok(boundary.allows(f), `${f} is allowed`)
    assert.deepEqual([...collectPropFilePaths(props)].sort(), files)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
