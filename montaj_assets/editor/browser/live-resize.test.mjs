// Run: npm --prefix montaj_assets/editor run test:browser
//
// §587 round 2, F-E, in a real browser: an element follows its selection box
// on every move of a resize, not only on release. jsdom does no layout, so
// only a real browser can say where the picture, the drawn shape and the text
// are while the handle is still held.
//
// The fixture (fixtures/live-resize.tsx) is the real CarouselEditor in the
// rail layout with the real frame-corners, shape-rect, line-straight,
// shape-heart and static-text templates, bundled with esbuild into a temp dir and opened from
// file://. The browser is render's puppeteer and its pinned headless Chrome,
// launched with a throwaway profile and no network, and closed at the end. It
// never reaches a running app or the person's browser.
//
// For each element: select it, press a handle, move in steps without
// releasing, and after each move measure against the selection box:
//   - the element wrapper's rect;
//   - an overlay's own layer and the template's root;
//   - a shape: the SVG's viewBox is the live box in slide px (redrawn at that
//     size, not stretched), and the drawn geometry's box is the selection box
//     less half the stroke;
//   - a picture: the image (a cropped one: the cropped part) fills the box;
//   - text on a corner: the font, as drawn, grows with the box;
//   - no other overlay renders during the drag: the slide is not re-rendered.
// Then release: the committed box is the last preview, and it draws there.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const EDITOR = join(HERE, '..')
const requireFromRender = createRequire(join(HERE, '..', '..', 'render', 'package.json'))
const { default: puppeteer } = await import(pathToFileURL(requireFromRender.resolve('puppeteer')).href)

// The templates live beside render's own React: one React, the editor's.
const oneReact = {
  name: 'one-react',
  setup(b) {
    b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) =>
      args.resolveDir.startsWith(EDITOR) ? undefined : b.resolve(args.path, { kind: args.kind, resolveDir: EDITOR }))
  },
}

// Display px an element may be off its selection box.
const TOL = 1.5

let browser
let page
let workDir

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'live-resize-'))
  await build({
    entryPoints: [join(HERE, 'fixtures', 'live-resize.tsx')],
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    outfile: join(workDir, 'page.js'),
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty', '.css': 'empty', '.jsx': 'jsx' },
    plugins: [oneReact],
    logLevel: 'error',
  })
  writeFileSync(
    join(workDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { margin: 0; background: #fff; font: 12px sans-serif; }
      /* The package ships no stylesheet. The layout utilities the rail's
         frame uses, so the canvas has a fixed size to fit the slide in;
         without them its measured size feeds back and shrinks the slide. */
      .flex { display: flex } .flex-col { flex-direction: column } .flex-1 { flex: 1 1 0% }
      .flex-shrink-0 { flex-shrink: 0 } .min-h-0 { min-height: 0 } .min-w-0 { min-width: 0 }
      .relative { position: relative } .overflow-auto { overflow: auto } .overflow-y-auto { overflow-y: auto }
      .overflow-hidden { overflow: hidden } .items-center { align-items: center } .justify-center { justify-content: center }
      .h-full { height: 100% } .w-full { width: 100% } .w-max { width: max-content } .min-w-full { min-width: 100% }
      .h-12 { height: 3rem } .h-11 { height: 2.75rem } .w-\[72px\] { width: 72px } .w-\[320px\] { width: 320px } .w-\[360px\] { width: 360px }
    </style></head><body><div id="root"></div><script src="page.js"></script></body></html>`,
  )
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND'],
  })
})

after(async () => {
  await browser?.close()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

let errors
beforeEach(async () => {
  await page?.close()
  page = await browser.newPage()
  await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 })
  errors = []
  page.on('pageerror', (e) => errors.push(e))
  await page.goto(pathToFileURL(join(workDir, 'index.html')).href)
  await page.waitForFunction(() => window.__ready === true)
  await page.waitForSelector('[data-element-id="text"] p, [data-element-id="text"] div')
  await page.waitForFunction(() => document.querySelectorAll('[data-element-id] svg').length >= 4)
})

const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

function rectOf(r) {
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

/** Everything measured about element `id` and its selection box. */
async function measure(id) {
  return page.evaluate((id) => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height } }
    const wrapper = document.querySelector(`[data-element-id="${id}"]`)
    const chrome = document.querySelector(`[data-chrome-for="${id}"]`)
    const out = { wrapper: r(wrapper), chrome: chrome ? r(chrome) : null, base: r(wrapper.closest('[data-slide-base]')) }
    const inner = wrapper.firstElementChild
    out.inner = r(inner)
    const svg = wrapper.querySelector('svg')
    if (svg) {
      out.svg = r(svg)
      const vb = svg.getAttribute('viewBox').split(/\s+/).map(Number)
      out.viewBox = { w: vb[2], h: vb[3] }
      const shape = svg.querySelector('path, rect, line')
      out.shape = r(shape)
    }
    const img = wrapper.querySelector('img')
    if (img) out.img = r(img)
    if (!svg && !img) {
      const root = inner.firstElementChild
      out.root = r(root)
      // The text as drawn: its font size times every scale above it.
      const p = [...wrapper.querySelectorAll('*')].find((n) => n.childElementCount === 0 && n.textContent.trim())
      const cs = getComputedStyle(p)
      out.drawnFont = parseFloat(cs.fontSize) * (p.getBoundingClientRect().height / p.offsetHeight)
      out.textRight = r(p).left + r(p).width
    }
    return out
  }, id)
}

function near(a, b, what, tol = TOL) {
  for (const k of ['left', 'top', 'width', 'height']) {
    if (a[k] === undefined || b[k] === undefined) continue
    assert.ok(Math.abs(a[k] - b[k]) <= tol, `${what}: ${k} ${a[k].toFixed(2)} is not ${b[k].toFixed(2)} (${JSON.stringify(rectOf(a))} vs ${JSON.stringify(rectOf(b))})`)
  }
}

async function select(id) {
  const m = await measure(id)
  await page.mouse.click(m.wrapper.left + m.wrapper.width / 2, m.wrapper.top + m.wrapper.height / 2)
  await page.waitForSelector(`[data-chrome-for="${id}"] [data-testid="resize-handle-se"]`)
  await frames()
}

async function handle(id, which) {
  return page.evaluate((sel) => {
    const b = document.querySelector(sel).getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
  }, `[data-chrome-for="${id}"] [data-testid="resize-handle-${which}"]`)
}

function committedBox(id) {
  return page.evaluate((id) => {
    const el = window.__project.slides[0].elements.find((e) => e.id === id)
    return { x: el.x, y: el.y, w: el.w, h: el.h, fontSize: el.overlay?.props.fontSize }
  }, id)
}

/** The checks one move of the drag must pass, for element `kind`. */
function assertLive(kind, m, start, scale, step) {
  const box = m.chrome
  const at = `${kind}, move ${step}`
  assert.ok(box, `${at}: no selection box`)
  // The box itself moved: the fixture moves the handle far enough.
  assert.ok(Math.abs(box.width - start.chrome.width) > 4 || Math.abs(box.height - start.chrome.height) > 4, `${at}: the box did not change`)
  near(m.wrapper, box, `${at}: the element wrapper`)
  if (m.img) {
    if (kind === 'cropped image') {
      // The kept half of the picture fills the box: the whole image is twice
      // the box, a quarter of it to the left and above.
      near(m.img, { left: box.left - box.width / 2, top: box.top - box.height / 2, width: box.width * 2, height: box.height * 2 }, `${at}: the cropped picture`)
    } else {
      near(m.img, box, `${at}: the picture`)
    }
    return
  }
  near(m.inner, box, `${at}: the overlay's layer`)
  if (m.svg) {
    near(m.svg, box, `${at}: the SVG`)
    // Redrawn at the live size, not the old drawing stretched.
    const vbTol = TOL / scale + 1
    assert.ok(Math.abs(m.viewBox.w - box.width / scale) <= vbTol && Math.abs(m.viewBox.h - box.height / scale) <= vbTol,
      `${at}: the SVG is drawn for ${m.viewBox.w} x ${m.viewBox.h}, the box is ${(box.width / scale).toFixed(1)} x ${(box.height / scale).toFixed(1)} slide px`)
    if (kind === 'frame' || kind === 'rect' || kind === 'heart') {
      // The corner marks / the rect / the heart's curves lie on the box, half a stroke in.
      const half = (kind === 'frame' ? 8 : 6) / 2 * scale
      near(m.shape, { left: box.left + half, top: box.top + half, width: box.width - 2 * half, height: box.height - 2 * half }, `${at}: the drawn ${kind}`)
    } else {
      // The line runs the box's whole width.
      near({ left: m.shape.left, width: m.shape.width }, { left: box.left, width: box.width }, `${at}: the drawn line`)
    }
    return
  }
  near(m.root, box, `${at}: the text box`)
}

const renders = () => page.evaluate(() => ({ ...window.__renders }))

async function dragAndCheck(id, kind, which, moves) {
  await select(id)
  const start = await measure(id)
  const rendersBefore = await renders()
  const el = await committedBox(id)
  const scale = start.wrapper.width / el.w
  const h = await handle(id, which)
  await page.mouse.move(h.x, h.y)
  await page.mouse.down()
  const seen = []
  let i = 0
  for (const [dx, dy] of moves) {
    i += 1
    // One pointer move, then measure before any frame passes.
    await page.mouse.move(h.x + dx, h.y + dy)
    const m = await measure(id)
    assertLive(kind, m, start, scale, i)
    seen.push({ m, scale, start })
  }
  const last = seen.at(-1).m.chrome
  // A move renders the overlay being resized, never the rest of the slide.
  const rendersDuring = await renders()
  for (const [name, n] of Object.entries(rendersDuring)) {
    if (name !== TEMPLATE[id]) assert.equal(n, rendersBefore[name], `${kind}: ${name} rendered ${n - rendersBefore[name]} times during the drag`)
  }
  // A drawn-from-box overlay, or text wrapping to a side handle, redraws on
  // every move; text on a corner may scale its layer instead.
  if (TEMPLATE[id] && !(kind === 'text' && which.length === 2)) assert.ok(rendersDuring[TEMPLATE[id]] - rendersBefore[TEMPLATE[id]] >= moves.length, `${kind}: rendered ${rendersDuring[TEMPLATE[id]] - rendersBefore[TEMPLATE[id]]} times in ${moves.length} moves`)
  await page.mouse.up()
  await frames()
  const done = await committedBox(id)
  const after = await measure(id)
  // The committed box is the last preview, to the whole slide px it rounds to.
  assert.ok(Math.abs(done.w - last.width / scale) <= 1 && Math.abs(done.h - last.height / scale) <= 1,
    `${kind}: committed ${done.w} x ${done.h}, last preview ${(last.width / scale).toFixed(1)} x ${(last.height / scale).toFixed(1)}`)
  near(after.wrapper, { width: done.w * scale, height: done.h * scale }, `${kind}: after release, the wrapper`)
  near(after.chrome, after.wrapper, `${kind}: after release, the selection box`)
  assertLive(kind, after, start, scale, 'release')
  assert.deepEqual(errors, [])
  return { seen, done, after, scale, start }
}

const TEMPLATE = { frame: 'frame-corners', rect: 'shape-rect', line: 'line-straight', heart: 'shape-heart', text: 'static-text' }

const CORNER = [[-20, -20], [-50, -50], [-80, -80], [-30, -30], [40, 40], [70, 70]]
const SIDE = [[-30, 0], [-70, 0], [-110, 0], [-40, 0], [30, 0], [60, 0]]

test('a photo follows a corner resize on every move', async () => {
  await dragAndCheck('img', 'image', 'se', CORNER)
})

test('a cropped photo: its cropped part follows the box on every move', async () => {
  await dragAndCheck('crop', 'cropped image', 'se', CORNER)
})

test('frame-corners: its corner marks are redrawn at the box on every move', async () => {
  await dragAndCheck('frame', 'frame', 'se', CORNER)
})

test('shape-rect, a side handle: redrawn at the box on every move', async () => {
  await dragAndCheck('rect', 'rect', 'e', SIDE)
})

test('shape-rect, a corner: redrawn at the box on every move', async () => {
  await dragAndCheck('rect', 'rect', 'se', CORNER)
})

test('shape-heart (§587 F-I), a corner: its curves are redrawn at the box on every move', async () => {
  await dragAndCheck('heart', 'heart', 'se', CORNER)
})

test('shape-heart, a side handle: redrawn at the box on every move', async () => {
  await dragAndCheck('heart', 'heart', 'e', SIDE)
})

test('line-straight: the line spans the box on every move', async () => {
  await dragAndCheck('line', 'line', 'e', SIDE)
})

test('text on a corner: the text box follows and the font scales with it on every move', async () => {
  const { seen, done, scale } = await dragAndCheck('text', 'text', 'se', CORNER)
  for (const [i, { m, start }] of seen.entries()) {
    const ratio = m.chrome.height / start.chrome.height
    const want = 80 * ratio * scale
    assert.ok(Math.abs(m.drawnFont - want) <= 0.6, `text, move ${i + 1}: drawn at ${m.drawnFont.toFixed(2)} px, the box asks ${want.toFixed(2)}`)
  }
  assert.notEqual(String(done.fontSize), '80', 'the font size was not written')
})

test('text on a side handle: the text box follows on every move, the font stays', async () => {
  const { seen, scale } = await dragAndCheck('text', 'text', 'e', SIDE)
  for (const [i, { m }] of seen.entries()) {
    assert.ok(Math.abs(m.drawnFont - 80 * scale) <= 0.6, `text, move ${i + 1}: drawn at ${m.drawnFont.toFixed(2)} px`)
  }
})

// A resize that ends any way but a plain release behind a move leaves the
// overlay drawn at the committed box, with no live box held over it (liveBox.ts).
async function assertSettled(kind, id, scale) {
  await frames()
  const done = await committedBox(id)
  const m = await measure(id)
  // Tight: a live box held over the element is the unrounded preview, a fraction of a slide px off.
  near(m.wrapper, { width: done.w * scale, height: done.h * scale }, `${kind}: the wrapper`, 0.05)
  near(m.inner, { width: done.w * scale, height: done.h * scale }, `${kind}: the overlay's layer is at element.w x element.h`, 0.05)
  assert.ok(Math.abs(m.viewBox.w - done.w) <= 0.01 && Math.abs(m.viewBox.h - done.h) <= 0.01,
    `${kind}: the SVG is drawn for ${m.viewBox.w} x ${m.viewBox.h}, the element is ${done.w} x ${done.h}`)
  assert.deepEqual(errors, [])
  return done
}

async function beginResize(id, which = 'e') {
  await select(id)
  const start = await committedBox(id)
  const m = await measure(id)
  const scale = m.wrapper.width / start.w
  const h = await handle(id, which)
  await page.mouse.move(h.x, h.y)
  await page.mouse.down()
  return { start, scale, h }
}

test('a resize released back at its start leaves the overlay at element.w x element.h', async () => {
  const { start, scale, h } = await beginResize('rect')
  await page.mouse.move(h.x - 60, h.y)
  await page.mouse.move(h.x - 120, h.y)
  const mid = await measure('rect')
  assert.ok(Math.abs(mid.chrome.width - start.w * scale) > 4, 'the box moved while held')
  // Back to within rounding of the start: the preview is a fraction of a slide px off, the commit is the start.
  await page.mouse.move(h.x + 0.3 * scale, h.y)
  await page.mouse.up()
  const done = await assertSettled('released at the start', 'rect', scale)
  assert.deepEqual({ w: done.w, h: done.h }, { w: start.w, h: start.h })
})

test('a pointercancel mid-resize ends it with no live box left', async () => {
  const { start, scale, h } = await beginResize('rect')
  await page.mouse.move(h.x - 60.3, h.y)
  await page.mouse.move(h.x - 120.3, h.y)
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'mouse' })))
  const done = await assertSettled('after pointercancel', 'rect', scale)
  // The gesture ended where it was: the committed box is the last preview.
  assert.ok(done.w < start.w, 'the box kept the preview')
  // The next move changes nothing: the gesture is over.
  await page.mouse.move(h.x - 200, h.y)
  await assertSettled('a move after the cancel', 'rect', scale)
  await page.mouse.up()
})

test('a lost release (a move with no button held) ends the resize with no live box left', async () => {
  const { start, scale, h } = await beginResize('rect')
  await page.mouse.move(h.x - 60.3, h.y)
  await page.mouse.move(h.x - 120.3, h.y)
  await page.evaluate((x, y) => window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', buttons: 0, clientX: x, clientY: y })), h.x - 120.3, h.y)
  const done = await assertSettled('after a lost release', 'rect', scale)
  assert.ok(done.w < start.w, 'the box kept the preview')
  await page.mouse.up()
})
