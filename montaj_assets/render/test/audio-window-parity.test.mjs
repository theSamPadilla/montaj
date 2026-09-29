// render/test/audio-window-parity.test.mjs
//
// The editor preview and the export must play an audio track over the SAME
// window. The preview asks timeline-core's `audioWindow(track, t)` whether a
// track is audible at t; the export places it with the ffmpeg args
// mix-audio.js builds (`-ss`/`-to` on the input, `adelay` in the graph). This
// suite reads the export's window back OUT of those real args — nothing is
// hand-copied — and requires the preview to agree at every sampled instant.
//
// Why it exists: a track with no `end` never played in preview (`end ?? 0` made
// `t >= end` true for every t) while the export played it at full length. In a
// 12-track project only the one track with an explicit `end` was audible in
// preview. The reverse divergence existed too: the export ignored `end` and
// played the file to its end, while the preview stopped at `end`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { audioWindow } from '@bycrux/timeline-core'
import { FFMPEG } from '../ffmpeg-bin.js'
import { buildAudioTrackInputs, buildAudioTrackFilters, mixAudioIntoVideo } from '../mix-audio.js'

/**
 * The window the export plays `track` over, recovered from mix-audio.js's own
 * output. `end: Infinity` = no `-to`, so ffmpeg plays to the end of the file.
 */
function exportWindow(track) {
  const t = { src: 'x.m4a', ...track }
  const args = buildAudioTrackInputs([t])
  const argAfter = (flag) => {
    const i = args.indexOf(flag)
    return i < 0 ? null : Number(args[i + 1])
  }
  const ss = argAfter('-ss') ?? 0
  const to = argAfter('-to')
  const { filterParts } = buildAudioTrackFilters([t], 1, '[0:a]')
  const m = filterParts.join(';').match(/adelay=(\d+):/)
  assert.ok(m, `no adelay in ${filterParts.join(';')}`)
  const start = Number(m[1]) / 1000
  return { start, end: to === null ? Infinity : start + (to - ss), inPoint: ss }
}

// Every shape a project on disk can carry. Starts are whole milliseconds,
// because adelay is.
const SHAPES = [
  { name: 'no end (the reported bug)', track: { start: 4 } },
  { name: 'nothing but src', track: {} },
  { name: 'end == start', track: { start: 4, end: 4 } },
  { name: 'end < start', track: { start: 4, end: 2 } },
  { name: 'end null', track: { start: 4, end: null } },
  { name: 'end non-numeric', track: { start: 4, end: '9' } },
  { name: 'no end, inPoint/outPoint', track: { start: 2, inPoint: 3, outPoint: 8 } },
  { name: 'explicit end', track: { start: 27, end: 31 } },
  { name: 'explicit end, inPoint', track: { start: 5.25, end: 15, inPoint: 2 } },
  { name: 'end, outPoint short of the span', track: { start: 10, end: 20, inPoint: 5, outPoint: 12 } },
  { name: 'end, outPoint past the span (split right half)', track: { start: 10, end: 20, inPoint: 10, outPoint: 60 } },
  { name: 'end, outPoint exactly the span', track: { start: 1, end: 6, inPoint: 2, outPoint: 7 } },
  { name: 'outPoint 0', track: { start: 1, outPoint: 0 } },
  { name: 'outPoint before inPoint', track: { start: 1, end: 9, inPoint: 5, outPoint: 3 } },
  { name: 'negative inPoint', track: { start: 3, end: 8, inPoint: -1 } },
  { name: 'ducked, faded', track: { start: 5, end: 9, fadeIn: 1, fadeOut: 1, ducking: { enabled: true } } },
  { name: 'ducked, no end', track: { start: 5, fadeOut: 1, ducking: { enabled: true } } },
]

/** Interior points plus both sides of every edge the two windows could disagree on. */
function sampleTimes(win) {
  const ts = []
  for (let t = -1; t <= 70; t += 0.25) ts.push(t)
  for (const edge of [win.start, win.end]) {
    if (Number.isFinite(edge)) ts.push(edge - 1e-6, edge + 1e-6)
  }
  return ts
}

for (const { name, track } of SHAPES) {
  test(`preview window == export window: ${name} ${JSON.stringify(track)}`, () => {
    const win = exportWindow(track)
    for (const t of sampleTimes(win)) {
      const expected = t >= win.start && t < win.end
      const got = audioWindow(track, t)
      assert.equal(
        got.active, expected,
        `t=${t}: export plays [${win.start}, ${win.end}), preview says active=${got.active}`,
      )
      if (expected) {
        assert.ok(
          Math.abs(got.trackTime - (t - win.start + win.inPoint)) < 1e-9,
          `t=${t}: preview seeks the source to ${got.trackTime}, export to ${t - win.start + win.inPoint}`,
        )
      }
    }
  })
}

// ── Measured, not parsed ────────────────────────────────────────────────────
//
// The table above trusts that ffmpeg honours input `-to` as a SOURCE position
// (so the window is `to - ss` long). This renders one real mix and measures it,
// so the `end` cut is proven in audio rather than in an argument list.

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `ffmpeg ${args.join(' ')} failed: ${r.stderr}`)
}

function meanVolumeDb(file, from, to) {
  const r = spawnSync(FFMPEG, [
    '-hide_banner', '-ss', String(from), '-to', String(to), '-i', file,
    '-vn', '-af', 'volumedetect', '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 60_000 })
  const m = (r.stderr ?? '').match(/mean_volume:\s*(-?[\d.]+) dB/)
  assert.ok(m, `volumedetect produced no mean_volume for ${file}:\n${(r.stderr ?? '').slice(-500)}`)
  return parseFloat(m[1])
}

test('export: an explicit end stops the track there; no end plays the file out', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'montaj-audio-window-'))
  try {
    const video = path.join(dir, 'silent.mp4')
    const tone = path.join(dir, 'tone10.m4a')
    ff(['-f', 'lavfi', '-i', 'color=black:s=64x64:d=10:r=10', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video])
    ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=10:sample_rate=48000', '-c:a', 'aac', tone])

    // A 10s file with `end` 3s after `start`: the preview stops at 3s, so the
    // export must be silent from 3s on — not play the other 7s of the file.
    const cut = path.join(dir, 'cut.mp4')
    mixAudioIntoVideo(video, [{ id: 'a', src: tone, start: 1, end: 3 }], cut)
    assert.ok(meanVolumeDb(cut, 1.5, 2.5) > -40, 'audible inside [start, end)')
    const after = meanVolumeDb(cut, 4, 7)
    assert.ok(after < -80, `silent after end; got ${after} dB (the file is 10s long, so sound here means the export ignored end)`)

    // No `end`: natural length, audible well past where any end would be.
    const open = path.join(dir, 'open.mp4')
    mixAudioIntoVideo(video, [{ id: 'b', src: tone, start: 1 }], open)
    assert.ok(meanVolumeDb(open, 4, 7) > -40, 'a track with no end plays its natural length')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
