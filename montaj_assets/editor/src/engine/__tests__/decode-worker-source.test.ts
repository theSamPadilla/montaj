/**
 * SP4 T3 — the decode worker's own two requirements, tested against the
 * shipped string.
 *
 * The worker ships as an inlined source string (plan decision 6), so it can
 * neither be imported as a module nor type-checked. It can, however, be
 * *executed*: the string is plain JS whose only free identifiers are `self`,
 * `VideoDecoder` and `EncodedVideoChunk`, so `new Function('self',
 * 'VideoDecoder', 'EncodedVideoChunk', decodeWorkerSource)` runs it with all
 * three shadowed by fakes. That is worth doing rather than testing a
 * main-side re-implementation, because both requirements here are about what
 * the *worker* does with frames it has been handed: closing them, and owing a
 * `done` no matter what.
 *
 * The fakes model the two WebCodecs behaviors the requirements depend on:
 *   - `EncodedVideoChunk.timestamp` is a `long long`, so a float sample time
 *     is TRUNCATED at construction (SP1 §7.2's root cause);
 *   - a decoder emits nothing until `flush()` settles, and emission lands on a
 *     later microtask — which is exactly the window in which a newer request
 *     supersedes an older one.
 */
import { describe, it, expect } from 'vitest'
import { decodeWorkerSource } from '../decode-worker-source'
import { PRE_ROLL_EPSILON_US, shouldEmitFrame } from '../batch-planner'
import type { DecodeCmd, WorkerSample } from '../frame-server'

interface FakeFrame {
  timestamp: number
  closed: boolean
  close: () => void
}

type Posted =
  | { t: 'frame'; frame: FakeFrame; reqId: number }
  | { t: 'done'; reqId: number; decoded: number; dropped: number }
  | { t: 'error'; message: string; reqId?: number }

interface Harness {
  send: (cmd: DecodeCmd) => void
  posted: Posted[]
  /** Every frame the fake decoder ever emitted, in emission order. */
  frames: FakeFrame[]
  /** Chunk timestamps in the order they were handed to `decode()`. */
  fed: number[]
}

/** Let every pending microtask (and therefore every `flush()`) settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function harness(opts: { decodeThrows?: boolean } = {}): Harness {
  const posted: Posted[] = []
  const frames: FakeFrame[] = []
  const fed: number[] = []
  let emit: (frame: FakeFrame) => void = () => {}
  let queued: { timestamp: number }[] = []

  class FakeEncodedVideoChunk {
    type: string
    timestamp: number
    duration: number
    data: Uint8Array
    constructor(init: { type: string; timestamp: number; duration: number; data: Uint8Array }) {
      this.type = init.type
      // WebIDL `long long`: the float sample time loses its fraction here.
      this.timestamp = Math.trunc(init.timestamp)
      this.duration = Math.trunc(init.duration)
      this.data = init.data
    }
  }

  class FakeVideoDecoder {
    constructor(init: { output: (frame: FakeFrame) => void; error: (e: Error) => void }) {
      emit = init.output
    }
    configure(): void {}
    decode(chunk: { timestamp: number }): void {
      if (opts.decodeThrows) throw new Error('boom')
      fed.push(chunk.timestamp)
      queued.push(chunk)
    }
    flush(): Promise<void> {
      return Promise.resolve().then(() => {
        const batch = queued
        queued = []
        // Real decoders emit in PRESENTATION order regardless of feed order.
        batch.sort((a, b) => a.timestamp - b.timestamp)
        for (const chunk of batch) {
          const frame: FakeFrame = {
            timestamp: chunk.timestamp,
            closed: false,
            close() {
              this.closed = true
            },
          }
          frames.push(frame)
          emit(frame)
        }
      })
    }
  }

  const scope = {
    onmessage: null as ((ev: { data: DecodeCmd }) => void) | null,
    postMessage(msg: Posted): void {
      posted.push(msg)
    },
  }

  const factory = new Function('self', 'VideoDecoder', 'EncodedVideoChunk', decodeWorkerSource)
  factory(scope, FakeVideoDecoder, FakeEncodedVideoChunk)

  return {
    posted,
    frames,
    fed,
    send: (cmd) => scope.onmessage?.({ data: cmd }),
  }
}

function init(preRollEpsilonUs = PRE_ROLL_EPSILON_US): DecodeCmd {
  return { t: 'init', codec: 'av01.0.05M.08', hardwareAcceleration: 'no-preference', preRollEpsilonUs }
}

/** Samples at a real 29.97fps cadence, so the timestamps are the awkward floats §7.2 is about. */
function sample(index: number, isKey = index === 0): WorkerSample {
  return { tsUs: index * 33333.333, durUs: 33333.333, isKey, data: new Uint8Array([index]) }
}

function dones(posted: Posted[], reqId: number): Posted[] {
  return posted.filter((m) => m.t === 'done' && m.reqId === reqId)
}

function framesFor(posted: Posted[], reqId: number): number[] {
  return posted.flatMap((m) => (m.t === 'frame' && m.reqId === reqId ? [m.frame.timestamp] : []))
}

describe('decode worker source', () => {
  it('preroll-epsilon', async () => {
    // Requested: the frame at cts 33333.333 (sample 1). Decoding starts at the
    // keyframe, so sample 0 is genuine pre-roll and must be closed.
    const target = 33333.333
    const w = harness()
    w.send(init())
    w.send({ t: 'decodeRange', samples: [sample(0), sample(1), sample(2)], targetTsUs: target, reqId: 0 })
    await settle()

    // The chunk fed at 33333.333 comes back stamped 33333 — an INTEGER, one
    // notch BELOW the target it was asked for.
    expect(w.frames.map((f) => f.timestamp)).toEqual([0, 33333, 66666])
    // With the 1µs epsilon it survives, along with everything after it.
    expect(framesFor(w.posted, 0)).toEqual([33333, 66666])
    // Pre-roll is closed, never transferred, and counted as dropped.
    expect(w.frames[0].closed).toBe(true)
    expect(w.frames.filter((f) => !f.closed).map((f) => f.timestamp)).toEqual([33333, 66666])
    expect(dones(w.posted, 0)).toEqual([{ t: 'done', reqId: 0, decoded: 2, dropped: 1 }])

    // The same predicate, main-side, so both sides of the string boundary
    // agree on the boundary condition.
    expect(shouldEmitFrame(33333, target)).toBe(true)
    expect(shouldEmitFrame(16666, target)).toBe(false)

    // And the regression this guards: without the epsilon (the state SP1
    // measured), the requested frame is itself rejected as pre-roll — ~2 of 3
    // seeks silently painted nothing, and those seeks were quietly excluded
    // from the latency distribution rather than failing loudly (§7.2).
    const broken = harness()
    broken.send(init(0))
    broken.send({ t: 'decodeRange', samples: [sample(0), sample(1), sample(2)], targetTsUs: target, reqId: 0 })
    await settle()
    expect(framesFor(broken.posted, 0)).toEqual([66666])
    expect(broken.frames[1].closed).toBe(true)
  })

  it('stale frames closed, done always posted', async () => {
    const w = harness()
    w.send(init())

    // req 0 is fed and awaiting flush; its frames have not been emitted yet.
    w.send({ t: 'decodeRange', samples: [sample(0), sample(1)], targetTsUs: 0, reqId: 0 })
    // Two more arrive before any of that lands: 1 is superseded while still
    // queued, 2 is the one that should actually run.
    w.send({ t: 'decodeRange', samples: [sample(2), sample(3)], targetTsUs: 66666.666, reqId: 1 })
    w.send({ t: 'decodeRange', samples: [sample(4), sample(5)], targetTsUs: 133333.332, reqId: 2 })
    await settle()

    // req 0: superseded mid-flush. Its frames were produced, so they must be
    // CLOSED — never transferred, never leaked.
    expect(framesFor(w.posted, 0)).toEqual([])
    expect(w.frames.slice(0, 2).every((f) => f.closed)).toBe(true)
    // req 1: superseded before reaching the decoder, so nothing was decoded
    // for it at all.
    expect(framesFor(w.posted, 1)).toEqual([])
    expect(w.fed).toEqual([0, 33333, 133333, 166666])
    // req 2: the live one, served normally.
    expect(framesFor(w.posted, 2)).toEqual([133333, 166666])

    // The total `done` contract: EVERY request gets exactly one, whatever
    // happened to it. SP1 §7.4 is what the alternative costs — an orphaned
    // pending entry and a seek promise that never settles.
    expect(dones(w.posted, 0)).toHaveLength(1)
    expect(dones(w.posted, 1)).toEqual([{ t: 'done', reqId: 1, decoded: 0, dropped: 0 }])
    expect(dones(w.posted, 2)).toHaveLength(1)
    // No `reset()` was needed to achieve any of that — supersession is purely
    // a bookkeeping question, and `reset()` would leave the decoder
    // unconfigured so the next `decode()` throws InvalidStateError.
    expect(decodeWorkerSource).not.toContain('reset()')
  })

  it('still posts done when the decoder throws', async () => {
    const w = harness({ decodeThrows: true })
    w.send(init())
    w.send({ t: 'decodeRange', samples: [sample(0)], targetTsUs: 0, reqId: 0 })
    await settle()

    expect(w.posted.filter((m) => m.t === 'error')).toHaveLength(1)
    expect(dones(w.posted, 0)).toEqual([{ t: 'done', reqId: 0, decoded: 0, dropped: 0 }])
  })

  it('still posts done when decodeRange arrives before init', async () => {
    const w = harness()
    w.send({ t: 'decodeRange', samples: [sample(0)], targetTsUs: 0, reqId: 7 })
    await settle()

    expect(w.posted.filter((m) => m.t === 'error')).toHaveLength(1)
    expect(dones(w.posted, 7)).toHaveLength(1)
  })

  it('feeds chunks to the decoder in the exact order handed over, never sorted', async () => {
    // A reordered GOP as the planner slices it: decode order I0 P3 B1 B2, cts
    // zig-zagging. The worker must not "helpfully" sort — that is SP1 §7.1,
    // which killed the decoder outright on the first non-intra frame.
    const gop: WorkerSample[] = [
      { tsUs: 0, durUs: 1000, isKey: true, data: new Uint8Array([0]) },
      { tsUs: 3000, durUs: 1000, isKey: false, data: new Uint8Array([1]) },
      { tsUs: 1000, durUs: 1000, isKey: false, data: new Uint8Array([2]) },
      { tsUs: 2000, durUs: 1000, isKey: false, data: new Uint8Array([3]) },
    ]
    const w = harness()
    w.send(init())
    w.send({ t: 'decodeRange', samples: gop, targetTsUs: 0, reqId: 0 })
    await settle()

    expect(w.fed).toEqual([0, 3000, 1000, 2000])
    // …while the frames come back in presentation order, as a real decoder emits them.
    expect(framesFor(w.posted, 0)).toEqual([0, 1000, 2000, 3000])
  })
})
