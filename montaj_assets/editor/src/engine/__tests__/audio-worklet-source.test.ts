/**
 * SP4 T4 — the ring processor's own rules, tested against the shipped string.
 *
 * The worklet ships as an inlined source string (plan decision 6), so it can
 * neither be imported as a module nor type-checked. It can be *executed*
 * though — `decode-worker-source.test.ts` is the precedent. Its only free
 * identifiers are `AudioWorkletProcessor`, `registerProcessor`, `globalThis`
 * and `currentTime`; the first three are shadowed by `new Function`
 * parameters, and `currentTime` (which the report cadence reads dynamically)
 * is driven through the real global object.
 *
 * Worth executing rather than re-implementing main-side, because the rules
 * that live in this string live ONLY in this string: silence-through-
 * underruns (the clock must advance through starvation or the painter
 * freezes), the pause gate, and the epoch echo that lets main discard reports
 * from a ring it has already reset.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { audioWorkletSource, RING_PROCESSOR_NAME } from '../audio-worklet-source'

const QUANTUM = 128

interface Report {
  t: 'consumed'
  epoch: number
  samplesConsumed: number
  underrunFrames: number
  queuedFrames: number
}

interface RingProcessor {
  process(inputs: unknown[], outputs: Float32Array[][]): boolean
}

interface Harness {
  /** Name the string registered under, or null if the guard suppressed it. */
  registeredAs: string | null
  processor: RingProcessor
  /** Everything the processor posted back to main, in order. */
  reports: Report[]
  /** main → worklet. */
  send(msg: Record<string, unknown>): void
  /** Run one render quantum and return the (fresh, zero-filled) output channels. */
  render(channels?: number): Float32Array[]
}

function setCurrentTime(seconds: number): void {
  ;(globalThis as unknown as { currentTime: number }).currentTime = seconds
}

afterEach(() => {
  delete (globalThis as unknown as { currentTime?: number }).currentTime
})

function harness(processorOptions: Record<string, unknown> = {}, scope: Record<string, unknown> = {}): Harness {
  setCurrentTime(0)
  const reports: Report[] = []
  let onmessage: ((ev: { data: unknown }) => void) | null = null

  const port = {
    set onmessage(fn: ((ev: { data: unknown }) => void) | null) {
      onmessage = fn
    },
    get onmessage() {
      return onmessage
    },
    postMessage(msg: Report) {
      reports.push(msg)
    },
  }

  class FakeAudioWorkletProcessor {
    port = port
  }

  let registered: { name: string; cls: new (opts: unknown) => RingProcessor } | null = null
  const registerProcessor = (name: string, cls: new (opts: unknown) => RingProcessor) => {
    registered = { name, cls }
  }

  const load = new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    'globalThis',
    audioWorkletSource,
  ) as (base: unknown, register: unknown, scope: unknown) => void
  load(FakeAudioWorkletProcessor, registerProcessor, scope)

  const entry = registered as { name: string; cls: new (opts: unknown) => RingProcessor } | null
  if (!entry) {
    return {
      registeredAs: null,
      processor: { process: () => true },
      reports,
      send: () => {},
      render: () => [],
    }
  }

  const processor = new entry.cls({ processorOptions })
  return {
    registeredAs: entry.name,
    processor,
    reports,
    send(msg) {
      onmessage?.({ data: msg })
    },
    render(channels = 2) {
      // The host hands `process` zero-filled output buffers every quantum;
      // "silence" in this processor means "left untouched".
      const out = Array.from({ length: channels }, () => new Float32Array(QUANTUM))
      processor.process([], [out])
      return out
    },
  }
}

/** Interleaved stereo PCM chunk message with `frames` frames of a constant value per channel. */
function chunk(frames: number, left: number, right: number) {
  const pcm = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    pcm[i * 2] = left
    pcm[i * 2 + 1] = right
  }
  return { t: 'chunk', pcm, channels: 2, frames }
}

describe('registration', () => {
  it('registers the processor name audio-clock.ts constructs its node with', () => {
    expect(harness().registeredAs).toBe(RING_PROCESSOR_NAME)
    expect(RING_PROCESSOR_NAME).toBe('montaj-engine-pcm-ring')
  })

  it('does not re-register into a scope that already has it (shared context, second clock)', () => {
    const scope: Record<string, unknown> = {}
    expect(harness({}, scope).registeredAs).toBe(RING_PROCESSOR_NAME)
    // A duplicate registerProcessor throws NotSupportedError and would reject
    // addModule, dropping a healthy engine onto the wall clock.
    expect(harness({}, scope).registeredAs).toBe(null)
  })
})

describe('pause gate', () => {
  it('renders silence and does not advance the clock before play', () => {
    const h = harness()
    h.send(chunk(QUANTUM, 0.5, -0.5))
    const out = h.render()
    expect(Array.from(out[0]).every((v) => v === 0)).toBe(true)
    setCurrentTime(0.2)
    h.render()
    const last = h.reports[h.reports.length - 1]
    expect(last.samplesConsumed).toBe(0)
    // The chunk is still queued — pausing does not throw audio away.
    expect(last.queuedFrames).toBe(QUANTUM)
  })

  it('stops advancing on pause and resumes from exactly where it stopped', () => {
    const h = harness()
    h.send({ t: 'play' })
    h.send(chunk(QUANTUM * 3, 0.25, 0.25))
    h.render()
    h.send({ t: 'pause' })
    const atPause = h.reports[h.reports.length - 1]
    expect(atPause.samplesConsumed).toBe(QUANTUM)
    expect(atPause.queuedFrames).toBe(QUANTUM * 2)

    h.render() // paused: no drain, no advance
    setCurrentTime(0.5)
    h.render()
    expect(h.reports[h.reports.length - 1].samplesConsumed).toBe(QUANTUM)

    h.send({ t: 'play' })
    const out = h.render()
    expect(out[0][0]).toBeCloseTo(0.25, 6)
    setCurrentTime(1)
    h.render()
    expect(h.reports[h.reports.length - 1].samplesConsumed).toBe(QUANTUM * 3)
  })

  it('reports immediately on pause rather than making main wait a full interval', () => {
    const h = harness()
    h.send({ t: 'play' })
    h.render()
    const before = h.reports.length
    h.send({ t: 'pause' })
    expect(h.reports.length).toBe(before + 1)
  })
})

describe('ring drain', () => {
  it('drains interleaved PCM into the output channels in order', () => {
    const h = harness()
    h.send({ t: 'play' })
    h.send(chunk(QUANTUM, 0.5, -0.5))
    const out = h.render()
    expect(out[0][0]).toBeCloseTo(0.5, 6)
    expect(out[1][0]).toBeCloseTo(-0.5, 6)
    expect(out[0][QUANTUM - 1]).toBeCloseTo(0.5, 6)
  })

  it('spans chunk boundaries within one render quantum', () => {
    const h = harness()
    h.send({ t: 'play' })
    h.send(chunk(QUANTUM / 2, 1, 1))
    h.send(chunk(QUANTUM / 2, -1, -1))
    const out = h.render()
    expect(out[0][0]).toBeCloseTo(1, 6)
    expect(out[0][QUANTUM / 2 - 1]).toBeCloseTo(1, 6)
    expect(out[0][QUANTUM / 2]).toBeCloseTo(-1, 6)
    expect(out[0][QUANTUM - 1]).toBeCloseTo(-1, 6)
  })

  it('duplicates the last source channel when a mono clip plays to a stereo output', () => {
    const h = harness()
    h.send({ t: 'play' })
    h.send({ t: 'chunk', pcm: new Float32Array(QUANTUM).fill(0.75), channels: 1, frames: QUANTUM })
    const out = h.render()
    expect(out[0][0]).toBeCloseTo(0.75, 6)
    expect(out[1][0]).toBeCloseTo(0.75, 6)
  })
})

describe('silence through underruns', () => {
  it('renders silence AND keeps the clock advancing when the ring is empty', () => {
    const h = harness()
    h.send({ t: 'play' })
    const out = h.render()
    expect(Array.from(out[0]).every((v) => v === 0)).toBe(true)

    setCurrentTime(0.2)
    h.render()
    const report = h.reports[h.reports.length - 1]
    // The load-bearing half: a starved ring must NOT stall the clock, or the
    // canvas painter that follows it freezes on every slow decode tick.
    expect(report.samplesConsumed).toBe(QUANTUM * 2)
    expect(report.underrunFrames).toBe(QUANTUM * 2)
    expect(report.queuedFrames).toBe(0)
  })

  it('counts only the starved frames, not the rendered ones', () => {
    const h = harness()
    h.send({ t: 'play' })
    h.send(chunk(QUANTUM, 0.5, 0.5))
    h.render() // fully fed
    h.render() // starved
    setCurrentTime(0.2)
    h.render() // starved
    const report = h.reports[h.reports.length - 1]
    expect(report.samplesConsumed).toBe(QUANTUM * 3)
    expect(report.underrunFrames).toBe(QUANTUM * 2)
    // samplesConsumed - underrunFrames is what audio-clock.ts treats as the
    // ring's drained frames; it must equal what was actually enqueued.
    expect(report.samplesConsumed - report.underrunFrames).toBe(QUANTUM)
  })
})

describe('report cadence and epoch', () => {
  it('reports no more often than the injected interval', () => {
    const h = harness({ reportIntervalS: 0.1 })
    h.send({ t: 'play' })
    h.render()
    h.render()
    expect(h.reports.length).toBe(0)
    setCurrentTime(0.1)
    h.render()
    expect(h.reports.length).toBe(1)
    setCurrentTime(0.15)
    h.render()
    expect(h.reports.length).toBe(1)
    setCurrentTime(0.2)
    h.render()
    expect(h.reports.length).toBe(2)
  })

  it('honors an injected interval rather than a duplicated constant', () => {
    const h = harness({ reportIntervalS: 0.5 })
    h.send({ t: 'play' })
    setCurrentTime(0.2)
    h.render()
    expect(h.reports.length).toBe(0)
    setCurrentTime(0.5)
    h.render()
    expect(h.reports.length).toBe(1)
  })

  it('resets the ring, zeroes the counters and adopts the new epoch immediately', () => {
    const h = harness()
    h.send({ t: 'play' })
    h.send(chunk(QUANTUM * 4, 0.5, 0.5))
    h.render()
    setCurrentTime(0.1)
    h.render()
    expect(h.reports[h.reports.length - 1].epoch).toBe(0)

    h.send({ t: 'reset', epoch: 7 })
    const afterReset = h.reports[h.reports.length - 1]
    expect(afterReset.epoch).toBe(7)
    expect(afterReset.samplesConsumed).toBe(0)
    expect(afterReset.underrunFrames).toBe(0)
    // Stale audio for the position we just left is discarded, not played.
    expect(afterReset.queuedFrames).toBe(0)

    const out = h.render()
    expect(Array.from(out[0]).every((v) => v === 0)).toBe(true)
  })

  it('stamps every later report with the new epoch so main can discard stale ones', () => {
    const h = harness()
    h.send({ t: 'play' })
    h.send({ t: 'reset', epoch: 3 })
    setCurrentTime(0.2)
    h.render()
    expect(h.reports.every((r) => r.epoch === 0 || r.epoch === 3)).toBe(true)
    expect(h.reports[h.reports.length - 1].epoch).toBe(3)
  })
})
