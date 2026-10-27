// Run: npm --prefix montaj_assets/editor run test:browser
//
// A sound dragged from the Media bin lands in audio.tracks, in a real browser: a real mouse drag from a card that
// starts the drag as AudioCard does, released over the real TimelineCanvas. jsdom fires whatever drag events a test
// hands it; this one lets Chrome run the drag.
//
// The fixture (fixtures/audio-drop.tsx) is bundled with esbuild into a temp dir and opened from file://. The browser
// is render's puppeteer and its pinned headless Chrome, launched with a throwaway profile and no network, and closed at
// the end. It never reaches a running app or the person's browser.

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

let browser
let page
let workDir
let errors

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'audio-drop-'))
  await build({
    entryPoints: [join(HERE, 'fixtures', 'audio-drop.tsx')],
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    outfile: join(workDir, 'page.js'),
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty', '.css': 'empty' },
    absWorkingDir: EDITOR,
    logLevel: 'error',
  })
  writeFileSync(
    join(workDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { margin: 0; background: #fff; font: 12px sans-serif; }
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

beforeEach(async () => {
  await page?.close()
  page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 600, deviceScaleFactor: 1 })
  errors = []
  page.on('pageerror', (e) => errors.push(e))
  await page.goto(pathToFileURL(join(workDir, 'index.html')).href)
  await page.waitForFunction(() => window.__ready === true)
  await page.waitForSelector('#timeline canvas')
})

const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
const center = async (sel) => page.$eval(sel, (el) => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })

/** A real drag: press on the card, move in steps, release at (x, y) page coordinates. */
async function dragCardTo(x, y) {
  const from = await center('#card')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 4 })
  await page.mouse.move(x, y, { steps: 12 })
  await page.mouse.up()
  await frames()
}

const audioTracks = () => page.evaluate(() => window.__project.audio.tracks)
const timelineBox = () => page.$eval('#timeline', (el) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height } })

test('a card dropped on the audio lane lands on that lane at the time under the pointer', async () => {
  // The audio lane is the bottom row of the surface. Release on it, at x for t = 5 s (100 px per second).
  const surface = await page.$eval('[data-timeline-canvas]', (el) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top } })
  const lane = await page.evaluate(() => window.__layout().lanes[0])
  await dragCardTo(surface.left + 500, surface.top + lane.y + lane.height / 2)
  const tracks = await audioTracks()
  assert.equal(tracks.length, 2, JSON.stringify(tracks))
  const added = tracks.find((t) => t.src === '/p/assets/bed.mp3')
  assert.ok(added, JSON.stringify(tracks))
  assert.equal(added.type, 'music')
  assert.equal(added.lane, 0, 'the existing lane')
  assert.ok(Math.abs(added.start - 5) < 0.05, `start ${added.start}`)
  assert.ok(Math.abs(added.end - 9) < 0.05, `end ${added.end}`)
  assert.deepEqual(errors, [])
})

test('a card dropped on the ruler lands on a new audio lane and leaves the video track alone', async () => {
  const box = await timelineBox()
  await dragCardTo(box.left + 700, box.top + 8)
  const tracks = await audioTracks()
  const added = tracks.find((t) => t.src === '/p/assets/bed.mp3')
  assert.ok(added, JSON.stringify(tracks))
  assert.equal(added.lane, 1)
  const items = await page.evaluate(() => window.__project.tracks[0].items.length)
  assert.equal(items, 1)
  assert.deepEqual(errors, [])
})
