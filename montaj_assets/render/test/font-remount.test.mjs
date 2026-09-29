// render/test/font-remount.test.mjs
//
// PV50 T2. The shim (bundle.js `generateShim`) mounts the overlay before its
// webfont has loaded, so an overlay that positions text by measuring it
// measures fallback metrics. Waiting for `document.fonts.ready` inside
// `__setFrame` does not help on its own: frame 0 does not even re-render, and a
// mount-only measurement never re-runs. The fix remounts the overlay once a font
// has loaded, and waits for a face the overlay first uses on a later frame.
//
// Every case drives a real page exactly the way renderChunk (renderer.js) does
// (same launch args, `networkidle0`, `__setFrame`, wait for `renderedFrame`,
// double rAF), one page per chunk. The fonts are the offline fixture set in
// fixtures/fonts, so nothing here reaches the network.
//
// Positions are checked against the live DOM re-measured after every font is
// in, not against hardcoded numbers, and each check also asserts the face
// really loaded: with the font missing, both sides would be fallback metrics
// and agree, which is a pass that proves nothing.
//
// (a) to (c) fail before the fix. (d) and (e) are regression guards for the
// fix itself: an overlay with no font must never remount, and a remounted
// Three.js canvas must still be drawn on the frame it remounts on.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'
import { bundleComponent, cleanupBundle } from '../bundle.js'
import { toFileHref } from '../file-url.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FONTS    = join(__dirname, 'fixtures', 'fonts')
const OVERLAYS = join(__dirname, 'fixtures', 'font-remount')
const WIDTH    = 1080
const HEIGHT   = 600

let browser
before(async () => {
  // Same args as launchBrowser() in renderer.js, kept in sync by hand.
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-web-security', '--allow-file-access-from-files'],
    protocolTimeout: 300000,
  })
})
after(async () => { await browser?.close() })

// One page is one chunk: bundled and loaded fresh, then stepped frame by frame.
async function openChunk(overlay, googleFonts) {
  const { htmlPath, workDir } = await bundleComponent({
    componentPath: join(OVERLAYS, overlay), props: {}, fps: 30, durationFrames: 90,
    width: WIDTH, height: HEIGHT, googleFonts, fontsBaseDir: FONTS,
  })
  const page = await browser.newPage()
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 })
  await page.goto(toFileHref(htmlPath), { waitUntil: 'networkidle0' })
  return {
    page,
    async frame(f) {
      await page.evaluate((f) => window.__setFrame(f), f)
      await page.waitForFunction((f) => document.documentElement.dataset.renderedFrame === String(f), { timeout: 10000 }, f)
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
    },
    async close() {
      await page.close()
      cleanupBundle(workDir)
    },
  }
}

// The word positions the overlay committed for the captured frame, and where
// those words really go once every font is in, re-measured from the live DOM.
async function positions(page, font) {
  return page.evaluate(async (font) => {
    const committed = document.getElementById('ov').dataset.xs
    await document.fonts.ready
    let x = 60
    const truth = []
    for (const s of document.querySelectorAll('.w')) {
      truth.push(Math.round(x))
      x += s.getBoundingClientRect().width + 30
    }
    return { committed, truth: truth.join(','), loaded: document.fonts.check(font) }
  }, font)
}

async function assertPositions(page, font, label) {
  const p = await positions(page, font)
  assert.ok(p.loaded, `${label}: ${font} never loaded, so this check would compare fallback with fallback`)
  assert.equal(p.committed, p.truth, `${label}: committed x positions must equal the real-font layout`)
}

// The screenshot's pixel at (x, y), decoded in a blank page so the overlay's
// own page is left alone.
async function screenshotPixel(page, x, y) {
  const png = await page.screenshot({ encoding: 'base64' })
  const probe = await browser.newPage()
  try {
    return await probe.evaluate(async (b64, x, y) => {
      const img = new Image()
      img.src = 'data:image/png;base64,' + b64
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const g = c.getContext('2d')
      g.drawImage(img, 0, 0)
      return [...g.getImageData(x, y, 1, 1).data]
    }, png, x, y)
  } finally {
    await probe.close()
  }
}

test('(a) an overlay measuring per frame is right on frame 0', { timeout: 120_000 }, async () => {
  const chunk = await openChunk('WordsDom.jsx', ['Bebas+Neue'])
  try {
    await chunk.frame(0)
    await assertPositions(chunk.page, "160px 'Bebas Neue'", 'WordsDom frame 0')
  } finally {
    await chunk.close()
  }
})

test('(b) an overlay measuring once at mount is right on every frame, in every chunk', { timeout: 120_000 }, async () => {
  const font = "160px 'Bebas Neue'"
  const seen = {}
  const first = await openChunk('WordsMount.jsx', ['Bebas+Neue'])
  try {
    for (const f of [0, 5]) {
      await first.frame(f)
      seen[`frame ${f}`] = await positions(first.page, font)
    }
  } finally {
    await first.close()
  }
  // A later chunk mounts at 0 and jumps straight to its own first frame.
  const later = await openChunk('WordsMount.jsx', ['Bebas+Neue'])
  try {
    await later.frame(30)
    seen['chunk starting at frame 30'] = await positions(later.page, font)
  } finally {
    await later.close()
  }
  // Collected first and compared once, so a failure shows every frame at once.
  for (const [label, p] of Object.entries(seen)) {
    assert.ok(p.loaded, `WordsMount ${label}: ${font} never loaded, so this check would compare fallback with fallback`)
  }
  const pick = (key) => Object.fromEntries(Object.entries(seen).map(([label, p]) => [label, p[key]]))
  assert.deepEqual(pick('committed'), pick('truth'),
    'WordsMount: committed x positions must equal the real-font layout on every frame and in every chunk')
})

test('(c) a face first used on frame 10 is loaded and measured on frame 10', { timeout: 120_000 }, async () => {
  const chunk = await openChunk('LateFace.jsx', ['Oswald'])
  try {
    for (const f of [0, 9, 10]) await chunk.frame(f)
    await assertPositions(chunk.page, "160px 'Oswald'", 'LateFace frame 10')
  } finally {
    await chunk.close()
  }
})

test('(d) an overlay that loads no font mounts exactly once', { timeout: 120_000 }, async () => {
  // The stylesheet is linked, but nothing uses its faces, so nothing loads.
  const chunk = await openChunk('NoFont.jsx', ['Bebas+Neue'])
  try {
    for (const f of [0, 1, 2, 5]) await chunk.frame(f)
    assert.equal(await chunk.page.evaluate(() => window.__mounts), 1,
      'no font loaded, so the overlay must never be remounted: its frames stay byte-identical')
  } finally {
    await chunk.close()
  }
})

test('(e) a Three.js overlay remounted for its font still draws on frame 0', { timeout: 120_000 }, async () => {
  const chunk = await openChunk('ThreeText.jsx', ['Bebas+Neue'])
  try {
    await chunk.frame(0)
    assert.ok(await chunk.page.evaluate(() => document.fonts.check("120px 'Bebas Neue'")),
      'the label font must load, or the overlay is never remounted and this checks nothing')
    // The unlit red plane sits at the centre of the frame; blank there is the
    // #222233 background.
    const [r, g, b] = await screenshotPixel(chunk.page, WIDTH / 2, HEIGHT / 2)
    assert.ok(r > 200 && g < 50 && b < 50,
      `the Three scene must be drawn on frame 0, got rgb(${r}, ${g}, ${b}) at the centre`)
  } finally {
    await chunk.close()
  }
})
