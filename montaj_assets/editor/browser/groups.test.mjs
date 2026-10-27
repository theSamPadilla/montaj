// Run: npm --prefix montaj_assets/editor run test:browser
//
// §587 round 3, groups, in a real browser: select three elements, Group, then
// drag the group and resize it from a corner with real mouse moves. jsdom does
// no layout, so only a real browser can say where every member is while the
// mouse is still held.
//
// The fixture (fixtures/groups.tsx) is the real CarouselEditor in the rail
// layout with a photo and the real shape-rect and static-text templates,
// bundled with esbuild into a temp dir and opened from file://. The browser is
// render's puppeteer and its pinned headless Chrome, launched with a throwaway
// profile and no network, and closed at the end. It never reaches a running app
// or the person's browser.

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

// Display px an element may be off where the group puts it.
const TOL = 1.5
const MEMBERS = ['img', 'rect', 'text']

let browser
let page
let workDir

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'groups-'))
  await build({
    entryPoints: [join(HERE, 'fixtures', 'groups.tsx')],
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
      .flex { display: flex } .flex-col { flex-direction: column } .flex-1 { flex: 1 1 0% }
      .flex-shrink-0 { flex-shrink: 0 } .min-h-0 { min-height: 0 } .min-w-0 { min-width: 0 }
      .relative { position: relative } .overflow-auto { overflow: auto } .overflow-y-auto { overflow-y: auto }
      .overflow-hidden { overflow: hidden } .items-center { align-items: center } .justify-center { justify-content: center }
      .h-full { height: 100% } .w-full { width: 100% } .w-max { width: max-content } .min-w-full { min-width: 100% }
      .h-12 { height: 3rem } .h-11 { height: 2.75rem } .w-\\[72px\\] { width: 72px } .w-\\[320px\\] { width: 320px } .w-\\[360px\\] { width: 360px }
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
  await page.waitForFunction(() => document.querySelectorAll('[data-element-id] svg').length >= 1)
})

const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

/** Each member's wrapper rect, the group box's rect, and what the text and the shape draw. */
async function measure() {
  return page.evaluate((ids) => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height } }
    const out = { members: {} }
    for (const id of ids) out.members[id] = r(document.querySelector(`[data-element-id="${id}"]`))
    const box = document.querySelector('[data-group-chrome]')
    out.box = box ? r(box) : null
    const svg = document.querySelector('[data-element-id="rect"] svg')
    const vb = svg.getAttribute('viewBox').split(/\s+/).map(Number)
    out.viewBox = { w: vb[2], h: vb[3] }
    const wrapper = document.querySelector('[data-element-id="text"]')
    const p = [...wrapper.querySelectorAll('*')].find((n) => n.childElementCount === 0 && n.textContent.trim())
    out.drawnFont = parseFloat(getComputedStyle(p).fontSize) * (p.getBoundingClientRect().height / p.offsetHeight)
    return out
  }, MEMBERS)
}

function near(a, b, what, tol = TOL) {
  for (const k of ['left', 'top', 'width', 'height']) {
    if (a[k] === undefined || b[k] === undefined) continue
    assert.ok(Math.abs(a[k] - b[k]) <= tol, `${what}: ${k} ${a[k].toFixed(2)} is not ${b[k].toFixed(2)}`)
  }
}

const committed = () => page.evaluate(() => Object.fromEntries(window.__project.slides[0].elements.map((e) => [e.id, { x: e.x, y: e.y, w: e.w, h: e.h, group: e.group, fontSize: e.overlay?.props.fontSize }])))

async function centreOf(id) {
  const m = await measure()
  const b = m.members[id]
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
}

/** Select the three members (a click, then shift-clicks) and Group them from the toolbar. */
async function groupThree() {
  const a = await centreOf('img')
  await page.mouse.click(a.x, a.y)
  await page.keyboard.down('Shift')
  for (const id of ['rect', 'text']) {
    const c = await centreOf(id)
    await page.mouse.click(c.x, c.y)
  }
  await page.keyboard.up('Shift')
  await page.waitForSelector('[role="toolbar"][aria-label="Element"] button[aria-label="Group"]')
  await page.click('[role="toolbar"][aria-label="Element"] button[aria-label="Group"]')
  await page.waitForSelector('[data-group-chrome] [data-testid="group-resize-handle-se"]')
  await frames()
  const done = await committed()
  assert.ok(done.img.group, 'img is grouped')
  assert.equal(done.rect.group, done.img.group)
  assert.equal(done.text.group, done.img.group)
  assert.equal(done.far.group, undefined)
}

test('Group, then a drag of a member moves every member and the group box by one delta, mid-drag and after', async () => {
  await groupThree()
  const start = await measure()
  const before = await committed()
  const scale = start.members.img.width / before.img.w
  const from = await centreOf('img')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  let last
  for (const [dx, dy] of [[10, 6], [40, 25], [90, 60], [130, 45]]) {
    await page.mouse.move(from.x + dx, from.y + dy)
    const m = await measure()
    const d = { x: m.members.img.left - start.members.img.left, y: m.members.img.top - start.members.img.top }
    if (dx > 20) assert.ok(Math.abs(d.x) > 5 || Math.abs(d.y) > 5, `move (${dx}, ${dy}): the group did not move`)
    for (const id of MEMBERS) {
      near(m.members[id], { ...start.members[id], left: start.members[id].left + d.x, top: start.members[id].top + d.y }, `move (${dx}, ${dy}): ${id}`)
    }
    near(m.box, { ...start.box, left: start.box.left + d.x, top: start.box.top + d.y }, `move (${dx}, ${dy}): the group box`)
    last = d
  }
  await page.mouse.up()
  await frames()
  const after = await committed()
  const moved = { x: after.img.x - before.img.x, y: after.img.y - before.img.y }
  assert.ok(Math.abs(moved.x - last.x / scale) <= 1 && Math.abs(moved.y - last.y / scale) <= 1, `committed ${JSON.stringify(moved)}, last preview ${last.x / scale}, ${last.y / scale}`)
  for (const id of MEMBERS) {
    assert.deepEqual([after[id].x - before[id].x, after[id].y - before[id].y], [moved.x, moved.y], `${id} moved by the same delta`)
  }
  assert.deepEqual([after.far.x, after.far.y], [before.far.x, before.far.y])
  assert.deepEqual(errors, [])
})

test('a corner of the group box scales every member live, the text and the shape with it, and commits that', async () => {
  await groupThree()
  const start = await measure()
  const before = await committed()
  const scale = start.members.img.width / before.img.w
  const h = await page.evaluate(() => {
    const b = document.querySelector('[data-group-chrome] [data-testid="group-resize-handle-se"]').getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
  })
  await page.mouse.move(h.x, h.y)
  await page.mouse.down()
  let last
  for (const [dx, dy] of [[20, 20], [60, 50], [110, 90], [40, 30], [-30, -25]]) {
    await page.mouse.move(h.x + dx, h.y + dy)
    const m = await measure()
    const k = m.box.width / start.box.width
    assert.ok(Math.abs(m.box.height / start.box.height - k) < 0.01, `move (${dx}, ${dy}): the corner keeps the group's ratio`)
    assert.ok(Math.abs(k - 1) > 0.01, `move (${dx}, ${dy}): the group box did not change`)
    near({ left: m.box.left, top: m.box.top }, { left: start.box.left, top: start.box.top }, `move (${dx}, ${dy}): the pinned corner`)
    for (const id of MEMBERS) {
      const s = start.members[id]
      near(m.members[id], {
        left: m.box.left + (s.left - start.box.left) * k,
        top: m.box.top + (s.top - start.box.top) * k,
        width: s.width * k,
        height: s.height * k,
      }, `move (${dx}, ${dy}): ${id}`)
    }
    // The shape is redrawn at its live box, not stretched; the text's font scales with the group.
    const vbTol = TOL / scale + 1
    assert.ok(Math.abs(m.viewBox.w - m.members.rect.width / scale) <= vbTol, `move (${dx}, ${dy}): the shape is drawn for ${m.viewBox.w}, its box is ${(m.members.rect.width / scale).toFixed(1)}`)
    assert.ok(Math.abs(m.drawnFont - 80 * scale * k) <= 0.6, `move (${dx}, ${dy}): text drawn at ${m.drawnFont.toFixed(2)} px, the group asks ${(80 * scale * k).toFixed(2)}`)
    last = { m, k }
  }
  await page.mouse.up()
  await frames()
  const after = await committed()
  for (const id of MEMBERS) {
    const b = last.m.members[id]
    assert.ok(Math.abs(after[id].w - b.width / scale) <= 1 && Math.abs(after[id].h - b.height / scale) <= 1,
      `${id}: committed ${after[id].w} x ${after[id].h}, last preview ${(b.width / scale).toFixed(1)} x ${(b.height / scale).toFixed(1)}`)
  }
  assert.ok(Math.abs(Number(after.text.fontSize) - 80 * last.k) <= 1, `the font size ${after.text.fontSize} is the group's scale of 80 (${(80 * last.k).toFixed(1)})`)
  // After release every member draws where it was committed.
  const settled = await measure()
  for (const id of MEMBERS) near(settled.members[id], { width: after[id].w * scale, height: after[id].h * scale }, `${id} after release`)
  assert.deepEqual(errors, [])
})
