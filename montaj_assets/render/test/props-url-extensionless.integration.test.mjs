// render/test/props-url-extensionless.integration.test.mjs
//
// The export matches the preview for a remote image with no extension (Spotify
// cover art, https://i.scdn.co/image/ab67…): the preview's <img> loads it when
// the overlay shows it, and so does the render now. Node fetches it ON DEMAND,
// when the overlay page requests that exact props URL (page-guard.js), never
// before: a link with no extension that the overlay only shows as text is
// never requested (PV54).
//
// The render captures frame by frame, so an image fetched on demand must be in
// the frame it first appears in. Each image here answers after DELAY_MS, so a
// capture that did not wait for it would come out blank: the sample, the export
// (render.js) and a carousel slide are pixel-checked on the frame the image
// mounts in, frame 0 and a later one.
//
// Served by a local listener only; nothing here reaches the network.
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
const COVER = '/image/ab67616d0000b273e8b066f70c206551210d902b'   // the shape of a Spotify cover URL
const COVER_RGB = [0x22, 0x66, 0xcc]
const WHITE = [0xff, 0xff, 0xff]
const SIZE = 64
const DELAY_MS = 300
const HTML = '<!doctype html><html><head><title>Sign up</title></head><body>hello</body></html>'

let base, ws, elsewhere, server, origin, coverPng, overlay, late
const hits = []

// White behind the image; an image that does not load hides itself, so what is
// left is the white (the overlay's own fallback). `from` is the first frame it
// is shown in.
const coverJsx = from => `export default function Cover({ cover }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#ffffff' }}>
      {frame >= ${from} && <img src={cover} onError={e => { e.currentTarget.style.display = 'none' }}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />}
    </div>
  )
}
`

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

  overlay = join(ws, 'proj', 'overlays', 'cover.jsx')
  writeFileSync(overlay, coverJsx(0))
  late = join(ws, 'proj', 'overlays', 'late.jsx')
  writeFileSync(late, coverJsx(3))

  server = createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, ua: req.headers['user-agent'] ?? '' })
    const send = (type, body) => setTimeout(() => {
      res.writeHead(200, { 'content-type': type, 'content-length': body.length })
      res.end(body)
    }, DELAY_MS)
    const path = req.url.split('?')[0]
    if (path.startsWith(COVER)) return send('image/png', coverPng)                 // COVER, COVER-late, …
    if (path === '/image/octet') return send('application/octet-stream', coverPng)
    if (path === '/image/html') return send('text/html; charset=utf-8', Buffer.from(HTML))
    if (path === '/image/huge') {
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

/** The centre pixel of frame `n` of an image or video, as [r, g, b]. */
function centrePixel(file, n = 0) {
  const r = spawnSync(FFMPEG, ['-loglevel', 'error', '-i', file,
    '-vf', `select=eq(n\\,${n}),crop=2:2:iw/2-1:ih/2-1,scale=1:1:flags=area,format=rgb24`,
    '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })
  assert.equal(r.status, 0, `ffmpeg could not read ${file}: ${r.stderr}`)
  assert.equal(r.stdout.length, 3, `${file} has no frame ${n}`)
  return [...r.stdout]
}

function assertColour(file, rgb, tolerance, label, n = 0) {
  const px = centrePixel(file, n)
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(px[i] - rgb[i]) <= tolerance, `${label}: frame ${n} centre pixel ${px} is not ${rgb}`)
  }
}

/** Exactly these GETs, each from Node rather than the page. */
function assertNodeGets(paths, label) {
  assert.deepEqual(hits.map(h => `${h.method} ${h.url}`), paths.map(p => `GET ${p}`), `${label}: the listener saw`)
  for (const h of hits) assert.doesNotMatch(h.ua, /Chrome/, `${label}: fetched by Node, not by the page`)
}

async function withStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr)
  let text = ''
  process.stderr.write = (c, ...rest) => { text += String(c); return orig(c, ...rest) }
  try { return [await fn(), text] } finally { process.stderr.write = orig }
}

const sample = (props, name, { componentPath = overlay, frame = 0 } = {}) => sampleOverlay({
  componentPath, props, frame, fps: 30, width: SIZE, height: SIZE, outPath: join(base, name),
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

// (a)
test('a text-only link with no extension is never requested; neither is a page or another extension', { timeout: 120_000 }, async () => {
  hits.length = 0
  const comp = join(ws, 'proj', 'overlays', 'links.jsx')
  writeFileSync(comp, `export default function Links({ link, home, page }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#ffffff' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '25%', overflow: 'hidden', fontSize: 6, color: '#000' }}>{link} {home} {page}</div>
    </div>
  )
}
`)
  const res = await sample({ link: `${origin}/signup?token=abc`, home: `${origin}/`, page: `${origin}/signup.php?token=abc` },
    'links.png', { componentPath: comp })
  assertColour(res.pngPath, WHITE, 2, 'text-only links')
  assert.deepEqual(hits, [], 'no request reached the listener')
  assert.equal(res.degraded, false, 'nothing was blocked: the page never asked')
})

// (b)
test('sampleOverlay: an extension-less image the overlay loads is drawn on frame 0', { timeout: 120_000 }, async () => {
  hits.length = 0
  const res = await sample({ cover: `${origin}${COVER}-sample` }, 'png.png')
  assertNodeGets([`${COVER}-sample`], 'image/png')
  assertColour(res.pngPath, COVER_RGB, 2, 'image/png')
})

test('sampleOverlay: the same bytes as application/octet-stream are drawn, by their first bytes', { timeout: 120_000 }, async () => {
  hits.length = 0
  const res = await sample({ cover: `${origin}/image/octet` }, 'octet.png')
  assertNodeGets(['/image/octet'], 'octet-stream')
  assertColour(res.pngPath, COVER_RGB, 2, 'octet-stream')
})

test('sampleOverlay: an image that mounts on a later frame is drawn in that frame', { timeout: 120_000 }, async () => {
  hits.length = 0
  const res = await sample({ cover: `${origin}${COVER}-sample-late` }, 'late.png', { componentPath: late, frame: 3 })
  assertNodeGets([`${COVER}-sample-late`], 'later frame')
  assertColour(res.pngPath, COVER_RGB, 2, 'later frame')
})

// (c)
test('sampleOverlay: one that serves text/html is aborted: blank, logged as not fetched, and the sample is not failed or cached', { timeout: 120_000 }, async () => {
  hits.length = 0
  const url = `${origin}/image/html`
  const [res, log] = await withStderr(() => sample({ cover: `${url}?token=abc` }, 'html.png'))
  assertNodeGets(['/image/html?token=abc'], 'text/html')
  assertColour(res.pngPath, WHITE, 2, 'text/html')
  assert.ok(log.includes(`[montaj] not fetched: ${url} (a props URL is fetched only when`), log)
  assert.doesNotMatch(log, /token=abc/)
  assert.equal(res.degraded, true, 'a sample the guard blocked anything in is not cached')
})

// (d)
test('unchanged: an extension-less URL the props do not name is aborted, unrequested', { timeout: 120_000 }, async () => {
  hits.length = 0
  const comp = join(ws, 'proj', 'overlays', 'hardcoded-url.jsx')
  writeFileSync(comp, readFileSync(overlay, 'utf8').replace('src={cover}', `src={${JSON.stringify(`${origin}${COVER}-unnamed`)}}`))
  const [res, log] = await withStderr(() => sample({ cover: `${origin}${COVER}-named` }, 'unnamed.png', { componentPath: comp }))
  assertColour(res.pngPath, WHITE, 2, 'not in props')
  assert.ok(log.includes(`[montaj] blocked a network request to ${new URL(origin).host}`), log)
  assert.deepEqual(hits, [], 'neither the hardcoded URL nor the named one the page never asked for')
})

test('an extension-less image over the 50 MB cap is refused, failing the sample by name', { timeout: 120_000 }, async () => {
  hits.length = 0
  const url = `${origin}/image/huge`
  await assert.rejects(sample({ cover: url }, 'huge.png'), err => {
    assert.equal(err.sampleError, 'props_fetch_failed')
    assert.equal(err.message, `props URL ${url} exceeds 50 MB`)
    return true
  })
  assertNodeGets(['/image/huge'], 'oversize')
})

test('unchanged: data: and file: never reach the fetcher, and are decided as before', { timeout: 180_000 }, async () => {
  hits.length = 0
  // data: is allowed on the page, as before.
  const inline = await sample({ cover: `data:image/png;base64,${coverPng.toString('base64')}` }, 'data.png')
  assertColour(inline.pngPath, COVER_RGB, 2, 'data:')
  // An extension-less file outside the workspace that props do not name is
  // refused by the read boundary, as before: the overlay hardcodes it.
  const noext = join(elsewhere, 'cover-noext')
  writeFileSync(noext, coverPng)
  const hardcoded = join(ws, 'proj', 'overlays', 'hardcoded.jsx')
  writeFileSync(hardcoded, readFileSync(overlay, 'utf8').replace('src={cover}', `src={${JSON.stringify(pathToFileURL(noext).href)}}`))
  const [refused, log] = await withStderr(() => sample({}, 'file.png', { componentPath: hardcoded }))
  assertColour(refused.pngPath, WHITE, 2, 'file: outside the boundary')
  assert.ok(log.includes(`[montaj] blocked a read outside the allowed folders: ${noext}`), log)
  assert.deepEqual(hits, [], 'neither reached the listener')
})

// (b), the export
test('render.js: the export draws an extension-less cover on frame 0, and one that mounts later in its frame', { timeout: 300_000 }, async () => {
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
        props: { cover: `${origin}${COVER}-export` }, start: 0, end: 0.2,
      }] },
    ],
    assets: [], audio: {},
  }))
  const out = join(proj, 'out.mp4')
  const r = await runNode([join(RENDER, 'render.js'), join(proj, 'project.json'), '--out', out])
  assert.equal(r.status, 0, r.stderr.slice(-800))
  assertNodeGets([`${COVER}-export`], 'render.js')
  // Through yuv420p and back: a few levels either way.
  assertColour(out, COVER_RGB, 8, 'render.js', 0)

  hits.length = 0
  const lateProj = join(ws, 'video-late')
  mkdirSync(lateProj, { recursive: true })
  writeFileSync(join(lateProj, 'project.json'), JSON.stringify({
    version: '0.2', id: 'props-url-noext-late', status: 'final', projectType: 'editing',
    settings: { resolution: [SIZE * 2, SIZE * 2], fps: 30, colorSpace: 'sdr_bt709' },
    tracks: [
      { id: 'trk-0', items: [] },
      { id: 'trk-1', items: [{
        id: 'late', type: 'overlay', src: late,
        props: { cover: `${origin}${COVER}-export-late` }, start: 0, end: 0.2,
      }] },
    ],
    assets: [], audio: {},
  }))
  const lateOut = join(lateProj, 'out.mp4')
  const r2 = await runNode([join(RENDER, 'render.js'), join(lateProj, 'project.json'), '--out', lateOut])
  assert.equal(r2.status, 0, r2.stderr.slice(-800))
  assertNodeGets([`${COVER}-export-late`], 'render.js, later frame')
  assertColour(lateOut, WHITE, 8, 'render.js before it mounts', 2)
  assertColour(lateOut, COVER_RGB, 8, 'render.js, the frame it mounts in', 3)
})

// (b), a carousel slide
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
      { id: 'img', type: 'image', src: `${origin}${COVER}-slide`, x: 0, y: 0, w: SIZE * 2, h: SIZE * 2 },
    ] }],
  }))
  const r = await runNode([join(RENDER, 'render-carousel.js'), '--project-json', join(proj, 'project.json'), '--out', out])
  assert.equal(r.status, 0, r.stderr.slice(-800))
  const pngs = readdirSync(out).filter(n => n.endsWith('.png'))
  assert.equal(pngs.length, 1)
  assertNodeGets([`${COVER}-slide`], 'render-carousel.js')
  assertColour(join(out, pngs[0]), COVER_RGB, 2, 'render-carousel.js')
})
