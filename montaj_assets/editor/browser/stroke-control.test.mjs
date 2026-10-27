// Run: npm --prefix montaj_assets/editor run test:browser
//
// §587 round 2, F-F, in a real browser: the element toolbar's Stroke button
// opens its popover, and the Dotted tile makes the shipped line template draw
// a dashed SVG stroke (round dots), in one save.
//
// The fixture (fixtures/stroke-control.tsx) is the real CarouselEditor in the
// rail layout with the real line-straight template, bundled with esbuild into a
// temp dir and opened from file://. The browser is render's puppeteer and its
// pinned headless Chrome, launched with a throwaway profile and no network, and
// closed at the end. It never reaches a running app or the person's browser.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const requireFromRender = createRequire(join(HERE, '..', '..', 'render', 'package.json'))
const { default: puppeteer } = await import(pathToFileURL(requireFromRender.resolve('puppeteer')).href)

let browser
let page
let workDir
const errors = []

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'stroke-control-'))
  await build({
    entryPoints: [join(HERE, 'fixtures', 'stroke-control.tsx')],
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    outfile: join(workDir, 'page.js'),
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty', '.css': 'empty' },
    logLevel: 'error',
  })
  writeFileSync(
    join(workDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { margin: 0; background: #fff; font: 12px sans-serif; }
      /* The package ships no stylesheet: the few utilities the layout needs. */
      .flex { display: flex } .flex-col { flex-direction: column } .items-center { align-items: center }
      .flex-1 { flex: 1 1 0% } .min-w-0 { min-width: 0 } .min-h-0 { min-height: 0 } .h-full { height: 100% } .w-full { width: 100% }
      .flex-shrink-0 { flex-shrink: 0 } .w-\\[72px\\] { width: 72px } .w-\\[320px\\] { width: 320px } .w-\\[360px\\] { width: 360px }
      .relative { position: relative } .absolute { position: absolute } .h-4 { height: 1rem } .w-4 { width: 1rem } .h-2 { height: 0.5rem } .w-10 { width: 2.5rem } .block { display: block }
      .pt-14 { padding-top: 3.5rem } .inset-x-0 { left: 0; right: 0 } .top-2 { top: 0.5rem } .z-30 { z-index: 30 } .z-40 { z-index: 40 } .top-full { top: 100% }
      .justify-center { justify-content: center } .pointer-events-none { pointer-events: none } .pointer-events-auto { pointer-events: auto }
      [role="dialog"][aria-label="Stroke"] { background: #fff }
    </style></head><body><div id="root"></div><script src="page.js"></script></body></html>`,
  )
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND'],
  })
  page = await browser.newPage()
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 })
  page.on('pageerror', (e) => errors.push(e))
  await page.goto(pathToFileURL(join(workDir, 'index.html')).href)
  await page.waitForFunction(() => window.__ready === true)
  await page.waitForSelector('[data-element-id="l"] svg line')
})

after(async () => {
  await browser?.close()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
const TOOLBAR = '[role="toolbar"][aria-label="Element"]'
/** The canvas line's dash and cap, as the browser computes them. */
const lineStroke = () => page.$eval('[data-element-id="l"] svg line', (el) => {
  const cs = getComputedStyle(el)
  return { dash: el.getAttribute('stroke-dasharray'), cap: cs.strokeLinecap }
})

test('the Stroke popover opens from the toolbar, and Dotted gives the line a dasharray in one save', async () => {
  assert.equal((await lineStroke()).dash, null, 'a solid line has no dasharray')
  // Select the line as a person does: a click on it.
  const box = await page.$eval('[data-element-id="l"]', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
  await page.mouse.click(box.x, box.y)
  await page.waitForSelector(`${TOOLBAR} button[aria-label="Stroke"]`)
  await page.click(`${TOOLBAR} button[aria-label="Stroke"]`)
  await page.waitForSelector('[role="dialog"][aria-label="Stroke"]')
  const tiles = await page.$$eval('[role="dialog"][aria-label="Stroke"] button[aria-pressed]', (bs) => bs.map((b) => [b.getAttribute('aria-label'), b.getAttribute('aria-pressed')]))
  assert.deepEqual(tiles, [['Solid', 'true'], ['Long dash', 'false'], ['Short dash', 'false'], ['Dotted', 'false']])

  const before = await page.evaluate(() => window.__saves.length)
  await page.click('[role="dialog"][aria-label="Stroke"] button[aria-label="Dotted"]')
  await page.waitForFunction((n) => window.__saves.length > n, { timeout: 3000 }, before)
  await frames()
  const drawn = await lineStroke()
  assert.equal(drawn.dash, '0 24', 'the line does not draw dots')
  assert.equal(drawn.cap, 'round')
  const saves = await page.evaluate(() => window.__saves)
  assert.equal(saves.length, before + 1, 'more than one save for one pick')
  assert.equal(saves.at(-1)[0].elements.find((e) => e.id === 'l').overlay.props.strokeStyle, 'dotted')
  assert.equal(await page.$eval('[role="dialog"][aria-label="Stroke"] button[aria-label="Dotted"]', (b) => b.getAttribute('aria-pressed')), 'true')
  assert.deepEqual(errors, [])
})
