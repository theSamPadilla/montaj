import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpegErrorTail } from '../ffmpeg-error.js'
import { mixAudioIntoVideo } from '../mix-audio.js'

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
