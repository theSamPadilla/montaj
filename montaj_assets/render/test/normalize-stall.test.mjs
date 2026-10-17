// montaj_assets/render/test/normalize-stall.test.mjs
//
// normalizeIfNeeded runs `python -m lib.normalize`. Three rules:
//   - items sharing a src share one conform (one spawn per output path);
//   - a conform is killed only when its temporary output stops growing, and the
//     kill takes the whole process group, so its ffmpeg does not survive;
//   - the temporary file a killed conform leaves is removed.
// PYTHON is a stub that spawns a sleeping child, like lib.normalize spawns ffmpeg.
// render.js reads MONTAJ_PYTHON at import, so the env is set first.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORK = mkdtempSync(join(tmpdir(), 'montaj-normalize-stall-'))
after(() => rmSync(WORK, { recursive: true, force: true }))
const STUB = join(WORK, 'python-stub.cjs')

// argv: -m lib.normalize --input SRC --color-space CS --out OUT
// STUB_MODE: 'stall' (writes tmp once, sleeps), 'grow' (grows tmp, then finishes), 'ok'.
writeFileSync(STUB, `#!/usr/bin/env node
const fs = require('fs'), cp = require('child_process')
const a = process.argv.slice(2)
const out = a[a.indexOf('--out') + 1]
fs.appendFileSync(process.env.STUB_LOG, process.pid + '\\n')
const tmp = out + '.tmp.' + process.pid + '.mp4'
const mode = process.env.STUB_MODE
if (mode === 'ok') { fs.writeFileSync(out, 'done'); console.log(out); process.exit(0) }
const child = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' })
fs.appendFileSync(process.env.STUB_LOG, 'child ' + child.pid + '\\n')
fs.writeFileSync(tmp, 'x')
if (mode === 'grow') {
  let n = 0
  const t = setInterval(() => {
    fs.appendFileSync(tmp, 'x'.repeat(100))
    if (++n === 12) { clearInterval(t); child.kill(); fs.renameSync(tmp, out); console.log(out); process.exit(0) }
  }, 50)
} else setTimeout(() => {}, 60000)
`, { mode: 0o755 })

process.env.MONTAJ_PYTHON = STUB
process.env.MONTAJ_NORMALIZE_STALL_MS = '400'
const { normalizeIfNeeded, killNormalizeTree, buildNormalizedOutputPath } = await import('../render.js')

let n = 0
function setup(mode) {
  const dir = join(WORK, `case-${++n}`)
  mkdirSync(dir)
  const src = join(dir, 'clip.mp4')
  writeFileSync(src, 'source')
  const log = join(dir, 'calls.log')
  writeFileSync(log, '')
  Object.assign(process.env, { STUB_MODE: mode, STUB_LOG: log })
  const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean)
  return { dir, src, out: buildNormalizedOutputPath(src, 'sdr_bt709', false, false), lines }
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

test('items sharing a src share one conform', async () => {
  const { src, lines } = setup('ok')
  const r = await Promise.all([1, 2, 3].map(() => normalizeIfNeeded(src, 'sdr_bt709', false)))
  assert.equal(lines().length, 1)
  assert.equal(new Set(r).size, 1)
  assert.notEqual(r[0], src)
})

test('a stalled conform is killed with its child, its tmp file removed, and falls back to src', async () => {
  const { dir, src, lines } = setup('stall')
  const results = await Promise.all([normalizeIfNeeded(src, 'sdr_bt709', false), normalizeIfNeeded(src, 'sdr_bt709', false)])
  assert.deepEqual(results, [src, src])
  assert.equal(lines().filter((l) => !l.startsWith('child')).length, 1, 'one conform for both')
  const child = Number(lines().find((l) => l.startsWith('child')).split(' ')[1])
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(alive(child), false, 'the sleeping child did not survive')
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp.')), [])
  // A later item on the same src falls back at once rather than conforming again.
  assert.equal(await normalizeIfNeeded(src, 'sdr_bt709', false), src)
  assert.equal(lines().filter((l) => !l.startsWith('child')).length, 1)
})

test('a conform that keeps growing outlives the stall window', async () => {
  const { src, out, lines } = setup('grow')
  const r = await normalizeIfNeeded(src, 'sdr_bt709', false)   // ~600 ms of growth > 400 ms stall
  assert.equal(r, out)
  assert.equal(existsSync(out), true)
  assert.equal(lines().filter((l) => !l.startsWith('child')).length, 1)
})

test('a cancel that kills render.js\'s group takes the conform and its child too', async () => {
  const { src, lines } = setup('stall')
  const runner = join(WORK, 'runner.mjs')
  writeFileSync(runner, `const { normalizeIfNeeded } = await import(${JSON.stringify(fileURLToPath(new URL('../render.js', import.meta.url)))})
await normalizeIfNeeded(${JSON.stringify(src)}, 'sdr_bt709', false)`)
  // Its own group, as serve starts render.js; the stall window is long, so only the cancel can end it.
  const host = spawn(process.execPath, [runner], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, MONTAJ_NORMALIZE_STALL_MS: '600000' },
  })
  const until = Date.now() + 10_000
  while (!lines().some((l) => l.startsWith('child')) && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
  const child = Number(lines().find((l) => l.startsWith('child')).split(' ')[1])
  assert.equal(alive(child), true)
  process.kill(-host.pid, 'SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(alive(child), false, 'the conform\'s child did not survive the cancel')
})

test('on win32 the kill is taskkill /T /F /PID, falling back to proc.kill if taskkill fails', () => {
  const calls = []
  const killed = []
  const proc = { pid: 4242, kill: (sig) => killed.push(sig) }
  killNormalizeTree(proc, join(WORK, 'out.mp4'), { platform: 'win32', run: (cmd, args) => { calls.push([cmd, args]); return { status: 0 } } })
  assert.deepEqual(calls, [['taskkill', ['/T', '/F', '/PID', '4242']]])
  assert.deepEqual(killed, [], 'taskkill reached the tree, so no second kill')

  killNormalizeTree(proc, join(WORK, 'out.mp4'), { platform: 'win32', run: () => ({ status: 128 }) })
  assert.deepEqual(killed, ['SIGKILL'])
})
