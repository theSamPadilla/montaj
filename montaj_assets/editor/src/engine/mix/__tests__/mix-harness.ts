/**
 * §190 T2: test rigs for the mixer's two string modules and MixClock.
 *
 * Both strings are executed, not re-implemented: `new Function` shadows the
 * free identifiers a real AudioWorkletGlobalScope / Worker provides
 * (`AudioWorkletProcessor`, `registerProcessor`, `self`, `fetch`), the way
 * audio-worklet-source.test.ts and decode-worker-source.test.ts do it.
 * `currentTime`, which the processor reads as a global, is driven through
 * `globalThis`.
 *
 * Messages travel through a `Bus`: a FIFO that a test drains explicitly, so
 * the interleaving of the audio thread, the Worker and main is under the
 * test's control. Each message is shallow-cloned on the way (arrays copied,
 * typed arrays and ports passed by reference, as transfer would), because the
 * processor reuses its report object exactly as a structured clone allows.
 */
import { mixProcessorSource, MIX_PROCESSOR_NAME } from '../mix-processor-source'
import { mixWorkerSource } from '../mix-worker-source'

export const QUANTUM = 128

export type Msg = Record<string, unknown> & { t: string }

export class Bus {
  private queue: Array<() => void> = []
  push(fn: () => void): void {
    this.queue.push(fn)
  }
  get size(): number {
    return this.queue.length
  }
  /** Deliver everything queued, including what deliveries enqueue. */
  drain(limit = 1_000_000): number {
    let n = 0
    while (this.queue.length > 0 && n < limit) {
      this.queue.shift()!()
      n++
    }
    return n
  }
}

export function cloneMsg<T>(m: T): T {
  if (!m || typeof m !== 'object') return m
  const o = { ...(m as Record<string, unknown>) }
  for (const k of Object.keys(o)) if (Array.isArray(o[k])) o[k] = (o[k] as unknown[]).slice()
  return o as T
}

export class FakePort {
  other: FakePort | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  closed = false
  sent: Msg[] = []
  constructor(private bus: Bus) {}
  postMessage(msg: unknown): void {
    const data = cloneMsg(msg) as Msg
    this.sent.push(data)
    const to = this.other
    this.bus.push(() => {
      if (to && !to.closed) to.onmessage?.({ data })
    })
  }
  close(): void {
    this.closed = true
  }
}

export function portPair(bus: Bus): [FakePort, FakePort] {
  const a = new FakePort(bus)
  const b = new FakePort(bus)
  a.other = b
  b.other = a
  return [a, b]
}

export function setCurrentTime(seconds: number): void {
  ;(globalThis as unknown as { currentTime: number }).currentTime = seconds
}

export function clearCurrentTime(): void {
  delete (globalThis as unknown as { currentTime?: number }).currentTime
}

export function getCurrentTime(): number {
  return (globalThis as unknown as { currentTime?: number }).currentTime ?? 0
}

export interface Processor {
  process(inputs: unknown[], outputs: Float32Array[][]): boolean
  // Internals the tests read (the string's own fields).
  k: number
  gen: number
  state: number
  anchorTime: number
  rate: number
  segs: Array<Record<string, unknown> & { id: string; kStart: number; kEnd: number; q: unknown[]; qp: unknown[] }>
  underrunFrames: number
  primingFrames: number
  renderedFrames: number
}

export interface ProcessorRig {
  registeredAs: string | null
  proc: Processor
  /** The processor's own port (main side holds `main`). */
  main: FakePort
  /** The Worker's end of the MessageChannel, once `connect` has been sent. */
  worker: FakePort
  bus: Bus
  sampleRate: number
  /** Reports the processor sent to main, in order. */
  reports(): Msg[]
  /** Messages the processor sent to the Worker, in order. */
  toWorker(): Msg[]
  /** main → processor, delivered immediately. */
  send(msg: Msg): void
  /** Worker → processor, delivered immediately. */
  fromWorker(msg: Msg): void
  /** Render `quanta` quanta; returns the concatenated [L, R]. Advances currentTime. */
  render(quanta?: number): [Float32Array, Float32Array]
}

/** Load the processor string and wire a Worker-side port to it. */
export function processorRig(
  processorOptions: Record<string, unknown> = {},
  scope: Record<string, unknown> = {},
): ProcessorRig {
  setCurrentTime(0)
  const bus = new Bus()
  const [mainSide, procSide] = portPair(bus)
  const [workerSide, procWorkerSide] = portPair(bus)

  class FakeAudioWorkletProcessor {
    port = procSide
  }
  let registered: { name: string; cls: new (o: unknown) => Processor } | null = null
  const registerProcessor = (name: string, cls: new (o: unknown) => Processor) => {
    registered = { name, cls }
  }
  const load = new Function('AudioWorkletProcessor', 'registerProcessor', 'globalThis', mixProcessorSource) as (
    a: unknown,
    b: unknown,
    c: unknown,
  ) => void
  load(FakeAudioWorkletProcessor, registerProcessor, scope)
  const entry = registered as { name: string; cls: new (o: unknown) => Processor } | null
  if (!entry) {
    return { registeredAs: null } as unknown as ProcessorRig
  }
  const sampleRate = (processorOptions.sampleRate as number) ?? 48000
  const proc = new entry.cls({ processorOptions: { sampleRate, ...processorOptions } })
  const collected = { reports: [] as Msg[], toWorker: [] as Msg[] }

  const rig: ProcessorRig = {
    registeredAs: entry.name,
    proc,
    main: mainSide,
    worker: workerSide,
    bus,
    sampleRate,
    reports: () => collected.reports,
    toWorker: () => collected.toWorker,
    send(msg) {
      mainSide.postMessage(msg)
      bus.drain()
    },
    fromWorker(msg) {
      workerSide.postMessage(msg)
      bus.drain()
    },
    render(quanta = 1) {
      const L = new Float32Array(quanta * QUANTUM)
      const R = new Float32Array(quanta * QUANTUM)
      for (let q = 0; q < quanta; q++) {
        const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)]
        proc.process([], [out])
        L.set(out[0], q * QUANTUM)
        R.set(out[1], q * QUANTUM)
        setCurrentTime(getCurrentTime() + QUANTUM / sampleRate)
        bus.drain()
      }
      return [L, R]
    },
  }
  mainSide.onmessage = (ev) => collected.reports.push(ev.data as Msg)
  workerSide.onmessage = (ev) => collected.toWorker.push(ev.data as Msg)
  rig.send({ t: 'connect', port: procWorkerSide } as unknown as Msg)
  return rig
}

export { MIX_PROCESSOR_NAME }

// ── The Worker ──────────────────────────────────────────────────────────────

export interface WorkerInternals {
  timeStretch(input: Float32Array, channels: number, factor: number): Float32Array
  createStreamStretch(
    channels: number,
    factor: number,
    exact: boolean,
  ): { push(input: Float32Array): Float32Array; setFactor(f: number): void; reset(): void }
  createResampler(ratio: number): {
    push(c: Float32Array): void
    pull(out: Float32Array, off: number, max: number): number
  }
  createFifo(): { push(c: Float32Array): void; pull(out: Float32Array, off: number, max: number): number }
  convertPcm(buf: ArrayBuffer, format: string, channels: number): Float32Array
  createLru(cap: number): {
    get(key: string): { bytes: number } | undefined
    peek(key: string): { bytes: number } | undefined
    has(key: string): boolean
    set(key: string, v: { bytes: number }): void
    clear(): void
    keys(): string[]
    size(): number
    bytes(): number
    evictions(): number
  }
  normSeg(s: Record<string, unknown>): Record<string, unknown>
  sigOf(s: Record<string, unknown>): string
  state(): {
    gen: number
    anchorTime: number
    rate: number
    clockK: number
    playing: boolean
    planGen: number
    plan: Array<Record<string, unknown>>
    streams: Map<string, Record<string, unknown>>
    cache: { size(): number; bytes(): number; keys(): string[] }
    inflight: Map<string, boolean>
    knownFrames: Map<string, number>
    stats: Record<string, number>
    outRate: number
    aheadS: number
  }
}

export interface FetchLog {
  url: string
  range: string | null
}

export interface FakeFetchOptions {
  /** Ignore Range and answer 200 with the whole file. */
  ignoreRange?: boolean
  /** Fail requests for these urls with HTTP 500. */
  failUrls?: Set<string>
  /** Hold every response until release() is called. */
  hold?: boolean
}

export function fakeFetch(files: Record<string, Uint8Array>, opts: FakeFetchOptions = {}) {
  const log: FetchLog[] = []
  const held: Array<() => void> = []
  const fetchImpl = (url: string, init?: { headers?: Record<string, string> }) => {
    const range = init?.headers?.Range ?? null
    log.push({ url, range })
    const respond = (): Promise<unknown> => {
      const data = files[url]
      if (!data || opts.failUrls?.has(url)) {
        return Promise.resolve({ ok: false, status: data ? 500 : 404, arrayBuffer: async () => new ArrayBuffer(0) })
      }
      if (opts.ignoreRange || !range) {
        const copy = data.slice()
        return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => copy.buffer })
      }
      const m = /bytes=(\d+)-(\d+)/.exec(range)!
      const from = Number(m[1])
      const to = Math.min(Number(m[2]), data.length - 1)
      if (from >= data.length) {
        return Promise.resolve({ ok: false, status: 416, arrayBuffer: async () => new ArrayBuffer(0) })
      }
      const slice = data.slice(from, to + 1)
      return Promise.resolve({ ok: true, status: 206, arrayBuffer: async () => slice.buffer })
    }
    if (opts.hold) return new Promise((resolve) => held.push(() => resolve(respond())))
    return respond()
  }
  return {
    fetch: fetchImpl,
    log,
    release() {
      while (held.length) held.shift()!()
    },
  }
}

export interface WorkerRig {
  internals: WorkerInternals
  /** Messages the Worker sent to main. */
  toMain: Msg[]
  /** The worklet's end of the channel: the Worker's blocks and segments land in `fromWorker`. */
  worklet: FakePort
  fromWorker: Msg[]
  bus: Bus
  /** main → Worker. */
  send(msg: Record<string, unknown>): void
  /** worklet → Worker (transport, clock). */
  fromWorklet(msg: Record<string, unknown>): void
  /** Drain the bus and let fetches and the pump settle. */
  settle(): Promise<void>
}

export function loadWorkerSource(
  fetchImpl: unknown,
  onMain: (m: Msg) => void,
  bus: Bus,
): { self: { onmessage: ((ev: { data: unknown }) => void) | null }; internals: WorkerInternals } {
  let internals: WorkerInternals | null = null
  const self = {
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(m: unknown) {
      const data = cloneMsg(m) as Msg
      bus.push(() => onMain(data))
    },
    __montajMixExpose(x: WorkerInternals) {
      internals = x
    },
  }
  const load = new Function('self', 'fetch', 'performance', mixWorkerSource) as (
    a: unknown,
    b: unknown,
    c: unknown,
  ) => void
  load(self, fetchImpl, performance)
  return { self, internals: internals as unknown as WorkerInternals }
}

export async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

export function workerRig(fetchImpl: unknown, init: Record<string, unknown> = {}): WorkerRig {
  const bus = new Bus()
  const toMain: Msg[] = []
  const { self, internals } = loadWorkerSource(fetchImpl, (m) => toMain.push(m), bus)
  const [worklet, workerPort] = portPair(bus)
  const fromWorker: Msg[] = []
  worklet.onmessage = (ev) => fromWorker.push(ev.data as Msg)
  const rig: WorkerRig = {
    internals,
    toMain,
    worklet,
    fromWorker,
    bus,
    send(msg) {
      bus.push(() => self.onmessage?.({ data: msg }))
    },
    fromWorklet(msg) {
      worklet.postMessage(msg)
    },
    async settle() {
      for (let i = 0; i < 200; i++) {
        const delivered = bus.drain()
        await tick()
        if (delivered === 0 && bus.size === 0) {
          await tick()
          if (bus.size === 0) return
        }
      }
    },
  }
  rig.send({ t: 'init', port: workerPort, sampleRate: 48000, ...init })
  return rig
}

// ── Signals ─────────────────────────────────────────────────────────────────

/** Interleaved stereo int16 bytes of f(t) (same value both channels unless `right` given). */
export function pcmS16(frames: number, sampleRate: number, left: (t: number) => number, right?: (t: number) => number) {
  const out = new Int16Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate
    out[i * 2] = Math.max(-32768, Math.min(32767, Math.round(left(t) * 32767)))
    out[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round((right ?? left)(t) * 32767)))
  }
  return new Uint8Array(out.buffer)
}

/** Interleaved stereo float32 bytes. */
export function pcmF32(frames: number, sampleRate: number, left: (t: number) => number, right?: (t: number) => number) {
  const out = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate
    out[i * 2] = left(t)
    out[i * 2 + 1] = (right ?? left)(t)
  }
  return new Uint8Array(out.buffer)
}

/** Constant-value interleaved stereo block message for the processor. */
export function constBlock(id: string, gen: number, ver: number, k0: number, frames: number, l: number, r = l): Msg {
  const pcm = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    pcm[i * 2] = l
    pcm[i * 2 + 1] = r
  }
  return { t: 'block', gen, id, ver, k0, frames, pcm }
}

export function seg(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    ver: 0,
    tlStart: 0,
    tlEnd: Infinity,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    curveIn: 'linear',
    curveOut: 'linear',
    ...over,
  }
}
