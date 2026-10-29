// Run: npm --prefix montaj_assets/editor run test:browser
//
// §587 round 2 (R9), in a real browser: `photoColoursOf` reads an image's
// dominant colours through a canvas. jsdom has no canvas pixels, so only a real
// browser can say what a same-origin picture gives, that a cross-origin picture
// served without CORS is refused, and how a broken URL ends.
//
// Two throwaway servers on 127.0.0.1 (nothing leaves the machine): A serves the
// page and a PNG, B serves a PNG with no CORS header, a different origin. The
// browser is render's puppeteer and its pinned headless Chrome, with a
// throwaway profile, closed at the end. It never reaches a running app or the
// person's browser.
//
// A failure is kept for the session: the image is requested once, however many
// times the panel opens.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const EDITOR = join(HERE, '..')
const requireFromRender = createRequire(join(HERE, '..', '..', 'render', 'package.json'))
const { default: puppeteer } = await import(pathToFileURL(requireFromRender.resolve('puppeteer')).href)

/** A PNG: the left half red, the right half blue. */
function twoColourPng(size = 32) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3)
    for (let x = 0; x < size; x++) {
      const o = 1 + x * 3
      if (x < size / 2) row[o] = 255
      else row[o + 2] = 255
    }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const png = twoColourPng()
let workDir
let pageJs
let browser
let page
let hits = {}
const servers = []

function serve(handler) {
  return new Promise((resolve) => {
    const s = createServer(handler)
    servers.push(s)
    s.listen(0, '127.0.0.1', () => resolve(s.address().port))
  })
}

let a
let b
before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'photo-colours-'))
  await build({
    stdin: {
      contents: `import { photoColoursOf } from './src/carousel/photoColours'\nwindow.photoColoursOf = photoColoursOf`,
      resolveDir: EDITOR,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    outfile: join(workDir, 'page.js'),
    logLevel: 'error',
  })
  const { readFileSync } = await import('node:fs')
  pageJs = readFileSync(join(workDir, 'page.js'))
  a = await serve((req, res) => {
    hits[`A${req.url}`] = (hits[`A${req.url}`] ?? 0) + 1
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><body><script src="/page.js"></script>'); return }
    if (req.url === '/page.js') { res.setHeader('content-type', 'text/javascript'); res.end(pageJs); return }
    if (req.url === '/two.png') { res.setHeader('content-type', 'image/png'); res.end(png); return }
    res.statusCode = 404
    res.end('no')
  })
  b = await serve((req, res) => {
    hits[`B${req.url}`] = (hits[`B${req.url}`] ?? 0) + 1
    // A picture, but no Access-Control-Allow-Origin.
    res.setHeader('content-type', 'image/png')
    res.end(png)
  })
  browser = await puppeteer.launch({ headless: 'new', args: ['--use-mock-keychain', '--password-store=basic', '--no-sandbox'] })
  page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${a}/`)
  await page.waitForFunction(() => typeof window.photoColoursOf === 'function')
})

after(async () => {
  await browser?.close()
  for (const s of servers) s.close()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

const read = (src) => page.evaluate((src) => window.photoColoursOf(src).then((ok) => ({ ok }), (e) => ({ error: String(e && e.message) })), src)

test('a same-origin PNG gives its colours, and is read once', async () => {
  const out = await read('/two.png')
  assert.ok(out.ok, JSON.stringify(out))
  assert.deepEqual([...out.ok].sort(), ['#0000ff', '#ff0000'])
  assert.equal(JSON.stringify(await read('/two.png')), JSON.stringify(out))
  assert.equal(hits['A/two.png'], 1, 'the picture was requested more than once')
})

test('a cross-origin picture without CORS is refused, and the refusal is kept for the session', async () => {
  const src = `http://127.0.0.1:${b}/plain.png`
  const first = await read(src)
  assert.ok(first.error, `expected a rejection, got ${JSON.stringify(first)}`)
  const second = await read(src)
  assert.ok(second.error, 'the second read also rejects')
  assert.equal(hits['B/plain.png'], 1, 'an unreadable picture was fetched again')
})

test('a broken URL rejects, and is not fetched again', async () => {
  const first = await read('/missing.png')
  assert.ok(first.error, `expected a rejection, got ${JSON.stringify(first)}`)
  const second = await read('/missing.png')
  assert.ok(second.error)
  assert.equal(hits['A/missing.png'], 1, 'a broken picture was fetched again')
})
