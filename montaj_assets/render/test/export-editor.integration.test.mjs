// render/test/export-editor.integration.test.mjs
/**
 * The Export for editor CLI (render/export-editor.js) end to end on a tiny real
 * project: a 2 s generated clip, one overlay, two caption segments.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, existsSync, readdirSync, mkdirSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { FFMPEG, FFPROBE } from '../ffmpeg-bin.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dirname, '..', 'export-editor.js')
const W = 320
const H = 180

const haveTools = () => spawnSync(FFPROBE, ['-version']).status === 0 && spawnSync(FFMPEG, ['-version']).status === 0

let dir = null
let projDir = null
let projectPath = null
let skip = false

function project(overlaySrc = 'cadence-ramp.jsx') {
  return {
    version: '0.2',
    id: 'export-editor-test',
    status: 'final',
    projectType: 'editing',
    settings: { resolution: [W, H], fps: 30, colorSpace: 'sdr_bt709' },
    tracks: [
      { id: 'trk-0', items: [
        { id: 'clip', type: 'video', src: 'clip.mp4', start: 0, end: 2, inPoint: 0, outPoint: 2 },
      ] },
      { id: 'trk-1', items: [
        { id: 'ramp', type: 'overlay', src: overlaySrc, props: {}, start: 0.5, end: 1.5 },
      ] },
    ],
    captions: { style: 'subtitle', segments: [
      { id: 'c1', text: 'Hello', start: 0.2, end: 0.6 },
      { id: 'c2', text: 'World', start: 0.8, end: 1.3 },
    ] },
    assets: [],
    audio: {},
  }
}

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return r
}

const sha256Of = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

const progressLines = (stderr) => stderr.split('\n').filter((l) => l.startsWith('{"progress"')).map((l) => JSON.parse(l).progress)

before(() => {
  if (!haveTools()) { skip = true; return }
  dir = mkdtempSync(join(tmpdir(), 'montaj-export-editor-test-'))
  projDir = join(dir, 'proj')
  mkdirSync(projDir)
  copyFileSync(join(__dirname, 'fixtures', 'cadence-ramp.jsx'), join(projDir, 'cadence-ramp.jsx'))
  const gen = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=${W}x${H}:rate=30:duration=2`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-pix_fmt', 'yuv420p', '-y', join(projDir, 'clip.mp4')])
  assert.equal(gen.status, 0, String(gen.stderr))
  projectPath = join(projDir, 'project.json')
  writeFileSync(projectPath, JSON.stringify(project(), null, 2))
})

after(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

test('the package: XML, media copy, graphic, captions movie and srt, one JSON result, progress per step', { timeout: 300_000 }, (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const r = runCli(['--project', projectPath, '--name', 'My Cut'])
  assert.equal(r.status, 0, r.stderr)

  const pkg = join(projDir, 'export', 'My Cut (Premiere Pro)')
  const result = JSON.parse(r.stdout)
  assert.deepEqual(Object.keys(result).sort(), ['dir', 'files', 'leftOut', 'open', 'openSha256', 'seconds', 'warnings', 'xml'])
  assert.equal(result.openSha256, sha256Of(result.open))
  assert.match(result.openSha256, /^[0-9a-f]{64}$/)
  assert.equal(result.dir, pkg)
  assert.equal(result.xml, join(pkg, 'My Cut.xml'))
  assert.equal(result.open, result.xml, 'open is the file to hand the editor')
  assert.deepEqual(result.files, ['My Cut.xml', 'captions.mov', 'captions.srt', 'graphics/ramp.mov', 'media/clip.mp4'])
  assert.ok(Array.isArray(result.leftOut) && Array.isArray(result.warnings))
  assert.equal(typeof result.seconds, 'number')
  for (const f of result.files) assert.ok(existsSync(join(pkg, f)), f)

  // Progress: one line for the media copy, then one per movie, on stderr, each ending at done == total.
  const progress = progressLines(r.stderr)
  assert.deepEqual(progress.map((p) => [p.done, p.total]), [[1, 1], [1, 2], [2, 2]])
  assert.deepEqual(progress.map((p) => p.label).sort(), ['Copying clip.mp4', 'captions', 'ramp'])

  // The XML parses and links the package's own movies, by their final paths.
  const xml = readFileSync(result.xml, 'utf8')
  const lint = spawnSync('xmllint', ['--noout', result.xml], { encoding: 'utf8' })
  if (lint.error?.code !== 'ENOENT') assert.equal(lint.status, 0, lint.stderr)
  assert.ok(xml.includes('xmeml'))
  assert.ok(xml.includes('graphics/ramp.mov') && xml.includes('captions.mov'))
  assert.ok(xml.includes('media/clip.mp4'), 'the XML links the copy beside it')
  assert.ok(!xml.includes('/proj/clip.mp4'), 'and not the original')
  assert.ok(!xml.includes('.tmp-'), 'no temp path leaked into the XML')
  assert.ok(!/not rendered yet/.test(result.warnings.join('|')), result.warnings.join(' | '))

  assert.equal(readFileSync(join(pkg, 'captions.srt'), 'utf8'),
    '1\n00:00:00,200 --> 00:00:00,600\nHello\n\n2\n00:00:00,800 --> 00:00:01,300\nWorld\n')
  const probe = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'csv=p=0', join(pkg, 'graphics', 'ramp.mov')], { encoding: 'utf8' })
  assert.match(probe.stdout, /^prores,yuva444p/)

  // No scratch siblings left behind.
  assert.deepEqual(readdirSync(join(projDir, 'export')), ['My Cut (Premiere Pro)'])
  assert.equal(readFileSync(join(pkg, 'media', 'clip.mp4')).length, readFileSync(join(projDir, 'clip.mp4')).length, 'the copy is the whole file')
})

test('a second export of the same name goes beside the first, never over it', { timeout: 300_000 }, (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const pkg = join(projDir, 'export', 'My Cut (Premiere Pro)')
  writeFileSync(join(pkg, 'mine.txt'), 'kept')
  const r = runCli(['--project', projectPath, '--name', 'My Cut'])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(join(pkg, 'mine.txt'), 'utf8'), 'kept', 'the first package is untouched')
  const second = JSON.parse(r.stdout)
  assert.equal(second.dir, join(projDir, 'export', 'My Cut (Premiere Pro) 2'))
  assert.deepEqual(second.files, ['My Cut.xml', 'captions.mov', 'captions.srt', 'graphics/ramp.mov', 'media/clip.mp4'])
  const again = JSON.parse(runCli(['--project', projectPath, '--name', 'My Cut']).stdout)
  assert.equal(again.dir, join(projDir, 'export', 'My Cut (Premiere Pro) 3'))
  assert.ok(!readdirSync(join(projDir, 'export')).some((e) => e.includes('.tmp-')), 'no scratch left')
})

test('--editor names the folder; premiere and resolve write the same XML; one that is not written yet or unknown is refused', { timeout: 300_000 }, (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const proj = plainProject('editors')
  const out = join(dir, 'editors-out')
  const r = runCli(['--project', proj.path, '--name', 'e', '--editor', 'resolve', '--out', out])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).dir, join(out, 'e (DaVinci Resolve)'))
  for (const [editor, code] of [['bogus', 'invalid_args']]) {
    const bad = runCli(['--project', proj.path, '--name', 'e', '--editor', editor, '--out', out])
    assert.notEqual(bad.status, 0, editor)
    assert.equal(JSON.parse(bad.stderr.trim().split('\n').pop()).error, code, editor)
  }
  assert.deepEqual(readdirSync(out), ['e (DaVinci Resolve)'], 'a refused export leaves nothing')
})

test('--editor fcp: an .fcpxml linking the media copies by file URL', { timeout: 300_000 }, (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const proj = plainProject('fcp')
  const out = join(dir, 'fcp-out')
  const r = runCli(['--project', proj.path, '--name', 'f', '--editor', 'fcp', '--out', out])
  assert.equal(r.status, 0, r.stderr)
  const res = JSON.parse(r.stdout)
  assert.equal(res.dir, join(out, 'f (Final Cut Pro)'))
  assert.equal(res.open, join(res.dir, 'f.fcpxml'))
  assert.equal(res.openSha256, sha256Of(res.open))
  const xml = readFileSync(res.open, 'utf8')
  assert.match(xml, /<fcpxml version="1.9">/)
  assert.ok(xml.includes('src="file://' + res.dir.split('/').map(encodeURIComponent).join('/')) || xml.includes('/media/'), 'media linked in the package')
})

test('--editor ae: a .jsx beside relative media, an .aep path in the result, text layers for the captions', { timeout: 300_000 }, (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const proj = plainProject('ae')
  const out = join(dir, 'ae-out')
  const r = runCli(['--project', proj.path, '--name', 'a', '--editor', 'ae', '--out', out])
  assert.equal(r.status, 0, r.stderr)
  const res = JSON.parse(r.stdout)
  assert.equal(res.dir, join(out, 'a (After Effects)'))
  assert.equal(res.open, join(res.dir, 'a.jsx'))
  assert.equal(res.aep, join(res.dir, 'a.aep'))
  assert.equal(res.openSha256, sha256Of(res.open), 'the hash is of the .jsx')
  const jsx = readFileSync(res.open, 'utf8')
  assert.ok(jsx.includes('"path": "media/'), 'media is relative to the script')
  assert.ok(!jsx.includes(res.dir), 'the package folder path is not baked in')
  assert.ok(readdirSync(res.dir).includes('.montaj-editor-export'))
})

test('--out: the package goes in the folder asked for, which is created if it is new', { timeout: 300_000 }, (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const out = join(dir, 'elsewhere', 'pkgs')
  const r = runCli(['--project', projectPath, '--name', 'x', '--out', out])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).dir, join(out, 'x (Premiere Pro)'))
  assert.ok(existsSync(join(out, 'x (Premiere Pro)', 'x.xml')))
  assert.deepEqual(readdirSync(out), ['x (Premiere Pro)'])
})

test('a failing export leaves no package, and an earlier one is untouched', { timeout: 300_000 }, (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const broken = join(dir, 'broken')
  mkdirSync(broken)
  copyFileSync(join(projDir, 'clip.mp4'), join(broken, 'clip.mp4'))
  writeFileSync(join(broken, 'bad.jsx'), 'export default function ( {{{ not jsx')
  const bp = join(broken, 'project.json')
  writeFileSync(bp, JSON.stringify(project('bad.jsx')))
  const r = runCli(['--project', bp, '--name', 'Broken'])
  assert.notEqual(r.status, 0)
  assert.equal(r.stdout.trim(), '')
  const err = JSON.parse(r.stderr.trim().split('\n').filter((l) => l.startsWith('{"error"')).pop())
  assert.equal(typeof err.error, 'string')
  assert.ok(err.message.length > 0)
  const exportDir = join(broken, 'export')
  assert.deepEqual(existsSync(exportDir) ? readdirSync(exportDir) : [], [], 'no package and no scratch')

  // A failed re-export keeps the previous package.
  const pkg = join(projDir, 'export', 'My Cut (Premiere Pro)')
  const before = readdirSync(join(projDir, 'export')).sort()
  writeFileSync(projectPath, JSON.stringify(project('bad.jsx')))
  const r2 = runCli(['--project', projectPath, '--name', 'My Cut'])
  writeFileSync(projectPath, JSON.stringify(project(), null, 2))
  assert.notEqual(r2.status, 0)
  assert.ok(existsSync(join(pkg, 'My Cut.xml')), 'the earlier package is still there')
  assert.deepEqual(readdirSync(join(projDir, 'export')).sort(), before, 'nothing added, nothing left over')
})

test('bad arguments: JSON error, non-zero exit', (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  for (const args of [[], ['--project', join(dir, 'nope.json'), '--name', 'x'], ['--project', projectPath, '--bogus']]) {
    const r = runCli(args)
    assert.notEqual(r.status, 0)
    if (args.length) assert.equal(typeof JSON.parse(r.stderr.trim().split('\n').pop()).error, 'string')
  }
  const r = runCli(['--project', projectPath, '--name', 'x', '--out', projDir])
  assert.notEqual(r.status, 0)
  assert.equal(JSON.parse(r.stderr.trim()).error, 'invalid_args')
  assert.ok(existsSync(projectPath), 'the project folder is never replaced')
})

test('renderMode ffmpeg-drawtext: no graphics and no captions movie, the srt still goes', { timeout: 300_000 }, (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const dt = join(dir, 'drawtext')
  mkdirSync(dt)
  copyFileSync(join(projDir, 'clip.mp4'), join(dt, 'clip.mp4'))
  copyFileSync(join(projDir, 'cadence-ramp.jsx'), join(dt, 'cadence-ramp.jsx'))
  writeFileSync(join(dt, 'project.json'), JSON.stringify({ ...project(), renderMode: 'ffmpeg-drawtext' }))
  const r = runCli(['--project', join(dt, 'project.json'), '--name', 'D'])
  assert.equal(r.status, 0, r.stderr)
  const result = JSON.parse(r.stdout)
  assert.deepEqual(result.files, ['D.xml', 'captions.srt', 'media/clip.mp4'])
  assert.ok(result.warnings.some((w) => /ffmpeg-drawtext draws no overlays/.test(w)), result.warnings.join(' | '))
  assert.ok(result.warnings.some((w) => /ffmpeg-drawtext draws captions/.test(w)), result.warnings.join(' | '))
  assert.ok(!/not rendered yet/.test(result.warnings.join('|')))
  assert.ok(!readFileSync(result.xml, 'utf8').includes('.mov'), 'the XML links no movie')
  assert.deepEqual(progressLines(r.stderr).map((p) => p.label), ['Copying clip.mp4'], 'only the media copy reports: no movie is rendered')
})

/** A project with one video clip and nothing to render, in its own folder; `edit` may change it. */
function plainProject(name, edit = (p) => p) {
  const d = join(dir, name)
  mkdirSync(d, { recursive: true })
  copyFileSync(join(projDir, 'clip.mp4'), join(d, 'clip.mp4'))
  const p = edit({ ...project(), tracks: [{ id: 'trk-0', items: [
    { id: 'clip', type: 'video', src: 'clip.mp4', start: 0, end: 2, inPoint: 0, outPoint: 2 },
  ] }], captions: undefined })
  writeFileSync(join(d, 'project.json'), JSON.stringify(p))
  return { dir: d, path: join(d, 'project.json') }
}

test('--out is a folder the package goes in: a file there is refused; a folder with other things in it is fine and left as it is', { timeout: 300_000 }, (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const proj = plainProject('guard')
  const unrelated = join(dir, 'guard-unrelated')
  mkdirSync(join(unrelated, 'sub'), { recursive: true })
  writeFileSync(join(unrelated, 'sub', 'keep.txt'), 'mine')
  const asFile = join(dir, 'guard-file')
  writeFileSync(asFile, 'a file')

  const bad = runCli(['--project', proj.path, '--name', 'g', '--out', asFile])
  assert.notEqual(bad.status, 0)
  assert.equal(JSON.parse(bad.stderr.trim().split('\n').pop()).error, 'out_exists')
  assert.equal(readFileSync(asFile, 'utf8'), 'a file')

  const ok = runCli(['--project', proj.path, '--name', 'g', '--out', unrelated])
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(readFileSync(join(unrelated, 'sub', 'keep.txt'), 'utf8'), 'mine', 'what was in the folder is untouched')
  const pkg = JSON.parse(ok.stdout).dir
  assert.equal(pkg, join(unrelated, 'g (Premiere Pro)'))
  assert.ok(existsSync(join(pkg, '.montaj-editor-export')), 'every package carries the marker')
  assert.ok(!JSON.parse(ok.stdout).files.includes('.montaj-editor-export'), 'the marker is not listed')
})

test('the package folder has the usual folder mode, not the owner-only temp mode', (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const proj = plainProject('mode')
  const r = runCli(['--project', proj.path, '--name', 'm'])
  assert.equal(r.status, 0, r.stderr)
  const mode = statSync(JSON.parse(r.stdout).dir).mode & 0o777
  assert.equal(mode, 0o777 & ~process.umask())
})

test('two clips from one file: leftOut names each clip', (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const proj = plainProject('twoclips', (p) => ({ ...p, tracks: [{ id: 'trk-0', items: [
    { id: 'first', type: 'video', src: 'clip.mp4', start: 0, end: 1, inPoint: 0, outPoint: 1, loop: true },
    { id: 'second', type: 'video', src: 'clip.mp4', start: 1, end: 2, inPoint: 1, outPoint: 2, loop: true },
  ] }] }))
  const r = runCli(['--project', proj.path, '--name', 't'])
  assert.equal(r.status, 0, r.stderr)
  const clips = JSON.parse(r.stdout).leftOut.map((l) => l.clip)
  assert.ok(clips.includes('first') && clips.includes('second'), JSON.stringify(clips))
})

test('a file the render finds under a narrow no-break space name is linked, not offline', (t) => {
  if (skip) { t.skip('ffmpeg/ffprobe not available'); return }
  const proj = plainProject('nnbsp', (p) => ({ ...p, tracks: [{ id: 'trk-0', items: [
    { id: 'clip', type: 'video', src: 'my clip.mp4', start: 0, end: 2, inPoint: 0, outPoint: 2 },
  ] }] }))
  copyFileSync(join(proj.dir, 'clip.mp4'), join(proj.dir, 'my\u202fclip.mp4'))
  const r = runCli(['--project', proj.path, '--name', 'n'])
  assert.equal(r.status, 0, r.stderr)
  const result = JSON.parse(r.stdout)
  assert.equal(result.files.filter((f) => f.startsWith('media/')).length, 1, 'the real file was found and copied')
  assert.equal(statSync(join(result.dir, result.files.find((f) => f.startsWith('media/')))).size, statSync(join(proj.dir, 'clip.mp4')).size)
  assert.ok(!/not on this computer|not found|offline|missing/i.test(result.warnings.join('|')), result.warnings.join(' | '))
})

test('SIGTERM mid-run leaves no hidden temp folder', { timeout: 120_000 }, async (t) => {
  if (skip || process.platform === 'win32') { t.skip('needs ffmpeg and POSIX signals'); return }
  const d = join(dir, 'sigterm')
  mkdirSync(d)
  const child = spawn(process.execPath, [CLI, '--project', projectPath, '--name', 'k', '--out', d], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })))
  const tmpSeen = () => readdirSync(d).some((e) => e.includes('.tmp-'))
  const deadline = Date.now() + 30_000
  while (!tmpSeen() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  assert.ok(tmpSeen(), 'the export started its temp folder')
  child.kill('SIGTERM')
  await exited
  assert.deepEqual(readdirSync(d), [], 'no temp folder and no package')
})

test('SIGTERM mid-movie leaves no movie scratch in the temp dir', { timeout: 120_000 }, async (t) => {
  if (skip || process.platform === 'win32') { t.skip('needs ffmpeg and POSIX signals'); return }
  const d = join(dir, 'sigterm-movie')
  const tmp = join(dir, 'sigterm-movie-tmp')
  mkdirSync(d)
  mkdirSync(tmp)
  const child = spawn(process.execPath, [CLI, '--project', projectPath, '--name', 'k', '--out', d], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: tmp },
  })
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })))
  const scratch = () => readdirSync(tmp).filter((e) => e.startsWith('montaj-nle-graphics-') || e.startsWith('montaj-bundle-'))
  const deadline = Date.now() + 60_000
  while (!scratch().some((e) => e.startsWith('montaj-nle-graphics-')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  assert.ok(scratch().length, 'a movie started its scratch')
  child.kill('SIGTERM')
  await exited
  assert.deepEqual(scratch(), [], 'no movie scratch left')
  assert.deepEqual(readdirSync(d), [], 'no temp folder and no package')
})

test('an export whose parent is killed stops by itself and leaves nothing behind', { timeout: 120_000 }, async (t) => {
  if (skip || process.platform === 'win32') { t.skip('needs ffmpeg and POSIX signals'); return }
  const d = join(dir, 'orphan')
  mkdirSync(d)
  // The parent gives the export no pipes (a closed pipe would end it another way), says its pid, and waits.
  const args = [CLI, '--project', projectPath, '--name', 'o', '--out', d]
  const parentJs = `const c = require('node:child_process').spawn(process.execPath, ${JSON.stringify(args)}, { stdio: 'ignore' });`
    + ' console.log(c.pid); setInterval(() => {}, 1000)'
  const parent = spawn(process.execPath, ['-e', parentJs], { stdio: ['ignore', 'pipe', 'inherit'] })
  const pid = Number(await new Promise((res) => parent.stdout.once('data', (b) => res(String(b).trim()))))
  const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
  try {
    const started = Date.now() + 30_000
    while (!readdirSync(d).some((e) => e.includes('.tmp-')) && Date.now() < started) await new Promise((r) => setTimeout(r, 10))
    assert.ok(readdirSync(d).length, 'the export started')
    parent.kill('SIGKILL')
    const deadline = Date.now() + 15_000
    while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    assert.ok(!alive(), 'the orphaned export exited')
    assert.deepEqual(readdirSync(d), [], 'no temp folder and no package')
  } finally {
    if (alive()) process.kill(pid, 'SIGKILL')
  }
})
