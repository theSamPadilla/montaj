// RAW sample: the source frame under the playhead, no look applied.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pickRawVideo, rawSeekSeconds, sampleRawFrame } from '../sample-frame.js'
import { FFMPEG } from '../ffmpeg-bin.js'

test('pickRawVideo takes the topmost video and ignores images/overlays', () => {
  const items = [
    { kind: 'video', trackIdx: 0, item: { id: 'a' } },
    { kind: 'image', trackIdx: 2, item: { id: 'img' } },
    { kind: 'video', trackIdx: 1, item: { id: 'b' } },
    { kind: 'overlay', trackIdx: 3, item: { id: 'o' } },
  ]
  assert.equal(pickRawVideo(items, {}).item.id, 'b')
  assert.equal(pickRawVideo(items, { 0: 5, 1: 1 }).item.id, 'a')
  assert.equal(pickRawVideo([{ kind: 'image', trackIdx: 0, item: {} }]), null)
})

test('rawSeekSeconds is source time: inPoint + speed * elapsed', () => {
  assert.equal(rawSeekSeconds({ start: 4, inPoint: 1, speed: 2 }, 5), 3)
  assert.equal(rawSeekSeconds({ start: 4 }, 3), 0)
})

const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0

test('full: raw frame at t in clip 2 is clip 2 source, uncropped, no overlay', { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'raw-'))
  const mk = (name, color) => {
    const f = join(dir, name)
    const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=64x48:d=2:r=10`, '-pix_fmt', 'yuv420p', f])
    assert.equal(r.status, 0, r.stderr?.toString())
    return f
  }
  const red = mk('red.mp4', 'red'), blue = mk('blue.mp4', 'blue')
  const project = {
    settings: { resolution: [1080, 1920], fps: 10 },
    tracks: [{ type: 'video', items: [
      { id: 'c1', type: 'video', src: red, start: 0, end: 2, inPoint: 0, outPoint: 2, sourceWidth: 64, sourceHeight: 48 },
      { id: 'c2', type: 'video', src: blue, start: 2, end: 4, inPoint: 0, outPoint: 2, sourceWidth: 64, sourceHeight: 48,
        transform: { scale: 3 } },
    ] }],
  }
  const pj = join(dir, 'project.json')
  writeFileSync(pj, JSON.stringify(project))
  const out = join(dir, 'out.png')
  await sampleRawFrame({ projectJson: pj, atSeconds: 3, outPath: out })
  const probe = spawnSync(FFMPEG, ['-v', 'error', '-i', out, '-vf', 'scale=1:1,format=rgb24', '-f', 'rawvideo', '-'])
  const [r, , b] = probe.stdout
  assert.ok(b > 200 && r < 60, `expected blue source, got r=${r} b=${b}`)
  const size = spawnSync(FFMPEG, ['-v', 'info', '-i', out, '-vf', 'showinfo', '-f', 'null', '-'], { encoding: 'utf8' })
  assert.match(size.stderr, /s:64x48/, 'source resolution, not project canvas')
})

// §563: settings.resolution and settings.fps go into a lavfi canvas source as text.
test('a sampled frame refuses a canvas size or frame rate that is not a number, naming the field', { skip: !hasFfmpeg }, async () => {
  const { sampleFrame } = await import('../sample-frame.js')
  const out = join(mkdtempSync(join(tmpdir(), 'canvas-')), 'f.png')
  const project = (settings) => ({ settings, tracks: [] })
  await sampleRawFrame({ projectJson: project({ resolution: [64, 48], fps: 10 }), atSeconds: 0, outPath: out })
  await sampleFrame({ projectJson: project({ resolution: [64, 48], fps: 10 }), atSeconds: 0, outPath: out })
  await assert.rejects(sampleRawFrame({ projectJson: project({ resolution: ['64:x', 48] }), atSeconds: 0, outPath: out }),
    /settings\.resolution\[0\]/)
  await assert.rejects(sampleFrame({ projectJson: project({ resolution: [64, '48:x'], fps: 10 }), atSeconds: 0, outPath: out }),
    /settings\.resolution\[1\]/)
  await assert.rejects(sampleFrame({ projectJson: project({ resolution: [64, 48], fps: '10:x' }), atSeconds: 0, outPath: out }),
    /settings\.fps/)
})
