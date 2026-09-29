// render/test/embed-thumbnail-seek.integration.test.mjs
//
// PV48: embedThumbnail's extractAt used a single input seek (`-ss t -i
// outputPath`). Our own HDR render outputs are open-GOP libx265 (x265
// defaults), so a seek whose target is a keyframe's leading picture (pts
// before the keyframe, but decoded after it) returned the keyframe instead
// of the wanted frame (1-3 frames late, T3 audit). It now uses the same
// two-stage seek as encode-segment.js's video items (twoStageSeek /
// SEEK_PREROLL_S, imported directly, not duplicated).
//
// The target isn't hardcoded to a fixed offset before a keyframe: exactly
// which pts are "leading" depends on this machine's x265 build (bframes
// count etc), so this test PROBES the generated clip's own packets to find a
// real leading picture, then targets exactly its pts. embedThumbnail's
// public seek is always `leadingGap + 1.0` with `leadingGap >= 0`, so the
// target must be >= 1.0; this test uses the second interior keyframe
// (~2.0s) rather than the first (1.0s) so a leading picture just before it
// is always reachable through the public API.
//
// GATING: skipped without libx265 (MONTAJ_FFMPEG picks the binary), loud
// under MONTAJ_REQUIRE_HDR_FFMPEG=1 (test/per-layer-sdr.integration.test.mjs).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FFMPEG, FFPROBE } from '../ffmpeg-bin.js'
import { embedThumbnail } from '../compose.js'

function capabilityReason() {
  const encoders = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  if (!/\blibx265\b/.test(encoders)) return `${FFMPEG} lacks libx265 (set MONTAJ_FFMPEG)`
  return false
}
function capabilitySkip() {
  const reason = capabilityReason()
  if (reason && process.env.MONTAJ_REQUIRE_HDR_FFMPEG === '1') throw new Error(`MONTAJ_REQUIRE_HDR_FFMPEG=1 but ${reason}`)
  return reason
}
const SKIP = capabilitySkip()

const FPS = 30
const W = 320
const H = 180
const GW = 32  // gray comparison width
const GH = 18  // gray comparison height

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-nostdin', ...args], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `ffmpeg ${args.join(' ')} failed: ${r.stderr}`)
}

/** Every frame of `file`, decoded from the start with NO seek at all (so
 * there is nothing for an open-GOP file to get wrong), downscaled to a small
 * gray buffer. Index i is frame i, i.e. presentation time i/FPS. */
function decodeAllFrames(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-nostdin', '-i', file,
    '-vf', `scale=${GW}:${GH}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'],
  { encoding: 'buffer', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })
  assert.equal(r.status, 0, `decode of ${file} failed: ${r.stderr}`)
  const n = r.stdout.length / (GW * GH)
  assert.ok(Number.isInteger(n) && n > 0, `${file}: expected a whole number of ${GW}x${GH} frames, got ${r.stdout.length}`)
  const frames = []
  for (let i = 0; i < n; i++) frames.push(r.stdout.subarray(i * GW * GH, (i + 1) * GW * GH))
  return frames
}

/** The muxed attached_pic poster stream (v:1), decoded to the same small gray buffer. */
function decodePoster(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-nostdin', '-i', file,
    '-map', '0:v:1', '-frames:v', '1',
    '-vf', `scale=${GW}:${GH}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'],
  { encoding: 'buffer', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  assert.equal(r.status, 0, `decode of ${file}'s poster stream failed: ${r.stderr}`)
  assert.equal(r.stdout.length, GW * GH, `${file}: expected exactly one ${GW}x${GH} poster frame`)
  return r.stdout
}

function meanAbs(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

test(
  'embedThumbnail: the poster is the frame AT the seek time, not the next keyframe, on an open-GOP HEVC render',
  { skip: SKIP },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'montaj-thumb-seek-'))
    try {
      const src = path.join(dir, 'src.mp4')
      // testsrc2: every frame differs, so a wrong frame is detectable.
      // x265 defaults are open-GOP; -g 30 -keyint_min 30 at 30fps puts
      // interior keyframes at 1.0s and 2.0s.
      ff(['-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}:rate=${FPS}:duration=3`,
        '-c:v', 'libx265', '-pix_fmt', 'yuv420p',
        '-g', '30', '-keyint_min', '30', '-x265-params', 'log-level=error',
        src])

      // Find the keyframe near t=2.0 and every "leading picture" after it in
      // decode/packet order (ffprobe lists packets in that order): a packet
      // whose pts is BEFORE the keyframe's pts, but which appears AFTER the
      // keyframe's own packet. That is open-GOP's defining trait, and it's
      // exactly what a naive single-stage input seek cannot decode without
      // its true (earlier-GOP) reference frames.
      const pkt = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', src],
      { encoding: 'utf8', timeout: 30_000 })
      assert.equal(pkt.status, 0, `ffprobe packets failed: ${pkt.stderr}`)
      let keyPts = null
      const leadingPts = []
      for (const line of pkt.stdout.trim().split('\n')) {
        const [ptsStr, flags] = line.split(',')
        const pts = Number(ptsStr)
        if (flags.includes('K') && Math.abs(pts - 2.0) < 1e-3) { keyPts = pts; continue }
        if (keyPts !== null && pts < keyPts - 1e-6) leadingPts.push(pts)
      }
      assert.ok(keyPts !== null, 'setup invalid: no keyframe found near t=2.0')
      assert.ok(leadingPts.length > 0, 'setup invalid: the keyframe at t=2.0 has no leading pictures on this ffmpeg/x265 build')

      // Target the leading picture CLOSEST to the keyframe (the tightest
      // case, matching the T3 audit's "just before the keyframe" finding).
      const targetPts = Math.max(...leadingPts)
      const leadingGap = targetPts - 1.0
      assert.ok(leadingGap >= 0, `leading picture at ${targetPts} is before embedThumbnail's reachable floor of 1.0`)

      // Run the real, fixed embedThumbnail through its public API:
      // extractAt(leadingGap + 1.0) = extractAt(targetPts).
      const renderOut = path.join(dir, 'render-out.mp4')
      copyFileSync(src, renderOut)
      embedThumbnail(renderOut, 'sdr_bt709', { leadingGap })

      const refFrames = decodeAllFrames(src)  // no seek anywhere: ground truth
      const wantIdx = Math.round(targetPts * FPS)
      const wrongIdx = Math.round(keyPts * FPS)  // the keyframe the old bug returned instead
      assert.notEqual(wantIdx, wrongIdx, 'test setup must target a different frame than the keyframe')
      assert.ok(refFrames.length > Math.max(wantIdx, wrongIdx),
        `need reference frames past ${Math.max(wantIdx, wrongIdx)}, got ${refFrames.length}`)

      // Positive control: the OLD single input seek (embedThumbnail's
      // pre-PV48 form, `-ss t -i clip -frames:v 1`) must really return the
      // keyframe on THIS ffmpeg/x265 build — otherwise the fix assertion
      // below could pass vacuously (same method as the Python two-stage-seek
      // tests' test_naive_single_stage_seek_reproduces_the_bug).
      const naiveJpg = path.join(dir, 'naive.jpg')
      ff(['-ss', String(targetPts), '-i', src, '-frames:v', '1', naiveJpg])
      const naiveRaw = spawnSync(FFMPEG, ['-v', 'error', '-nostdin', '-i', naiveJpg,
        '-vf', `scale=${GW}:${GH}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'],
      { encoding: 'buffer', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
      assert.equal(naiveRaw.status, 0, `decode of the naive-seek frame failed: ${naiveRaw.stderr}`)
      const naiveErrRight = meanAbs(naiveRaw.stdout, refFrames[wantIdx])
      const naiveErrWrong = meanAbs(naiveRaw.stdout, refFrames[wrongIdx])
      assert.ok(naiveErrWrong < naiveErrRight,
        `fixture did not reproduce the open-GOP drop at t=${targetPts}: the naive single-stage seek ` +
        `already matched the wanted frame (err ${naiveErrRight}) better than the keyframe (err ${naiveErrWrong}). ` +
        'Adjust the fixture so the bug is exercised.')

      const poster = decodePoster(renderOut)
      // testsrc2 moves smoothly, so neighbouring frames are close too (same
      // method as T1's detector: min mean-abs-diff against an exact decode).
      // The load-bearing check is which frame is CLOSEST, not an absolute
      // distance: find the best match in a window around the two candidates
      // and require it to be exactly the wanted frame, not the keyframe the
      // old single-seek bug returned.
      let bestIdx = -1
      let bestErr = Infinity
      const lo = Math.min(wantIdx, wrongIdx) - 4
      const hi = Math.max(wantIdx, wrongIdx) + 4
      for (let i = Math.max(0, lo); i <= Math.min(refFrames.length - 1, hi); i++) {
        const err = meanAbs(poster, refFrames[i])
        if (err < bestErr) { bestErr = err; bestIdx = i }
      }
      const errRight = meanAbs(poster, refFrames[wantIdx])
      const errWrong = meanAbs(poster, refFrames[wrongIdx])
      assert.ok(errRight < 1, `poster should match the t=${targetPts} leading picture almost exactly (mean abs diff ${errRight})`)
      assert.equal(bestIdx, wantIdx,
        `closest frame to the poster is ${bestIdx} (err ${bestErr}), expected ${wantIdx} (err ${errRight}); ` +
        `t=${keyPts} keyframe (${wrongIdx}) err was ${errWrong}`)
      assert.notEqual(bestIdx, wrongIdx, 'poster must not match the next keyframe')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
