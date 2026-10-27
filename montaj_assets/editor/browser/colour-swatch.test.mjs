// Run: npm --prefix montaj_assets/editor run test:browser
//
// §587 round 2, R9, in a real browser: the element toolbar's colour swatch
// opens the colour panel in the LEFT side panel, and a click on a default solid
// recolours the shape on the canvas, in one save. The photo colours are read
// from the slide's image by the real sampler (a canvas downscale), which jsdom
// cannot run.
//
// The fixture (fixtures/colour-swatch.tsx) is the real CarouselEditor in the
// rail layout, bundled with esbuild into a temp dir and opened from file://.
// The browser is render's puppeteer and its pinned headless Chrome, launched
// with a throwaway profile and no network, and closed at the end. It never
// reaches a running app or the person's browser.

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
  workDir = mkdtempSync(join(tmpdir(), 'colour-swatch-'))
  await build({
    entryPoints: [join(HERE, 'fixtures', 'colour-swatch.tsx')],
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
      .relative { position: relative } .absolute { position: absolute } .h-5 { height: 1.25rem } .w-5 { width: 1.25rem } .block { display: block }
      /* The toolbar's strip over the canvas column, so the slide's margin box does not cover it. */
      .pt-14 { padding-top: 3.5rem } .inset-x-0 { left: 0; right: 0 } .top-2 { top: 0.5rem } .z-30 { z-index: 30 }
      .justify-center { justify-content: center } .pointer-events-none { pointer-events: none } .pointer-events-auto { pointer-events: auto }
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
  await page.waitForSelector('[data-element-id="r"] [data-shape-box]')
})

after(async () => {
  await browser?.close()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
/** The colour the canvas draws the shape in. */
const shapeColour = () => page.$eval('[data-element-id="r"] [data-shape-box]', (el) => getComputedStyle(el).backgroundColor)

test('the toolbar swatch opens the colour panel on the left, and a default solid recolours the shape in one save', async () => {
  assert.equal(await shapeColour(), 'rgb(189, 189, 189)')
  // Select the shape as a person does: a click on it.
  const box = await page.$eval('[data-element-id="r"]', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
  await page.mouse.click(box.x, box.y)
  await page.waitForSelector('[role="toolbar"][aria-label="Element"] button[aria-label="Color"]')
  const ball = await page.$eval('[role="toolbar"][aria-label="Element"] button[aria-label="Color"] [data-colour-swatch]', (el) => getComputedStyle(el).backgroundColor)
  assert.equal(ball, 'rgb(189, 189, 189)', 'the swatch does not show the fill')

  await page.click('[role="toolbar"][aria-label="Element"] button[aria-label="Color"]')
  await page.waitForSelector('section[aria-label="Colour panel"]')
  const where = await page.evaluate(() => {
    const panel = document.querySelector('section[aria-label="Colour panel"]').getBoundingClientRect()
    const canvas = document.querySelector('[data-element-id="r"]').getBoundingClientRect()
    const rail = document.querySelector('nav[aria-label="Editor rail"]').getBoundingClientRect()
    return { panelLeft: panel.left, panelRight: panel.right, canvasLeft: canvas.left, railRight: rail.right, title: document.querySelector('section[aria-label="Colour panel"] h2').textContent }
  })
  assert.equal(where.title, 'Fill color')
  assert.ok(where.panelLeft >= where.railRight - 1 && where.panelRight <= where.canvasLeft, `the panel is not on the left: ${JSON.stringify(where)}`)

  // The sampler reads the photo on the slide: orange and navy.
  await page.waitForSelector('section[aria-label="Photo colors"] button', { timeout: 3000 })
  const photo = await page.$$eval('section[aria-label="Photo colors"] button', (bs) => bs.map((b) => b.getAttribute('aria-label')))
  assert.deepEqual(photo, ['Photo color #f08020', 'Photo color #102060'])

  const before = await page.evaluate(() => window.__saves.length)
  await page.click('section[aria-label="Default colors"] button[aria-label="Default color #ef4444"]')
  await page.waitForFunction((n) => window.__saves.length > n, { timeout: 3000 }, before)
  await frames()
  assert.equal(await shapeColour(), 'rgb(239, 68, 68)', 'the canvas did not recolour the shape')
  const saves = await page.evaluate(() => window.__saves)
  assert.equal(saves.length, before + 1, 'more than one save for one pick')
  const saved = saves.at(-1)[0].elements.find((e) => e.id === 'r')
  assert.equal(saved.overlay.props.fill, '#ef4444')
  assert.equal(saved.overlay.props.stroke, '#111111')
  assert.equal(
    await page.$eval('[role="toolbar"][aria-label="Element"] button[aria-label="Color"] [data-colour-swatch]', (el) => getComputedStyle(el).backgroundColor),
    'rgb(239, 68, 68)',
    'the swatch does not follow the pick',
  )
  assert.deepEqual(errors, [])
})
