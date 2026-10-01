// render/test/motion-blur-opaque-frames.integration.test.mjs
//
// The guard for frames dropped under motion blur by a transparent overlay that
// has fully opaque frames (a full-screen card, say).
//
// Chrome writes an omitBackground screenshot as RGBA PNG, except for a frame
// with no transparent pixel, which it writes as RGB. So the sub-frame sequence
// flips pixel format at every opaque stretch. By default ffmpeg rebuilds the
// filter graph on each flip, and the blur graph is stateful: its
// setpts=PTS-STARTPTS restarts at 0, so the output's -r clock drops the rebuilt
// graph's frames as late. The segment came out short, missing the opaque
// stretch, with everything after it early.
//
// This drives the REAL path: Chrome capture -> PNG sequence -> the ffmpeg encode
// renderChunk builds. A frame count alone would pass a capture that kept the
// count and scrambled the order, so the per-frame alpha must also sit where the
// timeline puts it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FFMPEG } from '../ffmpeg-bin.js'
import { bundleComponent, cleanupBundle } from '../bundle.js'
import { renderAllSegments } from '../renderer.js'

const FPS = 60
const N = 3              // settings.motionBlur
const FRAMES = 60
const W = 64, H = 64
// Opaque for t in [OPAQUE_FROM, OPAQUE_TO). Both edges fall mid-frame, so the
// format flips between two sub-frames of one output frame, as a fade does.
const OPAQUE_FROM = 20.5
const OPAQUE_TO = 40.5

// Transparent frames cover the top half only; opaque frames cover everything.
const JSX = `export default function Card() {
  const full = frame >= ${OPAQUE_FROM} && frame < ${OPAQUE_TO}
  return <div style={{ position: 'absolute', left: 0, top: 0, width: '100%',
    height: full ? '100%' : '50%', background: 'rgb(200, 40, 40)' }} />
}
`

/** Mean alpha (0..255) of every frame of `path`, in order. */
function frameAlpha(path) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', path, '-vf', 'alphaextract',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, `alpha decode failed: ${r.stderr}`)
  const size = W * H, out = []
  for (let i = 0; i + size <= r.stdout.length; i += size) {
    let sum = 0
    for (let j = i; j < i + size; j++) sum += r.stdout[j]
    out.push(sum / size)
  }
  return out
}

test('a transparent overlay with fully opaque frames keeps every frame under motion blur', { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-blur-opaque-'))
  let workDir
  try {
    const jsx = join(dir, 'card.jsx')
    writeFileSync(jsx, JSX)
    const bundle = await bundleComponent({
      componentPath: jsx, props: {}, fps: FPS, durationFrames: FRAMES, width: W, height: H, projectDir: dir,
    })
    workDir = bundle.workDir
    // One chunk, so every flip lands in a single ffmpeg encode. captureScale 1
    // keeps the capture at W x H.
    const [seg] = await renderAllSegments([{
      id: 'card', htmlPath: bundle.htmlPath, fps: FPS, width: W, height: H, captureScale: 1,
      frameCount: FRAMES, startSeconds: 0, endSeconds: FRAMES / FPS,
      outputPath: join(dir, 'card.mkv'),
      boundary: bundle.boundary, needsGoogleFonts: bundle.needsGoogleFonts,
    }], { workers: 1, chunkSize: FRAMES, motionBlur: N })

    const alpha = frameAlpha(seg.webmPath)
    assert.equal(alpha.length, FRAMES, `segment has ${alpha.length} of ${FRAMES} frames`)

    // Frame f averages sub-frames f, f+1/3, f+2/3: 20 and 40 straddle an edge.
    for (let f = 0; f < FRAMES; f++) {
      const a = alpha[f]
      if (f > 20 && f < 40) assert.ok(a > 250, `frame ${f} should be the opaque card, mean alpha ${a.toFixed(1)}`)
      else if (f === 20 || f === 40) assert.ok(a > 140 && a < 240, `frame ${f} should blend the edge, mean alpha ${a.toFixed(1)}`)
      else assert.ok(a > 110 && a < 145, `frame ${f} should be half covered, mean alpha ${a.toFixed(1)}`)
    }
  } finally {
    if (workDir) cleanupBundle(workDir)
    rmSync(dir, { recursive: true, force: true })
  }
})
