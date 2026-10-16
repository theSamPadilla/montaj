// render/test/carousel-pages.test.mjs
//
// A carousel as web pages (render-carousel.js --html-dir): one still page per slide with no scripts, the files a slide
// names copied beside it with relative paths, an index.html that swipes through them, and --html-only / --only.
// Slow: it launches the real render and a real browser, like render-carousel.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, copyFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import puppeteer from 'puppeteer'
import { overlayPageLaunchOptions } from '../page-guard.js'
import { relocateFileUrls, swipePage } from '../carousel-pages.js'

const here = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(here, '..', 'render-carousel.js')

test('relocateFileUrls: each file:// URL is copied once and becomes a relative path; a missing one is kept and warned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-cpages-'))
  try {
    const pic = join(dir, 'a b.png')
    writeFileSync(pic, 'x')
    const href = pathToFileURL(pic).href
    const warnings = []
    const out = relocateFileUrls(`<img src="${href}"><div style="background:url(${href})"></div><img src="file:///nope/missing.png">`, join(dir, 'out'), new Map(), warnings, { n: 0 })
    assert.equal((out.match(/assets\/01-a b\.png/g) ?? []).length, 2, 'one copy, used twice')
    assert.equal(existsSync(join(dir, 'out', 'assets', '01-a b.png')), true)
    assert.match(out, /file:\/\/\/nope\/missing\.png/)
    assert.match(warnings[0], /missing\.png/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('swipePage: every slide in its own frame, scroll-snapped, sized to the slide', () => {
  const html = swipePage({ files: ['slide-01.html', 'slide-02.html'], width: 1080, height: 1350, title: 'Trail <tips>' })
  assert.equal((html.match(/<iframe /g) ?? []).length, 2)
  assert.match(html, /scroll-snap-type: x mandatory/)
  assert.match(html, /aspect-ratio: 1080 \/ 1350/)
  assert.match(html, /<title>Trail &lt;tips&gt;<\/title>/)
})

test('--html-dir writes a still page per slide, the swipeable index and the copied images; --html-only writes no PNGs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-cpages-'))
  const browser = await puppeteer.launch(overlayPageLaunchOptions({ needsGoogleFonts: false }))
  try {
    const proj = join(dir, 'proj')
    mkdirSync(proj)
    const badge = join(proj, 'badge.png')
    copyFileSync(join(here, 'fixtures', 'export-pages', 'logo.jpg'), badge)
    writeFileSync(join(proj, 'project.json'), JSON.stringify({
      projectType: 'carousel', name: 'Trail tips', settings: { resolution: [540, 675] }, carousel: { aspect: 'portrait' },
      slides: [
        { id: 's1', base_color: '#fde68a', elements: [{ id: 'i', type: 'image', src: badge, x: 40, y: 40, w: 200, h: 200 }] },
        { id: 's2', base_color: '#bbf7d0', elements: [] },
      ],
    }))
    const run = (extra) => spawnSync(process.execPath, [SCRIPT, '--project-json', join(proj, 'project.json'), '--out', join(dir, 'tmp'), '--scale', '1', ...extra], { encoding: 'utf8' })
    const out = join(dir, 'pages')
    const r = run(['--html-dir', out, '--html-only'])
    assert.equal(r.status, 0, r.stderr.slice(-800))
    assert.deepEqual(readdirSync(out).sort(), ['assets', 'index.html', 'slide-01.html', 'slide-02.html'])
    assert.deepEqual(readdirSync(join(dir, 'tmp')).filter((f) => f.endsWith('.png')), [], '--html-only writes no PNGs')
    const slide1 = readFileSync(join(out, 'slide-01.html'), 'utf8')
    assert.doesNotMatch(slide1, /<script/i, 'a still page has no scripts')
    assert.doesNotMatch(slide1, /file:\/\//, 'every file is a relative copy')
    assert.match(slide1, /assets\/01-badge\.png/)
    assert.equal(existsSync(join(out, 'assets', '01-badge.png')), true)
    assert.match(readFileSync(join(out, 'index.html'), 'utf8'), /slide-02\.html/)

    const page = await browser.newPage()
    await page.setViewport({ width: 540, height: 675 })
    await page.goto(pathToFileURL(join(out, 'slide-01.html')).href)
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0))
    const bg = await page.evaluate(() => getComputedStyle(document.getElementById('root').firstElementChild ?? document.body).backgroundColor)
    assert.ok(bg, 'the slide draws its background without any script')

    const only = join(dir, 'only')
    const r2 = run(['--html-dir', only, '--html-only', '--only', '2'])
    assert.equal(r2.status, 0, r2.stderr.slice(-800))
    assert.deepEqual(readdirSync(only).sort(), ['index.html', 'slide-02.html'], '--only 2: just the second slide')
  } finally {
    await browser.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
