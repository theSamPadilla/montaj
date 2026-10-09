// montaj_assets/render/test/audio-strip-atomic.test.mjs
//
// stripExtraAudioStreams writes `<src>_audioclean.mp4`, a cache that later
// renders and sample_frame reuse on mtime alone. ffmpeg writes it under a
// temporary name beside it, renamed onto the cache path only when ffmpeg exits
// 0 (lib/normalize._run_atomic_encode's rule), so a failed or killed copy never
// sits under the cache name.
//
// ffmpeg and ffprobe are stubs, windows-argv-cap.test.mjs's pattern: the stub
// is the process the OS spawned, so what it sees is what ffmpeg would see.
// ffprobe reports two audio streams; ffmpeg writes STUB_BYTES to its output,
// logs its argv and whether the cache path exists, and exits STUB_EXIT.
// ffmpeg-bin.js reads MONTAJ_FFMPEG once, at import, so the env is set first
// and render.js is imported dynamically after it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const WORK = mkdtempSync(join(tmpdir(), 'montaj-audio-strip-'))
after(() => rmSync(WORK, { recursive: true, force: true }))
const STUB = join(WORK, 'ffmpeg-stub.cjs')
const PROBE_STUB = join(WORK, 'ffprobe-stub.cjs')

writeFileSync(STUB, `#!/usr/bin/env node
const fs = require('fs')
const argv = process.argv.slice(2)
if (argv.includes('-version') || argv.includes('-filters')) process.exit(0)
const out = argv[argv.length - 1]
fs.writeFileSync(out, process.env.STUB_BYTES || '')
const cacheSeen = fs.existsSync(process.env.STUB_CACHE)
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv, cacheSeen }) + '\\n')
process.exit(Number(process.env.STUB_EXIT || 0))
`, { mode: 0o755 })
// `-select_streams a -show_entries stream=index -of csv=p=0`: two audio streams.
writeFileSync(PROBE_STUB, `#!/usr/bin/env node
process.stdout.write('1\\n2\\n')
`, { mode: 0o755 })

process.env.MONTAJ_FFMPEG = STUB
process.env.MONTAJ_FFPROBE = PROBE_STUB
const { stripExtraAudioStreams } = await import('../render.js')

let n = 0
/** A source in its own folder, and the env the stub reads for it. */
function setup({ exit, bytes }) {
  const dir = join(WORK, `case-${++n}`)
  mkdirSync(dir)
  const src = join(dir, 'clip.mov')
  writeFileSync(src, 'source')
  const cache = join(dir, 'clip_audioclean.mp4')
  const log = join(dir, 'calls.jsonl')
  Object.assign(process.env, { STUB_EXIT: String(exit), STUB_BYTES: bytes, STUB_CACHE: cache, STUB_LOG: log })
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { dir, src, cache, calls }
}

test('ffmpeg writes a temporary file beside the cache; the cache appears only after it exits 0', async () => {
  const { dir, src, cache, calls } = setup({ exit: 0, bytes: 'copied' })
  assert.equal(await stripExtraAudioStreams(src), cache)
  const [call] = calls()
  const out = call.argv.at(-1)
  assert.notEqual(out, cache, 'ffmpeg wrote the cache path itself')
  assert.equal(dirname(out), dir, 'the temporary file is beside the cache, so the rename is atomic')
  assert.match(out, /\.mp4$/, 'ffmpeg picks the mp4 muxer from the extension')
  assert.equal(call.cacheSeen, false, 'the cache path existed while ffmpeg was still running')
  assert.equal(readFileSync(cache, 'utf8'), 'copied')
  assert.deepEqual(readdirSync(dir).sort(), ['calls.jsonl', 'clip.mov', 'clip_audioclean.mp4'])
})

test('a failed copy leaves no cache and no temporary file, and the source is used', async () => {
  const { dir, src, cache } = setup({ exit: 1, bytes: 'half a fil' })
  assert.equal(await stripExtraAudioStreams(src), src)
  assert.equal(existsSync(cache), false)
  assert.deepEqual(readdirSync(dir).sort(), ['calls.jsonl', 'clip.mov'])
})

test('a failed copy leaves an older cache as it was', async () => {
  const { dir, src, cache } = setup({ exit: 1, bytes: 'half a fil' })
  writeFileSync(cache, 'older copy')
  const past = new Date(Date.now() - 60_000)
  utimesSync(cache, past, past)    // older than the source, so it is copied again
  assert.equal(await stripExtraAudioStreams(src), src)
  assert.equal(readFileSync(cache, 'utf8'), 'older copy')
  assert.deepEqual(readdirSync(dir).sort(), ['calls.jsonl', 'clip.mov', 'clip_audioclean.mp4'])
})

test('two copies of one source at once write two temporary files', async () => {
  // prepareVideoItems strips two items at a time, and a clip cut into several
  // items gives them one src: both copies run in this process, one pid.
  const { dir, src, cache, calls } = setup({ exit: 0, bytes: 'copied' })
  assert.deepEqual(await Promise.all([stripExtraAudioStreams(src), stripExtraAudioStreams(src)]), [cache, cache])
  const outs = calls().map((c) => c.argv.at(-1))
  assert.equal(outs.length, 2)
  assert.notEqual(outs[0], outs[1], 'both copies wrote the same file')
  assert.equal(readFileSync(cache, 'utf8'), 'copied')
  assert.deepEqual(readdirSync(dir).sort(), ['calls.jsonl', 'clip.mov', 'clip_audioclean.mp4'])
})
