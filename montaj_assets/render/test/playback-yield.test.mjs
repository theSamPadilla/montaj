// §698 tip 3: while the editor preview plays, a render lets most of its workers rest between chunks, and picks them up when the
// playing stops. It fails open: an unreadable play state is "not playing", and a render always finishes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPlaybackWatcher, createPlaybackThrottle, keptWorkers, isLoopbackUrl, sharedPlaybackWatcher } from '../playback.js'
import http from 'node:http'
import { renderAllSegments } from '../renderer.js'

const GB = 1e9
const memory = { readAvailable: () => 30 * GB, totalBytes: 36 * GB }
const segs = (n) => Array.from({ length: n }, (_, i) => ({
  id: `s${i}`, frameCount: 10, props: {}, outputPath: `/tmp/yield-${i}.webm`,
  boundary: { allows: () => true }, startSeconds: 0, endSeconds: 1, fps: 30,
}))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fakes(ms = 12) {
  const seen = { running: 0, most: 0, done: 0 }
  return {
    seen,
    launchWorker: async () => ({ close: async () => {} }),
    renderJob: async (_w, job) => {
      seen.running++; seen.most = Math.max(seen.most, seen.running)
      await sleep(ms)
      seen.running--; seen.done++
      return { webmPath: job.outputPath }
    },
  }
}

test('keptWorkers: a third of the workers keep rendering while the preview plays, at least one', () => {
  assert.equal(keptWorkers(6), 2)
  assert.equal(keptWorkers(12), 4)
  assert.equal(keptWorkers(2), 1)
  assert.equal(keptWorkers(1), 1)
  assert.equal(keptWorkers(0), 1)
})

test('the throttle: worker 0 never waits; the others wait while it plays and go on when it stops', async () => {
  let playing = true
  const logs = []
  const t = createPlaybackThrottle({ workers: 6, isPlaying: () => playing, pollMs: 2, log: (m) => logs.push(m) })
  assert.equal(await t.wait(0, () => true), false, 'a kept worker is never held')
  assert.equal(await t.wait(1, () => true), false)
  let released = false
  const held = t.wait(5, () => true).then((w) => { released = true; return w })
  await sleep(30)
  assert.equal(released, false, 'worker 5 rests while it plays')
  playing = false
  assert.equal(await held, true, 'and reports that it waited')
  assert.equal(logs.filter((m) => /preview/.test(m)).length, 1, 'one line, not one per poll')
})

test('the throttle lets a worker go when there is nothing left to take', async () => {
  const t = createPlaybackThrottle({ workers: 6, isPlaying: () => true, pollMs: 2 })
  let more = true
  setTimeout(() => { more = false }, 20)
  await t.wait(5, () => more)
  assert.equal(more, false)
})

test('the watcher reads the play state, fails open on every error, and is off without a url', async () => {
  const ok = createPlaybackWatcher({ url: 'http://127.0.0.1:1/api/playback', fetchImpl: async () => ({ ok: true, json: async () => ({ playing: true }) }), intervalMs: 5 })
  await ok.refresh()
  assert.equal(ok.isPlaying(), true)
  for (const bad of [
    async () => { throw new Error('ECONNREFUSED') },
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => { throw new Error('not json') } }),
    async () => ({ ok: true, json: async () => ({ playing: 'yes' }) }),
  ]) {
    const w = createPlaybackWatcher({ url: 'http://127.0.0.1:1/api/playback', fetchImpl: bad, intervalMs: 5 })
    await w.refresh()
    assert.equal(w.isPlaying(), false)
  }
  assert.equal(createPlaybackWatcher({ url: '', fetchImpl: async () => { throw new Error('never') } }).isPlaying(), false)
  // a play state that turns unreadable after playing reads as not playing again
  let fail = false
  const flip = createPlaybackWatcher({ url: 'http://127.0.0.1:1/x', fetchImpl: async () => { if (fail) throw new Error('down'); return { ok: true, json: async () => ({ playing: true }) } }, intervalMs: 5 })
  await flip.refresh(); assert.equal(flip.isPlaying(), true)
  fail = true; await flip.refresh(); assert.equal(flip.isPlaying(), false)
})

test('renderAllSegments: while it plays at most a third of the workers render at once; every chunk still renders', async () => {
  const f = fakes()
  const out = await renderAllSegments(segs(12), {
    workers: 6, chunkSize: 1000, launchWorker: f.launchWorker, renderJob: f.renderJob, memory,
    playback: { isPlaying: () => true, pollMs: 2 },
  })
  assert.equal(out.length, 12)
  assert.equal(f.seen.done, 12, 'a render always finishes, even if the preview plays the whole time')
  assert.equal(f.seen.most, 2, '6 workers, a third kept: 2 at once')
})

test('renderAllSegments: when the preview stops, the rested workers join in', async () => {
  const f = fakes(20)
  let playing = true
  setTimeout(() => { playing = false }, 70)
  await renderAllSegments(segs(30), {
    workers: 6, chunkSize: 1000, launchWorker: f.launchWorker, renderJob: f.renderJob, memory,
    playback: { isPlaying: () => playing, pollMs: 2 },
  })
  assert.equal(f.seen.done, 30)
  assert.ok(f.seen.most > 2, `most at once ${f.seen.most}`)
})

test('renderAllSegments: nothing playing, nothing changes: all workers render at once', async () => {
  const f = fakes()
  await renderAllSegments(segs(12), {
    workers: 6, chunkSize: 1000, launchWorker: f.launchWorker, renderJob: f.renderJob, memory,
    playback: { isPlaying: () => false, pollMs: 2 },
  })
  assert.equal(f.seen.most, 6)
})

test('only serve\'s own loopback is ever polled', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:4123/api/playback'), true)
  assert.equal(isLoopbackUrl('http://localhost:3000/api/playback'), true)
  assert.equal(isLoopbackUrl('http://[::1]:3000/api/playback'), true)
  for (const bad of ['http://example.com/api/playback', 'https://169.254.169.254/x', 'file:///etc/passwd', 'junk', '']) assert.equal(isLoopbackUrl(bad), false, bad)
})

test('the watcher never has two requests in flight', async () => {
  let open = 0, most = 0
  const slow = async () => { open++; most = Math.max(most, open); await sleep(30); open--; return { ok: true, json: async () => ({ playing: true }) } }
  const w = createPlaybackWatcher({ url: 'http://127.0.0.1:1/x', fetchImpl: slow, intervalMs: 5 })
  await Promise.all([w.refresh(), w.refresh(), w.refresh()])
  assert.equal(most, 1)
  assert.equal(w.isPlaying(), true)
})

test('a render that STARTS while the preview plays is throttled from its first chunk (the first answer is awaited): real loopback server', async () => {
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"playing":true}') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/api/playback`
  const prev = process.env.MONTAJ_PLAYBACK_URL
  process.env.MONTAJ_PLAYBACK_URL = url
  try {
    const f = fakes(40)
    const out = await renderAllSegments(segs(12), { workers: 6, chunkSize: 1000, launchWorker: f.launchWorker, renderJob: f.renderJob, memory })
    assert.equal(out.length, 12)
    assert.equal(f.seen.most, 2, 'never the whole pool at once, not even in the first wave')
  } finally {
    if (prev === undefined) delete process.env.MONTAJ_PLAYBACK_URL; else process.env.MONTAJ_PLAYBACK_URL = prev
    sharedPlaybackWatcher('').stop()
    server.close()
  }
})
