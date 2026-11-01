// render/test/cutout-sdr-matrix.integration.test.mjs
//
// §625: remove_bg writes a cutout's YUV with BT.601 (PyAV's default) and no
// tags. An SDR segment used to declare every untagged clip BT.709, the cutout
// included, so its saturated colours shifted. Real ffmpeg, tiny frames, the
// REAL encodeSegment; the output is read back as RGB through the BT.709 matrix.
//
// The cutout is built the way steps/transform/remove_bg.py writes one: RGB to
// BT.601 limited YUV, ProRes 4444 yuva444p10le, tags unknown, alpha opaque.
// (Replicated with ffmpeg's scaler, whose RGB->YUV default is the one PyAV uses.)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FFMPEG } from '../ffmpeg-bin.js'
import { encodeSegment } from '../encode-segment.js'

const FPS = 30
const DUR = 0.1
const S = 32
const TOL = 2
// pure-ish red, green, a skin tone
const COLORS = [[230, 25, 75], [30, 200, 40], [224, 172, 105]]
const W = S * COLORS.length

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `ffmpeg ${args.join(' ')} failed: ${r.stderr}`)
}

const hex = (c) => '0x' + c.map((v) => v.toString(16).padStart(2, '0')).join('')

test('sdr_bt709: an untagged remove_bg cutout keeps its colours (BT.601 declared) (§625)', { timeout: 240_000 },
  async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'montaj-cutmat-'))
    try {
      const cut = path.join(dir, 'cutout.mov')
      const inputs = COLORS.flatMap((c) => ['-f', 'lavfi', '-i', `color=c=${hex(c)}:size=${S}x${S}:rate=${FPS}:duration=${DUR},format=rgb24`])
      ff([...inputs,
        '-filter_complex', `[0:v][1:v][2:v]hstack=inputs=3,format=rgba,`
          + 'scale=out_color_matrix=bt601:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuva444p10le,'
          + 'setparams=colorspace=unknown:color_trc=unknown:color_primaries=unknown:range=tv',
        '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', cut])
      const item = {
        type: 'video', src: cut, nobg_src: cut, remove_bg: true, start: 0, end: DUR, inPoint: 0, trackIdx: 0,
        scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: true, hasAudio: false,
        colorTransfer: 'unknown', probedWidth: W, probedHeight: S, probedAlpha: true,
      }
      const { args } = await encodeSegment({ start: 0, end: DUR, vw: W, vh: S, fps: FPS, colorSpace: 'sdr_bt709', items: [item], overlays: [] },
        path.join(dir, 'unused.mp4'), { _dryRun: true })
      const from = args.indexOf('-c:v')
      const to = args.indexOf('-pix_fmt', from) + 2
      const out = path.join(dir, 'seg.mkv')
      const tail = args.slice(to, -1)
      for (const flag of ['-tag:v', '-bsf:v', '-movflags']) {
        const i = tail.indexOf(flag)
        if (i >= 0) tail.splice(i, 2)
      }
      ff([...args.slice(0, from), '-c:v', 'ffv1', '-pix_fmt', 'yuv420p', ...tail, out])
      assert.ok(existsSync(out), 'the segment encode produced no file')
      const r = spawnSync(FFMPEG, ['-v', 'error', '-i', out, '-frames:v', '1',
        '-vf', 'scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
      assert.equal(r.status, 0, `read failed: ${r.stderr}`)
      COLORS.forEach((want, k) => {
        const o = (S / 2 * W + k * S + S / 2) * 3
        const got = [r.stdout[o], r.stdout[o + 1], r.stdout[o + 2]]
        t.diagnostic(`want RGB ${want} got ${got}`)
        for (let i = 0; i < 3; i++) assert.ok(Math.abs(got[i] - want[i]) <= TOL, `colour ${k}: ${got} vs ${want}`)
      })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
