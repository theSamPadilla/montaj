// PL89: several times in one call share one sampling session: one browser, each overlay page bundled and loaded once.
// A contact sheet of eight 3D times went from about 44 s (a browser, a bundle and a scene load per time) to about 8 s.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSampleSession, scenesAlone } from '../sample-frame.js'

const SCRIPT = new URL('../sample-frame.js', import.meta.url).pathname
const tick = () => new Promise((r) => setTimeout(r, 5))

function fakes() {
  const launched = []
  const launch = async (options) => {
    const b = { options, closed: false, close: async () => { b.closed = true } }
    launched.push(b)
    return b
  }
  const opened = []
  const open = (name) => async () => {
    const ctx = { name, pageErrors: [], workDir: mkdtempSync(join(tmpdir(), 'session-bundle-')), page: { closed: false, close: async () => { ctx.page.closed = true } } }
    opened.push(ctx)
    return ctx
  }
  return { launched, launch, opened, open }
}

test('a session launches one browser per kind of launch', async () => {
  const f = fakes()
  const s = createSampleSession()
  const a = await s.browserFor('plain', () => f.launch('plain'))
  assert.equal(await s.browserFor('plain', () => f.launch('plain')), a)
  await s.browserFor('fonts', () => f.launch('fonts'))
  assert.equal(f.launched.length, 2)
  await s.close()
  assert.ok(f.launched.every((b) => b.closed))
})

test('one page per key, opened once; its uses run one at a time, in order, with page errors cleared', async () => {
  const f = fakes()
  const s = createSampleSession()
  const seen = []
  let busy = 0
  const capture = (frame) => async (ctx) => {
    assert.deepEqual(ctx.pageErrors, [], 'errors from an earlier use are cleared')
    busy++
    assert.equal(busy, 1, 'never two uses of one page at once')
    await tick()
    seen.push(frame)
    ctx.pageErrors.push('left over')
    busy--
    return { frame }
  }
  const open = f.open('stage')
  const shots = await Promise.all([1, 2, 3].map((n) => s.sample('k', open, capture(n))))
  assert.deepEqual(shots.map((x) => x.shot.frame), [1, 2, 3])
  assert.deepEqual(seen, [1, 2, 3])
  assert.equal(f.opened.length, 1)
  await s.sample('other', f.open('captions'), capture(4))
  assert.equal(f.opened.length, 2)
  await s.close()
  assert.ok(f.opened.every((c) => c.page.closed))
  assert.ok(f.opened.every((c) => !existsSync(c.workDir)), 'the bundles are removed')
})

test('a page whose capture fails is closed and the next use opens a new one', async () => {
  const f = fakes()
  const s = createSampleSession()
  const open = f.open('stage')
  await assert.rejects(s.sample('k', open, async () => { throw new Error('blank') }), /blank/)
  assert.equal(f.opened[0].page.closed, true)
  const ok = await s.sample('k', open, async () => 'drawn')
  assert.equal(ok.shot, 'drawn')
  assert.equal(f.opened.length, 2)
  await assert.rejects(s.sample('bad', async () => { throw new Error('no bundle') }, async () => 'never'), /no bundle/)
  await s.close()
})

test('scenesAlone: one item from 0 past the last time, inPoint 0, each time a frame on the grid, in time order', () => {
  const { alone, frames, fps, order } = scenesAlone({ settings: { fps: 30 }, scene: 'mount', times: [4, 0.5, 1.26] })
  assert.equal(fps, 30)
  assert.deepEqual(frames, [120, 15, 38])
  assert.deepEqual(order, [1, 2, 0])
  const [item] = alone.tracks[0]
  assert.deepEqual({ src: item.src, start: item.start, end: item.end, props: item.props }, { src: 'engine:scene3d', start: 0, end: 121 / 30, props: { scene: 'mount', inPoint: 0 } })
  assert.deepEqual(scenesAlone({ settings: {}, scene: '', times: [1] }).alone.tracks[0][0].props, { inPoint: 0 })
})

// A real browser: the frames of one call match the same times sampled one by one.
const pj = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'session-'))
  const jsx = join(dir, 'count.jsx')
  writeFileSync(jsx, 'export default function Count() { return <div style={{ position: "absolute", left: frame * 3, top: 40, width: 60, height: 60, background: "#00b4d8" }} /> }\n')
  const file = join(dir, 'project.json')
  writeFileSync(file, JSON.stringify({
    settings: { resolution: [320, 240], fps: 10 },
    tracks: [[{ id: 'o1', type: 'overlay', src: jsx, start: 0, end: 5, props: {} }]],
  }))
  return { dir, file }
})()
const run = (args) => spawnSync('node', [SCRIPT, '--mode', 'frame', '--project', pj.file, ...args], { encoding: 'utf8', env: { ...process.env, TMPDIR: mkdtempSync(join(tmpdir(), 'session-tmp-')) } })
const probe = run(['--at', '0', '--out', join(pj.dir, 'probe.png')])
const canSample = probe.status === 0

test('an overlay sampled at several times in one call matches each time sampled alone', { skip: !canSample && `no browser: ${probe.stderr.slice(-200)}` }, () => {
  const times = ['3', '0.5', '1.2']
  const many = run([...times.flatMap((t) => ['--at', t]), '--frames-dir', join(pj.dir, 'many')])
  assert.equal(many.status, 0, many.stderr)
  const paths = many.stdout.trim().split('\n')
  times.forEach((t, k) => {
    const one = run(['--at', t, '--out', join(pj.dir, `one-${t}.png`)])
    assert.equal(one.status, 0, one.stderr)
    assert.ok(readFileSync(paths[k]).equals(readFileSync(join(pj.dir, `one-${t}.png`))), `at ${t}s`)
  })
})

test('at most maxPages pages stay open: one more closes the least recently used', async () => {
  const f = fakes()
  const s = createSampleSession({ maxPages: 2 })
  const openOf = (k) => f.opened.filter((c) => c.name === k)
  const live = () => f.opened.filter((c) => !c.page.closed).map((c) => c.name)
  const use = (k) => s.sample(k, f.open(k), async () => k)
  await use('a')
  await use('b')
  await use('a')
  await use('c')
  await tick()
  assert.deepEqual(live().sort(), ['a', 'c'], 'b was the least recently used')
  await use('a')
  assert.equal(openOf('a').length, 1, 'a stayed open, so it was never opened again')
  for (const k of ['d', 'e', 'f']) await use(k)
  await tick()
  assert.ok(live().length <= 2, live().join())
  await s.close()
  assert.deepEqual(live(), [])
  assert.ok(f.opened.every((c) => !existsSync(c.workDir)), 'every bundle is removed, evicted ones too')
})

test('a page is closed for room only after its use in flight finishes', async () => {
  const f = fakes()
  const s = createSampleSession({ maxPages: 1 })
  let release
  const slow = s.sample('a', f.open('a'), () => new Promise((r) => { release = r }))
  await tick()
  const next = s.sample('b', f.open('b'), async () => 'b')
  await next
  assert.equal(f.opened[0].page.closed, false, 'a is still capturing')
  release('a')
  assert.equal((await slow).shot, 'a')
  await tick()
  assert.equal(f.opened[0].page.closed, true)
  await s.close()
})
