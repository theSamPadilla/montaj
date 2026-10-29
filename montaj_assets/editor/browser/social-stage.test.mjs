// Run: npm --prefix montaj_assets/editor run test:browser
//
// The social preview, in a real browser: with a platform picked, the preview is
// the platform's 9:16 phone, and a 1:1, 4:5 or 16:9 video sits in it whole,
// centred, with black above and below, the way all three platforms show such an
// upload; the platform's UI covers the phone, not the video. With no preview
// the frame is the video's own aspect, as before. The export never changes.
//
// The fixture (fixtures/social-stage.tsx) is the real PreviewPlayer in a host
// box sized as VideoEditor sizes it, bundled with esbuild and served from a
// throwaway local HTTP server. The browser is render's puppeteer and its pinned
// headless Chrome, with a throwaway profile and no network. It never reaches a
// running app or the person's browser. STILLS_DIR=<dir> also saves 1:1 and
// 16:9 stills for each platform.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  workDir = mkdtempSync(join(tmpdir(), 'social-stage-'))
  await build({
    entryPoints: [join(HERE, 'fixtures', 'social-stage.tsx')],
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
      .relative { position: relative } .absolute { position: absolute } .inset-0 { inset: 0 }
      .overflow-hidden { overflow: hidden } .pointer-events-none { pointer-events: none } .z-50 { z-index: 50 }
      .flex { display: flex } .items-center { align-items: center } .justify-center { justify-content: center }
      .cursor-pointer { cursor: pointer } .w-14 { width: 56px } .h-14 { height: 56px } .rounded-full { border-radius: 999px }
      /* The chrome's own utilities, near enough for the stills. */
      .bg-black { background: #000 } [class*="text-white"] { color: rgba(255,255,255,.92) } .text-black { color: #000 }
      [class*="bg-white"] { background: rgba(255,255,255,.95) } .rounded-xl { border-radius: 12px } .rounded-full { border-radius: 999px }
      .flex-col { flex-direction: column } .justify-between { justify-content: space-between } .items-end { align-items: flex-end }
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
  await page.setViewport({ width: 640, height: 640, deviceScaleFactor: 2 })
  page.errors = []
  page.on('pageerror', (e) => page.errors.push(e))
  await page.goto(`${origin}/index.html?${query}`)
  await page.waitForFunction(() => window.__ready === true)
  await page.waitForFunction(() => document.querySelectorAll('[data-montaj-preview-frame] svg').length >= 2)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  return page
}

function boxes(page) {
  return page.evaluate(() => {
    const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height } }
    return {
      host: r('[data-host-box]'),
      stage: r('[data-montaj-preview-stage]'),
      frame: r('[data-montaj-preview-frame]'),
      chrome: r('[data-testid="social-safe-zone-canvas"]'),
      stageBg: getComputedStyle(document.querySelector('[data-montaj-preview-stage]')).backgroundColor,
    }
  })
}

const TOL = 1.5
function near(a, b, what) {
  assert.ok(Math.abs(a - b) <= TOL, `${what}: ${a.toFixed(2)} is not ${b.toFixed(2)}`)
}

// Where the stills go, when asked for (STILLS_DIR=...): 1:1 and 16:9 on each platform.
const STILLS = process.env.STILLS_DIR

const ASPECTS = [['1:1', 1080, 1080], ['4:5', 1080, 1350], ['16:9', 1920, 1080], ['9:16', 1080, 1920]]
const PLATFORMS = ['tiktok', 'youtube', 'instagram']

for (const [label, w, h] of ASPECTS) {
  for (const social of PLATFORMS) {
    test(`${social}, a ${label} video sits whole in the 9:16 phone, centred, black above and below, under the chrome`, async () => {
      const page = await open(`res=${w}x${h}&social=${social}`)
      const b = await boxes(page)
      // The stage is the phone: 9:16, filling the host box.
      near(b.stage.width / b.stage.height, 9 / 16, 'the stage aspect')
      near(b.stage.width, b.host.width, 'the stage width')
      near(b.stage.height, b.host.height, 'the stage height')
      assert.equal(b.stageBg, 'rgb(0, 0, 0)')
      // The frame keeps the video's aspect, as wide as the phone, centred.
      near(b.frame.width, b.stage.width, 'the frame width')
      near(b.frame.height, b.stage.width * h / w, 'the frame height')
      near(b.frame.left, b.stage.left, 'the frame left')
      near(b.frame.top - b.stage.top, b.stage.top + b.stage.height - (b.frame.top + b.frame.height), 'the black above against the black below')
      // The chrome covers the phone, not the video.
      assert.ok(b.chrome, 'no chrome')
      near(b.chrome.left, b.stage.left, 'the chrome left')
      near(b.chrome.top, b.stage.top, 'the chrome top')
      near(b.chrome.width, b.stage.width, 'the chrome width')
      near(b.chrome.height, b.stage.height, 'the chrome height')
      if (STILLS && (label === '1:1' || label === '16:9')) {
        mkdirSync(STILLS, { recursive: true })
        const el = await page.$('[data-host-box]')
        await el.screenshot({ path: join(STILLS, `${social}-${label.replace(':', 'x')}.png`) })
      }
      assert.deepEqual(page.errors, [])
      await page.close()
    })
  }

  test(`no preview, a ${label} video fills its own frame as before`, async () => {
    const page = await open(`res=${w}x${h}&social=none`)
    const b = await boxes(page)
    assert.equal(b.chrome, null)
    near(b.stage.width / b.stage.height, w / h, 'the stage aspect')
    for (const k of ['left', 'top', 'width', 'height']) {
      near(b.frame[k], b.stage[k], `the frame ${k}`)
      near(b.stage[k], b.host[k], `the stage ${k}`)
    }
    assert.deepEqual(page.errors, [])
    await page.close()
  })
}
