// render/test/preview-bundle.test.mjs
//
// PV49 T1a. The editor preview runs an overlay by evaluating its module body
// inside `new Function('React','frame','fps','duration','props', ...globals)`,
// once per frame. preview-bundle.js bundles the overlay with render's own
// esbuild options so imports work there too. These tests run the bundle inside
// a copy of that wrapper, with real React 19 and real
// makeOverlayGlobals('preview'), and render the result with react-dom/server.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, realpathSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeOverlayGlobals } from 'montaj-overlay-runtime'
import { bundleComponent, cleanupBundle } from '../bundle.js'
import {
  bundleOverlayForPreview,
  PreviewBuildError,
  PREVIEW_GLOBAL_NAME,
  WHOLE_PACKAGE_GLOBALS,
  SUBSET_PACKAGE_GLOBALS,
  SHIMMED_SPECIFIERS,
  previewModuleSource,
} from '../preview-bundle.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDER    = join(__dirname, '..')
const FIX       = join(__dirname, 'fixtures', 'preview-bundle')
const CLI       = join(RENDER, 'preview-bundle.js')

// The fixtures stand in for the user's workspace (PV54): their imports of one
// another are allowed only under a root of the read boundary (overlay-build.js),
// and an overlay's own folder is not one. Read at each build, and inherited by
// the CLI children below; node --test runs each file in its own process.
process.env.MONTAJ_WORKSPACE_DIR = FIX

// The same globals the preview injects (overlay-eval.ts getOverlayGlobals).
const GLOBALS      = makeOverlayGlobals('preview')
const GLOBAL_NAMES = Object.keys(GLOBALS)
const GLOBAL_VALUES = Object.values(GLOBALS)
const WRAPPER_NAMES = new Set(['React', 'frame', 'fps', 'duration', 'props', ...GLOBAL_NAMES])

// A copy of the preview wrapper's shape (desktop/ui/src/lib/overlay-eval.ts):
// the same parameter list, strict mode, the bundle's code, then a direct call
// of the default export with frame/fps/duration merged over props.
function makeFactory(code) {
  // eslint-disable-next-line no-new-func
  const fn = new Function('React', 'frame', 'fps', 'duration', 'props', ...GLOBAL_NAMES,
    `"use strict";\n${code}\nvar __Component = ${PREVIEW_GLOBAL_NAME}.default;\nif (typeof __Component !== 'function') return null;\nreturn __Component({ frame, fps, duration, ...props });`)
  return (frame, props = {}, ReactArg = React) => fn(ReactArg, frame, 30, 90, props, ...GLOBAL_VALUES)
}

async function build(rel) {
  return bundleOverlayForPreview(join(FIX, rel))
}

async function buildError(rel) {
  try {
    await build(rel)
  } catch (err) {
    return err
  }
  assert.fail(`${rel} was expected to fail to build`)
}

// Render's side of a parity check: bundle `componentPath` exactly as render
// does, through bundleComponent. Resolves on success (and cleans up), rejects
// with esbuild's error on failure. bundleComponent leaves its work dir behind
// when esbuild fails, so TMPDIR points into a dir this file owns and removes;
// os.tmpdir() reads TMPDIR on every call, and node --test gives each test file
// its own process, so no other file sees the change.
let renderTmp
async function renderBundle(componentPath) {
  renderTmp ??= mkdtempSync(join(tmpdir(), 'montaj-preview-parity-'))
  const prev = process.env.TMPDIR
  process.env.TMPDIR = renderTmp
  try {
    const { workDir } = await bundleComponent({
      componentPath, props: {}, fps: 30, durationFrames: 30, width: 64, height: 64,
    })
    cleanupBundle(workDir)
  } finally {
    if (prev === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = prev
  }
}
after(() => { if (renderTmp) rmSync(renderTmp, { recursive: true, force: true }) })

async function renderError(componentPath) {
  try {
    await renderBundle(componentPath)
  } catch (err) {
    return err
  }
  assert.fail(`render was expected to reject ${componentPath}`)
}

// The seven packages overlay-runtime depends on that render cannot resolve
// from a user's overlay (they are not in render's node_modules).
const RENDER_UNRESOLVABLE = [
  'three',
  '@react-three/fiber',
  'recharts',
  '@phosphor-icons/react',
  '@fortawesome/react-fontawesome',
  '@fortawesome/free-solid-svg-icons',
  '@fortawesome/free-brands-svg-icons',
]

describe('preview bundle: the import chain', () => {
  let out
  before(async () => { out = await build('chain/entry.jsx') })

  test('inputs are exactly entry.jsx, lib/a.js and lib/b.js, absolute and sorted', () => {
    assert.deepEqual(out.inputs, [
      join(FIX, 'chain', 'entry.jsx'),
      join(FIX, 'chain', 'lib', 'a.js'),
      join(FIX, 'chain', 'lib', 'b.js'),
    ])
  })

  test('the helper and the child component both see each call\'s frame', () => {
    const factory = makeFactory(out.code)
    const at7  = factory(7)
    const at42 = factory(42)
    // Render the frame-7 tree AFTER the frame-42 call: each call re-runs the
    // module body, so the frame-7 tree's closures still hold 7.
    const html7  = renderToStaticMarkup(at7)
    const html42 = renderToStaticMarkup(at42)
    assert.match(html7,  /<span data-helper="">helper:7<\/span>/)
    assert.match(html7,  /<span data-child="">child:7<\/span>/)
    assert.match(html42, /<span data-helper="">helper:42<\/span>/)
    assert.match(html42, /<span data-child="">child:42<\/span>/)
  })

  test('the free identifiers are left for the wrapper, not renamed or declared', () => {
    // Belt to the behavioural test above: the bundle reads `frame` and `React`
    // by those exact names and declares neither.
    assert.match(out.code, /`helper:\$\{frame\}`/)
    assert.match(out.code, /`child:\$\{frame\}`/)
    assert.match(out.code, /React\.createElement\(/)
    assert.doesNotMatch(out.code, /\b(?:var|let|const|function)\s+(?:frame|React)\b/)
  })
})

describe('preview bundle: identifiers', () => {
  test('a module-level binding named like a global is renamed, and the free one still binds', async () => {
    const { code } = await build('shadow.jsx')
    const html = renderToStaticMarkup(makeFactory(code)(5))
    assert.equal(html, '<div>module-frame/module-three|5|function</div>')
  })
})

describe('preview bundle: React', () => {
  let out
  before(async () => { out = await build('react-import.jsx') })

  test('`import React, { useMemo }` and a file with no React import both get the React passed in', () => {
    let calls = 0
    const spy = { ...React, createElement: (...args) => { calls++; return React.createElement(...args) } }
    let seen
    const el = makeFactory(out.code)(3, { seen: s => { seen = s } }, spy)
    const html = renderToStaticMarkup(el)
    assert.equal(seen.React, spy, 'the default import is the React the wrapper was called with')
    assert.equal(seen.useMemo, React.useMemo, 'a named import reads through to the passed React')
    // Memo's <b>, the root <div>, both JSX calls in the entry, plus NoImport's
    // createElement in lib/no-react-import.js: the spy saw all of them.
    assert.ok(calls >= 4, `spy.createElement ran ${calls} times`)
    assert.equal(html, '<div><b data-memo="">memo:3</b><i>no-import</i></div>',
      'useMemo ran under react-dom/server, so the hooks dispatcher is the real one')
  })

  test('the bundle does not carry React\'s own source', () => {
    assert.ok(out.code.length < 10_000, `bundle is ${out.code.length} bytes`)
    assert.doesNotMatch(out.code, /react\.transitional\.element|__CLIENT_INTERNALS|ReactSharedInternals/)
    assert.deepEqual(out.inputs, [join(FIX, 'lib', 'no-react-import.js'), join(FIX, 'react-import.jsx')])
  })

  test('an automatic-runtime file gets jsx/jsxs/Fragment built on the passed React', async () => {
    const { code } = await build('auto-runtime.jsx')
    assert.doesNotMatch(code, /react\.transitional\.element|ReactSharedInternals/)
    const el = makeFactory(code)(9)
    // Static JSX siblings (jsxs) must not trip development React's missing-key
    // warning, which the real runtime does not raise for them either.
    const errors = []
    const origError = console.error
    console.error = (...args) => { errors.push(args.join(' ')) }
    let html
    try { html = renderToStaticMarkup(el) } finally { console.error = origError }
    assert.equal(html, '<ul><li>a9</li><li>b9</li><li data-k=""></li></ul>')
    assert.deepEqual(errors.filter(e => /key/.test(e)), [])
    // Key handling: the key argument is used, and a `key` inside props wins.
    const [mapped, fragment] = el.props.children
    assert.deepEqual(mapped.map(c => c.key), ['a', 'b'])
    assert.equal(fragment.type, React.Fragment)
    assert.equal(fragment.props.children.key, 'from-props')
  })
})

describe('preview bundle: shimmed packages map onto the preview globals', () => {
  test('each import is the global the wrapper passed in', async () => {
    const { code, inputs } = await build('shims.jsx')
    let seen
    const html = renderToStaticMarkup(makeFactory(code)(0, { seen: s => { seen = s } }))
    assert.equal(html, '<div>2</div>')
    const g = GLOBALS
    assert.equal(seen.React, React, 'react default')
    assert.equal(seen.useMemo, React.useMemo, 'react named')
    assert.equal(typeof seen.jsx, 'function', 'react/jsx-runtime')
    assert.equal(typeof seen.jsxDEV, 'function', 'react/jsx-dev-runtime')
    assert.equal(seen.interpolate, g.interpolate, 'montaj/render')
    assert.equal(seen.useThreeFrame, g.useThreeFrame, 'montaj/render useThreeFrame is the preview one')
    for (const name of ['springStep', 'Canvas', 'FaIcon', 'THREE', 'Ph', 'FaSolid', 'FaBrands', 'BarChart']) {
      assert.equal(seen[name], g[name], `montaj-overlay-runtime ${name}`)
    }
    assert.deepEqual(inputs, [join(FIX, 'shims.jsx')], 'no virtual module and no engine file is an input')
    assert.ok(code.length < 20_000, `no library source bundled (${code.length} bytes)`)
  })

  test('the shimmed specifiers are exactly the ones render resolves', () => {
    assert.deepEqual([...SHIMMED_SPECIFIERS].sort(), [
      'montaj-overlay-runtime',
      'montaj/render',
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-dev-runtime',
      'react/jsx-runtime',
    ])
    for (const spec of RENDER_UNRESOLVABLE) assert.ok(!SHIMMED_SPECIFIERS.includes(spec), spec)
  })

  test('render resolves every shimmed specifier (shims.jsx builds through bundleComponent)', async () => {
    // shims.jsx must import every shimmed specifier, or this proves less than it says.
    const src = readFileSync(join(FIX, 'shims.jsx'), 'utf8')
    const imported = [...src.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1]).sort()
    assert.deepEqual(imported, [...SHIMMED_SPECIFIERS].sort())
    await renderBundle(join(FIX, 'shims.jsx'))
  })

  test('the shim tables match what the wrapper really has in scope', async () => {
    // montaj-overlay-runtime is exactly the preview globals.
    assert.deepEqual(Object.keys(SUBSET_PACKAGE_GLOBALS['montaj-overlay-runtime']).sort(), [...GLOBAL_NAMES].sort())
    // montaj/render is exactly what render's core/index.js exports, so a name
    // render cannot import fails in the preview too.
    const core = await import('../core/index.js')
    assert.deepEqual(Object.keys(SUBSET_PACKAGE_GLOBALS['montaj/render']).sort(), Object.keys(core).sort())
    // Every identifier a virtual module reads is one the wrapper binds.
    for (const glob of Object.values(WHOLE_PACKAGE_GLOBALS)) assert.ok(WRAPPER_NAMES.has(glob), glob)
    for (const [spec, map] of Object.entries(SUBSET_PACKAGE_GLOBALS)) {
      for (const glob of Object.values(map)) assert.ok(WRAPPER_NAMES.has(glob), `${spec}: ${glob}`)
    }
    for (const spec of SHIMMED_SPECIFIERS) assert.ok(previewModuleSource(spec), spec)
  })
})

describe('preview bundle: build failures', () => {
  test('`from \'remotion\'` fails, naming the package and the file', async () => {
    const err = await buildError('remotion.jsx')
    assert.ok(err instanceof PreviewBuildError, String(err))
    assert.equal(err.message, `${join(FIX, 'remotion.jsx')}:1:32: Could not resolve "remotion"`)
  })

  test('`import * as THREE from \'three\'` fails in the preview naming three, and render rejects it too', async () => {
    const file = join(FIX, 'three-import.jsx')
    const err = await buildError('three-import.jsx')
    assert.ok(err instanceof PreviewBuildError, String(err))
    assert.equal(err.message, `${file}:4:23: Could not resolve "three"`)
    const renderErr = await renderError(file)
    assert.equal(renderErr.errors?.[0]?.text, 'Could not resolve "three"', String(renderErr))
    assert.match(renderErr.errors[0].location.file, /three-import\.jsx$/)
  })

  test('every package render cannot resolve fails the same way in both', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'montaj-preview-unresolvable-'))
    try {
      for (const spec of RENDER_UNRESOLVABLE) {
        const file = join(realpathSync(dir), `${spec.replace(/[@/]/g, '_')}.jsx`)
        writeFileSync(file, `import * as M from '${spec}'\nexport default function P() { return <div>{Object.keys(M).length}</div> }\n`)
        let previewErr
        try { await bundleOverlayForPreview(file) } catch (e) { previewErr = e }
        assert.ok(previewErr instanceof PreviewBuildError, `${spec}: preview built it`)
        assert.equal(previewErr.message, `${file}:1:19: Could not resolve "${spec}"`)
        const renderErr = await renderError(file)
        assert.equal(renderErr.errors?.[0]?.text, `Could not resolve "${spec}"`, `${spec}: ${renderErr}`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a name the preview lacks from a shimmed package fails naming it, and render rejects it too', async () => {
    const file = join(FIX, 'missing-export.jsx')
    const err = await buildError('missing-export.jsx')
    assert.ok(err instanceof PreviewBuildError, String(err))
    assert.match(err.message, /missing-export\.jsx:3:9: /)
    assert.match(err.message, /No matching export in "montaj-preview-globals:montaj\/render" for import "springStep"/)
    const renderErr = await renderError(file)
    assert.match(renderErr.errors?.[0]?.text ?? String(renderErr), /No matching export in ".*core\/index\.js" for import "springStep"/)
  })

  test('a relative path is refused before esbuild sees it', async () => {
    await assert.rejects(bundleOverlayForPreview('chain/entry.jsx'), TypeError)
  })
})

describe('preview bundle: TypeScript', () => {
  test('a .tsx entry builds and runs, and its .js import is an input', async () => {
    const { code, inputs } = await build('typed.tsx')
    const html = renderToStaticMarkup(makeFactory(code)(11, { title: 'ts' }))
    assert.equal(html, '<p>ts:11:helper:11</p>')
    assert.deepEqual(inputs, [
      join(FIX, 'chain', 'lib', 'a.js'),
      join(FIX, 'chain', 'lib', 'b.js'),
      join(FIX, 'typed.tsx'),
    ])
  })
})

describe('preview bundle: working dir', () => {
  // Inferred cause of "build failed" on every overlay in an app: the preview
  // used process.cwd() (the app bundle) as esbuild's working dir. Export keeps
  // it in render's own dir, so the preview must not depend on the cwd at all.
  test('builds with a process cwd that no longer exists', async () => {
    const start = process.cwd()
    const tmp = mkdtempSync(join(tmpdir(), 'pv-cwd-'))
    const gone = join(tmp, 'gone')
    mkdirSync(gone)
    process.chdir(gone)
    rmSync(gone, { recursive: true })
    try {
      const out = await bundleOverlayForPreview(join(FIX, 'chain', 'entry.jsx'))
      assert.ok(out.code.length > 0)
    } finally {
      process.chdir(start)
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('preview bundle: CLI', () => {
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: RENDER })

  test('success prints one JSON line with code and inputs, exit 0', () => {
    const r = run(join(FIX, 'chain', 'entry.jsx'))
    assert.equal(r.status, 0, r.stderr)
    const lines = r.stdout.split('\n')
    assert.equal(lines.length, 2, 'one line plus the trailing newline')
    assert.equal(lines[1], '')
    const j = JSON.parse(lines[0])
    assert.equal(j.ok, true)
    assert.deepEqual(j.inputs, [
      join(FIX, 'chain', 'entry.jsx'),
      join(FIX, 'chain', 'lib', 'a.js'),
      join(FIX, 'chain', 'lib', 'b.js'),
    ])
    assert.equal(renderToStaticMarkup(makeFactory(j.code)(4)),
      '<div data-overlay="chain"><span data-helper="">helper:4</span><span data-child="">child:4</span></div>')
  })

  test('a build failure prints one JSON line, exit 2', () => {
    const r = run(join(FIX, 'remotion.jsx'))
    assert.equal(r.status, 2, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), {
      ok: false,
      error: 'build_failed',
      message: `${join(FIX, 'remotion.jsx')}:1:32: Could not resolve "remotion"`,
    })
  })

  test('usage and missing-file errors go to stderr, exit 1, nothing on stdout', () => {
    for (const args of [[], ['relative/overlay.jsx'], [join(FIX, 'no-such-file.jsx')], [FIX]]) {
      const r = run(...args)
      assert.equal(r.status, 1, `${JSON.stringify(args)}: ${r.stdout}`)
      assert.equal(r.stdout, '', JSON.stringify(args))
      assert.ok(r.stderr.length > 0, JSON.stringify(args))
    }
  })
})
