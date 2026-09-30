// render/test/hdr-segment-range.integration.test.mjs
//
// Every HDR segment is encoded LIMITED range, whatever range its layers carry.
//
// compose.js joins the segments with `-c:v copy`, and the joined mp4 keeps ONE
// set of parameter sets: the first segment's. So the first segment's range
// flag is the range flag of the whole film. The HDR canvas is untagged, and
// ffmpeg 8 negotiates colour range across the graph, so a segment took the
// range of whatever it composited: limited for camera HLG, FULL for a layer
// normalized from a full-range source (an iPhone screen recording is yuvj420p,
// and its SDR-to-HLG master keeps that range). One such clip at 0 s flagged a
// whole film full range while every other segment held limited samples, and
// every player lifted their blacks and dimmed their whites (measured on a real
// export: an SDR clip's shadows 10 -> 26, its whites 254 -> 227 of 255).
//
// ffmpeg only, no Chromium, no Python. Each case runs the REAL encodeSegment
// over a tiny HLG segment and reads the range from the encoded file, then
// decodes the layer's level the way that range tells a player to, so a fix
// that only relabels the samples (and so shifts the picture) fails as well.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FFMPEG, FFPROBE } from '../ffmpeg-bin.js'
import { encodeSegment } from '../encode-segment.js'

const W = 64
const H = 64
const DUR = 0.2
const FPS = 30
// A dark grey, where SDR-origin footage sits in an HLG film and where a range
// misread shows most. Full-range 10-bit code; its limited-range twin is
// 64 + 200 * 876 / 1023 = 235.
const LEVEL_FULL = 200

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `ffmpeg ${args.join(' ')} failed: ${r.stderr}`)
}

function rangeOf(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=color_range', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  return r.stdout.trim()
}

/** Centre luma as a FULL-range 10-bit code, converted from whatever range the file declares. */
function centreLumaFull(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-frames:v', '1',
    '-vf', 'scale=out_range=pc:flags=accurate_rnd,format=yuv444p10le',
    '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', timeout: 30_000 })
  assert.equal(r.status, 0, `frame read failed: ${r.stderr}`)
  const i = (H / 2) * W + W / 2
  return r.stdout.readUInt16LE(i * 2)
}

/** A flat HLG clip at LEVEL_FULL, stored in `range` (pc: full samples; tv: limited). */
function hlgClip(dir, range) {
  const out = path.join(dir, `hlg-${range}.mp4`)
  const y = range === 'pc' ? LEVEL_FULL : Math.round(64 + LEVEL_FULL * 876 / 1023)
  ff(['-f', 'lavfi', '-i', `color=black:size=${W}x${H}:rate=${FPS}:duration=${DUR}`,
    '-vf', `format=yuv420p10le,lutyuv=y=${y}:u=512:v=512,`
      + `setparams=colorspace=bt2020nc:color_trc=arib-std-b67:color_primaries=bt2020:range=${range}`,
    '-c:v', 'libx265', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p10le',
    '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
    '-color_range', range, out])
  assert.equal(rangeOf(out), range, `the ${range} fixture must say ${range}`)
  return out
}

const hlgItem = (src) => ({
  type: 'video', src, start: 0, end: DUR, inPoint: 0, trackIdx: 0,
  scale: 1, offsetX: 0, offsetY: 0, opacity: 1, muted: true, hasAudio: false,
  colorTransfer: 'arib-std-b67', probedWidth: W, probedHeight: H, probedAlpha: false,
})

async function encodeHlg(dir, src) {
  const out = path.join(dir, `seg-${Math.random().toString(36).slice(2)}.mp4`)
  await encodeSegment({
    start: 0, end: DUR, vw: W, vh: H, fps: FPS, colorSpace: 'hdr_hlg', items: [hlgItem(src)], overlays: [],
  }, out)
  assert.ok(existsSync(out), 'the segment encode produced no file')
  return out
}

for (const range of ['pc', 'tv']) {
  test(`HLG segment over a ${range === 'pc' ? 'full' : 'limited'}-range layer is encoded limited range, picture unchanged`, { timeout: 120_000 }, async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'montaj-hdrrange-'))
    try {
      const src = hlgClip(dir, range)
      const want = centreLumaFull(src)
      const out = await encodeHlg(dir, src)
      const got = centreLumaFull(out)
      t.diagnostic(`layer ${range}: fixture level ${want}, segment ${rangeOf(out)} level ${got}`)
      assert.equal(rangeOf(out), 'tv',
        'an HDR segment must be limited range whatever its layers are, or the stream-copy concat flags the whole film by its first segment')
      // 10-bit -> the 8-bit yuv420 composite -> 10-bit: a few codes of rounding.
      assert.ok(Math.abs(got - want) <= 8, `the layer's level moved: ${want} -> ${got}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
