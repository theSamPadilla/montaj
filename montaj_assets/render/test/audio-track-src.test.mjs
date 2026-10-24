// §559: an audio.tracks entry in the video-track shape ({id, items}, no src)
// fails with a message naming the entry and the fix, not Node's raw
// 'The "path" argument must be of type string' from dirname(undefined).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveProjectPaths, audioTrackNoSrcMessage } from '../render.js'

const RENDER_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'render.js')
const base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-audio-src-')))
after(() => rmSync(base, { recursive: true, force: true }))

test('resolveProjectPaths: a track without src does not throw; one with src still resolves', () => {
  const project = { tracks: [], audio: { tracks: [
    { id: 'music', items: [] },
    { id: 'vo', src: 'vo.wav' },
  ] } }
  resolveProjectPaths(project, base)
  assert.equal(project.audio.tracks[0].src, undefined)
  assert.equal(project.audio.tracks[1].src, join(base, 'vo.wav'))
})

test('audioTrackNoSrcMessage: names the entry and the fix, with and without items', () => {
  assert.equal(audioTrackNoSrcMessage({ id: 'music', items: [{ src: 'a.mp3' }] }, 0),
    'audio.tracks[0] (id "music") has items instead of src. An audio track is one file: give each file its own entry with src.')
  assert.equal(audioTrackNoSrcMessage({ id: 'music', items: [] }, 0),
    'audio.tracks[0] (id "music") has no src. Set src to the audio file\'s path.')
  assert.equal(audioTrackNoSrcMessage({ id: 'music' }, 1),
    'audio.tracks[1] (id "music") has no src. Set src to the audio file\'s path.')
  assert.equal(audioTrackNoSrcMessage({}, 2), 'audio.tracks[2] has no src. Set src to the audio file\'s path.')
})

for (const flags of [['--estimate'], []]) {
  test(`render.js ${flags.join(' ') || '(render)'}: an {id, items} audio track fails with the clear message`, () => {
    const dir = realpathSync(mkdtempSync(join(base, 'p-')))
    const path = join(dir, 'project.json')
    writeFileSync(path, JSON.stringify({
      version: '0.1', id: 'p', status: 'final', schema: 'montaj/project', settings: { resolution: [1080, 1920], fps: 30 },
      tracks: [[]], audio: { tracks: [{ id: 'music', items: [{ src: 'a.mp3' }] }] },
    }))
    const r = spawnSync(process.execPath, [RENDER_JS, path, ...flags], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(r.status, 1, r.stderr)
    const last = JSON.parse(r.stderr.trim().split('\n').pop())
    assert.equal(last.error, 'invalid_audio_track')
    assert.equal(last.message, 'audio.tracks[0] (id "music") has items instead of src. An audio track is one file: give each file its own entry with src.')
    assert.ok(!r.stderr.includes('"path" argument'))
  })
}
