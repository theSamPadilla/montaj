// PL89d: four b-roll cards rendered the source's opening title instead of the robot. The agent added the items with the
// source's full-length normalizedSrc (copied from project.sources) and no normalizedInPoint, and a normalizedSrc with no
// origin is read as a legacy window cache that starts at the item's inPoint (timeline-core's sourceWindow), so the
// render played the full file from 0. A cache that IS its source's recorded normalizedSrc covers the whole file: its
// origin is 0 (anchorFullSourceCaches). The editor and samples read the proxy, so only the render showed it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG } from '../ffmpeg-bin.js'
import { anchorFullSourceCaches } from '../render.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDER_JS = path.join(HERE, '..', 'render.js')

test('a normalizedSrc that is its source\'s recorded cache gets origin 0; a window cache and an explicit origin are kept', () => {
  const p = {
    sources: [{ id: 's1', type: 'video', src: '/w/a.mp4', normalizedSrc: '/w/a_normalized_hdr_hlg.mp4' }],
    tracks: [
      { id: 't0', items: [{ id: 'full', type: 'video', src: '/w/a.mp4', inPoint: 36, outPoint: 40, normalizedSrc: '/w/a_normalized_hdr_hlg.mp4' }] },
      { id: 't1', items: [
        { id: 'window', type: 'video', src: '/w/a.mp4', inPoint: 36, outPoint: 40, normalizedSrc: '/w/a_window_36.mp4' },
        { id: 'set', type: 'video', src: '/w/a.mp4', inPoint: 36, outPoint: 40, normalizedSrc: '/w/a_normalized_hdr_hlg.mp4', normalizedInPoint: 30 },
      ] },
    ],
  }
  anchorFullSourceCaches(p)
  const by = Object.fromEntries(p.tracks.flatMap((t) => t.items).map((it) => [it.id, it]))
  assert.equal(by.full.normalizedInPoint, 0)
  assert.equal('normalizedInPoint' in by.window, false, 'a cache the sources do not record stays a legacy window')
  assert.equal(by.set.normalizedInPoint, 30)
})

const hasX265 = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libx265')
const hasRender = existsSync(path.join(HERE, '..', 'node_modules', 'puppeteer'))

test('render: a contained, scaled, offset upper-track HLG video shows its inPoint frame, not the source start', { skip: !(hasX265 && hasRender) && 'needs libx265 and the render bundle' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'anchor-'))
  const ff = (args) => { const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 120_000 }); assert.equal(r.status, 0, r.stderr) }
  const hlg = ['-c:v', 'libx265', '-x265-params', 'log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
    '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1']
  // ten one-second colours: second 5 is blue, second 0 red
  const cols = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'magenta', 'white', 'brown']
  ff([...cols.flatMap((c) => ['-f', 'lavfi', '-i', `color=c=${c}:s=320x180:d=1:r=30`]), '-filter_complex', `${cols.map((_, i) => `[${i}]`).join('')}concat=n=10:v=1:a=0,format=yuv420p`, path.join(dir, 'src.mp4')])
  ff(['-i', path.join(dir, 'src.mp4'), '-vf', 'format=yuv420p10le', ...hlg, path.join(dir, 'src_normalized_hdr_hlg.mp4')])
  ff(['-f', 'lavfi', '-i', 'color=c=gray:s=540x960:d=3:r=30', '-vf', 'format=yuv420p10le', ...hlg, path.join(dir, 'main.mp4')])
  const project = path.join(dir, 'project.json')
  writeFileSync(project, JSON.stringify({
    version: '0.2', id: 'anchor', name: 'Anchor', status: 'final', settings: { fps: 30, resolution: [540, 960], colorSpace: 'hdr_hlg' },
    sources: [{ id: 's1', type: 'video', src: path.join(dir, 'src.mp4'), normalizedSrc: path.join(dir, 'src_normalized_hdr_hlg.mp4') }],
    tracks: [
      { id: 't0', items: [{ id: 'main', type: 'video', src: path.join(dir, 'main.mp4'), start: 0, end: 3, inPoint: 0, outPoint: 3 }] },
      { id: 't1', items: [{ id: 'br', type: 'video', src: path.join(dir, 'src.mp4'), normalizedSrc: path.join(dir, 'src_normalized_hdr_hlg.mp4'),
        start: 1, end: 2, inPoint: 5, outPoint: 6, sourceWidth: 320, sourceHeight: 180, muted: true, scale: 0.88, offsetX: 0, offsetY: -14 }] },
    ],
  }))
  const out = path.join(dir, 'out.mp4')
  const r = spawnSync('node', [RENDER_JS, project, '--out', out], { encoding: 'utf8', timeout: 300_000, env: { ...process.env, TMPDIR: dir } })
  assert.equal(r.status, 0, r.stderr.slice(-500))
  // the card's centre at 1.5 s (item 0.5 s, source 5.5 s): blue, in SDR after the HLG decode; red would be the source start
  const px = spawnSync(FFMPEG, ['-v', 'error', '-ss', '1.5', '-i', out, '-frames:v', '1', '-vf', 'crop=4:4:268:344,scale=1:1,format=rgb24', '-f', 'rawvideo', '-'], { timeout: 60_000 }).stdout
  const [R, G, B] = px
  assert.ok(B > 150 && R < 100, `the card shows rgb(${R}, ${G}, ${B}), not blue`)
})
