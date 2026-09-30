// montaj_assets/render/test/filter-script.test.mjs
//
// WIN1b: externalizeFilterGraph moves a `-filter_complex <graph>` pair into a
// `-/filter_complex <file>` pair, so the graph never counts against Windows'
// 32,767-character command line. The leaf check (a stub ffmpeg reading the
// file) is windows-argv-cap.test.mjs; this file pins the helper's own contract.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { externalizeFilterGraph } from '../filter-script.js'

const WORK = mkdtempSync(join(tmpdir(), 'montaj-filter-script-'))
after(() => rmSync(WORK, { recursive: true, force: true }))
let n = 0
const freshDir = () => mkdtempSync(join(WORK, `d${++n}-`))

const GRAPH = "[0:v]drawtext=text='Canción':fontsize=48[v];[1:a]anull[a]"
const ARGS = ['-y', '-i', 'in.mp4', '-i', 'in.wav', '-filter_complex', GRAPH, '-map', '[v]', '-map', '[a]', 'out.mp4']

test('only the -filter_complex pair changes; every other element keeps its place', () => {
  const dir = freshDir()
  const before = [...ARGS]
  const r = externalizeFilterGraph(ARGS, dir)
  try {
    assert.deepEqual(r.args,
      ['-y', '-i', 'in.mp4', '-i', 'in.wav', '-/filter_complex', r.path, '-map', '[v]', '-map', '[a]', 'out.mp4'])
    assert.deepEqual(ARGS, before, 'the input args were mutated')
    assert.equal(dirname(r.path), dir)
    assert.match(basename(r.path), new RegExp(`^montaj-fc-${process.pid}-[0-9a-f]{12}\\.txt$`))
  } finally { r.cleanup() }
})

test('the file is the graph as UTF-8: no BOM, no trailing newline', () => {
  const r = externalizeFilterGraph(ARGS, freshDir())
  try {
    const bytes = readFileSync(r.path)
    assert.ok(bytes.equals(Buffer.from(GRAPH, 'utf8')), `bytes differ: ${bytes.toString('hex')}`)
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'starts with a BOM')
    assert.notEqual(bytes.at(-1), 0x0a, 'ends with a newline')
    assert.ok(bytes.includes(Buffer.from('Canción', 'utf8')), 'the non-ASCII text is not UTF-8')
  } finally { r.cleanup() }
})

test('no -filter_complex: args unchanged, no file written, cleanup a no-op', () => {
  const dir = freshDir()
  const plain = ['-y', '-i', 'in.mp4', '-vf', 'scale=2:2', 'out.mp4']
  const r = externalizeFilterGraph(plain, dir)
  assert.deepEqual(r.args, plain)
  assert.equal(r.path, null)
  assert.deepEqual(readdirSync(dir), [])
  r.cleanup()
  r.cleanup()
})

test('two -filter_complex pairs throw, and write nothing', () => {
  const dir = freshDir()
  assert.throws(() => externalizeFilterGraph([...ARGS.slice(0, -1), '-filter_complex', 'anull', 'out.mp4'], dir),
    /-filter_complex/)
  assert.deepEqual(readdirSync(dir), [])
})

test('two calls into one dir give two files', () => {
  const dir = freshDir()
  const a = externalizeFilterGraph(ARGS, dir)
  const b = externalizeFilterGraph(ARGS, dir)
  try {
    assert.notEqual(a.path, b.path)
    assert.ok(existsSync(a.path) && existsSync(b.path))
    assert.equal(readdirSync(dir).length, 2)
  } finally { a.cleanup(); b.cleanup() }
  assert.deepEqual(readdirSync(dir), [])
})

test('cleanup is idempotent and does not throw on a missing file', () => {
  const r = externalizeFilterGraph(ARGS, freshDir())
  r.cleanup()
  assert.equal(existsSync(r.path), false)
  r.cleanup()
  const s = externalizeFilterGraph(ARGS, freshDir())
  rmSync(s.path)
  s.cleanup()
})

test('cleanup is best-effort: a script it cannot remove never throws', () => {
  const dir = freshDir()
  const r = externalizeFilterGraph(ARGS, dir)
  try {
    chmodSync(dir, 0o555)
    assert.doesNotThrow(() => r.cleanup())
  } finally { chmodSync(dir, 0o755); r.cleanup() }
})
