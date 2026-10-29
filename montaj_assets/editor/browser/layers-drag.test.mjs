// Run: npm --prefix montaj_assets/editor run test:browser
//
// §587 round 2, R1, in a real browser: a Layers row dragged with the mouse
// reorders the stack. jsdom fires whatever drag events a test hands it, so
// the jsdom tests (RailLayers.test.tsx) passed while the panel did not move a
// row under a real mouse; this one presses, moves and releases as a person does.
//
// The fixture (fixtures/layers-drag.tsx) is the real CarouselEditor in the
// rail layout with the Layers panel open, bundled with esbuild into a temp dir
// and opened from file://. The browser is render's puppeteer and its pinned
// headless Chrome, launched with a throwaway profile and no network, and
// closed at the end. It never reaches a running app or the person's browser.

import { test, before, after, beforeEach } from 'node:test'
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

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'layers-drag-'))
  await build({
    entryPoints: [join(HERE, 'fixtures', 'layers-drag.tsx')],
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
      /* The package ships no stylesheet. The few layout utilities a row uses,
         so rows have their real 40 px height and thumbnails their 28 px. */
      .flex { display: flex } .flex-col { flex-direction: column } .items-center { align-items: center }
      .flex-1 { flex: 1 1 0% } .min-w-0 { min-width: 0 } .overflow-hidden { overflow: hidden }
      .h-10 { height: 2.5rem } .h-7 { height: 1.75rem } .w-7 { width: 1.75rem } .h-full { height: 100% } .w-full { width: 100% }
    </style></head><body><div id="root"></div><script src="page.js"></script></body></html>`,
  )
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--use-mock-keychain', '--password-store=basic', '--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND'],
  })
})

after(async () => {
  await browser?.close()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

// A fresh editor per test: each starts from a, b (locked), c and no history.
beforeEach(async () => {
  await page?.close()
  page = await browser.newPage()
  await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e))
  await page.goto(pathToFileURL(join(workDir, 'index.html')).href)
  await page.waitForFunction(() => window.__ready === true)
  await page.waitForSelector('nav[aria-label="Editor rail"]')
  await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Editor rail"]')
    const btn = [...nav.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Layers' || b.textContent.trim() === 'Layers')
    btn.click()
  })
  await page.waitForSelector('[data-layer-id]')
  await frames()
  assert.deepEqual(errors, [])
  assert.deepEqual(await rowIds(), ['c', 'b', 'a'], 'the fixture is wrong')
})

const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
const rowIds = () => page.evaluate(() => [...document.querySelectorAll('[data-layer-id]')].map((e) => e.dataset.layerId))
const saves = () => page.evaluate(() => window.__saves)
/** Waits for the editor to save past `n` saves. */
async function savedPast(n) {
  try {
    await page.waitForFunction((n) => window.__saves.length > n, { timeout: 3000 }, n)
  } catch {
    assert.fail(`the drop saved nothing: the stack is still ${JSON.stringify(await rowIds())}`)
  }
}

/** A row's centre, and its top and bottom, in viewport px. */
async function rowBox(id) {
  return page.evaluate((id) => {
    const r = document.querySelector(`[data-layer-id="${id}"]`).getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom, height: r.height }
  }, id)
}

/** The cursor a person sees at (x, y): the computed cursor of whatever is hit there. */
const cursorAt = (x, y) => page.evaluate((x, y) => getComputedStyle(document.elementFromPoint(x, y)).cursor, x, y)

/** The drop line's place, or null when none is drawn. */
const dropLine = () => page.evaluate(() => {
  const el = document.querySelector('[data-layer-drop-line]')
  if (!el) return null
  const r = el.getBoundingClientRect()
  // The editor theme's accent, as the browser resolves it there.
  const probe = document.createElement('span')
  probe.style.background = 'var(--editor-accent)'
  el.parentElement.appendChild(probe)
  const accent = getComputedStyle(probe).backgroundColor
  probe.remove()
  return { top: r.top, bottom: r.bottom, height: r.height, width: r.width, color: getComputedStyle(el).backgroundColor, accent }
})

/** Press on `from`'s row, move in steps to `y`, and (unless `hold`) release. */
async function drag(from, y, { hold = false } = {}) {
  const a = await rowBox(from)
  // On the row's name, which is the most of the row a person grabs.
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(a.x, a.y + Math.sign(y - a.y) * 3, { steps: 2 })
  await page.mouse.move(a.x, y, { steps: 8 })
  await frames()
  if (!hold) { await page.mouse.up(); await frames() }
  return a
}

test('rows show a grab cursor where a person presses them', async () => {
  for (const id of ['c', 'b', 'a']) {
    const r = await rowBox(id)
    assert.equal(await cursorAt(r.x, r.y), 'grab', `row ${id}`)
  }
})

test('dragging the front row below the back row reorders the stack, with a drop line and a grabbing cursor, in one undo step', async () => {
  const before = (await saves()).length
  const a = await rowBox('a')
  await drag('c', a.bottom - 3, { hold: true })
  const line = await dropLine()
  assert.ok(line, 'no drop line while dragging')
  assert.ok(line.height >= 2 && line.width > 50, `drop line ${JSON.stringify(line)}`)
  assert.ok(Math.abs((line.top + line.bottom) / 2 - a.bottom) <= 4, `the drop line (${line.top}..${line.bottom}) is not under row a (bottom ${a.bottom})`)
  assert.equal(line.color, line.accent, 'the drop line is not in the accent colour')
  assert.notEqual(line.color, 'rgba(0, 0, 0, 0)')
  assert.equal(await cursorAt(a.x, a.bottom - 3), 'grabbing')
  await page.mouse.up()
  await frames()
  assert.equal(await dropLine(), null, 'the drop line stays after the drop')
  await savedPast(before)
  const after = await saves()
  assert.equal(after.length, before + 1, `saves: ${JSON.stringify(after)}`)
  assert.deepEqual(after.at(-1), ['c', 'a', 'b'])
  assert.deepEqual(await rowIds(), ['b', 'a', 'c'])
  // One undo step takes it all back, and there is no second one.
  await page.click('button[aria-label="Undo"]')
  await page.waitForFunction(() => JSON.stringify(window.__saves.at(-1)) === '["a","b","c"]')
  assert.deepEqual(await rowIds(), ['c', 'b', 'a'])
  assert.equal(await page.$eval('button[aria-label="Undo"]', (b) => b.disabled), true, 'a second undo step')
})

test('a locked element reorders too', async () => {
  const before = (await saves()).length
  const c = await rowBox('c')
  await drag('b', c.top + 3)
  await savedPast(before)
  assert.deepEqual((await saves()).at(-1), ['a', 'c', 'b'])
  assert.deepEqual(await rowIds(), ['b', 'c', 'a'])
})

test('a press without movement selects the row and reorders nothing', async () => {
  const b = await rowBox('a')
  await page.mouse.click(b.x, b.y)
  await frames()
  assert.equal(await page.$eval('[data-layer-id="a"] button[aria-pressed]', (el) => el.getAttribute('aria-pressed')), 'true')
  assert.equal(await dropLine(), null)
  assert.deepEqual(await rowIds(), ['c', 'b', 'a'])
  assert.deepEqual(await saves(), [])
})

test('a drag that ends where it began reorders nothing and selects nothing', async () => {
  const c = await rowBox('c')
  await drag('c', c.y + 12)
  assert.equal(await page.$eval('[data-layer-id="c"] button[aria-pressed]', (el) => el.getAttribute('aria-pressed')), 'false')
  assert.deepEqual(await saves(), [])
  assert.deepEqual(await rowIds(), ['c', 'b', 'a'])
})

test('the lock button still works on a row', async () => {
  await page.click('[data-layer-id="a"] button[aria-label^="Lock"]')
  await page.waitForFunction(() => window.__saves.length > 0)
  assert.ok(await page.$('[data-layer-id="a"] button[aria-label^="Unlock"]'))
  assert.deepEqual(await rowIds(), ['c', 'b', 'a'])
})

test('a window blur mid-drag ends the drag with no save, and the next press drags again', async () => {
  const a = await rowBox('a')
  await drag('c', a.bottom - 3, { hold: true })
  assert.ok(await dropLine(), 'no drop line while dragging')
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await frames()
  assert.equal(await dropLine(), null, 'the drop line stays after a blur')
  await page.mouse.up()
  await frames()
  assert.deepEqual(await saves(), [])
  assert.deepEqual(await rowIds(), ['c', 'b', 'a'])
  // Not stuck: a new drag works.
  const before = (await saves()).length
  const a2 = await rowBox('a')
  await drag('c', a2.bottom - 3)
  await savedPast(before)
  assert.deepEqual((await saves()).at(-1), ['c', 'a', 'b'])
})

test('a lost release (a move with no button down) ends the drag with no save', async () => {
  const a = await rowBox('a')
  await drag('c', a.bottom - 3, { hold: true })
  await page.evaluate((y) => window.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: y, buttons: 0, bubbles: true })), a.bottom - 3)
  await frames()
  assert.equal(await dropLine(), null, 'the drop line stays after a move with no button')
  await page.mouse.up()
  await frames()
  assert.deepEqual(await saves(), [])
  assert.deepEqual(await rowIds(), ['c', 'b', 'a'])
  // The next press is not ignored.
  const before = (await saves()).length
  const a2 = await rowBox('a')
  await drag('c', a2.bottom - 3)
  await savedPast(before)
  assert.deepEqual((await saves()).at(-1), ['c', 'a', 'b'])
})

test('dragging a row of a multi-selection moves the whole selection in one save', async () => {
  const c = await rowBox('c')
  await page.mouse.click(c.x, c.y)
  const a = await rowBox('a')
  await page.keyboard.down('Shift')
  await page.mouse.click(a.x, a.y)
  await page.keyboard.up('Shift')
  await frames()
  assert.equal(await page.$eval('[data-layer-id="a"] button[aria-pressed]', (el) => el.getAttribute('aria-pressed')), 'true')
  assert.equal(await page.$eval('[data-layer-id="c"] button[aria-pressed]', (el) => el.getAttribute('aria-pressed')), 'true')
  const before = (await saves()).length
  const b = await rowBox('b')
  await drag('c', b.bottom - 3)
  await savedPast(before)
  const after = await saves()
  assert.equal(after.length, before + 1, `saves: ${JSON.stringify(after)}`)
  // b (not selected) is now in front of both; c and a keep their order.
  assert.equal(after.at(-1).at(-1), 'b')
  assert.deepEqual(after.at(-1).slice().sort(), ['a', 'b', 'c'])
})
