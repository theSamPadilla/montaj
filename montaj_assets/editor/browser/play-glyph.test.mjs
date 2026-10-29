// Run: npm --prefix montaj_assets/editor run test:browser
//
// The preview's play glyph, in a real browser: wherever it shows, a click on it
// plays. It used to show over states where a click did nothing at all:
//   - the playhead at the end (a play there had nowhere to run);
//   - the on-screen clip selected (its move box took the click);
//   - an overlay under the glyph (the click selected the overlay instead).
// And a play() the browser refused was swallowed without a word.
//
// The fixture (fixtures/play-glyph.tsx) is the real PreviewPlayer on the engine
// (the app's default) and on the legacy <video> player, bundled with esbuild and
// served from a throwaway local HTTP server (the engine fetches its footage by
// range, which file:// cannot do). The browser is render's puppeteer and its
// pinned headless Chrome, with a throwaway profile and no network, closed at
// the end. It never reaches a running app or the person's browser.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const EDITOR = join(HERE, '..')
const requireFromRender = createRequire(join(HERE, '..', '..', 'render', 'package.json'))
const { default: puppeteer } = await import(pathToFileURL(requireFromRender.resolve('puppeteer')).href)

const oneReact = {
  name: 'one-react',
  setup(b) {
    b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) =>
      args.resolveDir.startsWith(EDITOR) ? undefined : b.resolve(args.path, { kind: args.kind, resolveDir: EDITOR }))
  },
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mp4': 'video/mp4' }

let browser
let server
let origin
let workDir

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'play-glyph-'))
  await build({
    entryPoints: [join(HERE, 'fixtures', 'play-glyph.tsx')],
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    outfile: join(workDir, 'page.js'),
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty', '.css': 'empty', '.jsx': 'jsx' },
    plugins: [oneReact],
    logLevel: 'error',
  })
  copyFileSync(join(HERE, 'fixtures', 'play-glyph-clip.mp4'), join(workDir, 'play-glyph-clip.mp4'))
  writeFileSync(
    join(workDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { margin: 0; background: #fff; font: 12px sans-serif; }
      .relative { position: relative } .absolute { position: absolute } .inset-0 { inset: 0 }
      .overflow-hidden { overflow: hidden } .pointer-events-none { pointer-events: none } .z-50 { z-index: 50 }
      .flex { display: flex } .items-center { align-items: center } .justify-center { justify-content: center }
      .cursor-pointer { cursor: pointer } .w-14 { width: 56px } .h-14 { height: 56px } .rounded-full { border-radius: 999px }
    </style></head><body><div id="root"></div><script src="page.js"></script></body></html>`,
  )
  // Static files with byte ranges; anything else is a 404.
  server = createServer((req, res) => {
    const path = join(workDir, new URL(req.url, 'http://x').pathname.replace(/^\/+/, '') || 'index.html')
    let size
    try { size = statSync(path).size } catch { res.writeHead(404).end(); return }
    const type = TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream'
    const body = readFileSync(path)
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
    if (m) {
      const start = m[1] ? Number(m[1]) : size - Number(m[2])
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
      res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
      res.end(body.subarray(start, end + 1))
      return
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size })
    res.end(body)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--use-mock-keychain', '--password-store=basic', '--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--autoplay-policy=no-user-gesture-required'],
  })
})

after(async () => {
  await browser?.close()
  await new Promise((r) => (server ? server.close(r) : r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

async function open(query) {
  const page = await browser.newPage()
  await page.setViewport({ width: 400, height: 700, deviceScaleFactor: 1 })
  page.errors = []
  page.on('pageerror', (e) => page.errors.push(e))
  await page.goto(`${origin}/index.html?${query}`)
  await page.waitForFunction(() => window.__ready === true)
  return page
}

const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

/** The play glyph: whether it is on screen, its centre, and what a click there lands on. */
function glyph(page) {
  return page.evaluate(() => {
    const path = document.querySelector('[data-montaj-preview-stage] svg path[d="M8 5v14l11-7z"]')
    if (!path) return { visible: false }
    const b = path.closest('svg').parentElement.getBoundingClientRect()
    const x = b.left + b.width / 2
    const y = b.top + b.height / 2
    const hit = document.elementFromPoint(x, y)
    return { visible: true, x, y, hit: hit ? `${hit.tagName.toLowerCase()} ${hit.getAttribute('aria-label') ?? ''} ${hit.getAttribute('style') ?? ''}`.slice(0, 160) : null }
  })
}

async function waitFor(page, fn, what, timeout = 4000) {
  try {
    await page.waitForFunction(fn, { timeout, polling: 50 })
  } catch {
    const g = await glyph(page)
    const state = await page.evaluate(() => ({ playing: window.__playing, time: window.__time(), warns: window.__warns }))
    assert.fail(`${what}: timed out (${JSON.stringify({ ...state, glyph: g })})`)
  }
}

/** Waits until the glyph shows, clicks it, and requires playback to start. */
async function clickGlyphPlays(page, what) {
  await waitFor(page, () => window.__playing === false, `${what}: paused before the click`)
  await frames(page)
  const g = await glyph(page)
  assert.ok(g.visible, `${what}: the play glyph is not on screen while paused`)
  await page.mouse.click(g.x, g.y)
  await waitFor(page, () => window.__playing === true, `${what}: a click on the play glyph did not play (it landed on ${g.hit})`)
}

/** The path the page actually plays on. */
async function assertPath(page, engine) {
  const shown = await page.evaluate(() => ({
    video: document.querySelectorAll('[data-montaj-preview-frame] video').length,
    fallback: window.__warns.some((w) => w.includes('playback engine unavailable')),
  }))
  if (engine) assert.ok(!shown.fallback && shown.video === 0, `expected the engine, got ${JSON.stringify(shown)}`)
  else assert.ok(shown.video > 0, `expected the legacy player, got ${JSON.stringify(shown)}`)
}

for (const engine of [true, false]) {
  const path = engine ? 'engine' : 'legacy'

  test(`${path}: with the playhead at the end, a click on the glyph plays from the start`, async () => {
    const page = await open(`engine=${engine ? 1 : 0}&kind=video`)
    await frames(page)
    await assertPath(page, engine)
    await page.evaluate(() => window.__setTime(1.5))
    await frames(page)
    await clickGlyphPlays(page, 'at the end')
    await waitFor(page, () => window.__time() > 0.05 && window.__time() < 1.4, 'playback runs from the start')
    assert.deepEqual(page.errors, [])
    await page.close()
  })

  test(`${path}: after playing out to the end, a click on the glyph plays again`, async () => {
    const page = await open(`engine=${engine ? 1 : 0}&kind=video`)
    await frames(page)
    await page.evaluate(() => window.__setTime(1.2))
    await frames(page)
    await clickGlyphPlays(page, 'near the end')
    await waitFor(page, () => window.__playing === false, 'playback stops at the end', 5000)
    await clickGlyphPlays(page, 'once ended')
    assert.deepEqual(page.errors, [])
    await page.close()
  })

  test(`${path}: an overlay-only timeline at its end plays again from the start`, async () => {
    const page = await open(`engine=${engine ? 1 : 0}&kind=canvas`)
    await frames(page)
    await page.evaluate(() => window.__setTime(1.5))
    await frames(page)
    // An overlay covers the middle here, so the glyph may hide; Space is the
    // other way in and must not be a no-op at the end either.
    await waitFor(page, () => window.__playing === false, 'paused at the end')
    await page.keyboard.press('Space')
    await waitFor(page, () => window.__playing === true, 'Space at the end did not play')
    await waitFor(page, () => window.__time() < 1.4, 'playback runs from the start')
    await page.close()
  })

  test(`${path}: with the on-screen clip selected, a click on the glyph plays`, async () => {
    const page = await open(`engine=${engine ? 1 : 0}&kind=video`)
    await frames(page)
    await page.evaluate(() => window.__select('c1'))
    await frames(page)
    await clickGlyphPlays(page, 'clip selected')
    assert.deepEqual(page.errors, [])
    await page.close()
  })

  test(`${path}: a right-click on the selected clip neither plays nor moves it`, async () => {
    const page = await open(`engine=${engine ? 1 : 0}&kind=video`)
    await frames(page)
    await page.evaluate(() => window.__select('c1'))
    await frames(page)
    const g = await glyph(page)
    await page.mouse.click(g.x + 40, g.y + 40, { button: 'right' })
    await new Promise((r) => setTimeout(r, 400))
    const state = await page.evaluate(() => ({ offsetX: window.__project.tracks[0][0].offsetX ?? 0, playing: window.__playing }))
    assert.deepEqual(state, { offsetX: 0, playing: false })
    await page.close()
  })

  test(`${path}: dragging the selected clip still moves it and does not play`, async () => {
    const page = await open(`engine=${engine ? 1 : 0}&kind=video`)
    await frames(page)
    await page.evaluate(() => window.__select('c1'))
    await frames(page)
    const g = await glyph(page)
    const x = g.x + 60
    const y = g.y + 120
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (let i = 1; i <= 5; i++) await page.mouse.move(x + i * 6, y)
    await page.mouse.up()
    await frames(page)
    const moved = await page.evaluate(() => ({ offsetX: window.__project.tracks[0][0].offsetX, playing: window.__playing }))
    assert.ok(moved.offsetX > 1, `the clip did not move: ${JSON.stringify(moved)}`)
    assert.equal(moved.playing, false)
    await page.close()
  })

  test(`${path}: the glyph never shows over a layer that takes the click`, async () => {
    const page = await open(`engine=${engine ? 1 : 0}&kind=video&overlay=1`)
    await waitFor(page, () => document.querySelectorAll('[data-montaj-preview-frame] svg polygon, [data-montaj-preview-frame] svg path').length >= 1, 'the overlay drew')
    await frames(page)
    await frames(page)
    // Unselected, the overlay is click-through: the glyph shows and plays.
    // Selected, it takes the click for its own drag: the glyph must not
    // promise a play there, and a click on the bare frame still plays.
    await page.evaluate(() => window.__select('hex'))
    await frames(page)
    await frames(page)
    const g = await glyph(page)
    assert.equal(g.visible, false, `the glyph shows over the selected overlay, where a click lands on ${g.hit}`)
    const frame = await page.evaluate(() => { const b = document.querySelector('[data-montaj-preview-frame]').getBoundingClientRect(); return { x: b.left + 20, y: b.top + 20 } })
    await page.mouse.click(frame.x, frame.y)
    await waitFor(page, () => window.__playing === true, 'a click on the bare frame did not play')
    await page.mouse.click(frame.x, frame.y)
    await waitFor(page, () => window.__playing === false, 'a second click did not pause')
    await page.evaluate(() => window.__select(undefined))
    await frames(page)
    await clickGlyphPlays(page, 'overlay deselected')
    await page.close()
  })
}

test('legacy: a play() the browser refuses is logged', async () => {
  const page = await open('engine=0&kind=video&src=missing')
  await frames(page)
  const g = await glyph(page)
  await page.mouse.click(g.x, g.y)
  await waitFor(page, () => window.__warns.some((w) => /play/i.test(w) && /refused|rejected|failed/i.test(w)), 'no log line for the refused play()')
  await page.close()
})
