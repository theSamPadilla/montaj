// render/test/static-text-container.test.mjs
//
// §621: static-text's `runs` inside a pill and container props (padX, padY,
// radius, borderColor, borderWidth, letterSpacing, hug), proven by server-side
// rendering of the template: no browser. The default-output snapshot was
// captured from the template as it stood before the container props.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = resolve(here, '..', 'templates', 'overlays', 'static-text', 'static-text.jsx')

// render/ has its own deps; the editor's copy serves a checkout that has only that.
const base = [resolve(here, '..'), resolve(here, '..', '..', 'editor')]
  .find(d => existsSync(join(d, 'node_modules', 'esbuild')) && existsSync(join(d, 'node_modules', 'react-dom')))
const skip = base ? false : 'esbuild and react-dom are not installed'

let render
let dir
if (!skip) {
  const req = createRequire(join(base, 'package.json'))
  const esbuild = req('esbuild')
  const React = req('react')
  const { renderToStaticMarkup } = req('react-dom/server')
  dir = mkdtempSync(join(tmpdir(), 'static-text-container-'))
  const out = join(dir, 'static-text.cjs')
  esbuild.buildSync({
    entryPoints: [TEMPLATE], outfile: out, bundle: true, format: 'cjs',
    jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
    banner: { js: `const React = require(${JSON.stringify(req.resolve('react'))});` }, external: ['react'], logLevel: 'silent',
  })
  const mod = createRequire(join(base, 'package.json'))(out)
  render = (props) => renderToStaticMarkup(React.createElement(mod.default, props))
}
test.after(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const opts = { skip }

test('defaults: output is unchanged', opts, () => {
  assert.equal(
    render({ text: 'Hello', fontSize: '64' }),
    '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:transparent;padding:6% 8%;box-sizing:border-box;overflow:hidden"><p data-montaj-text="" style="margin:0;font-family:system-ui, -apple-system, &quot;Helvetica Neue&quot;, sans-serif;font-weight:400;font-style:normal;color:#111111;font-size:64px;text-align:center;text-transform:none;line-height:1.2;letter-spacing:-0.01em;width:100%;white-space:pre-wrap;word-break:normal;overflow-wrap:break-word">Hello</p></div>',
  )
})

test('legacy short-key runs still draw', opts, () => {
  const html = render({ text: 'ab', runs: JSON.stringify([{ t: 'a' }, { t: 'b', c: '#ff0000', b: 1 }]) })
  assert.match(html, /<span style="text-decoration-line:none">a<\/span><span style="text-decoration-line:none;color:#ff0000;font-weight:700">b<\/span>/)
})

test('runs draw inside a hugging pill', opts, () => {
  const runs = JSON.stringify([{ t: 'for ' }, { t: 'you', c: '#f6e3a1', i: 1 }])
  const html = render({ text: 'for you', runs, hug: 'true', bgColor: '#222' })
  assert.match(html, /fit-content[^>]*><p data-montaj-text="" [^>]*><span style="text-decoration-line:none">for <\/span><span style="text-decoration-line:none;color:#f6e3a1;font-style:italic">you<\/span><\/p><\/div><\/div>$/)
})

test('runs: malformed or not spelling text fall back to text', opts, () => {
  const plain = render({ text: 'for beginners' })
  for (const runs of ['{not json', '{}', '[{"t":5}]', JSON.stringify([{ t: 'other' }])]) {
    assert.equal(render({ text: 'for beginners', runs }), plain, runs)
  }
})

test('pill: hug keeps the wrapper clear and the pill paints', opts, () => {
  const html = render({
    text: 'Hi', fontSize: '40', bgColor: '#ffe066', hug: 'true', textAlign: 'left',
    padX: '30', padY: '10', radius: '999', borderColor: '#000000', borderWidth: '3', letterSpacing: '0.08', fit: 'true',
  })
  assert.match(html, /^<div style="[^"]*justify-content:flex-start;background:transparent;padding:6% 8%;/)
  assert.match(html, /<div style="width:fit-content;max-width:100%;box-sizing:border-box;background:#ffe066;padding:10px 30px;font-size:40px;border-radius:999px;border:3px solid #000000">/)
  assert.match(html, /letter-spacing:0.08em;width:auto/)
  assert.doesNotMatch(html, /data-fitted-size/)
})

test('pill: padding defaults to 0.35em 0.9em', opts, () => {
  assert.match(render({ text: 'Hi', hug: 'true', bgColor: '#fff' }), /padding:0\.35em 0\.9em/)
})

test('container: border and radius apply to the full box', opts, () => {
  const html = render({ text: 'Hi', bgColor: '#222222', radius: '24', borderColor: '#fff', borderWidth: '2', padX: '40', padY: '20' })
  assert.match(html, /^<div style="[^"]*background:#222222;padding:20px 40px;box-sizing:border-box;overflow:hidden;border-radius:24px;border:2px solid #fff">/)
  assert.doesNotMatch(html, /fit-content/)
})

test('border needs both color and a width above 0', opts, () => {
  assert.doesNotMatch(render({ text: 'Hi', borderColor: '#fff' }), /border:/)
  assert.doesNotMatch(render({ text: 'Hi', borderWidth: '2' }), /border:/)
  assert.doesNotMatch(render({ text: 'Hi', borderColor: '#fff', borderWidth: '0' }), /border:/)
})

test('no hug: bgColor still paints the whole box', opts, () => {
  const html = render({ text: 'Hi', bgColor: '#123456' })
  assert.match(html, /^<div style="[^"]*background:#123456;padding:6% 8%/)
})
