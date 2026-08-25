/**
 * The frame server against a RANGED source: what happens when a decode range's
 * bytes are not resident yet.
 *
 * Four properties, each of which fails loudly if it is wrong:
 *
 *  1. **The resident case stays synchronous.** `ensure` returns `null` when the
 *     bytes are already there, and the post must go out in the same tick — a
 *     seek that hopped a microtask would paint late, and the whole reason
 *     all-intra was kept is that a seek decodes exactly one frame instantly.
 *  2. **Nothing overtakes a batch that is still fetching.** `VideoDecoder`
 *     throws on the first out-of-order chunk and stays dead until the worker is
 *     respawned (SP1 §7.1), so posts are serialized behind a pending fetch.
 *  3. **…but a SUPERSEDED batch is not something to wait for.** A scrub landing
 *     mid-fetch retires the queue and posts immediately; queueing behind the
 *     request it just made pointless would give back the latency this whole
 *     change exists to remove.
 *  4. **A failed or dropped fetch settles, never hangs.** `seek().frame` is
 *     contractually total; a range that will not load — or one abandoned
 *     because the caller asked for somewhere else — has to resolve `null` and
 *     report, not leave the scrubber waiting forever.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildPresIndex, type ChunkSource, type DemuxedSource, type SampleRef } from '../demux'
import { createFrameServer, type DecodeCmd, type DecodeEvt, type DecodeWorkerPort } from '../frame-server'

interface FakePort extends DecodeWorkerPort {
  sent: DecodeCmd[]
  terminated: boolean
  deliver: (evt: DecodeEvt) => void
}

function fakePort(): FakePort {
  const port: FakePort = {
    sent: [],
    terminated: false,
    onmessage: null,
    postMessage(msg) {
      port.sent.push(msg)
    },
    terminate() {
      port.terminated = true
    },
    deliver(evt) {
      port.onmessage?.({ data: evt })
    },
  }
  return port
}

/** Every `decodeRange` posted so far, oldest first. */
function batches(port: FakePort): { startTs: number; count: number; reqId: number }[] {
  return port.sent
    .filter((m): m is Extract<DecodeCmd, { t: 'decodeRange' }> => m.t === 'decodeRange')
    .map((m) => ({ startTs: m.samples[0]?.tsUs ?? -1, count: m.samples.length, reqId: m.reqId }))
}

/**
 * An all-intra ranged source: the index is complete, the bytes arrive through
 * `ensure`. `gate` decides what each call returns — `null` for resident.
 */
function rangedSource(
  gate: (startIdx: number, endIdx: number) => Promise<void> | null,
  n = 120,
): DemuxedSource {
  const samples: SampleRef[] = Array.from({ length: n }, (_, i) => ({
    tsUs: i * 33333,
    dtsUs: i * 33333,
    durUs: 33333,
    isKey: true,
    data: new Uint8Array(0),
    offset: i * 1000,
    size: 1000,
  }))
  const video: ChunkSource = {
    kind: 'video',
    codec: 'avc1.640028',
    description: undefined,
    fps: 30,
    durationS: n / 30,
    coded: { width: 1280, height: 720 },
    samples,
    presIndex: buildPresIndex(samples),
    firstPresentationTsUs: 0,
    ensure: gate,
  }
  return { src: '/proxies/ranged_proxy.mp4', video, audio: null }
}

/** A promise plus its settle handles, for driving a fetch by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve: () => void = () => {}
  let reject: (e: Error) => void = () => {}
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res()
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let every already-settled promise in the post chain run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0))

describe('frame server — ranged source', () => {
  it('posts in the same tick when the range is already resident', () => {
    const ensure = vi.fn(() => null)
    const port = fakePort()
    const server = createFrameServer({ source: rangedSource(ensure), spawnWorker: () => port })

    server.seek(30 * 33333)

    // Synchronously — no await anywhere in this test.
    expect(batches(port)).toHaveLength(1)
    expect(batches(port)[0]).toMatchObject({ startTs: 30 * 33333, count: 1 })
    expect(ensure).toHaveBeenCalledWith(30, 31)
    server.dispose()
  })

  it('holds the post until the bytes land, then sends it', async () => {
    const gate = deferred()
    let calls = 0
    const port = fakePort()
    const server = createFrameServer({
      source: rangedSource(() => (calls++ === 0 ? gate.promise : null)),
      spawnWorker: () => port,
    })

    server.seek(50 * 33333)
    expect(batches(port)).toHaveLength(0)

    gate.resolve()
    await settle()

    expect(batches(port)).toHaveLength(1)
    expect(batches(port)[0].startTs).toBe(50 * 33333)
    server.dispose()
  })

  it('posts nothing further while a range is still fetching, then resumes in order', async () => {
    // `planNextBatches` hands out one batch per pump (the first takes the whole
    // decode-ahead capacity), so this is what "in order" looks like from the
    // outside: while batch A's bytes are in flight nothing else reaches the
    // worker, no matter how many ticks come through. That ordering matters
    // because `VideoDecoder` throws on the first out-of-order chunk and stays
    // dead until the worker is respawned (SP1 §7.1).
    const gate = deferred()
    let calls = 0
    const port = fakePort()
    const server = createFrameServer({
      source: rangedSource(() => (calls++ === 0 ? gate.promise : null)),
      decodeAheadFrames: 8,
      spawnWorker: () => port,
    })

    server.startStream(0)
    server.nextFrameFor(0)
    server.nextFrameFor(33333)
    expect(batches(port)).toHaveLength(0)

    gate.resolve()
    await settle()

    const posted = batches(port)
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ startTs: 0, count: 8 })
    server.dispose()
  })

  it('drops a deferred batch whose request was superseded while fetching', async () => {
    const gate = deferred()
    let calls = 0
    const port = fakePort()
    const server = createFrameServer({
      source: rangedSource(() => (calls++ === 0 ? gate.promise : null)),
      spawnWorker: () => port,
    })

    const first = server.seek(10 * 33333)
    const second = server.seek(80 * 33333)
    gate.resolve()
    await settle()

    // The superseded seek settles with null (that is `claimReqId`'s job) and
    // its batch never reaches the worker — decoding it would only produce
    // frames `onFrameEvt` closes as stale.
    await expect(first.frame).resolves.toBeNull()
    const posted = batches(port)
    expect(posted.every((b) => b.reqId !== first.reqId)).toBe(true)
    expect(posted.some((b) => b.reqId === second.reqId)).toBe(true)
    server.dispose()
  })

  it('settles a seek with null and reports when its bytes cannot be fetched', async () => {
    const gate = deferred()
    const onError = vi.fn()
    const port = fakePort()
    const server = createFrameServer({
      source: rangedSource(() => gate.promise),
      spawnWorker: () => port,
      onError,
    })

    const { frame } = server.seek(60 * 33333)
    gate.reject(new Error('read: /proxies/ranged_proxy.mp4 [0-1048575] → 503 Service Unavailable'))

    await expect(frame).resolves.toBeNull()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('503 Service Unavailable'))
    expect(server.stats().lastError).toMatch(/503 Service Unavailable/)
    expect(batches(port)).toHaveLength(0)
    server.dispose()
  })

  it('does not make a new seek wait behind the fetch it superseded', async () => {
    // The latency trap in a serialized post queue: a scrub lands while the
    // stream's bytes are still in flight, and if the new request queued behind
    // the abandoned one it would paint no sooner than the frame nobody wants.
    // `claimReqId` retires the chain instead, so a resident seek posts in the
    // same tick — exactly as it does with no fetch pending at all.
    const gate = deferred()
    let calls = 0
    const port = fakePort()
    const server = createFrameServer({
      source: rangedSource(() => (calls++ === 0 ? gate.promise : null)),
      decodeAheadFrames: 8,
      spawnWorker: () => port,
    })

    server.startStream(0)
    expect(batches(port)).toHaveLength(0)

    server.seek(90 * 33333)

    // Synchronously, with the stream's fetch still unresolved.
    expect(batches(port)).toHaveLength(1)
    expect(batches(port)[0].startTs).toBe(90 * 33333)

    gate.resolve()
    await settle()

    // And the abandoned batch never shows up late.
    expect(batches(port)).toHaveLength(1)
    server.dispose()
  })

  it('does not post a deferred batch after dispose', async () => {
    const gate = deferred()
    const port = fakePort()
    const server = createFrameServer({
      source: rangedSource(() => gate.promise),
      spawnWorker: () => port,
    })

    server.seek(40 * 33333)
    server.dispose()
    gate.resolve()
    await settle()

    expect(batches(port)).toHaveLength(0)
    expect(port.terminated).toBe(true)
  })
})
