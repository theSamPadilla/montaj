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
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import esbuild from 'esbuild'
import { overlayEsbuildOptions } from '../overlay-build.js'
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

describe('overlayEsbuildOptions', () => {
  test('equals the literal it replaces', () => {
    assert.deepEqual(overlayEsbuildOptions(), LEGACY_OPTIONS)
  })

  test('returns a fresh object each call', () => {
    const a = overlayEsbuildOptions()
    a.alias.react = '/elsewhere'
    a.loader['.jsx'] = 'js'
    a.nodePaths.push('/elsewhere')
    a.define['process.env.NODE_ENV'] = '"development"'
    a.format = 'iife'
    assert.deepEqual(overlayEsbuildOptions(), LEGACY_OPTIONS)
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

  const buildWith = (options, shim) => esbuild.build({
    ...options,
    entryPoints: [shim],
    outfile:     join(dir, 'bundle.js'),
    write:       false,
  })

  for (const name of ['plain', 'keyframed', 'three']) {
    test(`${name} shim`, async () => {
      const legacy = await buildWith(LEGACY_OPTIONS, shims[name])
      const shared = await buildWith(overlayEsbuildOptions(), shims[name])
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
      { ...overlayEsbuildOptions(), define: { 'process.env.NODE_ENV': '"development"' } }, shims.plain)
    assert.notEqual(sha(changed.outputFiles[0].contents), sha(legacy.outputFiles[0].contents))
  })
})
