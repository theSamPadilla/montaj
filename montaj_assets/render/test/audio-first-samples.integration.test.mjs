// render/test/audio-first-samples.integration.test.mjs
//
// A clip read from its very start keeps its first audio samples.
//
// An AAC track opens with a priming packet stamped before 0 (pts -1024 here),
// which the decoder needs to rebuild the first real frame. An input seek, even
// `-ss 0`, lands on the packet at 0 and skips it, so the decoder starts cold
// and its first ~700 samples come out wrong (measured: 700 samples differ from
// a plain decode, up to 17394 off on a beep of 16383). encode-segment.js gave
// every clip input a seek, including 0, so a sound right at a clip's start was
// garbled: a clipped first syllable, a click.
//
// Real ffmpeg, the real compose(). One clip whose beep starts at sample 0,
// read from inPoint 0.
//
// GATING: needs libx264 and the aac encoder (MONTAJ_FFMPEG picks the binary).
// A missing capability fails unless MONTAJ_TEST_ALLOW_MISSING_CAPS=1.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FFMPEG, FFPROBE } from '../ffmpeg-bin.js'
import { compose } from '../compose.js'

const W = 160
const H = 96
const FPS = 30
const SR = 48000
const DUR = 2
const BEEP = 1440 // samples: 30 ms, starting at sample 0
const AMP = 0.5

function capabilityReason() {
  const enc = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  if (!/\blibx264\b/.test(enc) || !/^\s*A\S*\s+aac\b/m.test(enc)) return `${FFMPEG} lacks libx264 or aac (set MONTAJ_FFMPEG)`
  if (spawnSync(FFPROBE, ['-version'], { timeout: 10_000 }).status !== 0) return `${FFPROBE} does not run (set MONTAJ_FFPROBE)`
  return false
}
function capabilitySkip() {
  const reason = capabilityReason()
  if (reason && process.env.MONTAJ_TEST_ALLOW_MISSING_CAPS !== '1') throw new Error(`${reason}, or set MONTAJ_TEST_ALLOW_MISSING_CAPS=1 to skip.`)
  return reason
}
const SKIP = capabilitySkip()

const dir = mkdtempSync(path.join(tmpdir(), 'montaj-audio-first-'))
after(() => rmSync(dir, { recursive: true, force: true }))

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`)
}

/** Left-channel s16 PCM of a file's first audio stream, decoded from its first packet. */
function pcm(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 's16le', '-ac', '2', '-ar', String(SR), '-'],
    { maxBuffer: 1 << 28, timeout: 60_000 })
  if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`)
  return new Int16Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 2).filter((_, i) => i % 2 === 0)
}

const ideal = (n) => (n < BEEP ? AMP * 32767 * Math.sin((2 * Math.PI * 1000 * n) / SR) : 0)

let rendered = null
async function render() {
  if (rendered) return rendered
  const src = path.join(dir, 'beep-at-zero.mp4')
  const e = `if(lt(n\\,${BEEP})\\,${AMP}*sin(2*PI*1000*n/${SR})\\,0)`
  ff(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:r=${FPS}:d=${DUR},format=yuv420p`,
    '-f', 'lavfi', '-i', `aevalsrc=exprs='${e}|${e}':s=${SR}:d=${DUR}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '128k', '-ar', String(SR), '-ac', '2', src])
  const outputPath = path.join(dir, 'out.mp4')
  const keep = process.env.MONTAJ_KEEP_SEGMENTS
  process.env.MONTAJ_KEEP_SEGMENTS = '1'
  try {
    await compose({
      projectJson: { settings: { resolution: [W, H], fps: FPS, colorSpace: 'sdr_bt709' }, audio: { tracks: [] } },
      puppeteerSegments: [],
      imageItems: [],
      videoItems: [{
        id: 'beep', type: 'video', trackIdx: 0, src, start: 0, end: DUR, inPoint: 0, outPoint: DUR,
        offsetX: 0, offsetY: 0, scale: 1, opacity: 1, muted: false,
      }],
      outputPath,
    })
  } finally {
    if (keep === undefined) delete process.env.MONTAJ_KEEP_SEGMENTS
    else process.env.MONTAJ_KEEP_SEGMENTS = keep
  }
  const segDir = `${outputPath}.segments`
  const segment = readdirSync(segDir).filter((f) => /^seg-\d+\.mp4$/.test(f)).sort().map((f) => path.join(segDir, f))[0]
  rendered = { src, segment }
  return rendered
}

test('the fixture opens with an AAC priming packet, and a plain decode keeps its first beep', { skip: SKIP }, async () => {
  const { src } = await render()
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=pts', '-of', 'csv=p=0', src], { encoding: 'utf8' })
  assert.equal(Number(r.stdout.split('\n')[0].replace(/,+$/, '')), -1024, 'the first audio packet is the priming one, or this proves nothing')
  const s = pcm(src)
  let worst = 0
  for (let n = 0; n < BEEP; n++) worst = Math.max(worst, Math.abs(s[n] - ideal(n)))
  assert.ok(worst < 3000, `a plain decode is within AAC error of the beep (worst ${worst})`)
})

test('a clip read from inPoint 0 keeps its first beep: the segment has its decoder\'s own samples', { skip: SKIP }, async () => {
  const { src, segment } = await render()
  const seg = pcm(segment)
  const plain = pcm(src)
  let worst = 0
  for (let n = 0; n < BEEP; n++) worst = Math.max(worst, Math.abs(seg[n] - ideal(n)))
  assert.ok(worst < 3000, `the first beep is garbled in the segment (worst sample ${worst} off)`)
  const differ = []
  for (let n = 0; n < DUR * SR; n++) if (seg[n] !== plain[n]) differ.push(n)
  assert.deepEqual(differ.slice(0, 5), [], `${differ.length} segment samples differ from a plain decode of the source`)
})
