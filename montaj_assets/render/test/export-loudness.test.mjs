// render/test/export-loudness.test.mjs
//
// §697: the export levels by ONE static master gain, `settings.loudness - I`,
// I measured on the speech (serve's --speech-set) through mix-loudness.js, the
// number the editor preview plays at. Faders are absolute: lowering a sound
// effect lowers it by exactly its fader in the export and leaves the speech
// where it was. A dynamic loudnorm over the whole mix (the old export) pulled
// the speech up whenever the effect went down.
//
// The real render.js, on a project with no overlays (no browser) and an image
// for its picture (no normalize pass): a voiceover lane (300 Hz) and an
// effect lane (3 kHz), each read back out of the export on its own band.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG } from '../ffmpeg-bin.js'
import { measureMixLoudness } from '../mix-loudness.js'

const RENDER_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'render.js')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-export-loudness-')))
after(() => rmSync(root, { recursive: true, force: true }))

function ff(...args) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, r.stderr)
}

// ffmpeg's sine is 1/8 full scale: the voiceover peaks at 0.05 (about -27
// LUFS, so +13 dB to -14), the effect at 0.1; raised, their sum stays under
// the -1.5 dBFS ceiling, so the limiter never acts and every dB is the fader's.
ff('-f', 'lavfi', '-i', 'color=c=gray:s=64x64', '-frames:v', '1', join(root, 'bg.png'))
ff('-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=4', '-af', 'volume=0.4', '-ac', '2', join(root, 'vo.wav'))
ff('-f', 'lavfi', '-i', 'sine=f=3000:r=48000:d=2', '-af', 'volume=0.8', '-ac', '2', join(root, 'sfx.wav'))

const SPEECH = join(root, 'speech.json')
writeFileSync(SPEECH, JSON.stringify({ v: 1, items: [], lanes: ['vo'], srcs: [join(root, 'vo.wav')] }))

function project(name, { sfx = 1, withSfx = true } = {}) {
  const dir = join(root, name)
  spawnSync('mkdir', ['-p', dir])
  const p = {
    version: '0.2', id: name, name,
    settings: { resolution: [64, 64], fps: 30, loudness: -14 },
    tracks: [{ id: 't0', items: [{ id: 'bg', type: 'image', src: join(root, 'bg.png'), start: 0, end: 4 }] }],
    audio: {
      tracks: [
        { id: 'vo', src: join(root, 'vo.wav'), start: 0, end: 4, volume: 1 },
        ...(withSfx ? [{ id: 'sfx', src: join(root, 'sfx.wav'), start: 1, end: 3, volume: sfx }] : []),
      ],
    },
  }
  writeFileSync(join(dir, 'project.json'), JSON.stringify(p))
  return join(dir, 'project.json')
}

function render(projectPath) {
  const out = join(dirname(projectPath), 'out.mp4')
  const r = spawnSync(process.execPath, [RENDER_JS, projectPath, '--out', out, '--speech-set', SPEECH],
    { encoding: 'utf8', timeout: 180_000 })
  assert.equal(r.status, 0, r.stderr)
  return { out, stderr: r.stderr }
}

/** Overall RMS (dB) of `path`'s audio through `filter`. */
function bandRms(path, filter) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', path, '-vn', '-af', `${filter},astats=metadata=0`, '-f', 'null', '-'],
    { encoding: 'utf8', timeout: 60_000 })
  const all = [...r.stderr.matchAll(/RMS level dB:\s*(-?[\d.]+|-inf)/g)]
  assert.ok(all.length, r.stderr.slice(-800))
  return Number(all[all.length - 1][1])
}
const VO_BAND = 'lowpass=f=700,lowpass=f=700,lowpass=f=700,lowpass=f=700'
const SFX_BAND = 'highpass=f=1500,highpass=f=1500,highpass=f=1500,highpass=f=1500'

function integrated(path) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', path, '-vn', '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8', timeout: 60_000 })
  const m = r.stderr.match(/Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+) LUFS/)
  assert.ok(m, r.stderr.slice(-800))
  return Number(m[1])
}

test('§697 lowering the effect lane to 0.35 lowers it 9.1 dB in the export and leaves the voiceover where it was', { timeout: 400_000 }, () => {
  const full = render(project('full', { sfx: 1 }))
  const low = render(project('low', { sfx: 0.35 }))
  const sfxDelta = bandRms(low.out, SFX_BAND) - bandRms(full.out, SFX_BAND)
  const voDelta = bandRms(low.out, VO_BAND) - bandRms(full.out, VO_BAND)
  assert.ok(Math.abs(sfxDelta - 20 * Math.log10(0.35)) <= 0.3, `effect moved ${sfxDelta.toFixed(2)} dB, its fader ${(20 * Math.log10(0.35)).toFixed(2)} dB`)
  assert.ok(Math.abs(voDelta) <= 0.2, `voiceover moved ${voDelta.toFixed(2)} dB`)
})

test('§697 the export applies exactly target - I of the speech, and speech alone lands on the target', { timeout: 400_000 }, async () => {
  const path = project('speech-only', { withSfx: false })
  const { out, stderr } = render(path)
  const m = await measureMixLoudness(path, { speechSet: { items: [], lanes: ['vo'] } })
  const logged = /master gain ([-+]?[\d.]+) dB/.exec(stderr)
  assert.ok(logged, `no master gain line in:\n${stderr.slice(-1500)}`)
  assert.ok(Math.abs(Number(logged[1]) - (-14 - m.inputI)) <= 0.01, `gain ${logged[1]} dB, target - I = ${(-14 - m.inputI).toFixed(2)} dB`)
  const i = integrated(out)
  assert.ok(Math.abs(i - -14) <= 0.5, `export at ${i} LUFS, target -14`)
})
