/**
 * SP4 T3 — the frame server's main-side half: the worker protocol, the frame
 * budget, `batchExpected` reconciliation, and the `VideoFrame` leak contract.
 *
 * The worker port is injected, so none of this needs `Worker`,
 * `URL.createObjectURL` or WebCodecs — jsdom has none of the three. What the
 * fakes cannot prove (that a real decoder returns frames at all) is what T9's
 * operator parity checklist is for; what they CAN prove is every place a
 * `VideoFrame` could leak or a promise could hang, which is where SP1's bugs
 * actually were.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildPresIndex, type ChunkSource, type DemuxedSource, type SampleRef } from '../demux'
import { DEFAULT_DECODE_AHEAD_FRAMES, minBatchFrames } from '../batch-planner'
import {
  createFrameServer,
  type DecodeCmd,
  type DecodeEvt,
  type DecodeWorkerPort,
} from '../frame-server'

interface FakeFrame {
  timestamp: number
  closed: boolean
  close: () => void
}

function frame(timestamp: number): FakeFrame {
  return {
    timestamp,
    closed: false,
    close() {
      this.closed = true
    },
  }
}

/** Hand a fake frame to the server the way the worker would. */
function asVideoFrame(f: FakeFrame): VideoFrame {
  return f as unknown as VideoFrame
}

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

/** All-intra source at 30fps, the shape of an SP3 proxy. */
function proxySource(n = 100, src = '/proxies/clip_proxy.mp4'): DemuxedSource {
  const samples: SampleRef[] = Array.from({ length: n }, (_, i) => ({
    tsUs: i * 33333,
    dtsUs: i * 33333,
    durUs: 33333,
    isKey: true,
    data: new Uint8Array([i & 0xff]),
  }))
  const video: ChunkSource = {
    kind: 'video',
    codec: 'av01.0.05M.08',
    description: undefined,
    fps: 30,
    durationS: n / 30,
    coded: { width: 540, height: 960 },
    samples,
    presIndex: buildPresIndex(samples),
    firstPresentationTsUs: 0,
  }
  return { src, video, audio: null }
}

/** A reordered GOP: decode order I0 P3 B1 B2, so a seek run emits frames after the target too. */
function bFrameSource(): DemuxedSource {
  const mk = (cts: number, dts: number, isKey = false): SampleRef => ({
    tsUs: cts,
    dtsUs: dts,
    durUs: 1000,
    isKey,
    data: new Uint8Array([dts / 1000]),
  })
  const samples = [mk(0, 0, true), mk(3000, 1000), mk(1000, 2000), mk(2000, 3000)]
  const video: ChunkSource = {
    kind: 'video',
    codec: 'hvc1.2.4.L153.B0',
    fps: 1000,
    durationS: 0.004,
    coded: { width: 100, height: 100 },
    samples,
    presIndex: buildPresIndex(samples),
    firstPresentationTsUs: 0,
  }
  return { src: '/proxies/b.mp4', video, audio: null }
}

function decodeRanges(port: FakePort): Extract<DecodeCmd, { t: 'decodeRange' }>[] {
  return port.sent.flatMap((cmd) => (cmd.t === 'decodeRange' ? [cmd] : []))
}

describe('frame server', () => {
  it('decodes only from the single injected proxy source', () => {
    // SP1 requirement 4 (proxy-only playback) is structural here: the server
    // is handed one demuxed source and has no other input, no `fileUrl`, and
    // no fallback branch. What is left to assert is that the bytes it posts
    // really are that source's samples — sliced in decode order, by reference.
    const port = fakePort()
    const source = proxySource(40)
    const server = createFrameServer({ source, spawnWorker: () => port })

    expect(port.sent[0]).toEqual({
      t: 'init',
      codec: 'av01.0.05M.08',
      description: undefined,
      hardwareAcceleration: 'no-preference',
      preRollEpsilonUs: 1,
    })

    server.startStream(0)
    const [range] = decodeRanges(port)
    expect(range.samples).toHaveLength(DEFAULT_DECODE_AHEAD_FRAMES)
    range.samples.forEach((s, i) => {
      // Identity, not equality: the sample bytes are the demuxed table's own
      // buffers, handed over by structured clone (never transferred — a
      // transfer would detach them from `source` and corrupt every later
      // request overlapping the same GOP).
      expect(s.data).toBe(source.video.samples[i].data)
      expect(s.tsUs).toBe(source.video.samples[i].tsUs)
    })
    expect(server.src).toBe('/proxies/clip_proxy.mp4')
    server.dispose()
  })

  it('holds buffered + in-flight frames to the decode-ahead budget', () => {
    const port = fakePort()
    const server = createFrameServer({ source: proxySource(200), spawnWorker: () => port })
    const reqId = server.startStream(0)

    const first = decodeRanges(port)[0]
    expect(first.samples).toHaveLength(30)
    expect(server.stats()).toMatchObject({ buffered: 0, inFlightFrames: 30, inFlightBatches: 1 })

    for (let i = 0; i < 30; i++) port.deliver({ t: 'frame', frame: asVideoFrame(frame(i * 33333)), reqId })
    port.deliver({ t: 'done', reqId, decoded: 30, dropped: 0 })
    // Budget full: the `done` pumped, and the pump found no capacity.
    expect(server.stats()).toMatchObject({ buffered: 30, inFlightFrames: 0, inFlightBatches: 0 })
    expect(decodeRanges(port)).toHaveLength(1)

    // Painting 10 frames frees exactly 10 frames of budget, which clears the
    // batch floor and releases the next request.
    const taken = server.nextFrameFor(9 * 33333)
    expect(taken.frame?.timestamp).toBe(9 * 33333)
    expect(taken.dropped).toBe(9)
    expect(decodeRanges(port)).toHaveLength(2)
    expect(decodeRanges(port)[1].samples).toHaveLength(10)
    expect(minBatchFrames(DEFAULT_DECODE_AHEAD_FRAMES)).toBeLessThanOrEqual(10)
    expect(server.stats().buffered + server.stats().inFlightFrames).toBe(30)

    server.dispose()
  })

  it('reconciles the budget when the worker drops frames as pre-roll', () => {
    const port = fakePort()
    const server = createFrameServer({ source: proxySource(200), spawnWorker: () => port })
    const reqId = server.startStream(0)

    // The batch asked for 30 but 4 were pre-roll and never arrive. Without
    // reconciliation `inFlightFrames` would sit at 4 forever and that much
    // decode-ahead capacity would be gone for the rest of the session.
    for (let i = 4; i < 30; i++) port.deliver({ t: 'frame', frame: asVideoFrame(frame(i * 33333)), reqId })
    port.deliver({ t: 'done', reqId, decoded: 26, dropped: 4 })

    expect(server.stats()).toMatchObject({ buffered: 26, inFlightFrames: 0, inFlightBatches: 0 })
    // 4 frames of budget are free, but that is below the batch floor, so
    // nothing is posted yet — the flush amortization rule still holds.
    expect(decodeRanges(port)).toHaveLength(1)

    // Consume 7 frames (frames 4..10 by presentation time). Budget now: 11
    // free = 7 painted + the 4 the reconciliation recovered. WITHOUT the
    // reconciliation this next batch would be 7 — that difference is the
    // capacity that would have been lost permanently.
    expect(server.nextFrameFor(10 * 33333).frame?.timestamp).toBe(10 * 33333)
    expect(decodeRanges(port)[1].samples).toHaveLength(11)
    server.dispose()
  })

  it('closes frames from a superseded request instead of buffering them', () => {
    const port = fakePort()
    const server = createFrameServer({ source: proxySource(60), spawnWorker: () => port })
    const streamReq = server.startStream(0)
    const buffered = frame(0)
    port.deliver({ t: 'frame', frame: asVideoFrame(buffered), reqId: streamReq })
    expect(server.stats().buffered).toBe(1)

    // A seek supersedes the stream: the frame already buffered for it is
    // closed, and a straggler still in flight for it is closed on arrival.
    server.seek(33333)
    expect(buffered.closed).toBe(true)
    expect(server.stats().buffered).toBe(0)

    const straggler = frame(33333)
    port.deliver({ t: 'frame', frame: asVideoFrame(straggler), reqId: streamReq })
    expect(straggler.closed).toBe(true)
    expect(server.stats().buffered).toBe(0)
    server.dispose()
  })

  it('seek resolves the requested frame and closes every other frame in the run', async () => {
    const port = fakePort()
    const server = createFrameServer({ source: bFrameSource(), spawnWorker: () => port })
    const { reqId, frame: pending } = server.seek(2000)

    const range = decodeRanges(port)[0]
    // The whole GOP up to the target, in decode order.
    expect(range.samples.map((s) => s.tsUs)).toEqual([0, 3000, 1000, 2000])
    expect(range.targetTsUs).toBe(2000)

    // The worker drops 0 and 1000 as pre-roll; 2000 (the target) and 3000 (a
    // frame that precedes the target in DECODE order) both arrive.
    const target = frame(2000)
    const later = frame(3000)
    port.deliver({ t: 'frame', frame: asVideoFrame(target), reqId })
    port.deliver({ t: 'frame', frame: asVideoFrame(later), reqId })
    port.deliver({ t: 'done', reqId, decoded: 2, dropped: 2 })

    // The requested frame, not "whatever arrived last" — on a reordered source
    // those are different frames.
    expect(await pending).toBe(asVideoFrame(target))
    expect(target.closed).toBe(false) // handed to the caller, who closes it after painting
    expect(later.closed).toBe(true)
    server.dispose()
  })

  it('settles every seek, including superseded ones (total done contract)', async () => {
    const port = fakePort()
    const server = createFrameServer({ source: proxySource(60), spawnWorker: () => port })

    const first = server.seek(33333)
    const early = frame(33333)
    port.deliver({ t: 'frame', frame: asVideoFrame(early), reqId: first.reqId })

    // A second seek arrives before the first's `done`. The worker owes a
    // `done` for the superseded request regardless (SP1 §7.4) — and the frame
    // already held for it must not leak.
    const second = server.seek(66666)
    expect(early.closed).toBe(true)

    port.deliver({ t: 'done', reqId: first.reqId, decoded: 1, dropped: 1 })
    expect(await first.frame).toBeNull()

    const wanted = frame(66666)
    port.deliver({ t: 'frame', frame: asVideoFrame(wanted), reqId: second.reqId })
    port.deliver({ t: 'done', reqId: second.reqId, decoded: 1, dropped: 1 })
    expect(await second.frame).toBe(asVideoFrame(wanted))
    server.dispose()
  })

  it('holds the newest due frame and closes the ones it overtook', () => {
    const port = fakePort()
    const server = createFrameServer({ source: proxySource(60), spawnWorker: () => port })
    const reqId = server.startStream(0)
    const frames = [frame(0), frame(33333), frame(66666), frame(99999)]
    for (const f of frames) port.deliver({ t: 'frame', frame: asVideoFrame(f), reqId })

    // Clock sits between frames 2 and 3: frame 2 is due, 0 and 1 became due
    // and were overtaken, 3 is not due yet.
    const { frame: due, dropped } = server.nextFrameFor(70000)
    expect(due?.timestamp).toBe(66666)
    expect(dropped).toBe(2)
    expect(frames.map((f) => f.closed)).toEqual([true, true, false, false])
    expect(server.stats().buffered).toBe(1)

    // Nothing due yet → nothing painted, nothing closed.
    const none = server.nextFrameFor(80000)
    expect(none.frame).toBeNull()
    expect(frames[3].closed).toBe(false)
    server.dispose()
  })

  it('closes everything still held on dispose and terminates the worker', async () => {
    const port = fakePort()
    const server = createFrameServer({ source: proxySource(60), spawnWorker: () => port })
    const reqId = server.startStream(0)
    const held = [frame(0), frame(33333)]
    for (const f of held) port.deliver({ t: 'frame', frame: asVideoFrame(f), reqId })

    server.dispose()
    expect(held.every((f) => f.closed)).toBe(true)
    expect(port.terminated).toBe(true)
    expect(port.onmessage).toBeNull()

    // A frame that raced the teardown is closed rather than leaked, and a
    // disposed server hands nothing further to the worker.
    const sentBefore = port.sent.length
    server.startStream(0)
    expect(port.sent).toHaveLength(sentBefore)
  })

  it('reports decoder errors to the host rather than throwing', () => {
    const onError = vi.fn()
    const port = fakePort()
    const server = createFrameServer({ source: proxySource(60), spawnWorker: () => port, onError })
    server.startStream(0)
    port.deliver({ t: 'error', message: 'decoder: Decoding error' })

    expect(onError).toHaveBeenCalledWith('decoder: Decoding error')
    expect(server.stats().lastError).toBe('decoder: Decoding error')
    server.dispose()
  })
})
