import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpegErrorTail, describeFfmpegExit, assertInputsExist, fileInputsOf } from '../ffmpeg-error.js'
import { mixAudioIntoVideo } from '../mix-audio.js'
import { encodeSegment } from '../encode-segment.js'

const BANNER = [
  'ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers',
  '  built with Apple clang version 17.0.0',
  '  configuration: --prefix=/opt/homebrew --enable-gpl ' + '--enable-x '.repeat(150),
  '  libavutil      60.  8.100 / 60.  8.100',
  '  libavcodec     62. 11.100 / 62. 11.100',
]
const REAL = 'Error opening input file /x/gone.mp3: No such file or directory'
const STDERR = [...BANNER, ...Array.from({ length: 30 }, (_, i) => `progress line ${i}`), REAL, ''].join('\n')

test('ffmpegErrorTail keeps the last line and drops the banner', () => {
  const tail = ffmpegErrorTail(STDERR)
  assert.ok(tail.endsWith(REAL))
  assert.ok(!tail.includes('ffmpeg version'))
  assert.ok(!tail.includes('configuration:'))
  assert.ok(tail.length < 1000, `${tail.length}`)
  assert.equal(tail.split('\n').length, 10)
})

test('ffmpegErrorTail tolerates null', () => {
  assert.equal(ffmpegErrorTail(null), '')
})

test('mixAudioIntoVideo: a failing mix carries ffmpeg\'s last line, not its banner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mix-tail-'))
  try {
    const video = join(dir, 'v.mp4')
    writeFileSync(video, 'not a video')
    const audio = join(dir, 'a.mp3')
    writeFileSync(audio, 'not audio')
    assert.throws(
      () => mixAudioIntoVideo(video, [{ id: 't', src: audio, start: 0, end: 1 }], join(dir, 'o.mp4')),
      e => !e.message.includes('configuration:') && !e.message.includes('ffmpeg version') && e.message.length < 1500,
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('assertInputsExist names the missing file with code missing_files', () => {
  assert.throws(() => assertInputsExist(['/nope/a.mp3']), e =>
    e.code === 'missing_files' && e.message === 'Referenced files not found:\n  /nope/a.mp3')
  assert.doesNotThrow(() => assertInputsExist([undefined, '']))
})

test('fileInputsOf skips lavfi generators', () => {
  assert.deepEqual(fileInputsOf(['-f', 'lavfi', '-i', 'color=c=black', '-t', '1', '-i', '/a.mov', '-i', '/b.png']), ['/a.mov', '/b.png'])
})

test('mixAudioIntoVideo: a track deleted after validation fails with missing_files, not an ffmpeg error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mix-gone-'))
  try {
    const video = join(dir, 'v.mp4')
    writeFileSync(video, 'x')
    const gone = join(dir, 'deleted.mp3')
    assert.throws(
      () => mixAudioIntoVideo(video, [{ id: 't', src: gone, start: 0, end: 1 }], join(dir, 'o.mp4')),
      e => e.code === 'missing_files' && e.message.includes(gone) && !/ffmpeg/.test(e.message),
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('encodeSegment: a clip deleted after validation fails with missing_files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seg-gone-'))
  try {
    const gone = join(dir, 'deleted.mp4')
    const item = { type: 'video', src: gone, start: 0, end: 1, inPoint: 0, outPoint: 1, trackIdx: 0,
                   sourceWidth: 640, sourceHeight: 360, probedWidth: 640, probedHeight: 360 }
    await assert.rejects(
      encodeSegment({ start: 0, end: 1, items: [item], overlays: [], vw: 640, vh: 360, fps: 30 }, join(dir, 'o.mp4')),
      e => e.code === 'missing_files' && e.message.includes(gone),
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ffmpegErrorTail: \\r progress rewriting does not hide the error before it', () => {
  const progress = Array.from({ length: 50 }, (_, i) => `frame=${i} fps=30 time=00:00:0${i % 10}`).join('\r')
  const tail = ffmpegErrorTail(`${REAL}\n${progress}\r`)
  assert.equal(tail, `${REAL}\nframe=49 fps=30 time=00:00:09`)
})

test('ffmpegErrorTail: only the last progress line is kept, at the end', () => {
  const tail = ffmpegErrorTail(['size=1kB time=1', 'real error', 'size=9kB time=9', 'after'].join('\n'), 5)
  assert.equal(tail, 'real error\nafter\nsize=9kB time=9')
})

test('ffmpegErrorTail: a giant line keeps head and tail only', () => {
  const tail = ffmpegErrorTail(`${'a'.repeat(5000)}${'z'.repeat(5000)}`)
  assert.equal(tail.length, 300 + 5 + 300)
  assert.ok(tail.startsWith('aaa') && tail.endsWith('zzz') && tail.includes(' ... '))
})

test('describeFfmpegExit: exit, signal, timeout, stall', () => {
  assert.equal(describeFfmpegExit({ status: 1, stderr: REAL }), `exit 1\n${REAL}`)
  assert.equal(describeFfmpegExit({ status: null, signal: 'SIGKILL', stderr: '' }), 'killed by SIGKILL\n')
  assert.match(describeFfmpegExit({ status: null, signal: 'SIGKILL', timedOut: true, timeoutMs: 600_000, stderr: 'x' }), /^timed out after 600 s\nx$/)
  assert.match(describeFfmpegExit({ status: null, signal: 'SIGKILL', timedOut: true, stalledMs: 300_000, stderr: 'x' }), /^no output for 300 s \(stalled\)\nx$/)
})

test('describeFfmpegExit: ENOSPC leads with free space from statfs', () => {
  const statfs = (d) => { assert.equal(d, '/out'); return { bavail: 2_500_000, bsize: 1000 } }
  const msg = describeFfmpegExit({ status: 1, stderr: 'av_interleaved_write_frame(): No space left on device', outputDir: '/out', statfs })
  assert.ok(msg.startsWith('out of disk: 2.5 GB free on /out'))
  assert.ok(msg.includes('exit 1') && msg.includes('No space left'))
  const viaError = describeFfmpegExit({ status: null, error: Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' }), stderr: '', outputDir: '/out', statfs })
  assert.ok(viaError.startsWith('out of disk: 2.5 GB free on /out'))
})

test('describeFfmpegExit: ENOSPC with unreadable statfs still says out of disk', () => {
  const msg = describeFfmpegExit({ status: 1, stderr: 'ENOSPC', outputDir: '/out', statfs: () => { throw new Error('nope') } })
  assert.ok(msg.startsWith('out of disk ('))
})

test('runFfmpeg: a healthy long run is capped by hardMs, not the stall limit', async () => {
  const { runFfmpeg } = await import('../encode-segment.js')
  const dir = mkdtempSync(join(tmpdir(), 'run-ffmpeg-'))
  try {
    const t0 = Date.now()
    const r = await runFfmpeg(['-nostdin', '-re', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10', '-f', 'null', '-'], 60_000, dir, { hardMs: 2500 })
    assert.equal(r.timedOut, true)
    assert.equal(r.signal, 'SIGKILL')
    assert.equal(r.stalledMs, undefined)
    assert.ok(Date.now() - t0 < 10_000)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
