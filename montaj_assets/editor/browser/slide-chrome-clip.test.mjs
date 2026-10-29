// Run: npm --prefix montaj_assets/editor run test:browser
//   (= node --test browser/slide-chrome-clip.test.mjs, from montaj_assets/editor)
//
// §586 M4, in a real browser: the selection chrome of an element far off the
// slide is drawn whole and takes the pointer. jsdom does no layout and no
// clipping, so the jsdom tests (SlideCanvasChrome.test.tsx) can only say which
// boxes clip; this one measures what the person sees and can press.
//
// The fixture (fixtures/slide-chrome-clip.tsx) is the real SlideCanvas in the
// frame CarouselEditor gives it, bundled with esbuild into a temp dir and
// opened from file://. The browser is render's puppeteer and its pinned
// headless Chrome, launched here with a throwaway profile and no network, and
// closed at the end. It never reaches a running app or the person's browser.
//
// What is measured, for elements 60 to 70 display px past the 40 px margin:
//   - each handle's centre, inside the visible scroll area, is that handle for
//     `document.elementFromPoint` (hit testing honours every clip) and is drawn
//     in the selection colour (a screenshot pixel);
//   - the scroll area's scrollWidth/scrollHeight and the slide's place are what
//     they were with nothing selected: no scrollbars, no layout shift;
//   - a press on an outside handle resizes and starts no band select.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const requireFromRender = createRequire(join(HERE, '..', '..', 'render', 'package.json'))
const { default: puppeteer } = await import(pathToFileURL(requireFromRender.resolve('puppeteer')).href)

const SELECTION = [0, 128, 255]
const SURFACE = [255, 0, 255]
const MARGIN = 40

let browser
let page
let workDir

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'slide-chrome-clip-'))
  await build({
    entryPoints: [join(HERE, 'fixtures', 'slide-chrome-clip.tsx')],
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    outfile: join(workDir, 'page.js'),
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
  })
  writeFileSync(
    join(workDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><style>
      :root { --editor-selection: rgb(${SELECTION}); --editor-surface: rgb(${SURFACE}); }
      html, body { margin: 0; background: #fff; }
    </style></head><body><div id="root"></div><script src="page.js"></script></body></html>`,
  )
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--use-mock-keychain', '--password-store=basic', '--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND'],
  })
  page = await openPage('')
})

async function openPage(query) {
  const p = await browser.newPage()
  await p.setViewport({ width: 1000, height: 1000, deviceScaleFactor: 1 })
  const errors = []
  p.on('pageerror', (e) => errors.push(e))
  await p.goto(pathToFileURL(join(workDir, 'index.html')).href + query)
  await p.waitForFunction(() => window.__ready === true)
  assert.deepEqual(errors, [])
  return p
}

after(async () => {
  await browser?.close()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

async function set(state) {
  await page.evaluate((s) => {
    window.__calls = []
    window.__set(s)
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  }, state)
}

/** The scroll area's extent and where the slide and its margin box sit. */
async function layout() {
  return page.evaluate(() => {
    const area = document.querySelector('[data-testid="scroll-area"]')
    const root = document.querySelector('[data-interactive]').getBoundingClientRect()
    const r = area.getBoundingClientRect()
    const top = area.scrollTop
    return {
      scrollWidth: area.scrollWidth,
      scrollHeight: area.scrollHeight,
      clientWidth: area.clientWidth,
      clientHeight: area.clientHeight,
      // The visible scroll area, in viewport px.
      visible: { left: r.left + area.clientLeft, top: r.top + area.clientTop, right: r.left + area.clientLeft + area.clientWidth, bottom: r.top + area.clientTop + area.clientHeight },
      // Where the first slide sits in the scrolled content.
      slide: { left: root.left, top: root.top + top, width: root.width, height: root.height },
    }
  })
}

let baseline
test('baseline: nothing selected, nothing scrolls', async () => {
  await set({ selected: null, crop: null })
  baseline = await layout()
  assert.equal(baseline.scrollWidth, baseline.clientWidth)
  assert.equal(baseline.scrollHeight, baseline.clientHeight)
})

/** Each matched box's centre, whether hit testing there finds it, and how far
 *  the centre lies past the margin box (positive: outside it). */
async function probe(selector) {
  return page.evaluate((selector, margin) => {
    const root = el0().closest('[data-interactive]').getBoundingClientRect()
    function el0() { return document.querySelector(selector) }
    return [...document.querySelectorAll(selector)].map((el) => {
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      const hit = document.elementFromPoint(x, y)
      const past = Math.max(root.left - margin - x, x - (root.right + margin), root.top - margin - y, y - (root.bottom + margin))
      return { id: el.getAttribute('data-testid'), x, y, rect: { left: r.left, top: r.top }, hit: !!hit && (hit === el || el.contains(hit)), hitIs: hit?.getAttribute('data-testid') ?? hit?.tagName, past }
    })
  }, selector, MARGIN)
}

/** One pixel of a screenshot, as [r, g, b]. */
async function pixel(x, y) {
  const png = await page.screenshot({ clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 } })
  // A 1x1 PNG: every filter of a lone first-row pixel is the raw value.
  let at = 8
  let colorType = 0
  const idat = []
  while (at < png.length) {
    const len = png.readUInt32BE(at)
    const type = png.toString('ascii', at + 4, at + 8)
    const data = png.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') colorType = data[9]
    if (type === 'IDAT') idat.push(data)
    at += 12 + len
  }
  assert.ok(colorType === 2 || colorType === 6, `colour type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  return [raw[1], raw[2], raw[3]]
}

function assertColour(actual, want, what) {
  const off = Math.max(...actual.map((v, i) => Math.abs(v - want[i])))
  assert.ok(off <= 3, `${what}: pixel ${actual} is not ${want}`)
}

function inside(p, v) {
  return p.x > v.left && p.x < v.right && p.y > v.top && p.y < v.bottom
}

async function assertNoGrowth(what) {
  const now = await layout()
  assert.deepEqual(
    { w: now.scrollWidth, h: now.scrollHeight, cw: now.clientWidth, ch: now.clientHeight },
    { w: baseline.scrollWidth, h: baseline.scrollHeight, cw: baseline.clientWidth, ch: baseline.clientHeight },
    `${what}: the scroll area's extent changed`,
  )
  assert.deepEqual(now.slide, baseline.slide, `${what}: the slide moved`)
}

async function assertHandlesWhole(selector, { minOutside, colour = true }) {
  const handles = await probe(selector)
  assert.ok(handles.length > 0, `no ${selector}`)
  const outside = handles.filter((h) => h.past > 0)
  assert.ok(outside.length >= minOutside, `expected ${minOutside} handles past the margin, got ${outside.map((h) => h.id)}`)
  for (const h of handles) {
    assert.ok(inside(h, baseline.visible), `${h.id} is not in the visible scroll area: the fixture is wrong`)
    assert.ok(h.hit, `${h.id} at (${h.x}, ${h.y}), ${h.past} px past the margin: the press lands on ${h.hitIs}`)
    if (colour) assertColour(await pixel(h.x, h.y), SELECTION, h.id)
  }
}

test('an element half off the left: all eight handles and the rotate handle are drawn and take the press', async () => {
  await set({ selected: 'left' })
  await assertHandlesWhole('[data-testid^="resize-handle-"], [data-testid="rotate-handle"]', { minOutside: 3 })
  await assertNoGrowth('left selected')
})

test('an element half off the bottom: its bottom handles too', async () => {
  await set({ selected: 'bottom' })
  await assertHandlesWhole('[data-testid^="resize-handle-"]', { minOutside: 3 })
  await assertNoGrowth('bottom selected')
})

test('an element past the bottom-right of the scroll area: its handle in view is whole, and nothing scrolls', async () => {
  await set({ selected: 'far' })
  const handles = await probe('[data-testid^="resize-handle-"]')
  const shown = handles.filter((h) => inside(h, baseline.visible))
  assert.deepEqual(shown.map((h) => h.id), ['resize-handle-nw'], 'the fixture is wrong')
  // The rest lie past the scroll area's right or bottom edge.
  assert.ok(handles.some((h) => h.x > baseline.visible.right + 100 && h.y > baseline.visible.bottom + 100))
  assert.ok(shown[0].past > 0 && shown[0].hit, `the press lands on ${shown[0].hitIs}`)
  assertColour(await pixel(shown[0].x, shown[0].y), SELECTION, 'nw')
  await assertNoGrowth('far selected')
})

test('dragging the outside corner resizes it, and starts no band select', async () => {
  await set({ selected: 'left' })
  const [nw] = await probe('[data-testid="resize-handle-nw"]')
  assert.ok(nw.past > 0)
  await page.mouse.move(nw.x, nw.y)
  await page.mouse.down()
  await page.mouse.move(nw.x - 10, nw.y - 5, { steps: 4 })
  await page.mouse.up()
  const calls = await page.evaluate(() => window.__calls)
  const resize = calls.find((c) => c.fn === 'resizeElement')
  assert.ok(resize, `no resize: ${JSON.stringify(calls)}`)
  assert.equal(resize.args[1], 'left')
  assert.ok(resize.args[2].x < -200 && resize.args[2].w > 400, JSON.stringify(resize.args[2]))
  assert.equal(calls.some((c) => c.fn === 'onSelectMany' || (c.fn === 'onSelect' && c.args[1] === null)), false, JSON.stringify(calls))
})

test('the lock badge of a locked element past the right edge is drawn and takes the click', async () => {
  await set({ selected: 'right' })
  const [badge] = await probe('[data-testid="lock-badge"]')
  assert.ok(badge.past > 0, `badge only ${badge.past} px past the margin: the fixture is wrong`)
  assert.ok(badge.hit, `the press lands on ${badge.hitIs}`)
  // Inside the ring, left of the icon: the badge's surface.
  assertColour(await pixel(badge.rect.left + 4, badge.y), SURFACE, 'lock badge')
  await page.mouse.click(badge.x, badge.y)
  const calls = await page.evaluate(() => window.__calls)
  assert.deepEqual(calls.filter((c) => c.fn === 'onUnlock'), [{ fn: 'onUnlock', args: ['right'] }])
  await assertNoGrowth('badge')
})

test('in crop, the crop handles of an image half off the slide are whole and take the press', async () => {
  await set({ selected: 'left', crop: 'left' })
  await page.waitForSelector('[data-testid="crop-handle-nw"]')
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await assertHandlesWhole('[data-testid^="crop-handle-"]', { minOutside: 3, colour: false })
  await assertNoGrowth('crop')
  await set({ crop: null })
})

// ── A stack of slides that scrolls ──

test('stacked: a handle over the next slide takes the press, not that slide', async () => {
  await page.close()
  page = await openPage('?stack')
  await set({ selected: null })
  baseline = await layout()
  assert.ok(baseline.scrollHeight > baseline.clientHeight + 300, 'the fixture is wrong: the stack does not scroll')
  await set({ selected: 'low' })
  const handles = await probe('[data-testid^="resize-handle-"]')
  const onNext = await page.evaluate((hs) => {
    const next = document.querySelector('[data-slide="s2"]').getBoundingClientRect()
    return hs.filter((h) => h.y > next.top && h.y < next.bottom && h.x > next.left && h.x < next.right).map((h) => h.id)
  }, handles)
  for (const id of ['resize-handle-s', 'resize-handle-se', 'resize-handle-sw']) assert.ok(onNext.includes(id), `the fixture is wrong: ${onNext}`)
  for (const h of handles) {
    assert.ok(h.hit, `${h.id}: the press lands on ${h.hitIs}`)
    assertColour(await pixel(h.x, h.y), SELECTION, h.id)
  }
  await assertNoGrowth('stacked')
  const [s] = await probe('[data-testid="resize-handle-s"]')
  await page.mouse.move(s.x, s.y)
  await page.mouse.down()
  await page.mouse.move(s.x, s.y + 10, { steps: 3 })
  await page.mouse.up()
  const calls = await page.evaluate(() => window.__calls)
  assert.deepEqual(calls.filter((c) => c.fn.startsWith('on')), [], JSON.stringify(calls))
  assert.equal(calls.find((c) => c.fn === 'resizeElement')?.args[1], 'low')
})

test('stacked: scrolled to the next slide, its handles below the first view are whole, and nothing grows', async () => {
  // Selected before the scroll: only the scroll moves the chrome to where the area now looks.
  await set({ selected: 'under' })
  await page.evaluate(() => {
    document.querySelector('[data-testid="scroll-area"]').scrollTop = 100000
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
  const scrolled = await page.evaluate(() => document.querySelector('[data-testid="scroll-area"]').scrollTop)
  assert.ok(scrolled > 300, `the fixture is wrong: scrolled ${scrolled}`)
  const handles = await probe('[data-testid^="resize-handle-"]')
  const shown = handles.filter((h) => inside(h, baseline.visible)).map((h) => h.id)
  for (const id of ['resize-handle-s', 'resize-handle-se', 'resize-handle-sw']) assert.ok(shown.includes(id), `the fixture is wrong: ${shown}`)
  for (const h of handles.filter((h) => shown.includes(h.id))) {
    // Below what the area showed before the scroll.
    if (h.id.startsWith('resize-handle-s')) assert.ok(h.y + scrolled > baseline.visible.bottom, 'the fixture is wrong')
    assert.ok(h.hit, `${h.id}: the press lands on ${h.hitIs}`)
    assertColour(await pixel(h.x, h.y), SELECTION, h.id)
  }
  await assertNoGrowth('stacked, scrolled')
})
