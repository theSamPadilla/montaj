// render/test/export-pages.test.mjs
//
// Overlays as web pages (export-pages.js): the page is the render's own bundle inlined, plus a player. The unit
// tests pin the pieces (no CSP, an inline module, the player, assets copied with relative paths, icons left out
// only when unused); the integration test opens an exported page in headless Chrome and checks it draws the
// overlay's frames and plays by itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer'
import { exportPages, inlinePage, playerScript, relocateProps, usesIcons, listLayers } from '../export-pages.js'
import { overlayPageLaunchOptions } from '../page-guard.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixtures', 'export-pages')

function project(dir) {
  cpSync(FIXTURE, dir, { recursive: true })
  const logo = join(dir, 'logo.jpg')
  writeFileSync(join(dir, 'project.json'), JSON.stringify({
    version: '1', id: 'p', name: 'p', settings: { fps: 30, resolution: [540, 960] },
    tracks: [{ id: 'trk-0', items: [{ id: 'ov1', type: 'overlay', src: 'overlays/Box.jsx', start: 0, end: 2, props: { label: 'Hello', logo } }] }],
  }))
  return join(dir, 'project.json')
}

test('inlinePage: one file, an inline module, the player, no CSP, and a script tag in the code cannot end it', () => {
  const html = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">\n</head>\n<body>\n<div id="root"></div>\n<script type="module" src="bundle.js"></script>\n</body>\n</html>'
  const out = inlinePage(html, 'const s = "</script><b>"; const t = "$& $` $\' $$"; window.__setFrame = () => {}', { title: 'box', fps: 30, frames: 60 })
  assert.doesNotMatch(out, /Content-Security-Policy/)
  assert.doesNotMatch(out, /src="bundle.js"/)
  assert.match(out, /<script type="module">/)
  assert.match(out, /<title>box<\/title>/)
  assert.ok(out.includes('$&') && out.includes('$$'), 'the code goes in as it is: no replacement patterns')
  assert.match(out, /fps = 30, frames = 60/)
  assert.equal(out.match(/<\/script>/g).length, 2, 'the bundle and the player, each closed once')
  assert.throws(() => inlinePage('<html></html>', '', { title: 'x', fps: 30, frames: 1 }), /unexpected shape/)
})

test('playerScript: loops on the frame count and freezes on ?frame=N', () => {
  const s = playerScript(24, 48)
  assert.match(s, /fps = 24, frames = 48/)
  assert.match(s, /% frames/)
  assert.match(s, /q\.has\('frame'\)/)
})

test('relocateProps: a file a prop names is copied beside the page and the prop becomes a relative path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-pages-'))
  try {
    const file = join(dir, 'pic.png')
    writeFileSync(file, 'x')
    const warnings = []
    const copied = new Map()
    const out = relocateProps({ a: file, b: [file, 'plain text', 3], c: join(dir, 'missing.png'), d: 'https://example.com/x.png' }, join(dir, 'out', 'assets'), copied, warnings)
    assert.equal(out.a, 'assets/01-pic.png')
    assert.deepEqual(out.b, ['assets/01-pic.png', 'plain text', 3], 'the same file is copied once')
    assert.equal(out.d, 'https://example.com/x.png')
    assert.equal(existsSync(join(dir, 'out', 'assets', '01-pic.png')), true)
    assert.match(warnings[0], /missing\.png/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('usesIcons: only an overlay that names an icon keeps the icon packages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-pages-'))
  try {
    writeFileSync(join(dir, 'plain.jsx'), 'export default function A() { return <div>hi</div> }')
    writeFileSync(join(dir, 'icon.jsx'), 'export default function A() { return <Ph.Heart /> }')
    writeFileSync(join(dir, 'via.jsx'), "import Part from './part.jsx'\nexport default function A() { return <Part /> }")
    writeFileSync(join(dir, 'part.jsx'), 'export default function P() { return <FaIcon icon="x" /> }')
    assert.equal(usesIcons(join(dir, 'plain.jsx')), false)
    assert.equal(usesIcons(join(dir, 'icon.jsx')), true)
    assert.equal(usesIcons(join(dir, 'via.jsx')), true, 'an import beside it that uses an icon counts')
    assert.equal(usesIcons(join(dir, 'missing.jsx')), true, 'unreadable: keep the icons')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('exportPages: a page per overlay, small, with its files beside it, in a folder a re-export may replace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-pages-'))
  try {
    const projectPath = project(join(dir, 'proj'))
    const layers = listLayers(projectPath)
    assert.deepEqual(layers.map((l) => [l.id, l.name, l.caption]), [['overlay-0--ov1', 'box', false]])
    const out = join(dir, 'out')
    const r = await exportPages({ projectPath, outDir: out })
    assert.deepEqual(r.pages.map((p) => p.file), ['box.html'])
    assert.deepEqual(r.files, ['box.html', 'assets/01-logo.jpg'])
    assert.ok(statSync(join(out, 'box.html')).size < 3 * 1024 * 1024, 'a page without icons is a few MB at most')
    const again = await exportPages({ projectPath, outDir: out })
    assert.equal(again.pages.length, 1, 'a folder this module wrote is replaced')
    const other = join(dir, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'keep.txt'), 'mine')
    await assert.rejects(exportPages({ projectPath, outDir: other }), /already has other files/)
    assert.equal(readFileSync(join(other, 'keep.txt'), 'utf8'), 'mine')
    await assert.rejects(exportPages({ projectPath, outDir: join(dir, 'o2'), items: ['nope'] }), /None of the named overlays/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an exported page draws the overlay frame by frame and plays by itself (headless Chrome)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-pages-'))
  const browser = await puppeteer.launch(overlayPageLaunchOptions({ needsGoogleFonts: false }))
  try {
    const projectPath = project(join(dir, 'proj'))
    const out = join(dir, 'out')
    await exportPages({ projectPath, outDir: out })
    const page = await browser.newPage()
    await page.setViewport({ width: 540, height: 960 })
    const url = pathToFileURL(join(out, 'box.html')).href
    const boxWidth = () => page.evaluate(() => { const el = document.querySelector('[data-box]'); return el ? Math.round(el.getBoundingClientRect().width) : -1 })
    await page.goto(`${url}?frame=0`)
    await page.waitForFunction(() => document.querySelector('[data-box]'))
    assert.equal(await boxWidth(), 0, 'frame 0: the box has not grown yet')
    await page.goto(`${url}?frame=45`)
    await page.waitForFunction(() => document.querySelector('[data-box]') && document.querySelector('[data-box]').getBoundingClientRect().width > 0)
    assert.equal(await boxWidth(), 300, 'frame 45: the box is full width')
    const logo = await page.evaluate(() => { const i = document.querySelector('#root img'); return i && i.getAttribute('src') })
    assert.equal(logo, 'assets/01-logo.jpg', 'the file the prop named is the relative copy')
    await page.goto(url)
    await page.waitForFunction(() => document.querySelector('[data-box]') && document.querySelector('[data-box]').getBoundingClientRect().width > 0, { timeout: 5000 })
    assert.ok((await boxWidth()) > 0, 'no ?frame: it plays by itself')
  } finally {
    await browser.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
