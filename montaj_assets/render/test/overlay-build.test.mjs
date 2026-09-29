// render/test/overlay-build.test.mjs
//
// PV49 T1a. overlay-build.js's overlayEsbuildOptions() replaces the esbuild
// literal that bundle.js and render-carousel.js each carry today. The switch is
// only safe if render's output does not move by a byte, so this builds three
// real render shims twice, once with the literal and once with the shared
// options, and compares the bytes.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'crypto'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'fs'
import { join, dirname, relative } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import esbuild from 'esbuild'
import {
  overlayEsbuildOptions, overlayInputsFromMetafile, overlayReadBoundary, PREVIEW_NAMESPACE, READ_BOUNDARY_PLUGIN,
} from '../overlay-build.js'
import { generateShim } from '../bundle.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDER    = join(__dirname, '..')

// The literal from bundle.js:85-109 at montaj 2822c79, minus the per-call
// fields (entryPoints, outfile). render-carousel.js:342-364 carries the same
// values at that commit. Frozen here on purpose: it is what the shared options
// must keep reproducing after both files switch to them.
const LEGACY_OPTIONS = {
  bundle:      true,
  format:      'esm',
  platform:    'browser',
  jsx:         'automatic',
  loader:      { '.jsx': 'jsx', '.js': 'js', '.tsx': 'tsx', '.ts': 'ts' },
  alias: {
    'montaj/render':  join(RENDER, 'core', 'index.js'),
    'react':          join(RENDER, 'node_modules', 'react'),
    'react-dom':      join(RENDER, 'node_modules', 'react-dom'),
    'react-dom/client': join(RENDER, 'node_modules', 'react-dom', 'client'),
  },
  nodePaths: [join(RENDER, 'node_modules')],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'silent',
}

const PLAIN_OVERLAY = `import { interpolate } from 'montaj/render'
export default function Title({ title }) {
  const opacity = interpolate(frame, [0, 15], [0, 1])
  return <h1 style={{ opacity }}>{title}</h1>
}
`

const THREE_OVERLAY = `import { useThreeFrame } from 'montaj/render'
function Box() {
  useThreeFrame()
  const color = new THREE.Color('#ff0055')
  return (
    <mesh rotation={[0, frame / 30, 0]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial color={color} />
    </mesh>
  )
}
export default function Spin() {
  return <Canvas frameloop="never"><Box /></Canvas>
}
`

const BAKE = {
  offsetX: 5, offsetY: -10, scale: 0.5, scaleX: 0.5, scaleY: 0.5, rotation: 12, opacity: 0.8,
  keyframes: [
    { prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 2, value: 25 }] },
    { prop: 'opacity', points: [{ t: 0, value: 0, easing: 'ease-out' }, { t: 1, value: 1 }] },
  ],
}

const sha = buf => createHash('sha256').update(buf).digest('hex')

// PV54 added one field on purpose: `plugins`, holding the read-boundary guard.
// Everything else is still the literal, and the byte-identity tests below build
// with the REAL guard in place, so an allowed file must still build unchanged.
const ANY_BOUNDARY = { allows: () => true }
const withoutGuard = ({ plugins, ...rest }) => rest

// esbuild reads config files while RESOLVING, before any hook runs: it walks up
// from each input for tsconfig.json and reads package.json for main/module/
// browser. Those walks can leave the read boundary, so the shared options pin
// them. Stripped here rather than added to LEGACY_OPTIONS, which is frozen as
// the pre-guard baseline the bundle output must keep reproducing — and it still
// does: the byte-identical suite below covers exactly that.
const withoutResolutionScoping = ({ tsconfigRaw, absWorkingDir, ...rest }) => rest

describe('overlayEsbuildOptions', () => {
  test('equals the literal it replaces, plus the read-boundary guard', () => {
    const options = overlayEsbuildOptions({ boundary: ANY_BOUNDARY })
    assert.deepEqual(withoutResolutionScoping(withoutGuard(options)), LEGACY_OPTIONS)
    assert.deepEqual(options.plugins.map(p => p.name), [READ_BOUNDARY_PLUGIN])
  })

  test('pins esbuild config discovery so resolution cannot leave the boundary', () => {
    const options = overlayEsbuildOptions({ boundary: ANY_BOUNDARY })
    // Supplied inline, so no tsconfig.json is ever searched for up the tree.
    assert.deepEqual(options.tsconfigRaw, {})
    // Relative resolution starts at render's own dir, not the caller's cwd.
    assert.equal(options.absWorkingDir, RENDER)
  })

  test('returns a fresh object each call', () => {
    const a = overlayEsbuildOptions({ boundary: ANY_BOUNDARY })
    a.alias.react = '/elsewhere'
    a.loader['.jsx'] = 'js'
    a.nodePaths.push('/elsewhere')
    a.define['process.env.NODE_ENV'] = '"development"'
    a.format = 'iife'
    a.plugins.length = 0
    a.tsconfigRaw.compilerOptions = { jsx: 'preserve' }
    const b = overlayEsbuildOptions({ boundary: ANY_BOUNDARY })
    assert.deepEqual(withoutResolutionScoping(withoutGuard(b)), LEGACY_OPTIONS)
    assert.deepEqual(b.tsconfigRaw, {})
    assert.equal(b.plugins.length, 1)
  })

  test('(c) refuses to build options without a read boundary', () => {
    // Required, so no caller can bundle an overlay with its imports unbounded.
    for (const args of [[], [{}], [{ boundary: null }], [{ boundary: {} }]]) {
      assert.throws(() => overlayEsbuildOptions(...args), /read boundary is required/)
    }
  })
})

describe('overlayEsbuildOptions: esbuild output is byte-identical to the literal', () => {
  let dir
  const shims = {}
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'montaj-overlay-build-'))
    const plain = join(dir, 'plain.jsx')
    const three = join(dir, 'three.jsx')
    writeFileSync(plain, PLAIN_OVERLAY)
    writeFileSync(three, THREE_OVERLAY)
    const props = { title: 'hi', img: '/abs/pic.png' }
    for (const [name, component, bake] of [
      ['plain',     plain, null],
      ['keyframed', plain, BAKE],
      ['three',     three, null],
    ]) {
      const shim = join(dir, `shim-${name}.jsx`)
      writeFileSync(shim, generateShim(component, props, 30, 90, bake))
      shims[name] = shim
    }
  })
  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  // The legacy literal gets the shared options' absWorkingDir, which esbuild's
  // `// path` comments are relative to: without it the two builds differ
  // whenever the cwd is not render's dir, whatever the options.
  const buildWith = (options, shim) => esbuild.build({
    absWorkingDir: RENDER,
    ...options,
    entryPoints: [shim],
    outfile:     join(dir, 'bundle.js'),
    write:       false,
  })

  for (const name of ['plain', 'keyframed', 'three']) {
    test(`${name} shim`, async () => {
      const legacy = await buildWith(LEGACY_OPTIONS, shims[name])
      // The real guard: the shim and the overlay are in `dir`, the bundle's
      // work dir, and everything else they load is engine.
      const shared = await buildWith(overlayEsbuildOptions({ boundary: overlayReadBoundary({ workDir: dir }) }), shims[name])
      assert.equal(legacy.outputFiles.length, 1)
      assert.equal(shared.outputFiles.length, 1)
      const a = legacy.outputFiles[0].contents
      const b = shared.outputFiles[0].contents
      // A real render bundle: React, the runtime and the overlay are all in it.
      assert.ok(a.length > 100_000, `legacy bundle is ${a.length} bytes`)
      assert.equal(sha(b), sha(a))
      assert.ok(Buffer.from(a).equals(Buffer.from(b)))
      if (name === 'keyframed') assert.match(legacy.outputFiles[0].text, /geometryAt/)
      if (name === 'three')     assert.match(legacy.outputFiles[0].text, /ff0055/)
    })
  }

  test('the comparison can fail: a changed option changes the bytes', async () => {
    // Without this, a comparison that always matched (both builds empty, or
    // the options ignored) would pass the three tests above just the same.
    const legacy  = await buildWith(LEGACY_OPTIONS, shims.plain)
    const changed = await buildWith(
      { ...overlayEsbuildOptions({ boundary: overlayReadBoundary({ workDir: dir }) }), define: { 'process.env.NODE_ENV': '"development"' } }, shims.plain)
    assert.notEqual(sha(changed.outputFiles[0].contents), sha(legacy.outputFiles[0].contents))
  })
})

describe('overlayInputsFromMetafile', () => {
  // Metafile keys are paths relative to the build's working dir, as esbuild
  // writes them. `dir` is a realpath, so the keys below are what esbuild would
  // report for these files.
  let dir
  before(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-overlay-inputs-'))) })
  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  const metafileOf = (cwd, files) => ({ inputs: Object.fromEntries(files.map(f => [relative(cwd, f), {}])) })

  test('a file under an excluded dir is dropped and its sibling is kept', () => {
    const work    = join(dir, 'work')
    const shim    = join(work, 'shim.jsx')
    const overlay = join(dir, 'overlay.jsx')
    const nearby  = join(dir, 'work2', 'helper.js')   // shares the prefix "work", is not under it
    const metafile = metafileOf(dir, [shim, overlay, nearby])
    assert.deepEqual(overlayInputsFromMetafile(metafile, dir, { exclude: [work] }), [overlay, nearby])
    assert.deepEqual(overlayInputsFromMetafile(metafile, dir), [overlay, shim, nearby].sort(),
      'without exclude, the same file is kept')
  })

  test('an excluded dir given through a symlink still drops the realpath esbuild reports', () => {
    // bundle.js's work dir is join(tmpdir(), …): /var/folders/… on macOS,
    // which esbuild reports as /private/var/folders/….
    const real = join(dir, 'real')
    const link = join(dir, 'link')
    mkdirSync(join(real, 'work'), { recursive: true })
    symlinkSync(real, link)
    const shim    = join(real, 'work', 'shim.jsx')
    const overlay = join(real, 'overlay.jsx')
    const metafile = metafileOf(dir, [shim, overlay])
    assert.deepEqual(overlayInputsFromMetafile(metafile, dir, { exclude: [join(link, 'work')] }), [overlay])
  })

  test('drops the preview\'s virtual modules and engine files, keeps the rest', () => {
    const overlay = join(dir, 'overlay.jsx')
    const metafile = { inputs: {
      [relative(dir, overlay)]: {},
      [`${PREVIEW_NAMESPACE}:react`]: {},
      [relative(dir, join(RENDER, 'node_modules', 'react', 'index.js'))]: {},
      [relative(dir, join(RENDER, 'core', 'index.js'))]: {},
    } }
    assert.deepEqual(overlayInputsFromMetafile(metafile, dir), [overlay])
  })
})
