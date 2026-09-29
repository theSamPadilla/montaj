// render/test/untagged-master-cache.integration.test.mjs
//
// A cached SDR master of an UNTAGGED source is rebuilt when an older montaj
// built it, and reused when this one did.
//
// Up to 5.5.4, lib/normalize.py read an untagged source (most web downloads,
// which are BT.709 underneath) as BT.601 and converted it to bt709, and the
// segment encoder's untagged canvas converted it most of the way back. The
// canvas is tagged now (composite-matrix.integration.test.mjs), so a master
// still carrying that conversion would export visibly off. normalize now reads
// an untagged source as BT.709 and writes UNTAGGED_MASTER_MARKER into the
// master; render rebuilds any master of an untagged source that lacks it,
// whichever way the project points at it.
//
// Every "stale" master here is a solid magenta and every "current" one a solid
// green, never the source's own swatches, so "reused" and "rebuilt from the
// source" cannot be confused whatever this ffmpeg build does with colour tags.
// The rebuild runs the real `python -m lib.normalize`; the test skips when that
// cannot be imported.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG, FFPROBE } from '../ffmpeg-bin.js'
import { buildNormalizedOutputPath } from '../render.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDER_JS = path.join(HERE, '..', 'render.js')
const MONTAJ_ROOT = path.resolve(HERE, '..', '..', '..')
const PYTHON = process.env.MONTAJ_PYTHON || 'python3'

const SWATCHES = ['e6194b', '3cb44b', '4363d8', '808080']
const BAND = 64
const W = BAND * SWATCHES.length
const H = 64
const MAGENTA = 'ff00ff'
const GREEN = '00c000'
const TOL = 4
// lib/normalize.py's UNTAGGED_MASTER_MARKER, spelled out so the behaviour tests
// below do not depend on the constant they are testing; the last test pins
// that Python and render.js both still say exactly this.
const MARKER = 'montaj: untagged source read as BT.709'

const rgbOf = (hex) => ({ r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) })
const fmt = (p) => `rgb(${p.r}, ${p.g}, ${p.b})`
const near = (a, b, tol = TOL) => Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol

function ff(args) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, `ffmpeg ${args.join(' ')} failed: ${r.stderr}`)
}

const pythonReady = () => spawnSync(PYTHON, ['-c', 'import lib.normalize'], { cwd: MONTAJ_ROOT, encoding: 'utf8' })

/** Swatch means at t=1.5 s, decoded as BT.709 limited (what an SDR output's tag says). */
function swatchMeans(file) {
  const r = spawnSync(FFMPEG, [
    '-v', 'error', '-ss', '1.5', '-i', file, '-frames:v', '1',
    '-vf', 'setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709,scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { encoding: 'buffer', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, `frame read failed: ${r.stderr}`)
  assert.equal(r.stdout.length, W * H * 3)
  return SWATCHES.map((_, i) => {
    const sum = [0, 0, 0]
    let n = 0
    for (let y = H / 2 - 8; y < H / 2 + 8; y++) {
      for (let x = i * BAND + BAND / 2 - 8; x < i * BAND + BAND / 2 + 8; x++) {
        const o = (y * W + x) * 3
        sum[0] += r.stdout[o]; sum[1] += r.stdout[o + 1]; sum[2] += r.stdout[o + 2]; n++
      }
    }
    return { r: Math.round(sum[0] / n), g: Math.round(sum[1] / n), b: Math.round(sum[2] / n) }
  })
}

const comment = (file) => spawnSync(FFPROBE, ['-v', 'quiet', '-show_entries', 'format_tags=comment',
  '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' }).stdout.trim()

/**
 * A 3 s swatch clip, 709-encoded, with one keyframe (so normalize must re-encode
 * it: its GOP is over the 2 s contract). `tagged` writes the bt709 tags; untagged
 * leaves every colour field unknown, the shape of a web download.
 */
function source(dir, { tagged }) {
  const src = path.join(dir, tagged ? 'tagged.mp4' : 'download.mp4')
  const bands = SWATCHES.map((hex, i) => `color=c=0x${hex}:size=${BAND}x${H}:rate=30:duration=3[s${i}]`).join(';')
  const tags = tagged
    ? 'setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709:range=tv'
    : 'setparams=colorspace=unknown:color_trc=unknown:color_primaries=unknown:range=unknown'
  ff(['-filter_complex', `${bands};${SWATCHES.map((_, i) => `[s${i}]`).join('')}hstack=inputs=${SWATCHES.length},` +
    `format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,${tags}`,
    '-c:v', 'libx264', '-qp', '0', '-g', '300', '-pix_fmt', 'yuv420p',
    ...(tagged ? ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'] : []),
    src])
  return src
}

/** A solid-colour 3 s master at `out`, newer than any source, optionally marked. */
function master(out, hex, { marked }) {
  ff(['-f', 'lavfi', '-i', `color=c=0x${hex}:size=${W}x${H}:rate=30:duration=3`,
    '-vf', 'format=yuv420p', '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    ...(marked ? ['-metadata', `comment=${MARKER}`] : []), out])
  const later = new Date(Date.now() + 60_000)
  utimesSync(out, later, later)
  return out
}

function render(dir, item, settings = {}) {
  const projectPath = path.join(dir, 'project.json')
  writeFileSync(projectPath, JSON.stringify({
    version: '0.2', status: 'final', name: 'untagged-master-cache',
    settings: { resolution: [W, H], fps: 30, colorSpace: 'sdr_bt709', ...settings },
    tracks: [[{ id: 'c0', type: 'video', start: 0, end: 3, inPoint: 0, muted: true, ...item }]],
    audio: { tracks: [] },
  }, null, 2))
  const out = path.join(dir, 'out.mp4')
  const r = spawnSync(process.execPath, [RENDER_JS, projectPath, '--out', out], {
    encoding: 'utf8', timeout: 180_000, env: { ...process.env, TMPDIR: dir },
  })
  assert.equal(r.status, 0, `render failed: ${r.stderr.slice(-1500)}`)
  assert.ok(existsSync(out), 'render produced no file')
  return { out, log: r.stderr }
}

function assertShows(t, label, got, want) {
  const rows = SWATCHES.map((_, i) => `band ${i}: want ${fmt(want[i])} got ${fmt(got[i])}`)
  for (const row of rows) t.diagnostic(`${label}: ${row}`)
  assert.ok(got.every((g, i) => near(g, want[i])), `${label}:\n  ${rows.join('\n  ')}`)
}

const allOf = (hex) => SWATCHES.map(() => rgbOf(hex))

function withDir(fn) {
  return async (t) => {
    const ready = pythonReady()
    if (ready.status !== 0) {
      t.skip(`${PYTHON} cannot import lib.normalize (set MONTAJ_PYTHON): ${(ready.stderr || '').trim().slice(-200)}`)
      return
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'montaj-untagged-master-'))
    try { await fn(t, dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
}

test('untagged source, unmarked master from an older montaj: rebuilt from the source', { timeout: 240_000 }, withDir(async (t, dir) => {
  const src = source(dir, { tagged: false })
  const stale = master(buildNormalizedOutputPath(src, 'sdr_bt709', false), MAGENTA, { marked: false })
  const { out } = render(dir, { src })
  assertShows(t, 'export', swatchMeans(out), SWATCHES.map(rgbOf))
  assert.equal(comment(stale), MARKER, 'the master was not rebuilt in place with the marker')
}))

test('untagged source, marked master: reused as-is', { timeout: 240_000 }, withDir(async (t, dir) => {
  const src = source(dir, { tagged: false })
  const current = master(buildNormalizedOutputPath(src, 'sdr_bt709', false), GREEN, { marked: true })
  const before = { bytes: readFileSync(current), mtime: statSync(current).mtimeMs }
  const { out } = render(dir, { src })
  assertShows(t, 'export', swatchMeans(out), allOf(GREEN))
  assert.equal(statSync(current).mtimeMs, before.mtime, 'a current master was rewritten')
  assert.ok(readFileSync(current).equals(before.bytes), 'a current master was rewritten')
}))

test('tagged source, unmarked master: reused, never rebuilt (tagged masters carry no marker)', { timeout: 240_000 }, withDir(async (t, dir) => {
  const src = source(dir, { tagged: true })
  const cached = master(buildNormalizedOutputPath(src, 'sdr_bt709', false), GREEN, { marked: false })
  const mtime = statSync(cached).mtimeMs
  const { out } = render(dir, { src })
  assertShows(t, 'export', swatchMeans(out), allOf(GREEN))
  assert.equal(statSync(cached).mtimeMs, mtime, 'a tagged source\'s master was rebuilt')
}))

test('src swapped onto an unmarked master (serve\'s background normalize): rebuilt from the source beside it', { timeout: 240_000 }, withDir(async (t, dir) => {
  const src = source(dir, { tagged: false })
  const stale = master(buildNormalizedOutputPath(src, 'sdr_bt709', false), MAGENTA, { marked: false })
  const { out } = render(dir, { src: stale })
  assertShows(t, 'export', swatchMeans(out), SWATCHES.map(rgbOf))
  assert.equal(comment(stale), MARKER, 'the master was not rebuilt in place with the marker')
}))

test('lazy normalizedSrc, unmarked: not used; the item is normalized from its source', { timeout: 240_000 }, withDir(async (t, dir) => {
  const src = source(dir, { tagged: false })
  const stale = master(path.join(dir, 'download_window.mp4'), MAGENTA, { marked: false })
  const { out } = render(dir, { src, normalizedSrc: stale, normalizedInPoint: 0 }, { normalize: 'lazy' })
  assertShows(t, 'export', swatchMeans(out), SWATCHES.map(rgbOf))
}))

test('the marker is one string in lib/normalize.py and render.js; a master maps back to its source', withDir(async (t, dir) => {
  const r = spawnSync(PYTHON, ['-c', 'import lib.normalize as n; print(n.UNTAGGED_MASTER_MARKER)'],
    { cwd: MONTAJ_ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), MARKER)
  const mod = await import('../render.js')
  assert.equal(mod.UNTAGGED_MASTER_MARKER, MARKER)
  // originalOfSdrMaster: the one video <stem>.<ext> beside the master, else null.
  const src = path.join(dir, 'clip.mov')
  writeFileSync(src, '')
  writeFileSync(path.join(dir, 'clip.json'), '{}')  // a sidecar is not a candidate
  const m = buildNormalizedOutputPath(src, 'sdr_bt709', false)
  assert.equal(mod.originalOfSdrMaster(m), src)
  assert.equal(mod.originalOfSdrMaster(buildNormalizedOutputPath(src, 'sdr_bt709', true)), null,
    'an iPhone (_vivid1) master is never mapped back')
  writeFileSync(path.join(dir, 'clip.mp4'), '')
  assert.equal(mod.originalOfSdrMaster(m), null, 'two candidate sources: ambiguous, left alone')
}))
