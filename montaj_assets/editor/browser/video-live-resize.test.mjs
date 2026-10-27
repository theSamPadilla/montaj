// Run: npm --prefix montaj_assets/editor run test:browser
//
// §587 round 2, F-E, the video editor's half, in a real browser: an overlay
// in the preview follows its selection box on every move of a resize, not
// only on release.
//
// The fixture (fixtures/video-live-resize.tsx) is the real PreviewPlayer with
// the real shape-polygon and frame-corners templates, bundled with esbuild
// into a temp dir and opened from file://. The browser is render's puppeteer
// and its pinned headless Chrome, launched with a throwaway profile and no
// network, and closed at the end. It never reaches a running app or the
// person's browser.
//
// For each overlay: select it, press a handle, move in steps without
// releasing, and after each move measure the drawn shape against the
// selection box (the item's outlined box, whose handles sit on its corners).
// Then release: the committed scale is the last preview, and it draws there.

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

const TOL = 1.5

let browser
let page
let workDir
let errors

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'video-live-resize-'))
  await build({
    entryPoints: [join(HERE, 'fixtures', 'video-live-resize.tsx')],
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
      /* The package ships no stylesheet: the few utilities the preview's
         layers are placed with. */
      .relative { position: relative } .absolute { position: absolute } .inset-0 { inset: 0 }
      .overflow-hidden { overflow: hidden } .pointer-events-none { pointer-events: none } .z-50 { z-index: 50 }
      .flex { display: flex } .items-center { align-items: center } .justify-center { justify-content: center }
    </style></head><body><div id="root"></div><script src="page.js"></script></body></html>`,
  )
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND', '--autoplay-policy=no-user-gesture-required'],
  })
})

after(async () => {
  await browser?.close()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await page?.close()
  page = await browser.newPage()
  await page.setViewport({ width: 800, height: 1000, deviceScaleFactor: 1 })
  errors = []
  page.on('pageerror', (e) => errors.push(e))
  await page.goto(pathToFileURL(join(workDir, 'index.html')).href)
  await page.waitForFunction(() => window.__ready === true)
  await page.waitForFunction(() => document.querySelectorAll('[data-montaj-preview-frame] svg polygon, [data-montaj-preview-frame] svg path').length >= 2)
})

const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

/** The selected item's box (the parent of its handles), its SVG and the drawn shape. */
async function measure() {
  return page.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height } }
    const se = document.querySelector('[data-handle="se"]')
    const box = se.parentElement
    const svg = box.querySelector('svg')
    const shape = svg.querySelector('polygon, path')
    const handle = (h) => { const b = document.querySelector(`[data-handle="${h}"]`).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } }
    return { box: r(box), svg: r(svg), shape: r(shape), nw: handle('nw'), se: handle('se') }
  })
}

function near(a, b, what, tol = TOL) {
  for (const k of ['left', 'top', 'width', 'height', 'x', 'y']) {
    if (a[k] === undefined || b[k] === undefined) continue
    assert.ok(Math.abs(a[k] - b[k]) <= tol, `${what}: ${k} ${a[k].toFixed(2)} is not ${b[k].toFixed(2)} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`)
  }
}

/** The shape lies on the box, the handles on its corners. */
function assertOn(m, kind, at, startShape, startBox) {
  // The selection box's corners are where its handles are drawn.
  near({ x: m.box.left, y: m.box.top }, m.nw, `${at}: the nw handle`)
  near({ x: m.box.left + m.box.width, y: m.box.top + m.box.height }, m.se, `${at}: the se handle`)
  near(m.svg, m.box, `${at}: the SVG`)
  // The drawn shape keeps its place in the box: the same inset, as a share of it.
  const share = (s, b) => ({
    left: b.left + ((s.left - startBox.left) / startBox.width) * b.width,
    top: b.top + ((s.top - startBox.top) / startBox.height) * b.height,
    width: (s.width / startBox.width) * b.width,
    height: (s.height / startBox.height) * b.height,
  })
  near(m.shape, share(startShape, m.box), `${at}: the drawn ${kind}`, kind === 'frame' ? TOL + 1 : TOL)
}

async function dragAndCheck(id, kind, which, moves) {
  await page.evaluate((id) => window.__select(id), id)
  await page.waitForSelector('[data-handle="se"]')
  await frames()
  const start = await measure()
  near(start.svg, start.box, `${kind}: before the drag, the SVG`)
  const h = which === 'se' ? start.se : await page.evaluate((h) => { const b = document.querySelector(`[data-handle="${h}"]`).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } }, which)
  await page.mouse.move(h.x, h.y)
  await page.mouse.down()
  let last
  let i = 0
  for (const [dx, dy] of moves) {
    i += 1
    await page.mouse.move(h.x + dx, h.y + dy)
    const m = await measure()
    const at = `${kind}, move ${i}`
    assert.ok(Math.abs(m.box.width - start.box.width) > 4 || Math.abs(m.box.height - start.box.height) > 4, `${at}: the box did not change`)
    assertOn(m, kind, at, start.shape, start.box)
    last = m
  }
  await page.mouse.up()
  await frames()
  const after = await measure()
  near(after.box, last.box, `${kind}: after release, the box is the last preview`)
  assertOn(after, kind, `${kind}: after release`, start.shape, start.box)
  const committed = await page.evaluate((id) => window.__project.tracks[1].find((it) => it.id === id), id)
  const moved = which.length === 1 ? committed.scaleX : committed.scale
  assert.ok(typeof moved === 'number' && Math.abs(moved - 0.4) > 0.01, `${kind}: nothing committed: ${JSON.stringify(committed)}`)
  assert.deepEqual(errors, [])
}

const CORNER = [[-20, -20], [-50, -50], [-80, -80], [-30, -30], [40, 40], [70, 70]]
const SIDE = [[-30, 0], [-70, 0], [-110, 0], [-40, 0], [30, 0], [60, 0]]

test('video editor: a hexagon follows a corner resize on every move', async () => {
  await dragAndCheck('hex', 'hexagon', 'se', CORNER)
})

test('video editor: a hexagon follows a side resize on every move', async () => {
  await dragAndCheck('hex', 'hexagon', 'e', SIDE)
})

test('video editor: frame-corners follows a corner resize on every move', async () => {
  await dragAndCheck('corners', 'frame', 'se', CORNER)
})
