// render/test/hdr-normalize-parity.integration.test.mjs
//
// PREVIEW / EXPORT PARITY for an HDR clip in an SDR project.
//
// render.js normalizes an HLG/PQ source into an SDR master before the segment
// encoder sees it, and that master is already graded through the Montaj Vivid
// LUT. The encoder picks its per-item conversion from `item.colorTransfer`, so
// that field has to describe the file the encoder DECODES. It used to describe
// the original source, probed before normalize swapped `item.src`, and every
// iPhone HLG clip in an SDR project went through the LUT a second time on
// export (orange skin, neon shirt). sample_frame decodes the same master with
// no conversion, so the preview looked right and nothing flagged it.
//
// ffmpeg only, no Chromium, no Python: the fixture pre-builds the normalized
// master beside the source, so render's normalize pass takes its idempotency
// cache hit instead of spawning `lib.normalize`. The source and the master are
// different solid colours, which also catches an export that decodes the
// source instead of the master.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG } from '../ffmpeg-bin.js'
import { buildNormalizedOutputPath } from '../render.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDER_JS = path.join(HERE, '..', 'render.js')
const SAMPLE_FRAME_JS = path.join(HERE, '..', 'sample-frame.js')

const S = 128
// A skin tone: the double grade pushes it towards orange, well outside `near`.
const MASTER = { r: 0xc8, g: 0x90, b: 0x6e }

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `ffmpeg ${args.join(' ')} failed: ${r.stderr}`)
}

/** Centre pixel of the frame at `at` seconds (0 for a still), read whole as rgb24. */
function centre(file, at = 0) {
  const r = spawnSync(FFMPEG, [
    '-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { encoding: 'buffer', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, `frame read failed: ${r.stderr}`)
  assert.equal(r.stdout.length, S * S * 3)
  const i = ((S / 2) * S + S / 2) * 3
  return { r: r.stdout[i], g: r.stdout[i + 1], b: r.stdout[i + 2] }
}

/** Run a render-side CLI with TMPDIR inside the fixture, so sample_frame's PNG cache cannot answer. */
function run(script, args, dir) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env, TMPDIR: dir },
  })
}

const near = (p, c, tol = 12) =>
  Math.abs(p.r - c.r) <= tol && Math.abs(p.g - c.g) <= tol && Math.abs(p.b - c.b) <= tol
const fmt = (p) => `rgb(${p.r}, ${p.g}, ${p.b})`

test('HLG clip in an SDR project: the export matches sample_frame, graded once', { timeout: 180_000 }, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'montaj-hdrnorm-'))
  try {
    const src = path.join(dir, 'clip.mp4')
    ff(['-f', 'lavfi', '-i', `color=c=0x2040a0:size=${S}x${S}:rate=30:duration=1`,
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
      '-x264-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc', src])
    const master = buildNormalizedOutputPath(src, 'sdr_bt709', true)
    ff(['-f', 'lavfi', '-i', `color=c=0xc8906e:size=${S}x${S}:rate=30:duration=1`,
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
      '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', master])
    // normalizeIfNeeded reuses a master only when it is at least as new as its source.
    const later = new Date(Date.now() + 60_000)
    utimesSync(master, later, later)

    const projectPath = path.join(dir, 'project.json')
    writeFileSync(projectPath, JSON.stringify({
      version: '0.2',
      status: 'final',
      name: 'hdr-normalize-parity',
      // No `normalize: 'lazy'`: the eager normalize pass is the path under test.
      settings: { resolution: [S, S], fps: 30, colorSpace: 'sdr_bt709' },
      tracks: [[
        { id: 'c0', type: 'video', src, start: 0, end: 1, inPoint: 0, muted: true },
      ]],
      audio: { tracks: [] },
    }, null, 2))

    const out = path.join(dir, 'out.mp4')
    const rendered = run(RENDER_JS, [projectPath, '--out', out], dir)
    assert.equal(rendered.status, 0, `render failed: ${rendered.stderr.slice(-1000)}`)
    assert.match(rendered.stderr, /normalized clip\.mp4 → clip_normalized_sdr_bt709_\w+\.mp4/,
      'the render must have swapped in the normalized master, or this test proves nothing')

    const still = path.join(dir, 'still.png')
    const sampled = run(SAMPLE_FRAME_JS,
      ['--mode', 'frame', '--project', projectPath, '--at', '0.5', '--out', still], dir)
    assert.equal(sampled.status, 0, `sample_frame failed: ${sampled.stderr.slice(-1000)}`)

    const exported = centre(out, 0.5)
    const previewed = centre(still)
    t.diagnostic(`master ${fmt(MASTER)}, sample_frame ${fmt(previewed)}, export ${fmt(exported)}`)
    assert.ok(near(previewed, MASTER), `sample_frame should show the master as-is, got ${fmt(previewed)}`)
    assert.ok(near(exported, previewed),
      `export ${fmt(exported)} should match sample_frame ${fmt(previewed)}: the master was graded again`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
