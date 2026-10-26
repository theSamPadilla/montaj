// PL89: several times in one call share one sampling session: one browser, each overlay page bundled and loaded once.
// A contact sheet of eight 3D times went from about 44 s (a browser, a bundle and a scene load per time) to about 8 s.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSampleSession, lanesFor, sampleInSessions, scenesAlone, SHEET_LANES } from '../sample-frame.js'

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
  const front = { name: null }
  const open = (name) => async () => {
    const ctx = { name, pageErrors: [], workDir: mkdtempSync(join(tmpdir(), 'session-bundle-')), page: { closed: false, close: async () => { ctx.page.closed = true }, bringToFront: async () => { front.name = name } } }
    opened.push(ctx)
    return ctx
  }
  return { launched, launch, opened, open, front }
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
  // b's page opens now; its capture waits its turn (captures take turns).
  const next = s.sample('b', f.open('b'), async () => 'b')
  await tick()
  assert.equal(f.opened.length, 2, 'b opened while a captures')
  assert.equal(f.opened[0].page.closed, false, 'a is still capturing')
  release('a')
  assert.equal((await slow).shot, 'a')
  assert.equal((await next).shot, 'b')
  await tick()
  assert.equal(f.opened[0].page.closed, true)
  await s.close()
})

// PL89 round 1 on a real project: a page reused after another page opened in the same browser was not the front tab,
// got no animation frames, and its capture waited out the 300 s protocolTimeout.
test('every use brings its page to the front before it captures', async () => {
  const f = fakes()
  const s = createSampleSession()
  const fronts = []
  const capture = async () => { fronts.push(f.front.name) }
  await s.sample('stage', f.open('stage'), capture)
  await s.sample('specs', f.open('specs'), capture)
  await s.sample('stage', f.open('stage'), capture)
  assert.deepEqual(fronts, ['stage', 'specs', 'stage'])
  await s.close()
})

/** A fake session for sampleInSessions: records which session each frame ran in, and whether it was aborted. */
function sessions() {
  const made = []
  const newSession = () => {
    const s = { id: made.length, aborted: false, closed: false, abort: async () => { s.aborted = true }, close: async () => { s.closed = true } }
    made.push(s)
    return s
  }
  return { made, newSession }
}

test('sampleInSessions: a frame slower than the timeout is sampled alone, its session aborted, the rest in a new one', async () => {
  const z = sessions()
  const ran = []
  const sampleWith = (k, session) => {
    ran.push([k, session ? session.id : null])
    if (k === 1 && session) return new Promise(() => {}) // a capture that never returns
    return Promise.resolve(`f${k}`)
  }
  const out = await sampleInSessions({ count: 4, sampleWith, newSession: z.newSession, frameTimeoutMs: 20 })
  assert.deepEqual(out, ['f0', 'f1', 'f2', 'f3'])
  assert.deepEqual(ran, [[0, 0], [1, 0], [1, null], [2, 1], [3, 1]])
  assert.equal(z.made[0].aborted, true, 'the hung session is aborted, not closed politely')
  assert.equal(z.made[1].closed, true)
})

test('sampleInSessions: a frame that fails in its session is sampled alone; failing alone too is the error, named by time', async () => {
  const z = sessions()
  const out = await sampleInSessions({ count: 2, sampleWith: (k, session) => (k === 0 && session ? Promise.reject(new Error('blank')) : Promise.resolve(`f${k}`)), newSession: z.newSession })
  assert.deepEqual(out, ['f0', 'f1'])
  const y = sessions()
  await assert.rejects(
    sampleInSessions({ count: 2, order: [1, 0], label: (k) => [4, 9][k], sampleWith: (k) => (k === 1 ? Promise.reject(new Error('no bundle')) : Promise.resolve('ok')), newSession: y.newSession }),
    /^Error: at 9s: no bundle$/,
  )
  assert.ok(y.made.every((s) => s.closed || s.aborted), 'every session ends closed')
})

test('sampleInSessions: frames run in the order given and come back by index', async () => {
  const z = sessions()
  const ran = []
  const out = await sampleInSessions({ count: 3, order: [2, 0, 1], sampleWith: async (k) => { ran.push(k); return k * 10 }, newSession: z.newSession })
  assert.deepEqual(ran, [2, 0, 1])
  assert.deepEqual(out, [0, 10, 20])
})

test('abort closes the browsers at once, even while a capture is stuck', async () => {
  const f = fakes()
  const s = createSampleSession()
  const browser = await s.browserFor('plain', () => f.launch('plain'))
  s.sample('stuck', f.open('stuck'), () => new Promise(() => {})).catch(() => {})
  await tick()
  await s.abort()
  assert.equal(browser.closed, true)
})

// Two overlays live at two times: at the second time the first overlay's page is no longer the newest tab.
const two = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'session-two-'))
  const a = join(dir, 'a.jsx')
  const b = join(dir, 'b.jsx')
  writeFileSync(a, 'export default function A() { return <div style={{ position: "absolute", left: frame * 3, top: 20, width: 40, height: 40, background: "#00b4d8" }} /> }\n')
  writeFileSync(b, 'export default function B() { return <div style={{ position: "absolute", left: 10, top: 100 + frame, width: 40, height: 40, background: "#ff5a36" }} /> }\n')
  const file = join(dir, 'project.json')
  writeFileSync(file, JSON.stringify({
    settings: { resolution: [320, 240], fps: 10 },
    tracks: [[{ id: 'o1', type: 'overlay', src: a, start: 0, end: 5, props: {} }], [{ id: 'o2', type: 'overlay', src: b, start: 0, end: 5, props: {} }]],
  }))
  return { dir, file }
})()

test('two overlays at several times: each page is captured in front, quickly, matching each time alone', { skip: !canSample && 'no browser' }, () => {
  const go = (args) => spawnSync('node', [SCRIPT, '--mode', 'frame', '--project', two.file, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, TMPDIR: mkdtempSync(join(tmpdir(), 'session-tmp-')) } })
  const times = ['0.5', '1.5', '2.5']
  const t0 = Date.now()
  const many = go([...times.flatMap((t) => ['--at', t]), '--frames-dir', join(two.dir, 'many')])
  assert.equal(many.status, 0, `took ${Date.now() - t0} ms: ${many.stderr.slice(-300)}`)
  assert.ok(Date.now() - t0 < 30_000, `took ${Date.now() - t0} ms`)
  const paths = many.stdout.trim().split('\n')
  times.forEach((t, k) => {
    const one = go(['--at', t, '--out', join(two.dir, `one-${t}.png`)])
    assert.equal(one.status, 0, one.stderr)
    assert.ok(readFileSync(paths[k]).equals(readFileSync(join(two.dir, `one-${t}.png`))), `at ${t}s`)
  })
})

// One frame's overlays are sampled several at once (OVERLAY_CONCURRENCY), and only one page of a browser is in front.
test('captures in a session never overlap, even of different pages; their pages still open at once', async () => {
  const f = fakes()
  const s = createSampleSession()
  let busy = 0
  const order = []
  const capture = (k) => async () => {
    busy++
    assert.equal(busy, 1, 'one capture at a time in a session')
    assert.equal(f.front.name, k, 'and its own page is the one in front')
    await tick()
    order.push(k)
    busy--
  }
  await Promise.all(['a', 'b', 'c'].map((k) => s.sample(k, f.open(k), capture(k))))
  assert.deepEqual(order.sort(), ['a', 'b', 'c'])
  assert.equal(f.opened.length, 3)
  await s.close()
})

// PL89c: two contact sheets of 17 and 19 times over 12 overlays and a 3D scene took about 130 s each in one session
// (captures take turns, each page in front), past the app's 110 s wait. A sheet's frames now run in up to SHEET_LANES
// lanes, each its own session (its own browser, so its own front page): contiguous runs of the order, side by side.
test('lanesFor: one lane for a few frames, up to SHEET_LANES for a sheet', () => {
  assert.equal(SHEET_LANES, 4)
  assert.equal(lanesFor(1), 1)
  assert.equal(lanesFor(3), 1)
  assert.equal(lanesFor(6), 2)
  assert.equal(lanesFor(12), 4)
  assert.equal(lanesFor(19), 4)
})

test('sampleInSessions: lanes run side by side, each its own session over a contiguous run of the order', async () => {
  const made = []
  const newSession = () => { const s = { id: made.length, closed: false, abort: async () => {}, close: async () => { s.closed = true } }; made.push(s); return s }
  let busy = 0
  let peak = 0
  const seen = []
  const sampleWith = async (k, session) => {
    busy++
    peak = Math.max(peak, busy)
    await tick()
    seen.push([k, session.id])
    busy--
    return `f${k}`
  }
  const order = [7, 6, 5, 4, 3, 2, 1, 0]
  const out = await sampleInSessions({ count: 8, order, sampleWith, newSession, lanes: 4 })
  assert.deepEqual(out, ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'])
  assert.equal(made.length, 4)
  assert.ok(made.every((s) => s.closed))
  assert.equal(peak, 4)
  // each lane takes two neighbours of the order, in that order
  const byLane = made.map((s) => seen.filter(([, id]) => id === s.id).map(([k]) => k))
  assert.deepEqual(byLane, [[7, 6], [5, 4], [3, 2], [1, 0]])
})

test('a sheet over two overlays in four lanes matches each time sampled alone, pixel for pixel', { skip: !canSample && 'no browser' }, () => {
  const go = (args) => spawnSync('node', [SCRIPT, '--mode', 'frame', '--project', two.file, ...args], { encoding: 'utf8', timeout: 90_000, env: { ...process.env, TMPDIR: mkdtempSync(join(tmpdir(), 'session-tmp-')) } })
  const times = ['0.3', '0.8', '1.3', '1.8', '2.3', '2.8', '3.3', '3.8', '4.3']
  const many = go([...times.flatMap((t) => ['--at', t]), '--frames-dir', join(two.dir, 'lanes')])
  assert.equal(many.status, 0, many.stderr.slice(-300))
  assert.match(many.stderr, /in 3 lanes/)
  const paths = many.stdout.trim().split('\n')
  times.forEach((t, k) => {
    const one = go(['--at', t, '--out', join(two.dir, `lane-one-${t}.png`)])
    assert.equal(one.status, 0, one.stderr)
    assert.ok(readFileSync(paths[k]).equals(readFileSync(join(two.dir, `lane-one-${t}.png`))), `at ${t}s`)
  })
})

// PL89c: a sheet's frames composite at the design canvas (--max-short-edge), a single sample at the project's own size,
// and the cache never serves one for the other.
test('--max-short-edge caps the frames of a 4K project, and the cache keeps the two sizes apart', { skip: !canSample && 'no browser' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-4k-'))
  const file = join(dir, 'project.json')
  const jsx = join(dir, 'box.jsx')
  writeFileSync(jsx, 'export default function B() { return <div style={{ position: "absolute", left: 100 + frame, top: 200, width: 300, height: 120, background: "#00b4d8" }} /> }\n')
  writeFileSync(file, JSON.stringify({ settings: { resolution: [2160, 3840], fps: 10 }, tracks: [[{ id: 'o1', type: 'overlay', src: jsx, start: 0, end: 5, props: {} }]] }))
  const tmp = mkdtempSync(join(tmpdir(), 'session-tmp-'))
  const go = (args) => spawnSync('node', [SCRIPT, '--mode', 'frame', '--project', file, ...args], { encoding: 'utf8', timeout: 90_000, env: { ...process.env, TMPDIR: tmp } })
  const size = (p) => { const b = readFileSync(p); return [b.readUInt32BE(16), b.readUInt32BE(20)] }
  const small = go(['--at', '0.5', '--at', '1.5', '--frames-dir', join(dir, 'small'), '--max-short-edge', '1080'])
  assert.equal(small.status, 0, small.stderr.slice(-300))
  for (const p of small.stdout.trim().split('\n')) assert.deepEqual(size(p), [1080, 1920])
  const full = go(['--at', '0.5', '--out', join(dir, 'full.png')])
  assert.equal(full.status, 0, full.stderr.slice(-300))
  assert.deepEqual(size(join(dir, 'full.png')), [2160, 3840], 'the same time, after a capped one, is full size')
})
