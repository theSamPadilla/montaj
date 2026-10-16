// render/test/nle-graphics.integration.test.mjs
/**
 * `renderNleGraphics` (render/nle/graphics.js): every overlay and the caption
 * layer of an editor export, each rendered once into a full-canvas ProRes 4444
 * movie with alpha, through the real Puppeteer capture and ffmpeg.
 *
 * One small project (320x180, 30 fps) carries three overlays of the
 * frame-driven ramp fixture (frame N paints grey N*5, so a pixel's grey names
 * the overlay frame it came from) and a two-segment caption layer:
 *
 *   ramp    0.5 to 1.5 s, scaled, offset            frames 15..45, opaque
 *   early  -0.2 to 0.3 s, scaled, rotated, 0.8      frames 0..9, its frame 6 first
 *   moving  0.2 to 1.2 s, keyframed offset/opacity  frames 6..36
 *   captions "Hello" 0.2-0.6 s, "World" 0.8-1.3 s   frames 6..39, red boxes
 *
 * Each movie is checked for its format, size, frame count and first frame,
 * and the whole set for parity: the movies stacked over black in the render's
 * order must give the frames render.js itself writes for the project.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildNleTimeline } from '../nle/timeline.js'
import { renderNleGraphics } from '../nle/graphics.js'
import { probeSources } from '../nle/probe.js'
import { writeXmeml } from '../nle/xmeml.js'
import { FFMPEG, FFPROBE } from '../ffmpeg-bin.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDER_JS = join(__dirname, '..', 'render.js')
const W = 320
const H = 180
const FPS = 30

function haveTools() {
  return spawnSync(FFPROBE, ['-version']).status === 0 && spawnSync(FFMPEG, ['-version']).status === 0
}

function makeProject(jsx) {
  return {
    version: '0.2',
    id: 'nle-graphics-test',
    status: 'final',
    projectType: 'editing',
    settings: { resolution: [W, H], fps: FPS, colorSpace: 'sdr_bt709' },
    tracks: [
      { id: 'trk-0', items: [] },
      { id: 'trk-1', items: [
        { id: 'ramp', type: 'overlay', src: jsx, props: {}, start: 0.5, end: 1.5, scale: 0.5, offsetX: 10, offsetY: -5 },
        { id: 'early', type: 'overlay', src: jsx, props: {}, start: -0.2, end: 0.3, scale: 0.4, rotation: 15, opacity: 0.8 },
        { id: 'moving', type: 'overlay', src: jsx, props: {}, start: 0.2, end: 1.2, scale: 0.3,
          keyframes: [
            { prop: 'offsetX', points: [{ t: 0, value: -20 }, { t: 1, value: 20 }] },
            { prop: 'opacity', points: [{ t: 0, value: 0.3 }, { t: 0.5, value: 1 }] },
          ] },
      ] },
    ],
    captions: {
      style: 'subtitle',
      backgroundColor: '#ff0000',
      segments: [
        { id: 'c1', text: 'Hello', start: 0.2, end: 0.6 },
        { id: 'c2', text: 'World', start: 0.8, end: 1.3 },
      ],
    },
    assets: [],
    audio: {},
  }
}

/** Frame `n` of `path` as RGBA bytes, W x H. */
function frameRgba(path, n) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', path, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, `ffmpeg could not read frame ${n} of ${path}: ${r.stderr}`)
  assert.equal(r.stdout.length, W * H * 4, `frame ${n} of ${path} is not ${W}x${H} RGBA`)
  return r.stdout
}

/** Every frame of `path` as RGB bytes, concatenated. */
function allFramesRgb(path) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 256 * 1024 * 1024 })
  assert.equal(r.status, 0, `ffmpeg could not decode ${path}: ${r.stderr}`)
  return r.stdout
}

const px = (buf, x, y) => {
  const i = (y * W + x) * 4
  return { r: buf[i], g: buf[i + 1], b: buf[i + 2], a: buf[i + 3] }
}
const alphas = (buf) => Array.from({ length: W * H }, (_, i) => buf[i * 4 + 3])

function probeStream(path) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=codec_name,profile,pix_fmt,width,height,nb_read_frames,r_frame_rate,color_space,color_transfer,color_primaries',
    '-of', 'json', path], { encoding: 'utf8' })
  assert.equal(r.status, 0, `ffprobe failed on ${path}: ${r.stderr}`)
  return JSON.parse(r.stdout).streams[0]
}

let dir = null
let scratchTmp = null
let projectPath = null
let project = null
let timeline = null
let result = null
let progress = []
let projectEntriesBefore = null
let tmpEntriesAfter = null
let skip = false

before(async () => {
  if (!haveTools()) { skip = true; return }
  dir = mkdtempSync(join(tmpdir(), 'montaj-nle-graphics-test-'))
  // Everything the graphics step puts in the OS temp dir lands here, so the
  // test can see that it is all gone afterwards.
  scratchTmp = join(dir, 'tmp')
  mkdirSync(scratchTmp)
  const projDir = join(dir, 'proj')
  mkdirSync(projDir)
  copyFileSync(join(__dirname, 'fixtures', 'cadence-ramp.jsx'), join(projDir, 'cadence-ramp.jsx'))
  project = makeProject('cadence-ramp.jsx')
  projectPath = join(projDir, 'project.json')
  writeFileSync(projectPath, JSON.stringify(project, null, 2))
  projectEntriesBefore = readdirSync(projDir).sort()

  timeline = buildNleTimeline(project, { projectDir: projDir })
  const savedTmp = process.env.TMPDIR
  process.env.TMPDIR = scratchTmp
  try {
    result = await renderNleGraphics(project, timeline, {
      projectDir: projDir,
      outDir: join(projDir, 'export', 'nle-graphics-test (editor)'),
      onProgress: (p) => progress.push(p),
    })
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = savedTmp
  }
  tmpEntriesAfter = readdirSync(scratchTmp)
})

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const clipOf = (id) => timeline.videoTracks.flatMap((t) => t.clips).find((c) => c.id === id)

test('the timeline the movies are for', (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  assert.deepEqual([clipOf('ramp').startFrame, clipOf('ramp').endFrame], [15, 45])
  assert.deepEqual([clipOf('early').startFrame, clipOf('early').endFrame, clipOf('early').sourceIn], [0, 9, 0.2])
  assert.deepEqual([clipOf('moving').startFrame, clipOf('moving').endFrame], [6, 36])
  const cap = timeline.captionsTrack.clips[0]
  assert.deepEqual([cap.startFrame, cap.endFrame], [6, 39])
})

test('one movie per graphic and one for the captions, with progress per movie', (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const out = join(dirname(projectPath), 'export', 'nle-graphics-test (editor)')
  assert.deepEqual(result.graphics, {
    ramp: join(out, 'graphics', 'ramp.mov'),
    early: join(out, 'graphics', 'early.mov'),
    moving: join(out, 'graphics', 'moving.mov'),
  })
  assert.equal(result.captions, join(out, 'captions.mov'))
  assert.deepEqual(result.warnings, [])
  assert.ok(result.seconds > 0, `seconds is the time taken, got ${result.seconds}`)
  t.diagnostic(`graphics step took ${result.seconds.toFixed(1)} s for 4 movies (102 frames)`)

  assert.deepEqual(progress.map((p) => [p.done, p.total]), [[1, 4], [2, 4], [3, 4], [4, 4]])
  assert.deepEqual(progress.map((p) => p.label).sort(), ['captions', 'early', 'moving', 'ramp'])
})

test('each movie is ProRes 4444 with alpha, full frame, exactly its clip long', (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const expected = {
    [result.graphics.ramp]: 30,
    [result.graphics.early]: 9,
    [result.graphics.moving]: 30,
    [result.captions]: 33,
  }
  for (const [path, frames] of Object.entries(expected)) {
    assert.ok(existsSync(path), `${path} was not written`)
    const s = probeStream(path)
    assert.equal(s.codec_name, 'prores', path)
    assert.equal(s.profile, '4444', path)
    assert.match(s.pix_fmt, /^yuva/, `${path} has no alpha plane (${s.pix_fmt})`)
    assert.equal(s.width, W, path)
    assert.equal(s.height, H, path)
    assert.equal(Number(s.nb_read_frames), frames, `${path} frame count`)
    assert.equal(s.r_frame_rate, '30/1', path)
    assert.equal(s.color_space, 'bt709', path)
    assert.equal(s.color_transfer, 'bt709', path)
    assert.equal(s.color_primaries, 'bt709', path)
  }
})

test('a graphic: transparent outside its box, opaque inside, frame 0 is its first frame', (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  // ramp: scale 0.5 at offset (10%, -5%) is a 160x90 box centred on (192, 81).
  for (const k of [0, 10, 29]) {
    const f = frameRgba(result.graphics.ramp, k)
    for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [100, 81]]) {
      assert.equal(px(f, x, y).a, 0, `ramp frame ${k}: (${x}, ${y}) is outside the box and must be transparent`)
    }
    const c = px(f, 192, 81)
    assert.equal(c.a, 255, `ramp frame ${k}: the box centre must be opaque`)
    // The ramp's own frame k paints grey k*5: frame 0 of the movie is the overlay's frame 0.
    for (const v of [c.r, c.g, c.b]) {
      assert.ok(Math.abs(v - k * 5) <= 3, `ramp frame ${k}: grey ${v}, expected ${k * 5}`)
    }
  }
})

test('a graphic that starts before the timeline begins partway in, with its opacity in the alpha', (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  // early starts at -0.2 s: the timeline's frame 0 is the overlay's frame 6.
  for (const k of [0, 8]) {
    const f = frameRgba(result.graphics.early, k)
    assert.equal(px(f, 0, 0).a, 0, `early frame ${k}: corner must be transparent`)
    const c = px(f, W / 2, H / 2)
    assert.ok(Math.abs(c.a - 204) <= 2, `early frame ${k}: opacity 0.8 is alpha 204, got ${c.a}`)
    const grey = (k + 6) * 5
    for (const v of [c.r, c.g, c.b]) {
      assert.ok(Math.abs(v - grey) <= 3, `early frame ${k}: grey ${v}, expected ${grey} (overlay frame ${k + 6})`)
    }
  }
})

test('the captions movie starts at the first caption and is clear between captions', (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  // Movie frame k is timeline frame 6 + k. "Hello" fades in from its first
  // frame (subtitle.jsx), so frame 0 draws nothing yet.
  assert.ok(alphas(frameRgba(result.captions, 0)).every((a) => a === 0), 'frame 0 (0.2 s) must be clear: the caption fades in from 0')
  // Frame 6 is 0.4 s, inside "Hello": its red box is drawn opaque.
  const hello = frameRgba(result.captions, 6)
  assert.equal(px(hello, 0, 0).a, 0, 'corner must be transparent')
  const opaqueRed = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = px(hello, x, y)
      if (p.a === 255 && p.r > 200 && p.g < 40 && p.b < 40) opaqueRed.push([x, y])
    }
  }
  assert.ok(opaqueRed.length > 50, `the caption box must be drawn opaque red, found ${opaqueRed.length} pixels`)
  // Frame 15 is 0.7 s, between the two captions.
  assert.ok(alphas(frameRgba(result.captions, 15)).every((a) => a === 0), 'frame 15 (0.7 s) is between captions and must be clear')
})

test('scratch is cleaned up: nothing left in the temp dir, nothing but the export in the project', (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  assert.deepEqual(tmpEntriesAfter, [], `left in the temp dir: ${tmpEntriesAfter.join(', ')}`)
  const projDir = dirname(projectPath)
  assert.deepEqual(readdirSync(projDir).sort(), [...projectEntriesBefore, 'export'].sort())
  const out = join(projDir, 'export', 'nle-graphics-test (editor)')
  assert.deepEqual(readdirSync(out).sort(), ['captions.mov', 'graphics'])
  assert.deepEqual(readdirSync(join(out, 'graphics')).sort(), ['early.mov', 'moving.mov', 'ramp.mov'])
})

test('the XML links the rendered movies, sized and timed by their probe', async (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const movies = [...Object.values(result.graphics), result.captions]
  const probes = await probeSources(movies)
  for (const m of movies) {
    assert.equal(probes[m].exists, true, m)
    assert.equal(probes[m].width, W, m)
    assert.equal(probes[m].height, H, m)
  }
  const { xml, warnings } = writeXmeml(timeline, probes, {
    graphics: result.graphics, captions: result.captions, xmlDir: join(dirname(projectPath), 'export'),
  })
  assert.ok(!warnings.some((w) => /not rendered/.test(w)), `every movie is rendered: ${warnings.join(' | ')}`)
  for (const name of ['ramp.mov', 'early.mov', 'moving.mov', 'captions.mov']) {
    assert.ok(xml.includes(name), `the XML links ${name}`)
  }
})

test('parity: the movies stacked over black are the frames render.js writes', { timeout: 300_000 }, (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const rendered = join(dir, 'render.mp4')
  mkdirSync(join(dir, 'render-tmp'))
  const r = spawnSync(process.execPath, [RENDER_JS, projectPath, '--out', rendered],
    { encoding: 'utf8', timeout: 280_000, env: { ...process.env, TMPDIR: join(dir, 'render-tmp') } })
  assert.equal(r.status, 0, `render failed (a failed render is a failure, not a skip): ${r.stderr?.slice(-400)}`)

  // The render's compositing order: overlays in track order, then captions.
  // Each movie is delayed to its clip's first frame with transparent frames.
  const layers = [
    [result.graphics.ramp, clipOf('ramp').startFrame],
    [result.graphics.early, clipOf('early').startFrame],
    [result.graphics.moving, clipOf('moving').startFrame],
    [result.captions, timeline.captionsTrack.clips[0].startFrame],
  ]
  const total = timeline.durationFrames
  const stacked = join(dir, 'stacked.mkv')
  // Tagged Rec.709 like the movies and the render, so both decode to RGB with
  // the same matrix (untagged, the stack read as BT.601: 3 levels off on cyan).
  const bt709 = 'colorspace=bt709:color_trc=bt709:color_primaries=bt709:range=tv'
  const inputs = ['-f', 'lavfi', '-i',
    `color=black:size=${W}x${H}:rate=${FPS}:duration=${total / FPS},format=yuv444p,setparams=${bt709}`]
  const graph = []
  let label = '[0:v]'
  layers.forEach(([path, start], i) => {
    inputs.push('-i', path)
    graph.push(`[${i + 1}:v]tpad=start=${start}:color=black@0.0[d${i}]`)
    graph.push(`${label}[d${i}]overlay=eof_action=pass:format=auto[s${i}]`)
    label = `[s${i}]`
  })
  graph.push(`${label}format=yuv444p,setparams=${bt709}[out]`)
  const s = spawnSync(FFMPEG, ['-v', 'error', '-y', ...inputs, '-filter_complex', graph.join(';'),
    '-map', '[out]', '-frames:v', String(total), '-c:v', 'ffv1',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', stacked],
  { encoding: 'utf8' })
  assert.equal(s.status, 0, `stacking failed: ${s.stderr}`)

  const a = allFramesRgb(stacked)
  const b = allFramesRgb(rendered)
  const fs = W * H * 3
  assert.equal(b.length / fs, total, 'the render has the timeline\'s frames')
  assert.equal(a.length / fs, total, 'the stack has the timeline\'s frames')
  // The render's output is H.264 4:2:0 and the stack is not, so edges and flat
  // colour differ by compression: measured worst frame mean 0.38, p99 7. A
  // missing layer or a layer a frame late differs over its whole area: the
  // ramp a frame late is 5 levels over its box, a mean of about 1.25.
  let worstMean = 0
  let worstP99 = 0
  for (let f = 0; f < total; f++) {
    const diffs = new Uint8Array(fs)
    let sum = 0
    for (let i = 0; i < fs; i++) {
      const d = Math.abs(a[f * fs + i] - b[f * fs + i])
      diffs[i] = d
      sum += d
    }
    const mean = sum / fs
    diffs.sort()
    const p99 = diffs[Math.floor(fs * 0.99)]
    worstMean = Math.max(worstMean, mean)
    worstP99 = Math.max(worstP99, p99)
    assert.ok(mean < 0.75, `frame ${f}: mean difference ${mean.toFixed(2)} from the render`)
    assert.ok(p99 <= 10, `frame ${f}: 99th percentile difference ${p99} from the render`)
  }
  t.diagnostic(`worst frame: mean ${worstMean.toFixed(3)}, p99 ${worstP99}`)
})

test('an HDR project gets SDR movies and a warning; a drawtext caption layer is not rendered', async (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const projDir = join(dir, 'hdr')
  mkdirSync(projDir)
  copyFileSync(join(__dirname, 'fixtures', 'cadence-ramp.jsx'), join(projDir, 'cadence-ramp.jsx'))
  const hdr = {
    ...makeProject('cadence-ramp.jsx'),
    settings: { resolution: [W, H], fps: FPS, colorSpace: 'hdr_hlg' },
    renderMode: 'ffmpeg-drawtext',
  }
  hdr.tracks = [{ id: 'trk-0', items: [] }, { id: 'trk-1', items: [
    { id: 'short', type: 'overlay', src: 'cadence-ramp.jsx', props: {}, start: 0, end: 0.2 },
  ] }]
  hdr.captions = { segments: [{ id: 'c1', text: 'Hi', start: 0, end: 0.2 }] }
  // The timeline itself drops these layers in drawtext mode; build it without the
  // mode so renderNleGraphics's own guard is what is under test.
  const tl = buildNleTimeline({ ...hdr, renderMode: undefined }, { projectDir: projDir })
  const out = join(projDir, 'export')
  const res = await renderNleGraphics(hdr, tl, { projectDir: projDir, outDir: out })

  assert.equal(res.captions, null)
  assert.ok(res.warnings.some((w) => /^HDR project \(hdr_hlg\)/.test(w)), res.warnings.join(' | '))
  assert.ok(res.warnings.some((w) => /^captions: renderMode ffmpeg-drawtext/.test(w)), res.warnings.join(' | '))
  assert.ok(!existsSync(join(out, 'captions.mov')))
  const s = probeStream(res.graphics.short)
  assert.equal(Number(s.nb_read_frames), 6)
  assert.equal(s.color_transfer, 'bt709')
  assert.equal(s.color_primaries, 'bt709')
})
