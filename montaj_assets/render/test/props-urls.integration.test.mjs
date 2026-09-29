// render/test/props-urls.integration.test.mjs
//
// PV54 (f): the positive allowlist, at the listener. A normal project whose
// overlay shows one remote image its props name, served by a local listener,
// rendered through each entry point that loads an overlay page:
// sampleOverlay, render-carousel.js (one slide) and render.js (a few frames).
//
// Each must reach the listener exactly once, with Node's fetch rather than the
// page's (page-guard.js prefetches props URLs before the page loads and serves
// the page from that cache), and the image must be in the output. A props URL
// that cannot be fetched fails the job, naming it.
//
// Also a legit case the boundary must keep: a props image outside the
// workspace (a named file) still renders.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { FFMPEG } from '../ffmpeg-bin.js'
import { sampleOverlay } from '../sample-frame.js'

const RENDER = join(dirname(fileURLToPath(import.meta.url)), '..')
const BADGE_PATH = '/images/media/team/badge/barcelona.png'
const BADGE_RGB = [0x22, 0x66, 0xcc]
const SIZE = 64

let base, ws, elsewhere, server, origin, badgePng
const hits = []

before(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-props-urls-')))
  ws = join(base, 'ws')
  elsewhere = join(base, 'elsewhere')
  mkdirSync(join(ws, 'proj', 'overlays'), { recursive: true })
  mkdirSync(elsewhere)
  // The workspace, for this process and the render children it spawns.
  process.env.MONTAJ_WORKSPACE_DIR = ws

  const png = join(elsewhere, 'badge.png')
  const hex = BADGE_RGB.map(v => v.toString(16).padStart(2, '0')).join('')
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=${SIZE}x${SIZE}`,
    '-frames:v', '1', '-pix_fmt', 'rgb24', png], { encoding: 'utf8' })
  assert.equal(r.status, 0, `ffmpeg (${FFMPEG}) could not make the badge: ${r.stderr}`)
  badgePng = readFileSync(png)

  writeFileSync(join(ws, 'proj', 'overlays', 'badge.jsx'), `export default function Badge({ badge }) {
  return <img src={badge} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
}
`)

  server = createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, ua: req.headers['user-agent'] ?? '' })
    if (req.url === BADGE_PATH) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': badgePng.length })
      return res.end(badgePng)
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

function assertBadgeColour(file, tolerance) {
  const px = centrePixel(file)
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(px[i] - BADGE_RGB[i]) <= tolerance, `centre pixel ${px} is not the badge ${BADGE_RGB}`)
  }
}

/** Exactly one GET of the badge, and it came from Node, not from the page. */
function assertOneNodeGet(label) {
  assert.deepEqual(hits.map(h => `${h.method} ${h.url}`), [`GET ${BADGE_PATH}`], `${label}: the listener saw`)
  assert.doesNotMatch(hits[0].ua, /Chrome/, `${label}: fetched by Node before the page loaded, not by the page`)
}

/** Run a render entry point as the app does, as a child, without blocking this process's listener. */
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

test('sampleOverlay: one Node GET of the props URL, and the image is in the sample', { timeout: 120_000 }, async () => {
  hits.length = 0
  const out = join(base, 'sample.png')
  await sampleOverlay({
    componentPath: join(ws, 'proj', 'overlays', 'badge.jsx'),
    props: { badge: `${origin}${BADGE_PATH}` },
    frame: 0, fps: 30, width: SIZE, height: SIZE, outPath: out,
    projectDir: join(ws, 'proj'),
  })
  assertOneNodeGet('sampleOverlay')
  assertBadgeColour(out, 2)
})

test('render-carousel.js: one Node GET for a slide image, and the image is on the slide', { timeout: 180_000 }, async () => {
  hits.length = 0
  const proj = join(ws, 'carousel')
  const out = join(proj, 'out')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'project.json'), JSON.stringify({
    projectType: 'carousel',
    settings: { resolution: [SIZE * 2, SIZE * 2] },
    carousel: { aspect: 'square' },
    slides: [{ id: 's1', base_color: '#ffffff', elements: [
      { id: 'img', type: 'image', src: `${origin}${BADGE_PATH}`, x: 0, y: 0, w: SIZE * 2, h: SIZE * 2 },
    ] }],
  }))
  const r = await runNode([join(RENDER, 'render-carousel.js'), '--project-json', join(proj, 'project.json'), '--out', out])
  assert.equal(r.status, 0, r.stderr.slice(-800))
  const pngs = readdirSync(out).filter(n => n.endsWith('.png'))
  assert.equal(pngs.length, 1)
  assertOneNodeGet('render-carousel.js')
  assertBadgeColour(join(out, pngs[0]), 2)
})

test('render.js: one Node GET across the whole render, and the image is in the video', { timeout: 300_000 }, async () => {
  hits.length = 0
  const proj = join(ws, 'video')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'project.json'), JSON.stringify({
    version: '0.2', id: 'props-url', status: 'final', projectType: 'editing',
    settings: { resolution: [SIZE * 2, SIZE * 2], fps: 30, colorSpace: 'sdr_bt709' },
    tracks: [
      { id: 'trk-0', items: [] },
      { id: 'trk-1', items: [{
        id: 'badge', type: 'overlay', src: join(ws, 'proj', 'overlays', 'badge.jsx'),
        props: { badge: `${origin}${BADGE_PATH}` }, start: 0, end: 0.2,
      }] },
    ],
    assets: [], audio: {},
  }))
  const out = join(proj, 'out.mp4')
  const r = await runNode([join(RENDER, 'render.js'), join(proj, 'project.json'), '--out', out])
  assert.equal(r.status, 0, r.stderr.slice(-800))
  assertOneNodeGet('render.js')
  // Through yuv420p and back: a few levels either way.
  assertBadgeColour(out, 8)
})

test('a props URL that answers 404 fails the sample, naming the URL', { timeout: 120_000 }, async () => {
  hits.length = 0
  const missing = `${origin}/images/media/team/badge/missing.png`
  await assert.rejects(sampleOverlay({
    componentPath: join(ws, 'proj', 'overlays', 'badge.jsx'),
    props: { badge: missing },
    frame: 0, fps: 30, width: SIZE, height: SIZE, outPath: join(base, 'missing.png'),
  }), err => {
    assert.equal(err.sampleError, 'props_fetch_failed')
    assert.equal(err.message, `props URL ${missing} could not be fetched: HTTP 404`)
    return true
  })
})

test('a props URL that answers 404 fails render.js, naming the URL', { timeout: 120_000 }, async () => {
  const proj = join(ws, 'video-404')
  const missing = `${origin}/images/media/team/badge/missing.png`
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'project.json'), JSON.stringify({
    version: '0.2', id: 'props-url-404', status: 'final', projectType: 'editing',
    settings: { resolution: [SIZE * 2, SIZE * 2], fps: 30, colorSpace: 'sdr_bt709' },
    tracks: [{ id: 'trk-0', items: [] }, { id: 'trk-1', items: [{
      id: 'badge', type: 'overlay', src: join(ws, 'proj', 'overlays', 'badge.jsx'),
      props: { badge: missing }, start: 0, end: 0.2,
    }] }],
    assets: [], audio: {},
  }))
  const r = await runNode([join(RENDER, 'render.js'), join(proj, 'project.json'), '--out', join(proj, 'out.mp4')])
  assert.notEqual(r.status, 0)
  assert.ok(r.stderr.includes(`props URL ${missing} could not be fetched: HTTP 404`), r.stderr.slice(-800))
})

test('a props image that answers 404 fails its carousel slide, naming the URL', { timeout: 180_000 }, async () => {
  const proj = join(ws, 'carousel-404')
  const out = join(proj, 'out')
  const missing = `${origin}/images/media/team/badge/missing-slide.png`
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'project.json'), JSON.stringify({
    projectType: 'carousel',
    settings: { resolution: [SIZE * 2, SIZE * 2] },
    carousel: { aspect: 'square' },
    slides: [{ id: 's1', base_color: '#ffffff', elements: [
      { id: 'img', type: 'image', src: missing, x: 0, y: 0, w: SIZE * 2, h: SIZE * 2 },
    ] }],
  }))
  const r = await runNode([join(RENDER, 'render-carousel.js'), '--project-json', join(proj, 'project.json'), '--out', out])
  assert.equal(r.status, 1, r.stderr.slice(-800))
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.failures, [{ index: 1, id: 's1', error: `props URL ${missing} could not be fetched: HTTP 404` }])
  assert.deepEqual(readdirSync(out).filter(n => n.endsWith('.png')), [], 'no slide rendered without its image')
})

test('a props URL shown only as text is never fetched, and an unused one that fails does not fail the sample',
  { timeout: 120_000 }, async () => {
  hits.length = 0
  const comp = join(ws, 'proj', 'overlays', 'cta.jsx')
  writeFileSync(comp, `export default function Cta({ link }) {
  return <div style={{ position: 'absolute', inset: 0, background: '#2266cc', color: '#fff' }}>{link}</div>
}
`)
  const out = join(base, 'cta.png')
  await sampleOverlay({
    componentPath: comp,
    props: { link: `${origin}/signup?token=abc`, spare: `${origin}/images/media/team/badge/unused.png` },
    frame: 0, fps: 30, width: SIZE, height: SIZE, outPath: out, projectDir: join(ws, 'proj'),
  })
  assertBadgeColour(out, 2)
  // The media URL was prefetched (and failed, unused); the link never left the machine.
  assert.deepEqual(hits.map(h => h.url), ['/images/media/team/badge/unused.png'])
})

test('legit: a slide image given relative to a project outside the workspace renders', { timeout: 180_000 }, async () => {
  const proj = join(base, 'cli-carousel')   // outside the workspace, as a CLI project may be
  const out = join(proj, 'out')
  mkdirSync(join(proj, 'assets'), { recursive: true })
  writeFileSync(join(proj, 'assets', 'badge.png'), badgePng)
  writeFileSync(join(proj, 'project.json'), JSON.stringify({
    projectType: 'carousel',
    settings: { resolution: [SIZE * 2, SIZE * 2] },
    carousel: { aspect: 'square' },
    slides: [{ id: 's1', base_color: '#ffffff', elements: [
      { id: 'img', type: 'image', src: 'assets/badge.png', x: 0, y: 0, w: SIZE * 2, h: SIZE * 2 },
    ] }],
  }))
  const r = await runNode([join(RENDER, 'render-carousel.js'), '--project-json', join(proj, 'project.json'), '--out', out])
  assert.equal(r.status, 0, r.stderr.slice(-800))
  assert.doesNotMatch(r.stderr, /blocked a read/)
  const pngs = readdirSync(out).filter(n => n.endsWith('.png'))
  assertBadgeColour(join(out, pngs[0]), 2)
})

// A user's media often lives outside the workspace (an external drive,
// ~/Downloads). A project names it the way the overlay skill says to, in props
// (or as a slide's image, or a track's image item), and it must still render
// through every entry point, from a project inside the workspace.
test('legit: media outside the workspace renders through render.js, as an overlay prop and as an image item',
  { timeout: 300_000 }, async () => {
  const outsidePng = join(elsewhere, 'badge.png')
  for (const [label, item] of [
    ['overlay prop', { id: 'badge', type: 'overlay', src: join(ws, 'proj', 'overlays', 'badge.jsx'),
      props: { badge: outsidePng }, start: 0, end: 0.2 }],
    ['image item', { id: 'still', type: 'image', src: outsidePng, start: 0, end: 0.2 }],
  ]) {
    const proj = join(ws, `outside-media-${label.replace(' ', '-')}`)
    mkdirSync(proj, { recursive: true })
    writeFileSync(join(proj, 'project.json'), JSON.stringify({
      version: '0.2', id: 'outside-media', status: 'final', projectType: 'editing',
      settings: { resolution: [SIZE * 2, SIZE * 2], fps: 30, colorSpace: 'sdr_bt709' },
      tracks: [{ id: 'trk-0', items: [] }, { id: 'trk-1', items: [item] }],
      assets: [], audio: {},
    }))
    const out = join(proj, 'out.mp4')
    const r = await runNode([join(RENDER, 'render.js'), join(proj, 'project.json'), '--out', out])
    assert.equal(r.status, 0, `${label}: ${r.stderr.slice(-800)}`)
    assert.doesNotMatch(r.stderr, /blocked a read/, label)
    assertBadgeColour(out, 8)
  }
})

test('legit: a slide image outside the workspace renders through render-carousel.js', { timeout: 180_000 }, async () => {
  const proj = join(ws, 'outside-media-carousel')
  const out = join(proj, 'out')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'project.json'), JSON.stringify({
    projectType: 'carousel',
    settings: { resolution: [SIZE * 2, SIZE * 2] },
    carousel: { aspect: 'square' },
    slides: [{ id: 's1', base_color: '#ffffff', elements: [
      { id: 'img', type: 'image', src: join(elsewhere, 'badge.png'), x: 0, y: 0, w: SIZE * 2, h: SIZE * 2 },
    ] }],
  }))
  const r = await runNode([join(RENDER, 'render-carousel.js'), '--project-json', join(proj, 'project.json'), '--out', out])
  assert.equal(r.status, 0, r.stderr.slice(-800))
  assert.doesNotMatch(r.stderr, /blocked a read/)
  const pngs = readdirSync(out).filter(n => n.endsWith('.png'))
  assertBadgeColour(join(out, pngs[0]), 2)
})

test('legit: a props image outside the workspace still renders (a named file)', { timeout: 120_000 }, async () => {
  hits.length = 0
  const out = join(base, 'outside.png')
  await sampleOverlay({
    componentPath: join(ws, 'proj', 'overlays', 'badge.jsx'),
    props: { badge: join(elsewhere, 'badge.png') },
    frame: 0, fps: 30, width: SIZE, height: SIZE, outPath: out,
    projectDir: join(ws, 'proj'),
  })
  assertBadgeColour(out, 2)
  assert.deepEqual(hits, [], 'a file reaches no listener')
})
