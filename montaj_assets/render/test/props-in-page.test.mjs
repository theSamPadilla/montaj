// render/test/props-in-page.test.mjs
//
// §734: an overlay's big props (a 3D shot carries its whole scene, 85 to 100 MB on a real project) ride in the page's HTML as
// a JSON data block, not as a string literal in the shim, so esbuild never parses them; small props stay in the shim byte for
// byte. And a sample sheet that may draw 3D runs at most SCENE3D_MAX_WORKERS lanes, as an export of 3D does.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import {
  generateShim, bundleComponent, cleanupBundle, generateHtml, shimPropsJson, propsDataBlock, withPropsDataBlock,
  PROPS_IN_PAGE_MIN_BYTES, PROPS_DATA_BLOCK_ID,
} from '../bundle.js'
import { sheetLanes, lanesFor, projectHas3d } from '../sample-frame.js'
import { SCENE3D_MAX_WORKERS } from '../memory.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'props-in-page-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

/** The shim as it was made before §734: the props' text inline. */
const inlineShimProps = (props) => `const __props = ${JSON.stringify(props)}`

describe('the shim', () => {
  test('small props: the shim declares them inline, exactly as before (the caller\'s text or its own)', () => {
    const props = { title: 'Hi', n: 3, list: [1, 2] }
    const own = generateShim('/x/Card.jsx', props, 30, 60)
    const given = generateShim('/x/Card.jsx', props, 30, 60, null, { propsJson: shimPropsJson(props) })
    assert.equal(given, own)
    assert.ok(own.includes(inlineShimProps(props)))
    assert.ok(!own.includes(PROPS_DATA_BLOCK_ID))
  })

  test('props in the page: the shim reads the data block, holds no props text, and drops the block after reading it', () => {
    const shim = generateShim('/x/Card.jsx', { sceneJson: 'x'.repeat(1000) }, 30, 60, null, { propsInPage: true })
    assert.ok(!shim.includes('x'.repeat(1000)))
    assert.match(shim, new RegExp(`document\\.getElementById\\("${PROPS_DATA_BLOCK_ID}"\\)`))
    assert.match(shim, /const __props = JSON\.parse\(__propsBlock\.textContent\)/)
    assert.match(shim, /__propsBlock\.remove\(\)/)
    assert.match(shim, /window\.props {7}= __props/)
  })

  test('the data block: no text in the props can end the element or open a comment, and it parses back to the same props', () => {
    const props = { a: '</script><script>alert(1)</script>', b: '<!-- x -->', c: 'plain', d: { e: [1, '<'] } }
    const block = propsDataBlock(shimPropsJson(props))
    const inner = block.slice(block.indexOf('>') + 1, block.lastIndexOf('</script>'))
    assert.ok(!inner.includes('<'))
    assert.deepEqual(JSON.parse(inner), props)
    assert.ok(block.startsWith(`<script type="application/json" id="${PROPS_DATA_BLOCK_ID}">`))
  })

  test('the page: the block sits just before the bundle\'s script, once', () => {
    const html = withPropsDataBlock(generateHtml(1080, 1920), '{"a":1}')
    const block = html.indexOf(`id="${PROPS_DATA_BLOCK_ID}"`)
    const script = html.indexOf('<script type="module" src="bundle.js"></script>')
    assert.ok(block > 0 && block < script)
    assert.equal(html.split(PROPS_DATA_BLOCK_ID).length, 2)
    assert.throws(() => withPropsDataBlock('<html></html>', '{}'), /no bundle script/)
  })
})

describe('bundleComponent', () => {
  const component = join(scratch, 'Card.jsx')
  writeFileSync(component, 'export default function Card(props) { return <div>{String(props.sceneJson || props.title).length}</div> }\n')

  test('props under the threshold stay in the bundle, and the page has no data block', async () => {
    const props = { title: 'small' }
    const b = await bundleComponent({ componentPath: component, props, fps: 30, durationFrames: 30, width: 100, height: 100 })
    try {
      const html = readFileSync(b.htmlPath, 'utf8')
      assert.ok(!html.includes(PROPS_DATA_BLOCK_ID))
      assert.ok(readFileSync(join(b.workDir, 'shim.jsx'), 'utf8').includes(inlineShimProps(props)))
    } finally { cleanupBundle(b.workDir) }
  })

  test('props at the threshold go into the page: the bundle holds none of their text, the page holds all of it', async () => {
    const big = 'q'.repeat(PROPS_IN_PAGE_MIN_BYTES)
    const props = { sceneJson: big, inPoint: 0 }
    const b = await bundleComponent({ componentPath: component, props, fps: 30, durationFrames: 30, width: 100, height: 100 })
    try {
      const bundle = readFileSync(join(b.workDir, 'bundle.js'), 'utf8')
      const html = readFileSync(b.htmlPath, 'utf8')
      assert.ok(!bundle.includes(big), 'the scene text is not in the bundle')
      assert.ok(html.includes(propsDataBlock(shimPropsJson(props))), 'the page carries the props')
      assert.ok(bundle.includes(PROPS_DATA_BLOCK_ID))
    } finally { cleanupBundle(b.workDir) }
  })
})

describe('sample sheet lanes', () => {
  test('a sheet that may draw 3D runs at most SCENE3D_MAX_WORKERS lanes; one without keeps lanesFor', () => {
    assert.equal(SCENE3D_MAX_WORKERS, 2)
    for (const n of [1, 2, 3, 6, 9, 11, 12, 24]) {
      assert.equal(sheetLanes(n, false), lanesFor(n))
      assert.equal(sheetLanes(n, true), Math.min(lanesFor(n), SCENE3D_MAX_WORKERS))
    }
    assert.equal(sheetLanes(11, true), 2)
  })

  test('projectHas3d: any engine:scene3d item on any track; none, or an unreadable project, is false', () => {
    const write = (name, project) => { const f = join(scratch, name); writeFileSync(f, JSON.stringify(project)); return f }
    assert.equal(projectHas3d(write('3d.json', { tracks: [{ id: 't', items: [{ type: 'overlay', src: 'overlays/a.jsx' }] }, { id: 'u', items: [{ type: 'overlay', src: 'engine:scene3d', props: { scene: 's01' } }] }] })), true)
    assert.equal(projectHas3d(write('flat.json', { tracks: [{ id: 't', items: [{ type: 'overlay', src: 'overlays/a.jsx' }] }] })), false)
    assert.equal(projectHas3d(join(scratch, 'missing.json')), false)
  })
})
