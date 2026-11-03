// render/test/mix-loudness.test.mjs
//
// §660, §697: the export and the editor preview level the mix by one static
// gain, target - I, so the measurement must read the export's own mix. These specs
// hold `measureMixLoudness` to an actual export of the same fixture: the
// clips are composed by the export, mixed with the lanes by the export's own
// graph and measured as mixAudioIntoVideo measures them, and the two
// integrated loudnesses must agree within 0.1 LU.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { FFMPEG } from '../ffmpeg-bin.js'
import { compose } from '../compose.js'
import { buildMixGraph, measureLoudness } from '../mix-audio.js'
import { collectAllItems, stampSourceProbes, loadRenderProject } from '../render.js'
import { audioOnlyGraph, measureMixLoudness } from '../mix-loudness.js'

const tmp = mkdtempSync(join(tmpdir(), 'montaj-mix-loudness-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

function ff(...args) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, r.stderr)
}

/** A 64x64 clip whose own audio is a quiet tone, a voiceover of quiet noise, and a ducked music bed. */
function fixture(dir, { loudness = -14, silentClip = false, lanes = true } = {}) {
  ff('-f', 'lavfi', '-i', 'testsrc=duration=4:size=64x64:rate=30',
    '-f', 'lavfi', '-i', silentClip ? 'anullsrc=r=48000:cl=stereo' : 'sine=f=330:r=48000:d=4',
    ...(silentClip ? [] : ['-af', 'volume=0.05']),
    '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir, 'clip.mp4'))
  if (lanes) {
    ff('-f', 'lavfi', '-i', 'anoisesrc=c=pink:r=48000:a=0.03:d=3', '-ac', '2', join(dir, 'vo.wav'))
    ff('-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=4', '-af', 'volume=0.1', '-ac', '2', join(dir, 'music.wav'))
  }
  const project = {
    id: 'fixture', name: 'fixture',
    settings: { resolution: [64, 64], fps: 30, ...(loudness === null ? {} : { loudness }) },
    tracks: [{ id: 'trk-0', items: [{ id: 'c1', type: 'video', src: 'clip.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4 }] }],
    audio: {
      tracks: lanes
        ? [
            { id: 'vo', src: 'vo.wav', start: 0.5, end: 3.5, volume: 1.5 },
            { id: 'music', src: 'music.wav', start: 0, end: 4, volume: 0.8, fadeOut: 1, ducking: { enabled: true, depth: -12 } },
          ]
        : [],
    },
  }
  const path = join(dir, 'project.json')
  writeFileSync(path, JSON.stringify(project))
  return path
}

/**
 * What the export's loudnorm reads, from the export itself: compose the clips
 * alone (the premix mixAudioIntoVideo is handed, AAC-encoded by the join, as
 * an export's is), then measure it with the lanes through mixAudioIntoVideo's
 * own graph and measurement.
 */
async function exportMixLoudness(projectPath, premix) {
  const { projectJson } = loadRenderProject(projectPath)
  const lanes = projectJson.audio.tracks
  projectJson.audio.tracks = []
  delete projectJson.settings.loudness
  const { imageItems, videoItems } = collectAllItems(projectJson)
  stampSourceProbes(videoItems, new Map())
  await compose({ projectJson, imageItems, videoItems, outputPath: premix, videoWidth: 64, videoHeight: 64 })
  const graph = buildMixGraph(lanes, ['-i', premix])
  return measureLoudness(graph.inputs, -14, graph)
}

test('audioOnlyGraph keeps the chains that feed the label and stands in for every input they do not read', () => {
  const inputs = [
    '-f', 'lavfi', '-i', 'color=black:size=64x64:rate=30:duration=2',
    '-err_detect', 'ignore_err', '-t', '2', '-i', '/a.mp4',
    '-loop', '1', '-t', '2', '-i', '/b.png',
  ]
  const parts = [
    '[0:v]format=yuv420p[canvas]',
    '[1:v]scale=64:64[v1];[canvas][v1]overlay=0:0[c1]',
    "[2:v]scale=64:64,blend=all_expr='A+(B-A)*(0.5)'[c2]",
    '[c1]setparams=colorspace=bt709[vout]',
    "[1:a:0]atrim=0:2,asetpts=PTS-STARTPTS,volume='1-(0.5*t)':eval=frame,aformat=channel_layouts=stereo:sample_rates=48000[a1]",
    '[a1]apad=whole_len=96000,atrim=end_sample=96000[aseg]',
  ]
  const g = audioOnlyGraph(inputs, parts, '[aseg]')
  assert.deepEqual(g.filter.split(';'), [parts[4], parts[5]])
  assert.deepEqual(g.inputs, [
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-err_detect', 'ignore_err', '-t', '2', '-i', '/a.mp4',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
  ])
})

test('audioOnlyGraph sinks a kept chain output nothing else reads', () => {
  const g = audioOnlyGraph(['-i', '/a.wav'], ['[0:a]asplit=2[x][y]', '[x]volume=1[aseg]'], '[aseg]')
  assert.deepEqual(g.filter.split(';'), ['[0:a]asplit=2[x][y]', '[x]volume=1[aseg]', '[y]anullsink'])
})

test('measureMixLoudness reads the export\'s own mix: within 0.1 LU of the export, ducking and fades included', async () => {
  const dir = mkdtempSync(join(tmp, 'mix-'))
  const projectPath = fixture(dir)
  const got = await measureMixLoudness(projectPath, { workDir: join(dir, 'work') })
  assert.equal(got.status, 'measured')
  assert.equal(got.targetI, -14)
  const ref = await exportMixLoudness(projectPath, join(dir, 'premix.mp4'))
  assert.ok(Number.isFinite(got.inputI) && Number.isFinite(ref.inputI), JSON.stringify({ got, ref }))
  assert.ok(Math.abs(got.inputI - ref.inputI) <= 0.1, `measured ${got.inputI} LUFS, the export measures ${ref.inputI} LUFS`)
  assert.ok(Number.isFinite(got.inputTP) && Number.isFinite(got.inputLRA))
})

test('measureMixLoudness: a silent mix answers silent', async () => {
  const dir = mkdtempSync(join(tmp, 'silent-'))
  const got = await measureMixLoudness(fixture(dir, { silentClip: true, lanes: false }), { workDir: join(dir, 'work') })
  assert.equal(got.status, 'silent')
})

test('measureMixLoudness: no loudness target answers off, measuring nothing', async () => {
  const dir = mkdtempSync(join(tmp, 'off-'))
  const got = await measureMixLoudness(fixture(dir, { loudness: null, lanes: false }), { workDir: join(dir, 'work') })
  assert.deepEqual(got, { status: 'off' })
})

// ── §697: the speech set ────────────────────────────────────────────────────
//
// The level is one static master gain measured on the SPEECH when the project
// has speech (serve decides what that is and hands the set over), so a fader
// on anything else is heard as it is and never re-levelled away.

/** A silent 64x64 clip, a voiceover lane (300 Hz) and a sound-effect lane (3 kHz) at `sfxVolume`. */
function laneFixture(dir, { sfxVolume = 1 } = {}) {
  ff('-f', 'lavfi', '-i', 'testsrc=duration=3:size=64x64:rate=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'clip.mp4'))
  ff('-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=3', '-af', 'volume=0.05', '-ac', '2', join(dir, 'vo.wav'))
  ff('-f', 'lavfi', '-i', 'sine=f=3000:r=48000:d=2', '-af', 'volume=0.2', '-ac', '2', join(dir, 'sfx.wav'))
  const project = {
    id: 'lanes', name: 'lanes',
    settings: { resolution: [64, 64], fps: 30, loudness: -14 },
    tracks: [{ id: 'trk-0', items: [{ id: 'c1', type: 'video', src: 'clip.mp4', start: 0, end: 3, inPoint: 0, outPoint: 3 }] }],
    audio: {
      tracks: [
        { id: 'vo', src: 'vo.wav', start: 0, end: 3, volume: 1 },
        { id: 'sfx', src: 'sfx.wav', start: 0.5, end: 2.5, volume: sfxVolume },
      ],
    },
  }
  const path = join(dir, 'project.json')
  writeFileSync(path, JSON.stringify(project))
  return path
}

/** A talking clip (300 Hz) on track 0 and a loud b-roll clip (3 kHz) over it on track 1 at `brollVolume`. */
function clipFixture(dir, { brollVolume = 1 } = {}) {
  ff('-f', 'lavfi', '-i', 'testsrc=duration=3:size=64x64:rate=30', '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=3',
    '-af', 'volume=0.05', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir, 'talk.mp4'))
  ff('-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=30', '-f', 'lavfi', '-i', 'sine=f=3000:r=48000:d=2',
    '-af', 'volume=0.2', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir, 'broll.mp4'))
  const project = {
    id: 'clips', name: 'clips',
    settings: { resolution: [64, 64], fps: 30, loudness: -14 },
    tracks: [
      { id: 'trk-0', items: [{ id: 'talk', type: 'video', src: 'talk.mp4', start: 0, end: 3, inPoint: 0, outPoint: 3 }] },
      { id: 'trk-1', items: [{ id: 'broll', type: 'video', src: 'broll.mp4', start: 0.5, end: 2.5, inPoint: 0, outPoint: 2, volume: brollVolume }] },
    ],
    audio: { tracks: [] },
  }
  const path = join(dir, 'project.json')
  writeFileSync(path, JSON.stringify(project))
  return path
}

const VO_ONLY = { v: 1, items: [], lanes: ['vo'], srcs: [] }

test('§697 measureMixLoudness with a speech set measures the speech lane alone: the SFX fader does not move it', async () => {
  const loud = mkdtempSync(join(tmp, 'sfx-loud-'))
  const quiet = mkdtempSync(join(tmp, 'sfx-quiet-'))
  const a = await measureMixLoudness(laneFixture(loud, { sfxVolume: 1 }), { workDir: join(loud, 'work'), speechSet: VO_ONLY })
  const b = await measureMixLoudness(laneFixture(quiet, { sfxVolume: 0.35 }), { workDir: join(quiet, 'work'), speechSet: VO_ONLY })
  assert.equal(a.status, 'measured')
  assert.equal(a.basis, 'speech')
  assert.equal(b.basis, 'speech')
  assert.ok(Math.abs(a.inputI - b.inputI) <= 0.05, `speech measured ${a.inputI} then ${b.inputI} LUFS`)

  const wa = await measureMixLoudness(join(loud, 'project.json'), { workDir: join(loud, 'work') })
  const wb = await measureMixLoudness(join(quiet, 'project.json'), { workDir: join(quiet, 'work') })
  assert.equal(wa.basis, 'mix')
  assert.ok(Math.abs(wa.inputI - wb.inputI) > 1, `the whole mix should move with the SFX: ${wa.inputI} then ${wb.inputI} LUFS`)
})

test('§697 measureMixLoudness with a speech set mutes every timeline clip not in it: the b-roll fader does not move it', async () => {
  const loud = mkdtempSync(join(tmp, 'broll-loud-'))
  const quiet = mkdtempSync(join(tmp, 'broll-quiet-'))
  const set = { v: 1, items: ['talk'], lanes: [], srcs: [] }
  const a = await measureMixLoudness(clipFixture(loud, { brollVolume: 1 }), { workDir: join(loud, 'work'), speechSet: set })
  const b = await measureMixLoudness(clipFixture(quiet, { brollVolume: 0.35 }), { workDir: join(quiet, 'work'), speechSet: set })
  assert.equal(a.basis, 'speech')
  assert.ok(Math.abs(a.inputI - b.inputI) <= 0.05, `speech measured ${a.inputI} then ${b.inputI} LUFS`)
  const wa = await measureMixLoudness(join(loud, 'project.json'), { workDir: join(loud, 'work') })
  const wb = await measureMixLoudness(join(quiet, 'project.json'), { workDir: join(quiet, 'work') })
  assert.ok(Math.abs(wa.inputI - wb.inputI) > 1, `the whole mix should move with the b-roll: ${wa.inputI} then ${wb.inputI} LUFS`)
})

test('§697 a speech set with no items and no lanes measures the whole mix', async () => {
  const dir = mkdtempSync(join(tmp, 'nospeech-'))
  const path = laneFixture(dir)
  const none = await measureMixLoudness(path, { workDir: join(dir, 'work'), speechSet: { v: 1, items: [], lanes: [], srcs: [] } })
  const mix = await measureMixLoudness(path, { workDir: join(dir, 'work') })
  assert.equal(none.basis, 'mix')
  assert.ok(Math.abs(none.inputI - mix.inputI) <= 0.01, `${none.inputI} vs ${mix.inputI}`)
})

test('§697 the CLI takes --speech-set <file> and says its basis', () => {
  const dir = mkdtempSync(join(tmp, 'cli-'))
  const path = laneFixture(dir)
  const setPath = join(dir, 'speech.json')
  writeFileSync(setPath, JSON.stringify(VO_ONLY))
  const cli = join(import.meta.dirname, '..', 'mix-loudness.js')
  const r = spawnSync(process.execPath, [cli, '--project', path, '--speech-set', setPath], { encoding: 'utf8', timeout: 120_000 })
  assert.equal(r.status, 0, r.stderr)
  const line = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.equal(line.status, 'measured')
  assert.equal(line.basis, 'speech')
  const r2 = spawnSync(process.execPath, [cli, '--project', path], { encoding: 'utf8', timeout: 120_000 })
  assert.equal(JSON.parse(r2.stdout.trim().split('\n').pop()).basis, 'mix')
})
