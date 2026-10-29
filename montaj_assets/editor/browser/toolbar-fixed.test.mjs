// Run: npm --prefix montaj_assets/editor run test:browser
//
// §587 round 2, R8, in a real browser: the element toolbar sits in a row of
// its own at the top of the canvas column. The stack of slides scrolls under
// it; it never moves, never covers a slide (a wrapped toolbar too), and takes
// the press there. A selection holds while its element is in view, even when
// another slide is now the one most in view; scrolled far out of view it goes,
// and the toolbar with it. jsdom does no layout and no scrolling, so only a
// real browser can say where the toolbar is drawn and what is in view.
//
// The fixture (fixtures/toolbar-fixed.tsx) is the real CarouselEditor in the
// rail layout on three tall slides, bundled with esbuild into a temp dir and
// opened from file://. The package ships no stylesheet, so the page below
// gives the layout classes the shell and the toolbar use their real CSS. The
// browser is render's puppeteer and its pinned headless Chrome, launched with
// a throwaway profile and no network, and closed at the end. It never reaches
// a running app or the person's browser.

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

// The layout utilities of the rail shell, the canvas column, the stack and the
// toolbar's controls, as Tailwind writes them.
const LAYOUT_CSS = `
  *, ::before, ::after { box-sizing: border-box; border: 0 solid; }
  .flex { display: flex } .inline-flex { display: inline-flex } .flex-col { flex-direction: column } .flex-wrap { flex-wrap: wrap }
  .flex-1 { flex: 1 1 0% } .flex-shrink-0, .shrink-0 { flex-shrink: 0 }
  .items-center { align-items: center } .items-stretch { align-items: stretch } .items-start { align-items: flex-start }
  .justify-center { justify-content: center } .justify-between { justify-content: space-between } .justify-end { justify-content: flex-end }
  .min-h-0 { min-height: 0 } .min-w-0 { min-width: 0 } .min-w-full { min-width: 100% } .max-w-full { max-width: 100% }
  .h-full { height: 100% } .w-full { width: 100% } .w-max { width: max-content }
  .h-14 { height: 3.5rem } .h-12 { height: 3rem } .h-11 { height: 2.75rem } .h-10 { height: 2.5rem } .h-8 { height: 2rem } .h-7 { height: 1.75rem } .h-6 { height: 1.5rem }
  .w-8 { width: 2rem } .w-7 { width: 1.75rem } .min-w-8 { min-width: 2rem } .min-h-14 { min-height: 3.5rem }
  .w-\\[72px\\] { width: 72px } .w-\\[320px\\] { width: 320px } .w-\\[360px\\] { width: 360px } .w-\\[300px\\] { width: 300px }
  .overflow-hidden { overflow: hidden } .overflow-auto { overflow: auto } .overflow-y-auto { overflow-y: auto }
  .relative { position: relative } .absolute { position: absolute }
  .inset-x-0 { left: 0; right: 0 } .top-0 { top: 0 } .top-2 { top: 0.5rem } .top-full { top: 100% } .left-1\\/2 { left: 50% }
  .-translate-x-1\\/2 { transform: translateX(-50%) }
  .z-30 { z-index: 30 } .z-40 { z-index: 40 }
  .pointer-events-none { pointer-events: none } .pointer-events-auto { pointer-events: auto }
  .border { border-width: 1px }
  .p-4 { padding: 1rem } .px-3 { padding-left: 0.75rem; padding-right: 0.75rem } .px-4 { padding-left: 1rem; padding-right: 1rem }
  .px-1\\.5 { padding-left: 0.375rem; padding-right: 0.375rem }
  .py-1 { padding-top: 0.25rem; padding-bottom: 0.25rem } .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem }
  .pt-2 { padding-top: 0.5rem } .pb-1 { padding-bottom: 0.25rem } .pt-14 { padding-top: 3.5rem }
  .mt-2 { margin-top: 0.5rem } .m-0 { margin: 0 } .p-0 { padding: 0 } .border-0 { border-width: 0 }
  .gap-0\\.5 { gap: 0.125rem } .gap-1 { gap: 0.25rem } .gap-1\\.5 { gap: 0.375rem } .gap-2 { gap: 0.5rem } .gap-3 { gap: 0.75rem } .gap-4 { gap: 1rem }
  .whitespace-nowrap { white-space: nowrap }
  .hidden { display: none }
`

let browser
let page
let workDir

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'toolbar-fixed-'))
  await build({
    entryPoints: [join(HERE, 'fixtures', 'toolbar-fixed.tsx')],
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
      html, body { margin: 0; background: #fff; } body { font: 12px sans-serif; }
      ${LAYOUT_CSS}
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

async function open(width = 1200, height = 900) {
  await page?.close()
  page = await browser.newPage()
  await page.setViewport({ width, height, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e))
  await page.goto(pathToFileURL(join(workDir, 'index.html')).href)
  await page.waitForFunction(() => window.__ready === true)
  await page.waitForSelector('[data-slide-stack] [data-element-id="a"]')
  await frames()
  assert.deepEqual(errors, [])
}
beforeEach(() => open())

const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

/** A box in viewport px, or null when nothing matches. */
const box = (selector) => page.evaluate((selector) => {
  const el = document.querySelector(selector)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2 }
}, selector)

const TOOLBAR = '[role="toolbar"][aria-label="Element"]'
const POSITION = '[role="dialog"][aria-label="Position"]'
const elementBox = (id) => box(`[data-slide-stack] [data-element-id="${id}"]`)
const stackBox = () => page.evaluate(() => {
  const el = document.querySelector('[data-slide-stack]')
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.left + el.clientWidth, bottom: r.top + el.clientHeight, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
})
/** Each slide's share of its box in the stack's visible area. */
const shares = () => page.evaluate(() => {
  const st = document.querySelector('[data-slide-stack]').getBoundingClientRect()
  return Object.fromEntries([...document.querySelectorAll('[data-slide-section]')].map((el) => {
    const r = el.getBoundingClientRect()
    return [el.dataset.slideSection, Math.max(0, Math.min(r.bottom, st.bottom) - Math.max(r.top, st.top)) / r.height]
  }))
})
const counter = () => page.$eval('footer[aria-label="Bottom bar"]', (f) => [...f.querySelectorAll('button')].find((b) => /^Slides /.test(b.textContent.trim())).textContent.trim())
const selected = (id) => page.evaluate((id) => !!document.querySelector(`[data-chrome-for="${id}"]`), id)
const inView = (b, s) => !!b && b.bottom > s.top && b.top < s.bottom

/** Whether hit testing at the box's centre finds `selector` (or inside it). */
const hitsAtCentre = (b, selector) => page.evaluate((x, y, selector) => {
  const hit = document.elementFromPoint(x, y)
  return !!hit && !!hit.closest(selector)
}, b.x, b.y, selector)

/** Select an element of the first slide with a click, as a person does. */
async function select(id) {
  const a = await elementBox(id)
  await page.mouse.click(a.x, a.y)
  await page.waitForSelector(TOOLBAR)
  await frames()
}

/** Wheel the stack by `dy` px, the pointer over the stack near its bottom-left corner (clear of any popover). */
async function wheel(dy) {
  const s = await stackBox()
  await page.mouse.move(s.left + 20, s.bottom - 20)
  const hit = await page.evaluate((x, y) => !!document.elementFromPoint(x, y)?.closest('[data-slide-stack]'), s.left + 20, s.bottom - 20)
  assert.ok(hit, 'the fixture is wrong: the wheel is not over the stack')
  const before = s.scrollTop
  await page.mouse.wheel({ deltaY: dy })
  await page.waitForFunction((t) => document.querySelector('[data-slide-stack]').scrollTop !== t, { timeout: 3000 }, before)
  await frames()
  await frames()
}

function assertSameRect(now, then, what) {
  for (const k of ['left', 'top', 'width', 'height']) {
    assert.ok(Math.abs(now[k] - then[k]) <= 1, `${what}: the toolbar's ${k} moved from ${then[k]} to ${now[k]}`)
  }
}

test('the stack scrolls a few hundred px under the toolbar: it stays put, drawn and pressable, and covers no slide', async () => {
  const s0 = await stackBox()
  assert.ok(s0.scrollHeight > s0.clientHeight * 2, `the fixture is wrong: the stack does not scroll (${s0.scrollHeight} / ${s0.clientHeight})`)
  await select('a')
  const t0 = await box(TOOLBAR)
  assert.ok(t0 && t0.height > 0, 'no toolbar')
  assert.ok(await hitsAtCentre(t0, TOOLBAR), 'the toolbar does not take the press')
  assert.ok(s0.top >= t0.bottom, `the toolbar (bottom ${t0.bottom}) covers the stack (top ${s0.top})`)

  for (const dy of [150, 150]) {
    await wheel(dy)
    const s = await stackBox()
    assert.ok(inView(await elementBox('a'), s), 'the fixture is wrong: the element left the view')
    const t = await box(TOOLBAR)
    assert.ok(t, `scrolled ${s.scrollTop} px with the element in view: the toolbar went`)
    assertSameRect(t, t0, `scrolled ${s.scrollTop} px`)
    assert.ok(await hitsAtCentre(t, TOOLBAR), `scrolled ${s.scrollTop} px: the slides cover the toolbar`)
    assert.ok(s.top >= t.bottom, `the toolbar (bottom ${t.bottom}) covers the stack (top ${s.top})`)
  }
  assert.ok((await stackBox()).scrollTop - s0.scrollTop >= 250, 'the fixture is wrong: the stack did not scroll')
})

test('a toolbar that wraps in a narrow column pushes the slides down: it covers none of them', async () => {
  await open(780, 900)
  // The Text panel takes 320 px of the 780: the text's toolbar no longer fits on one row.
  await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="Editor rail"] button')].find((b) => b.textContent.trim() === 'Text').click())
  await frames()
  await select('t')
  const one = await page.$eval(`${TOOLBAR} button[aria-label="Delete"]`, (b) => b.getBoundingClientRect().height)
  const t = await box(TOOLBAR)
  assert.ok(t.height > one * 2, `the fixture is wrong: the toolbar did not wrap (${t.height} px tall)`)
  const s = await stackBox()
  assert.ok(s.top >= t.bottom, `the wrapped toolbar (bottom ${t.bottom}) covers the stack (top ${s.top})`)
  assert.ok(await hitsAtCentre(t, TOOLBAR), 'the toolbar does not take the press')
  // Its last row too.
  const del = await box(`${TOOLBAR} button[aria-label="Delete"]`)
  assert.ok(await hitsAtCentre(del, `${TOOLBAR} button[aria-label="Delete"]`), 'the slides cover the toolbar\'s last row')
})

test('the toolbar is centred over the canvas column, and a one-row toolbar moves no slide', async () => {
  const before = await stackBox()
  for (const id of ['a', 't']) {
    await select(id)
    const t = await box(TOOLBAR)
    const s = await stackBox()
    assert.ok(Math.abs(t.x - (s.left + s.right) / 2) <= 2, `${id}: toolbar centre ${t.x}, column centre ${(s.left + s.right) / 2}`)
    // The strip keeps one row's height whether or not anything is selected.
    assert.equal(s.top, before.top, `${id}: selecting moved the stack from ${before.top} to ${s.top}`)
    assert.equal(s.bottom, before.bottom, `${id}: selecting resized the stack`)
  }
})

test('a popover the toolbar opens anchors under it and stays on screen while the stack scrolls under it', async () => {
  await select('a')
  const t0 = await box(TOOLBAR)
  await page.evaluate((sel) => [...document.querySelectorAll(`${sel} button`)].find((b) => b.textContent.trim() === 'Position').click(), TOOLBAR)
  await page.waitForSelector(POSITION)
  const p0 = await box(POSITION)
  assert.ok(p0.top >= t0.bottom - 1 && p0.top <= t0.bottom + 16, `the popover (top ${p0.top}) is not under the toolbar (bottom ${t0.bottom})`)
  assert.ok(p0.left >= 0 && p0.right <= 1200 && p0.top >= 0, 'the popover is off screen')
  assert.ok(await hitsAtCentre(p0, POSITION), 'the slides cover the popover')
  await wheel(150)
  const p = await box(POSITION)
  assert.ok(p, 'the popover closed on a scroll')
  assertSameRect(p, p0, 'the popover')
  assert.ok(await hitsAtCentre(p, POSITION), 'scrolled: the slides cover the popover')
  assertSameRect(await box(TOOLBAR), t0, 'the toolbar, popover open')
})

test('another slide most in view takes nothing while the selected element is in view; scrolled far out of view, the selection and the toolbar go', async () => {
  await select('a')
  assert.match(await counter(), /^Slides 1 \//)
  // Scroll until slide 2 is more in view than slide 1, the element still on screen.
  for (let i = 0; i < 20; i++) {
    const v = await shares()
    if (v.s1 > v.s0) break
    await wheel(60)
  }
  const v = await shares()
  const s = await stackBox()
  assert.ok(v.s1 > v.s0, `the fixture is wrong: slide 2 is not the one most in view (${JSON.stringify(v)})`)
  assert.ok(inView(await elementBox('a'), s), 'the fixture is wrong: the element left the view')
  assert.ok(await box(TOOLBAR), 'the toolbar went while its element is in view')
  assert.equal(await selected('a'), true, 'the selection went while its element is in view')
  assert.match(await counter(), /^Slides 1 \//, 'the selection\'s slide is no longer active')

  // Delete acts on the selected element, on its own slide.
  await page.keyboard.press('Delete')
  await page.waitForFunction(() => window.__saves.length > 0, { timeout: 3000 })
  assert.deepEqual((await page.evaluate(() => window.__saves)).at(-1), [['t'], ['b'], ['c']])
  await page.keyboard.down('Meta')
  await page.keyboard.press('z')
  await page.keyboard.up('Meta')
  await page.waitForFunction(() => JSON.stringify(window.__saves.at(-1)) === '[["a","t"],["b"],["c"]]', { timeout: 3000 })
  await select('a')

  // On until the element is well past the stack's top edge.
  for (let i = 0; i < 20; i++) {
    const a = await elementBox('a')
    if (a.bottom < (await stackBox()).top - 60) break
    await wheel(120)
  }
  const a = await elementBox('a')
  assert.ok(a.bottom < (await stackBox()).top - 60, 'the fixture is wrong: the element is still near the view')
  await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 3000 }, TOOLBAR)
  assert.equal(await selected('a'), false, 'the element is still selected')
  // The slide in view is the active one now.
  assert.match(await counter(), /^Slides 2 \//)
})
