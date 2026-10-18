// render/test/render-overrides.integration.test.mjs
//
// §284: `render.js --fps <n> --motion-blur <n>` renders this export at that
// frame rate and motion blur (the export window's Fast), and never writes
// them to project.json. Without the flags the same project renders at its own
// settings, so the comparison can say no. The real render.js, spawned.
//
// GATING: needs libx264 (MONTAJ_FFMPEG picks the binary). A missing capability
// fails unless MONTAJ_TEST_ALLOW_MISSING_CAPS=1.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG, FFPROBE } from '../ffmpeg-bin.js'

const RENDER_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'render.js')

function capabilityReason() {
  const enc = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 }).stdout || ''
  return /\blibx264\b/.test(enc) ? false : `${FFMPEG} lacks libx264 (set MONTAJ_FFMPEG)`
}
const reason = capabilityReason()
if (reason && process.env.MONTAJ_TEST_ALLOW_MISSING_CAPS !== '1') throw new Error(`${reason}, or set MONTAJ_TEST_ALLOW_MISSING_CAPS=1 to skip.`)
const SKIP = reason

const base = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-render-overrides-it-')))
after(() => rmSync(base, { recursive: true, force: true }))

/** A final, overlay-only project at 60 fps with motion blur 2: one opaque card, 1 s. */
function project() {
  const dir = join(base, `proj-${Math.random().toString(16).slice(2)}`)
  mkdirSync(join(dir, 'overlays'), { recursive: true })
  writeFileSync(join(dir, 'overlays', 'card.jsx'), `export default function Card() {
  return <div style={{ position: 'absolute', inset: 0, background: 'rgb(20, 30, 50)' }}>
    <div style={{ position: 'absolute', left: frame * 4, top: 40, width: 40, height: 40, background: 'rgb(240, 200, 40)' }} />
  </div>
}
`)
  const json = JSON.stringify({
    version: '0.2', id: 'overrides', name: 'overrides', status: 'final', projectType: 'editing',
    settings: { resolution: [320, 568], fps: 60, motionBlur: 2, colorSpace: 'sdr_bt709' },
    tracks: [{ id: 'trk-0', items: [] }, { id: 'trk-1', items: [{
      id: 'card', type: 'overlay', src: join(dir, 'overlays', 'card.jsx'), props: {}, start: 0, end: 1, opaque: true,
    }] }],
    assets: [], audio: {},
  }, null, 2)
  writeFileSync(join(dir, 'project.json'), json)
  return { dir, json, tmp: (() => { const t = join(dir, 'tmp'); mkdirSync(t); return t })() }
}

function render(p, out, extra = []) {
  return spawnSync(process.execPath, [RENDER_JS, join(p.dir, 'project.json'), '--out', out, '--workers', '1', ...extra],
    { encoding: 'utf8', timeout: 170_000, env: { ...process.env, TMPDIR: p.tmp } })
}

/** `[frames, rate]` of a file's video stream. */
function videoOf(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames,r_frame_rate', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const [rate, frames] = r.stdout.trim().split(',')
  return [Number(frames), rate]
}

test('--fps and --motion-blur render this export at them; project.json keeps its own', { skip: SKIP, timeout: 360_000 }, () => {
  const p = project()
  const own = join(p.dir, 'own.mp4')
  const fast = join(p.dir, 'fast.mp4')
  const a = render(p, own)
  assert.equal(a.status, 0, a.stderr.slice(-800))
  const b = render(p, fast, ['--fps', '30', '--motion-blur', '1'])
  assert.equal(b.status, 0, b.stderr.slice(-800))
  assert.deepEqual(videoOf(own), [60, '60/1'], 'without the flags: the project\'s 60 fps')
  assert.deepEqual(videoOf(fast), [30, '30/1'], 'with them: 30 fps')
  // Motion blur 2 bakes two captures per frame; the override's 1 bakes one.
  assert.match(a.stderr, /baked 60\/60 frames/)
  assert.match(b.stderr, /baked 30\/30 frames/)
  assert.equal(readFileSync(join(p.dir, 'project.json'), 'utf8'), p.json, 'never written to project.json')
})

test('a bad --motion-blur is refused before any work, as JSON', { skip: SKIP, timeout: 60_000 }, () => {
  const p = project()
  const r = render(p, join(p.dir, 'x.mp4'), ['--motion-blur', '9'])
  assert.equal(r.status, 1)
  const line = JSON.parse(r.stderr.trim().split('\n').at(-1))
  assert.equal(line.error, 'invalid_argument')
  assert.match(line.message, /--motion-blur must be an integer from 0 to 8 \(0 or 1 is off\)/)
  assert.equal(readFileSync(join(p.dir, 'project.json'), 'utf8'), p.json)
})
