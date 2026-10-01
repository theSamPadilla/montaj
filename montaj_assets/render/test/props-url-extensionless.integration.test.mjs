// render/test/props-url-extensionless.integration.test.mjs
//
// The export matches the preview for a remote image with no extension (Spotify
// cover art, https://i.scdn.co/image/ab67…): the preview's <img> shows it, and
// the sample, the export (render.js) and a carousel slide now draw it too.
// Before, the render left it blank and logged "not fetched".
//
// Served by a local listener only; nothing here reaches the network. Each image
// reaches the listener once, from Node (page-guard.js prefetches props URLs and
// serves the page from that cache), and is pixel-checked in the output. What is
// not an image stays blank with the same log line as before, an oversized one is
// refused by the cap, and file: and data: are decided exactly as before.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FFMPEG } from '../ffmpeg-bin.js'
import { sampleOverlay } from '../sample-frame.js'

const RENDER = join(dirname(fileURLToPath(import.meta.url)), '..')
const COVER_PATH = '/image/ab67616d0000b273e8b066f70c206551210d902b'   // the shape of a Spotify cover URL
const COVER_RGB = [0x22, 0x66, 0xcc]
const WHITE = [0xff, 0xff, 0xff]
const SIZE = 64
const HTML = '<!doctype html><html><head><title>Sign up</title></head><body>hello</body></html>'

let base, ws, elsewhere, server, origin, coverPng, overlay
const hits = []

before(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-props-url-noext-')))
  ws = join(base, 'ws')
  elsewhere = join(base, 'elsewhere')
  mkdirSync(join(ws, 'proj', 'overlays'), { recursive: true })
  mkdirSync(elsewhere)
  process.env.MONTAJ_WORKSPACE_DIR = ws

  const png = join(elsewhere, 'cover.png')
  const hex = COVER_RGB.map(v => v.toString(16).padStart(2, '0')).join('')
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=${SIZE}x${SIZE}`,
    '-frames:v', '1', '-pix_fmt', 'rgb24', png], { encoding: 'utf8' })
  assert.equal(r.status, 0, `ffmpeg (${FFMPEG}) could not make the cover: ${r.stderr}`)
  coverPng = readFileSync(png)

  // White behind the image; an image that does not load hides itself, so what
  // is left is the white (the overlay's own fallback).
  overlay = join(ws, 'proj', 'overlays', 'cover.jsx')
  writeFileSync(overlay, `export default function Cover({ cover }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#ffffff' }}>
      <img src={cover} onError={e => { e.currentTarget.style.display = 'none' }}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
    </div>
  )
}
`)

  server = createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, ua: req.headers['user-agent'] ?? '' })
    const send = (type, body) => {
      res.writeHead(200, { 'content-type': type, 'content-length': body.length })
      res.end(body)
    }
    if (req.url === COVER_PATH) return send('image/png', coverPng)
    if (req.url === '/image/octet') return send('application/octet-stream', coverPng)
    if (req.url === '/image/html') return send('text/html; charset=utf-8', Buffer.from(HTML))
    if (req.url === '/image/huge') {
      // Declares more than the 50 MB cap; the body never needs to be sent.
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(60 * 1024 * 1024) })
      res.write(coverPng)
      return
    }
    res.writeHead(404); res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server?.closeAllConnections(); server?.close()
  if (base) rmSync(base, { recursive: true, force: true })
})

/** The centre pixel of an image or video's first frame, as [r, g, b]. */
function centrePixel(file) {
  const r = spawnSync(FFMPEG, ['-loglevel', 'error', '-i', file, '-frames:v', '1',
    '-vf', 'crop=2:2:iw/2-1:ih/2-1,scale=1:1:flags=area,format=rgb24', '-f', 'rawvideo', 'pipe:1'],
    { encoding: 'buffer' })
  assert.equal(r.status, 0, `ffmpeg could not read ${file}: ${r.stderr}`)
  return [...r.stdout.subarray(0, 3)]
}

function assertColour(file, rgb, tolerance, label) {
  const px = centrePixel(file)
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(px[i] - rgb[i]) <= tolerance, `${label}: centre pixel ${px} is not ${rgb}`)
  }
}

/** Exactly these GETs, each from Node rather than the page. */
function assertNodeGets(paths, label) {
  assert.deepEqual(hits.map(h => `${h.method} ${h.url}`), paths.map(p => `GET ${p}`), `${label}: the listener saw`)
  for (const h of hits) assert.doesNotMatch(h.ua, /Chrome/, `${label}: fetched by Node before the page loaded, not by the page`)
}

async function withStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr)
  let text = ''
  process.stderr.write = (c, ...rest) => { text += String(c); return orig(c, ...rest) }
  try { return [await fn(), text] } finally { process.stderr.write = orig }
}

const sample = (cover, name) => sampleOverlay({
  componentPath: overlay, props: { cover },
  frame: 0, fps: 30, width: SIZE, height: SIZE, outPath: join(base, name),
  projectDir: join(ws, 'proj'),
})

function runNode(args, { cwd = base } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: process.env })
    let stderr = ''
    child.stderr.on('data', c => { stderr += c })
    child.stdout.resume()
    child.on('error', reject)
    child.on('close', status => resolve({ status, stderr }))
  })
}

test('sampleOverlay: an extension-less URL serving image/png is drawn', { timeout: 120_000 }, async () => {
  hits.length = 0
  const res = await sample(`${origin}${COVER_PATH}`, 'png.png')
  assertNodeGets([COVER_PATH], 'image/png')
  assertColour(res.pngPath, COVER_RGB, 2, 'image/png')
})

test('sampleOverlay: the same bytes as application/octet-stream are drawn, by their first bytes', { timeout: 120_000 }, async () => {
  hits.length = 0
  const res = await sample(`${origin}/image/octet`, 'octet.png')
  assertNodeGets(['/image/octet'], 'octet-stream')
  assertColour(res.pngPath, COVER_RGB, 2, 'octet-stream')
})

test('sampleOverlay: text/html is refused: blank, logged as not fetched, and the sample is not failed or cached', { timeout: 120_000 }, async () => {
  hits.length = 0
  const url = `${origin}/image/html`
  const [res, log] = await withStderr(() => sample(url, 'html.png'))
  assertNodeGets(['/image/html'], 'text/html')
  assertColour(res.pngPath, WHITE, 2, 'text/html')
  assert.ok(log.includes(`[montaj] not fetched: ${url} (a props URL is fetched only when`), log)
  assert.equal(res.degraded, true, 'a sample the guard blocked anything in is not cached')
})

test('sampleOverlay: an extension-less image over the 50 MB cap is refused, failing the sample by name', { timeout: 120_000 }, async () => {
  hits.length = 0
  const url = `${origin}/image/huge`
  await assert.rejects(sample(url, 'huge.png'), err => {
    assert.equal(err.sampleError, 'props_fetch_failed')
    assert.equal(err.message, `props URL ${url} exceeds 50 MB`)
    return true
  })
  assertNodeGets(['/image/huge'], 'oversize')
})

test('unchanged: data: and file: never reach the fetcher, and are decided as before', { timeout: 180_000 }, async () => {
  hits.length = 0
  // data: is allowed on the page, as before.
  const inline = await sample(`data:image/png;base64,${coverPng.toString('base64')}`, 'data.png')
  assertColour(inline.pngPath, COVER_RGB, 2, 'data:')
  // An extension-less file outside the workspace that props do not name is
  // refused by the read boundary, as before: the overlay hardcodes it.
  const noext = join(elsewhere, 'cover-noext')
  writeFileSync(noext, coverPng)
  const hardcoded = join(ws, 'proj', 'overlays', 'hardcoded.jsx')
  writeFileSync(hardcoded, readFileSync(overlay, 'utf8').replace('src={cover}', `src={${JSON.stringify(pathToFileURL(noext).href)}}`))
  const [refused, log] = await withStderr(() => sampleOverlay({
    componentPath: hardcoded, props: {},
    frame: 0, fps: 30, width: SIZE, height: SIZE, outPath: join(base, 'file.png'), projectDir: join(ws, 'proj'),
  }))
  assertColour(refused.pngPath, WHITE, 2, 'file: outside the boundary')
  assert.ok(log.includes(`[montaj] blocked a read outside the allowed folders: ${noext}`), log)
  assert.deepEqual(hits, [], 'neither reached the listener')
})

test('render.js: the export draws an extension-less cover, fetched once by Node', { timeout: 300_000 }, async () => {
  hits.length = 0
  const proj = join(ws, 'video')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'project.json'), JSON.stringify({
    version: '0.2', id: 'props-url-noext', status: 'final', projectType: 'editing',
    settings: { resolution: [SIZE * 2, SIZE * 2], fps: 30, colorSpace: 'sdr_bt709' },
    tracks: [
      { id: 'trk-0', items: [] },
      { id: 'trk-1', items: [{
        id: 'cover', type: 'overlay', src: overlay,
        props: { cover: `${origin}${COVER_PATH}` }, start: 0, end: 0.2,
      }] },
    ],
    assets: [], audio: {},
  }))
  const out = join(proj, 'out.mp4')
  const r = await runNode([join(RENDER, 'render.js'), join(proj, 'project.json'), '--out', out])
  assert.equal(r.status, 0, r.stderr.slice(-800))
  assertNodeGets([COVER_PATH], 'render.js')
  // Through yuv420p and back: a few levels either way.
  assertColour(out, COVER_RGB, 8, 'render.js')
})

test('render-carousel.js: a slide image with no extension is drawn', { timeout: 180_000 }, async () => {
  hits.length = 0
  const proj = join(ws, 'carousel')
  const out = join(proj, 'out')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'project.json'), JSON.stringify({
    projectType: 'carousel',
    settings: { resolution: [SIZE * 2, SIZE * 2] },
    carousel: { aspect: 'square' },
    slides: [{ id: 's1', base_color: '#ffffff', elements: [
      { id: 'img', type: 'image', src: `${origin}${COVER_PATH}`, x: 0, y: 0, w: SIZE * 2, h: SIZE * 2 },
    ] }],
  }))
  const r = await runNode([join(RENDER, 'render-carousel.js'), '--project-json', join(proj, 'project.json'), '--out', out])
  assert.equal(r.status, 0, r.stderr.slice(-800))
  const pngs = readdirSync(out).filter(n => n.endsWith('.png'))
  assert.equal(pngs.length, 1)
  assertNodeGets([COVER_PATH], 'render-carousel.js')
  assertColour(join(out, pngs[0]), COVER_RGB, 2, 'render-carousel.js')
})
