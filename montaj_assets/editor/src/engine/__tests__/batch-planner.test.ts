/**
 * SP4 T3 — the decode planner, which is where three of SP1's five engine
 * requirements are actually decided. The three tests named by the plan
 * (`decode-order-feed`, `pipelined-batches`, `min-cts-target`) are `it()`
 * blocks with exactly those names; the other two (`preroll-epsilon`, and
 * supersession's `stale frames closed, done always posted`) live in
 * `decode-worker-source.test.ts`, where they can be run against the shipped
 * worker string itself.
 *
 * Every table here carries a B-frame pattern for the same reason T2's tests
 * do: on an all-intra table (which is what SP3's proxies are) decode order ==
 * presentation order, so a correct planner and the broken one that sorts by
 * cts — or targets `batch[0].tsUs` — produce identical answers. That is
 * precisely how both bugs survived to SP1's measurement stage
 * (`spikes/playback-engine/RESULTS.md` §6.1, §7.1).
 */
import { describe, it, expect } from 'vitest'
import { buildPresIndex, type SampleRef, type SampleTable } from '../demux'
import {
  DEFAULT_DECODE_AHEAD_FRAMES,
  MAX_IN_FLIGHT_BATCHES,
  minBatchFrames,
  minCtsUs,
  onFrameBuffered,
  onFramesConsumed,
  planNextBatches,
  planSeek,
  planStreamStart,
  reconcileOnBatchDone,
  type PipelineConfig,
  type PipelineState,
} from '../batch-planner'

/** One synthetic sample. Times in µs; 1000µs "frames" keep the tables readable. */
function s(cts: number, dts: number, isKey = false): SampleRef {
  return { tsUs: cts, dtsUs: dts, durUs: 1000, isKey, data: new Uint8Array(0) }
}

function table(samples: SampleRef[]): SampleTable {
  return { samples, presIndex: buildPresIndex(samples) }
}

/**
 * Reordered GOP, decode order: I0 P3 B1 B2 P6 B4 B5 I7 (cts in the comments).
 * The same fixture shape `demux.test.ts` uses, so both layers are exercised
 * against one reordering pattern.
 */
function bFrameGop(): SampleRef[] {
  return [
    s(0, 0, true), //  0: I0
    s(3000, 1000), //  1: P3
    s(1000, 2000), //  2: B1
    s(2000, 3000), //  3: B2
    s(6000, 4000), //  4: P6
    s(4000, 5000), //  5: B4
    s(5000, 6000), //  6: B5
    s(7000, 7000, true), // 7: I7
  ]
}

/** A long all-intra table — the shape of a real SP3 proxy, for the pipeline simulations. */
function allIntra(n: number): SampleRef[] {
  return Array.from({ length: n }, (_, i) => s(i * 33333.333, i * 33333.333, true))
}

const SHIPPED: PipelineConfig = {
  decodeAheadFrames: DEFAULT_DECODE_AHEAD_FRAMES,
  maxInFlightBatches: MAX_IN_FLIGHT_BATCHES,
}

/**
 * SP1's PRE-fix planner, rebuilt out of the shipped one's config: exactly one
 * request in flight, and each batch sized to the current shortfall with no
 * floor. Nothing else differs, so what the `pipelined-batches` test observes
 * is the scheduling rule and not a different implementation.
 */
const DEGENERATE: PipelineConfig = {
  decodeAheadFrames: DEFAULT_DECODE_AHEAD_FRAMES,
  maxInFlightBatches: 1,
  minBatchFrames: 1,
}

interface SimOptions {
  ticks: number
  /** Frames the painter consumes per tick. */
  paintPerTick: number
  /** Ticks between a batch being posted and the worker delivering it (decode + flush + round trip). */
  latency: number
}

interface SimResult {
  batchSizes: number[]
  maxInFlightBatches: number
  /** Peak `buffered + inFlightFrames` — the budget N is supposed to cap. */
  maxAlive: number
  painted: number
}

/**
 * Drive the planner the way the real tick does — pump, paint, then absorb
 * whatever the worker delivered — using the planner's own transition
 * functions, so the simulation cannot drift from the shipped bookkeeping.
 */
function simulate(src: SampleTable, config: PipelineConfig, opts: SimOptions): SimResult {
  let state: PipelineState = planStreamStart(src, 0)
  const inFlight: { expected: number; landsAt: number }[] = []
  const batchSizes: number[] = []
  let maxInFlightBatches = 0
  let maxAlive = 0
  let painted = 0

  for (let t = 0; t < opts.ticks; t++) {
    const planned = planNextBatches(src, state, config)
    state = planned.state
    for (const batch of planned.batches) {
      batchSizes.push(batch.count)
      inFlight.push({ expected: batch.count, landsAt: t + opts.latency })
    }
    maxInFlightBatches = Math.max(maxInFlightBatches, state.inFlightBatches)
    maxAlive = Math.max(maxAlive, state.buffered + state.inFlightFrames)

    for (let p = 0; p < opts.paintPerTick && state.buffered > 0; p++) {
      state = onFramesConsumed(state, 1)
      painted++
    }

    while (inFlight.length > 0 && inFlight[0].landsAt <= t) {
      const batch = inFlight.shift()!
      for (let k = 0; k < batch.expected; k++) state = onFrameBuffered(state)
      state = reconcileOnBatchDone(state, batch.expected, batch.expected)
      maxAlive = Math.max(maxAlive, state.buffered + state.inFlightFrames)
    }
  }

  return { batchSizes, maxInFlightBatches, maxAlive, painted }
}

describe('batch planner — SP1 engine requirements', () => {
  it('decode-order-feed', () => {
    const src = table(bFrameGop())

    // A seek slices DECODE indices: enclosing keyframe → the sample displayed
    // at the target, found by bisecting presIndex (T2), not by scanning cts.
    const seek = planSeek(src, 2000)!
    expect(seek.startIdx).toBe(0) // I0, walking back through decode order
    expect(seek.endIdx).toBe(4) // B2 (cts 2000) sits at decode index 3
    expect(seek.targetTsUs).toBe(2000)

    const fed = src.samples.slice(seek.startIdx, seek.endIdx)
    // What actually goes to VideoDecoder: strictly ascending DTS…
    expect(fed.map((x) => x.dtsUs)).toEqual([0, 1000, 2000, 3000])
    // …and a cts sequence that is NOT ascending. If this were ever sorted into
    // presentation order the decoder would throw on the first non-intra frame
    // and stay dead until respawned (SP1 §7.1).
    expect(fed.map((x) => x.tsUs)).toEqual([0, 3000, 1000, 2000])
    expect(fed[0].isKey).toBe(true)

    // Streaming batches tile `samples` contiguously in decode order: no gaps,
    // no overlaps, no reordering, every sample requested exactly once.
    const src2 = table(allIntra(97))
    let state = planStreamStart(src2, 0)
    const covered: number[] = []
    for (let round = 0; round < 200 && state.nextSampleIdx < src2.samples.length; round++) {
      const planned = planNextBatches(src2, state, SHIPPED)
      for (const batch of planned.batches) {
        for (let i = batch.startIdx; i < batch.endIdx; i++) covered.push(i)
      }
      // Pretend every requested frame arrived and was painted, so the next
      // round has budget again.
      state = { ...planned.state, buffered: 0, inFlightFrames: 0, inFlightBatches: 0 }
    }
    expect(covered).toEqual(Array.from({ length: 97 }, (_, i) => i))
  })

  it('min-cts-target', () => {
    const src = table(bFrameGop())

    // Mid-stream batch (no session pre-roll left): decode indices 1..4 —
    // P3(3000) B1(1000) B2(2000) P6(6000).
    const midStream: PipelineState = {
      nextSampleIdx: 1,
      buffered: 0,
      inFlightFrames: 0,
      inFlightBatches: 0,
      firstBatchTargetTsUs: 0,
    }
    const { batches } = planNextBatches(src, midStream, {
      decodeAheadFrames: 4,
      maxInFlightBatches: 1,
    })
    expect(batches).toHaveLength(1)
    const batch = batches[0]
    expect([batch.startIdx, batch.endIdx]).toEqual([1, 5])

    // The requirement: the target is the MINIMUM cts in the batch.
    expect(batch.targetTsUs).toBe(1000)
    expect(minCtsUs(src.samples, 1, 5)).toBe(1000)

    // And the bug it replaces: `batch[0].tsUs` is 3000 in decode order, which
    // would have made the worker discard two perfectly good frames as false
    // pre-roll on every mid-stream batch (SP1 §6.1's second, latent bug).
    const brokenTarget = src.samples[batch.startIdx].tsUs
    expect(brokenTarget).toBe(3000)
    const falselyDropped = src.samples
      .slice(batch.startIdx, batch.endIdx)
      .filter((x) => x.tsUs < brokenTarget)
    expect(falselyDropped.map((x) => x.tsUs)).toEqual([1000, 2000])

    // The one legitimate pre-roll — keyframe → the frame actually asked for —
    // is expressed as the first batch's floor, not as a per-batch guess.
    const started = planStreamStart(src, 2000)
    expect(started.nextSampleIdx).toBe(0) // decode from I0
    expect(started.firstBatchTargetTsUs).toBe(2000) // …but emit nothing before cts 2000
    const first = planNextBatches(src, started, SHIPPED).batches[0]
    expect(minCtsUs(src.samples, first.startIdx, first.endIdx)).toBe(0)
    expect(first.targetTsUs).toBe(2000)
  })

  it('pipelined-batches', () => {
    const src = table(allIntra(400))
    const floor = minBatchFrames(DEFAULT_DECODE_AHEAD_FRAMES)
    expect(floor).toBe(7) // max(4, N/4) at N=30

    // (a) SP1's pre-fix configuration, reproduced against this same planner:
    // one request in flight, batch sized to the shortfall. After the initial
    // fill it asks for ONE frame per batch — and every batch ends in
    // `decoder.flush()`, which drains the whole decoder pipeline. That is the
    // measured 4.5fps supply limit (§6.1), not a hypothetical.
    const degenerate = simulate(src, DEGENERATE, { ticks: 60, paintPerTick: 1, latency: 0 })
    expect(degenerate.maxInFlightBatches).toBe(1)
    expect(new Set(degenerate.batchSizes.slice(1))).toEqual(new Set([1]))

    // (b) The shipped configuration on the identical workload: batches floored
    // so flush cost amortizes over many frames instead of one.
    const shipped = simulate(src, SHIPPED, { ticks: 60, paintPerTick: 1, latency: 0 })
    expect(Math.min(...shipped.batchSizes)).toBeGreaterThanOrEqual(floor)
    expect(shipped.painted).toBe(degenerate.painted) // same workload, so the comparison is like-for-like

    // (c) …and when decode takes longer than one pump interval, the planner
    // keeps a second batch queued behind the in-flight one rather than
    // degenerating to a single request the worker has to wait on.
    const pipelined = simulate(src, SHIPPED, { ticks: 60, paintPerTick: 4, latency: 2 })
    expect(pipelined.maxInFlightBatches).toBe(MAX_IN_FLIGHT_BATCHES)
    expect(Math.min(...pipelined.batchSizes)).toBeGreaterThanOrEqual(floor)

    // (d) The budget invariant that must survive all of the above: N still
    // means "at most N frames alive at once" (SP1 §8's memory sweep rests on
    // it), in every configuration.
    for (const run of [degenerate, shipped, pipelined]) {
      expect(run.maxAlive).toBeLessThanOrEqual(DEFAULT_DECODE_AHEAD_FRAMES)
    }
  })
})

describe('batch planner — bookkeeping', () => {
  it('stops at end of source and never plans past the last sample', () => {
    const src = table(allIntra(5))
    const { batches, state } = planNextBatches(src, planStreamStart(src, 0), SHIPPED)
    expect(batches).toEqual([{ startIdx: 0, endIdx: 5, count: 5, targetTsUs: 0 }])
    expect(planNextBatches(src, state, SHIPPED).batches).toEqual([])
  })

  it('lets a starving pipeline through the batch floor rather than stalling', () => {
    const src = table(allIntra(100))
    // Nothing buffered, nothing coming, but only 3 frames of budget: a batch
    // below the floor still beats painting nothing.
    const starving: PipelineState = {
      nextSampleIdx: 10,
      buffered: 0,
      inFlightFrames: 0,
      inFlightBatches: 0,
      firstBatchTargetTsUs: 0,
    }
    const { batches } = planNextBatches(src, starving, { decodeAheadFrames: 3, maxInFlightBatches: 2 })
    expect(batches.map((b) => b.count)).toEqual([3])
  })

  it('reconciles inFlightFrames against what a batch actually decoded', () => {
    // A 10-frame batch whose first 4 were pre-roll: only 6 frames will ever
    // arrive, so the per-frame decrement under-counts by 4. Without
    // reconciliation that 4 is lost decode-ahead capacity, permanently.
    let state: PipelineState = {
      nextSampleIdx: 10,
      buffered: 0,
      inFlightFrames: 10,
      inFlightBatches: 1,
      firstBatchTargetTsUs: 0,
    }
    for (let i = 0; i < 6; i++) state = onFrameBuffered(state)
    expect(state).toMatchObject({ buffered: 6, inFlightFrames: 4 })
    state = reconcileOnBatchDone(state, 10, 6)
    expect(state).toMatchObject({ buffered: 6, inFlightFrames: 0, inFlightBatches: 0 })
  })

  it('planSeek returns null for an empty table', () => {
    expect(planSeek(table([]), 0)).toBeNull()
  })
})
