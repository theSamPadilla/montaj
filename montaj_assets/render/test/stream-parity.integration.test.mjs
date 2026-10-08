// §131 (PL83 Part 2): streaming a chunk's frames into its ffmpeg changes
// nothing in the chunk.
//
// Before §131 each screenshot was a PNG file, and the chunk's ffmpeg read the
// files (image2, frame-%06d.png) once the capture finished. Now the chunk's
// ffmpeg reads the same PNGs from its stdin (image2pipe) during the capture.
// The file-based chunk is built here, with the encode arguments renderer.js
// ran before §131 (182afcc1), and compared with the streamed chunk by
// framemd5: every frame's timestamps, duration, size and checksum, so the
// frame count too. The blur path's timestamps (-framerate at the sub-frame
// rate, select, setpts, -r) are where a different input would show first.
//
// Two comparisons per case:
//   - same screenshots: one capture, each screenshot taken as the old code took
//     it (`{ path, omitBackground }`, a PNG file), its bytes also streamed as
//     the new code streams them. The files are encoded the old way, the stream
//     the new way, so only the input differs.
//   - as shipped: an untouched renderChunk against that file-based chunk, so
//     the screenshot call's own change (a buffer, not a path) is covered too.
//
// Cases: a transparent overlay (frames larger than a pipe's buffer, so the
// png parser joins reads), an opaque one, motion blur off and on over a
// transparent overlay whose fully opaque frames Chrome writes as RGB (the
// RGBA/RGB flips -reinit_filter 0 exists for), and 4 sub-frames on an opaque
// overlay's second chunk.
//
// Real Chrome, a real bundle, the managed ffmpeg.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FFMPEG } from '../ffmpeg-bin.js'
import { motionBlurFilter } from '../motion-blur.js'
import { renderChunk, launchWorkerBrowser, captureOptionsFor } from '../renderer.js'
import { bundleComponent, cleanupBundle } from '../bundle.js'

// Noise over the left half (fresh each frame, so the PNGs stay near their raw
// size), nothing over the right half (transparent pixels: RGBA), and a
// half-transparent box crossing it.
const ALPHA = `export default function Alpha() {
  return <>
    <svg width="50%" height="100%" style={{ position: 'absolute', left: 0, top: 0 }}>
      <filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={Math.floor(frame)} /></filter>
      <rect width="100%" height="100%" filter="url(#n)" />
    </svg>
    <div style={{ position: 'absolute', left: frame * 7, top: 96, width: 48, height: 48,
      background: 'rgba(40, 120, 220, 0.6)', borderRadius: 12 }} />
  </>
}
`

// An opaque overlay: its own background covers the frame.
const OPAQUE = `export default function Opaque() {
  return <div style={{ position: 'absolute', inset: 0, background: 'rgb(20, 30, 50)' }}>
    <div style={{ position: 'absolute', left: frame * 1.7, top: 20 + frame * 0.6, width: 24, height: 24,
      background: 'rgb(240, 200, 40)', transform: \`rotate(\${frame * 9}deg)\` }} />
  </div>
}
`

// Transparent but for t in [20.5, 40.5), when it covers everything: Chrome
// writes those frames as RGB PNG, the rest as RGBA (motion-blur-opaque-frames).
// Both edges fall mid-frame, between two sub-frames of one output frame.
const FLIP = `export default function Flip() {
  const full = frame >= 20.5 && frame < 40.5
  return <>
    <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: full ? '100%' : '50%',
      background: 'rgb(200, 40, 40)' }} />
    <div style={{ position: 'absolute', left: frame * 0.9, top: 40, width: 12, height: 12,
      background: 'rgb(255, 255, 255)', borderRadius: 6 }} />
  </>
}
`

// FLIP with a dot that keeps moving on the canvas (wraps), so a long chunk's
// frames stay distinct.
const LONG = FLIP.replace('left: frame * 0.9', 'left: (frame * 0.9) % 50').replace('Flip()', 'Long()')

const CASES = [
  { name: 'alpha',        jsx: ALPHA,  size: 256, fps: 30, frames: 30, opaque: false, subframes: 1 },
  { name: 'opaque',       jsx: OPAQUE, size: 96,  fps: 30, frames: 30, opaque: true,  subframes: 1 },
  { name: 'blur off',     jsx: FLIP,   size: 64,  fps: 60, frames: 60, opaque: false, subframes: 1 },
  { name: 'blur on',      jsx: FLIP,   size: 64,  fps: 60, frames: 60, opaque: false, subframes: 3 },
  // A chunk that does not start at the segment's first frame.
  // Longer than ffmpeg's probe of a piped input (about 150 frames, MEASURED in
  // stream-frames.test.mjs): the steady state production chunks run in.
  { name: 'past probe',   jsx: LONG,   size: 64,  fps: 60, frames: 240, opaque: false, subframes: 3 },
  { name: 'subframes 4',  jsx: OPAQUE, size: 96,  fps: 30, frames: 60, opaque: true,  subframes: 4, chunk: [15, 45] },
]

/**
 * The chunk encode as renderer.js ran it before §131 (182afcc1,
 * encodeChunkFrames), reading `frameDir`'s PNG files.
 */
function fileBasedEncodeArgs(job, frameDir, chunkMkv) {
  const { fps, subframes = 1 } = job
  const { pixFmt, omitBackground } = captureOptionsFor(job)
  const blurVf = motionBlurFilter(subframes, { alpha: omitBackground })
  const inputRate = blurVf ? String(fps * subframes) : String(fps)
  const keepGraph = blurVf && omitBackground ? ['-reinit_filter', '0'] : []
  return [
    '-y',
    ...keepGraph,
    '-framerate',           inputRate,
    '-i',                   join(frameDir, 'frame-%06d.png'),
    ...(blurVf ? ['-vf', blurVf, '-r', String(fps)] : []),
    '-c:v',                 'ffv1',
    '-g',                   '1',
    '-pix_fmt',             pixFmt,
    '-f',                   'matroska',
    '-cluster_size_limit',  '2000000',
    '-reserve_index_space', '1000000',
    chunkMkv,
  ]
}

/**
 * Makes the worker's screenshots as they were before §131: `{ path,
 * omitBackground }`, each a PNG file in `frameDir` numbered in capture order
 * (localIdx * subframes + s, as the old frame names were). Puppeteer returns
 * the bytes it wrote, so the new code streams exactly the files' bytes.
 */
function screenshotsToFiles(worker, frameDir) {
  const shots = { n: 0, opts: [] }
  const newPage = worker.browser.newPage.bind(worker.browser)
  worker.browser.newPage = async (...a) => {
    const page = await newPage(...a)
    const screenshot = page.screenshot.bind(page)
    page.screenshot = async (opts) => {
      shots.opts.push(opts)
      const path = join(frameDir, `frame-${String(shots.n++).padStart(6, '0')}.png`)
      return screenshot({ path, omitBackground: opts.omitBackground })
    }
    return page
  }
  return shots
}

/** `ffmpeg -i chunk.mkv -map 0:v -f framemd5 -`, as lines. */
function framemd5(path) {
  const r = spawnSync(FFMPEG, ['-nostdin', '-v', 'error', '-i', path, '-map', '0:v', '-f', 'framemd5', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, `framemd5 of ${path} failed: ${r.stderr}`)
  return r.stdout.split('\n').filter(Boolean)
}

const frameLines = lines => lines.filter(l => !l.startsWith('#'))

/** Equal framemd5, or the first line that differs, with the frame lines around it. */
function assertSameFrames(streamed, fileBased, what) {
  if (streamed.join('\n') === fileBased.join('\n')) return
  const i = streamed.findIndex((l, k) => l !== fileBased[k])
  const at = i === -1 ? Math.min(streamed.length, fileBased.length) : i
  assert.fail(`${what}: framemd5 differs at line ${at} ` +
    `(${frameLines(streamed).length} frames streamed, ${frameLines(fileBased).length} file-based)\n` +
    `  streamed:   ${streamed[at] ?? '(end)'}\n  file-based: ${fileBased[at] ?? '(end)'}\n` +
    `  streamed before:   ${streamed[at - 1] ?? '(start)'}\n  file-based before: ${fileBased[at - 1] ?? '(start)'}`)
}

let base, projDir
const bundles = []

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-stream-parity-')))
  const ws = join(base, 'ws')
  projDir = join(ws, 'proj')
  mkdirSync(join(projDir, 'overlays'), { recursive: true })
  process.env.MONTAJ_WORKSPACE_DIR = ws
})

after(() => {
  for (const b of bundles) cleanupBundle(b.workDir)
  if (base) rmSync(base, { recursive: true, force: true })
})

async function bundleFor(c) {
  const componentPath = join(projDir, 'overlays', `${c.name.replace(/\W+/g, '-')}.jsx`)
  writeFileSync(componentPath, c.jsx)
  const b = await bundleComponent({
    componentPath, props: {}, fps: c.fps, durationFrames: c.frames, width: c.size, height: c.size,
    opaque: c.opaque, projectDir: projDir,
  })
  bundles.push(b)
  return b
}

/** renderChunk's job for case `c`, writing under `outDir`. */
function chunkJob(b, c, id, outDir) {
  const [frameStart, frameEnd] = c.chunk ?? [0, c.frames]
  const chunkIndex = c.chunk ? 1 : 0
  return {
    id, htmlPath: b.htmlPath, fps: c.fps, width: c.size, height: c.size, captureScale: 1,
    frameCount: c.frames, startSeconds: 0, endSeconds: c.frames / c.fps,
    outputPath: join(outDir, `${id}.mkv`), boundary: b.boundary, needsGoogleFonts: b.needsGoogleFonts,
    opaque: c.opaque, subframes: c.subframes, frameStart, frameEnd, chunkIndex, totalChunks: c.chunk ? 3 : 1,
  }
}

for (const c of CASES) {
  test(`${c.name}: the streamed chunk is the file-based chunk, frame for frame`, { timeout: 180_000 }, async () => {
    const b = await bundleFor(c)
    const dir = join(base, c.name.replace(/\W+/g, '-'))
    const frameDir = join(dir, 'frames')
    mkdirSync(frameDir, { recursive: true })
    const [frameStart, frameEnd] = c.chunk ?? [0, c.frames]
    const outFrames = frameEnd - frameStart

    // One capture, screenshots as files (old) and streamed (new).
    let worker = await launchWorkerBrowser({})
    let streamed, shots
    try {
      shots = screenshotsToFiles(worker, frameDir)
      streamed = (await renderChunk(worker, chunkJob(b, c, 'same', join(dir, 'same')))).webmPath
    } finally {
      await worker.close().catch(() => {})
    }
    assert.equal(shots.n, outFrames * c.subframes, 'screenshots')
    assert.ok(shots.opts.every(o => o.path === undefined && o.omitBackground === !c.opaque),
      `the new code's screenshot options: ${JSON.stringify(shots.opts[0])}`)
    assert.equal(readdirSync(frameDir).length, shots.n, 'one PNG file per screenshot')

    // The same files, encoded as before §131.
    const job = chunkJob(b, c, 'files', join(dir, 'files'))
    const fileBased = join(dir, 'files', 'files-chunk.mkv')
    mkdirSync(join(dir, 'files'), { recursive: true })
    const enc = spawnSync(FFMPEG, fileBasedEncodeArgs(job, frameDir, fileBased), { encoding: 'utf8' })
    assert.equal(enc.status, 0, `file-based encode failed: ${enc.stderr}`)

    const expected = framemd5(fileBased)
    // The comparison can say no: every output frame is there, and they differ.
    const frames = frameLines(expected)
    assert.equal(frames.length, outFrames, 'file-based chunk frames')
    const sums = new Set(frames.map(l => l.split(',').pop().trim()))
    assert.ok(sums.size >= outFrames / 2, `only ${sums.size} distinct frames of ${outFrames}`)

    assertSameFrames(framemd5(streamed), expected, `${c.name}, same screenshots`)

    // As shipped: renderChunk untouched, its own capture.
    worker = await launchWorkerBrowser({})
    let shipped
    try {
      shipped = (await renderChunk(worker, chunkJob(b, c, 'shipped', join(dir, 'shipped')))).webmPath
    } finally {
      await worker.close().catch(() => {})
    }
    assertSameFrames(framemd5(shipped), expected, `${c.name}, as shipped`)
  })
}
