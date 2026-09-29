// render/test/overlay-read-boundary.test.mjs
//
// PV54. overlay-build.js's read boundary: which folders are roots (Sam's
// project-folder rule), what allows() decides for a path, and the esbuild
// guard that refuses an import outside it, unread.
//
// HOME and the workspace are pointed at a scratch dir for the whole file
// (node --test runs each file in its own process), so the real home directory
// is never a root here.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync, realpathSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'
import {
  overlayReadBoundary, overlayReadRoots, overlayEsbuildOptions, overlayInputsFromMetafile, IMPORT_REFUSED,
} from '../overlay-build.js'
import { generateShim } from '../bundle.js'

const RENDER = join(dirname(fileURLToPath(import.meta.url)), '..')

let base, home, ws, proj, cliProj, outside
const saved = {}

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-read-boundary-')))
  home = join(base, 'home')
  ws = join(home, 'Montaj')              // the default workspace: ~/Montaj
  proj = join(ws, 'proj')                // a project where the app puts them
  cliProj = join(base, 'cli-proj')       // a CLI project outside every root
  outside = join(base, 'outside')        // an ordinary folder that is no root
  for (const d of [join(proj, 'overlays'), join(cliProj, 'overlays'), join(outside, 'lib'), join(home, 'notes')]) {
    mkdirSync(d, { recursive: true })
  }
  writeFileSync(join(home, 'notes', 'todo.txt'), 'buy milk\n')
  writeFileSync(join(proj, 'overlays', 'title.jsx'), 'export default () => null\n')
  writeFileSync(join(proj, 'lib.js'), 'export const a = 1\n')
  writeFileSync(join(cliProj, 'overlays', 'title.jsx'), 'export default () => null\n')
  writeFileSync(join(cliProj, 'pic.png'), 'png')
  writeFileSync(join(cliProj, 'sibling.js'), 'export const s = 1\n')
  writeFileSync(join(outside, 'palette.json'), '{"accent": "#c0ffee"}\n')
  writeFileSync(join(outside, 'lib', 'package.json'), '{"name": "lib", "main": "entry.js"}\n')
  writeFileSync(join(outside, 'lib', 'entry.js'), 'export const accent = "#c0ffee"\n')
  for (const k of ['HOME', 'MONTAJ_WORKSPACE_DIR', 'MONTAJ_FONTS_DIR']) saved[k] = process.env[k]
  process.env.HOME = home
  delete process.env.MONTAJ_WORKSPACE_DIR
  delete process.env.MONTAJ_FONTS_DIR
})

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  if (base) rmSync(base, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// roots: Sam's project-folder rule (2026-09-29)
// ---------------------------------------------------------------------------

describe('overlayReadRoots: a project folder is a root only inside another root', () => {
  test('the default roots are the workspace, ~/.montaj/{overlays,profiles}, templates and the engine', () => {
    const roots = overlayReadRoots()
    assert.ok(roots.includes(ws), 'the workspace (~/Montaj)')
    assert.ok(roots.includes(join(home, '.montaj', 'overlays')))
    assert.ok(roots.includes(join(home, '.montaj', 'profiles')))
    assert.ok(roots.includes(realpathSync(join(RENDER, 'templates'))))
    assert.ok(roots.includes(realpathSync(join(RENDER, 'node_modules'))))
    assert.ok(!roots.includes(home), 'the home directory itself is not a root')
  })

  test('a project folder equal to ~ is not a root, so nothing in ~ outside the roots is allowed', () => {
    const b = overlayReadBoundary({ projectDir: home })
    assert.ok(!b.roots.includes(home))
    assert.equal(b.allows(join(home, 'notes', 'todo.txt')), false)
  })

  test('nor is `/`, the folder above ~, or a folder outside the workspace', () => {
    for (const projectDir of ['/', base, cliProj, outside]) {
      const b = overlayReadBoundary({ projectDir })
      assert.ok(!b.roots.includes(projectDir), `${projectDir} is not a root`)
      assert.equal(b.allows(join(home, 'notes', 'todo.txt')), false, `${projectDir}: ~ stays closed`)
      assert.equal(b.allows(join(cliProj, 'sibling.js')), false, `${projectDir}: an outside folder stays closed`)
    }
  })

  test('a project inside the workspace is a root, and its files are allowed', () => {
    const b = overlayReadBoundary({ projectDir: proj })
    assert.ok(b.roots.includes(proj))
    assert.equal(b.allows(join(proj, 'lib.js')), true)
  })

  test('a CLI project outside the workspace keeps its entry file and the files its props name, not their siblings', () => {
    const entry = join(cliProj, 'overlays', 'title.jsx')
    const b = overlayReadBoundary({ projectDir: cliProj, files: [entry], props: { img: join(cliProj, 'pic.png') } })
    assert.equal(b.allows(entry), true, 'the entry file')
    assert.equal(b.allows(join(cliProj, 'pic.png')), true, 'a props-named file')
    assert.equal(b.allows(join(cliProj, 'sibling.js')), false, 'a sibling')
  })

  test('the fonts base the page links is a root, passed or from the env', () => {
    const fonts = join(outside, 'lib')
    assert.equal(overlayReadBoundary().allows(join(fonts, 'entry.js')), false)
    assert.equal(overlayReadBoundary({ fontsDir: fonts }).allows(join(fonts, 'entry.js')), true)
    process.env.MONTAJ_FONTS_DIR = fonts
    try {
      assert.equal(overlayReadBoundary().allows(join(fonts, 'entry.js')), true)
    } finally { delete process.env.MONTAJ_FONTS_DIR }
  })

  test('the bundle\'s own work dir is a root wherever it is: render creates it', () => {
    const b = overlayReadBoundary({ workDir: join(outside, 'lib') })
    assert.equal(b.allows(join(outside, 'lib', 'entry.js')), true)
  })
})

describe('engineRoots: the same in any layout', () => {
  test('with no node_modules at all (a wheel\'s layout), overlay-runtime and timeline-core are still engine roots', async () => {
    // Not reached through a node_modules symlink here, so only the fixed
    // entries can put them in: how npm links a `file:` dependency varies.
    const layout = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-layout-')))
    try {
      for (const d of ['render', 'overlay-runtime', 'timeline-core']) mkdirSync(join(layout, d))
      for (const f of ['overlay-build.js', 'file-url.js']) copyFileSync(join(RENDER, f), join(layout, 'render', f))
      const { engineRoots } = await import(pathToFileURL(join(layout, 'render', 'overlay-build.js')).href)
      const roots = engineRoots()
      assert.ok(roots.includes(join(layout, 'overlay-runtime')), 'overlay-runtime')
      assert.ok(roots.includes(join(layout, 'timeline-core')), 'timeline-core')
    } finally { rmSync(layout, { recursive: true, force: true }) }
  })
})

// ---------------------------------------------------------------------------
// allows(): decisions on path strings
// ---------------------------------------------------------------------------

describe('allows(): in or out of the boundary', () => {
  test('a file under a root is in; a file under no root is out', () => {
    const b = overlayReadBoundary()
    assert.equal(b.allows(join(proj, 'lib.js')), true)
    assert.equal(b.allows(join(outside, 'palette.json')), false)
  })

  test('a missing path is judged by its nearest existing folder: in a root it is a plain not-found, elsewhere it is out', () => {
    const b = overlayReadBoundary()
    assert.equal(b.allows(join(proj, 'not-yet.js')), true)
    assert.equal(b.allows(join(proj, 'no-such-dir', 'deeper', 'x.js')), true)
    assert.equal(b.allows(join(outside, 'not-yet.js')), false)
    assert.equal(b.allows(join(outside, 'no-such-dir', 'x.js')), false)
  })

  test('a symlink inside a root that points outside is out, file or folder', () => {
    const fileLink = join(proj, 'palette-link.json')
    const dirLink = join(proj, 'lib-link')
    symlinkSync(join(outside, 'palette.json'), fileLink)
    symlinkSync(join(outside, 'lib'), dirLink)
    try {
      const b = overlayReadBoundary()
      assert.equal(b.allows(fileLink), false)
      assert.equal(b.allows(dirLink), false)
      assert.equal(b.allows(join(dirLink, 'entry.js')), false)
    } finally {
      unlinkSync(fileLink); unlinkSync(dirLink)
    }
  })

  test('`..` is resolved before the check', () => {
    const b = overlayReadBoundary()
    assert.equal(b.allows(join(proj, '..', '..', 'notes', 'todo.txt')), false)
    assert.equal(b.allows(join(proj, 'overlays', '..', 'lib.js')), true)
  })

  test('a relative path, a NUL byte or a non-string is out', () => {
    const b = overlayReadBoundary()
    for (const p of ['lib.js', './lib.js', `${join(proj, 'lib.js')}\0`, null, undefined, 42, {}]) {
      assert.equal(b.allows(p), false, JSON.stringify(String(p)))
    }
  })

  test('props name exact files: an absolute path or a file:// URL, nested anywhere', () => {
    const palette = join(outside, 'palette.json')
    for (const props of [
      { img: palette },
      { slides: [{ layers: [{ src: pathToFileURL(palette).href }] }] },
    ]) {
      assert.equal(overlayReadBoundary({ props }).allows(palette), true, JSON.stringify(props))
    }
  })

  test('a props-named folder opens nothing under it', () => {
    const b = overlayReadBoundary({ props: { dir: join(outside, 'lib') } })
    assert.equal(b.allows(join(outside, 'lib', 'entry.js')), false)
    assert.equal(b.files.size, 0)
  })

  test('props http(s) URLs are collected and normalized; only media ones are to be fetched', () => {
    const b = overlayReadBoundary({ props: {
      a: 'HTTPS://Example.COM/team/badge.PNG?v=2', b: 'not a url', c: 'ftp://x/y',
      cta: 'https://example.com/signup', unsub: 'https://example.com/u?token=1', data: 'https://example.com/scores.json',
    } })
    assert.deepEqual([...b.urls], ['https://example.com/team/badge.PNG?v=2', 'https://example.com/scores.json'])
    assert.deepEqual([...b.unfetchedUrls], ['https://example.com/signup', 'https://example.com/u?token=1'])
    assert.equal(b.files.size, 0)
  })
})

// ---------------------------------------------------------------------------
// the esbuild guard, as a unit
// ---------------------------------------------------------------------------

describe('the esbuild guard refuses an import outside the boundary, unread', () => {
  const build = (entry, extra = {}) => esbuild.build({
    ...overlayEsbuildOptions({ boundary: overlayReadBoundary({ files: [entry] }) }),
    entryPoints: [entry],
    write: false,
    outfile: join(dirname(entry), 'out.js'),
    ...extra,
  })

  const overlay = (name, importLine) => {
    const p = join(proj, 'overlays', name)
    writeFileSync(p, `${importLine}\nexport default function O() { return <b>{String(v)}</b> }\n`)
    return p
  }

  /** Build, expect exactly one refusal; returns esbuild's error. */
  async function refused(entry) {
    const err = await build(entry).then(() => null, e => e)
    assert.ok(err, 'the build must fail')
    assert.equal(err.errors.length, 1)
    return err
  }

  test('positive control: the same import from inside the workspace IS bundled, value included', async () => {
    // What makes the refusals below mean something: were the file loaded, its
    // value would be in the output, so its absence there is not an accident.
    writeFileSync(join(proj, 'palette.json'), '{"accent": "#c0ffee"}\n')
    const r = await build(overlay('inside.jsx', "import v from '../palette.json'"))
    assert.match(Buffer.from(r.outputFiles[0].contents).toString(), /#c0ffee/)
  })

  for (const [label, spec] of [
    ['an absolute path', () => join(outside, 'palette.json')],
    ['a relative path that climbs out', () => '../../../../outside/palette.json'],
  ]) {
    test(`${label}: refused, the error names the path only`, async () => {
      const err = await refused(overlay('abs.jsx', `import v from ${JSON.stringify(spec())}`))
      assert.equal(err.errors[0].text, `${IMPORT_REFUSED} ${join(outside, 'palette.json')}`)
      assert.doesNotMatch(JSON.stringify(err.errors) + err.message, /c0ffee|accent/)
    })
  }

  test('a folder outside: refused before esbuild reads its package.json', async () => {
    const err = await refused(overlay('dir.jsx', `import { accent as v } from ${JSON.stringify(join(outside, 'lib'))}`))
    // Named as written, not as `<dir>/<main>`: `main` is package.json content,
    // and appears only if esbuild read the file.
    assert.equal(err.errors[0].text, `${IMPORT_REFUSED} ${join(outside, 'lib')}`)
    assert.doesNotMatch(JSON.stringify(err.errors) + err.message, /entry\.js|c0ffee/)
  })

  test('a symlink inside the workspace to a file outside: refused', async () => {
    const link = join(proj, 'overlays', 'palette-link.json')
    symlinkSync(join(outside, 'palette.json'), link)
    try {
      const err = await refused(overlay('link.jsx', "import v from './palette-link.json'"))
      assert.ok(err.errors[0].text.startsWith(`${IMPORT_REFUSED} `))
      assert.doesNotMatch(JSON.stringify(err.errors) + err.message, /c0ffee|accent/)
    } finally { unlinkSync(link) }
  })

  test('an import from a folder that does not exist in the workspace is a plain not-found, not a refusal', async () => {
    const err = await refused(overlay('typo.jsx', "import { v } from './lib/helpers.js'"))
    assert.match(err.errors[0].text, /^Could not resolve/)
    assert.ok(!err.errors[0].text.includes(IMPORT_REFUSED))
  })

  test('a refused build writes no output', async () => {
    const entry = overlay('nowrite.jsx', `import v from ${JSON.stringify(join(outside, 'palette.json'))}`)
    const out = join(proj, 'overlays', 'nowrite-out.js')
    await build(entry, { write: true, outfile: out }).then(() => assert.fail('must fail'), () => {})
    assert.equal(existsSync(out), false)
  })

  test('legit: a render shim resolves the engine, one React, and the aliases', async () => {
    const comp = overlay('legit.jsx', "import { interpolate } from 'montaj/render'\nconst v = typeof interpolate")
    const work = mkdtempSync(join(tmpdir(), 'montaj-read-boundary-work-'))
    try {
      const shim = join(work, 'shim.jsx')
      writeFileSync(shim, generateShim(comp, { title: 'hi' }, 30, 30, null))
      const r = await esbuild.build({
        ...overlayEsbuildOptions({ boundary: overlayReadBoundary({ workDir: work, files: [comp] }) }),
        entryPoints: [shim], outfile: join(work, 'b.js'), write: false, metafile: true,
      })
      const keys = Object.keys(r.metafile.inputs).map(k => join(RENDER, k))
      const reactReal = realpathSync(join(RENDER, 'node_modules', 'react'))
      const reactDomReal = realpathSync(join(RENDER, 'node_modules', 'react-dom'))
      assert.ok(keys.some(k => k.startsWith(reactReal)), 'react from render\'s node_modules')
      assert.ok(keys.some(k => k.startsWith(reactDomReal)), 'react-dom from render\'s node_modules')
      assert.ok(!keys.some(k => /overlay-runtime\/node_modules\/react\//.test(k)), 'no second React')
      assert.ok(keys.includes(realpathSync(join(RENDER, 'core', 'index.js'))), 'montaj/render')
      assert.deepEqual(overlayInputsFromMetafile(r.metafile, RENDER, { exclude: [work] }), [realpathSync(comp)])
    } finally { rmSync(work, { recursive: true, force: true }) }
  })
})
