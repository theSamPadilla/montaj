/**
 * T8 pure-fn coverage for scrub-source.ts's grain machinery: Hann-window
 * sample math, throttle+epsilon silence, release-ramp-to-zero, and the T7
 * Bluetooth-latency guard. No WebCodecs mock — every test here is driven only
 * as far as the `resolve()` gate (or a standalone exported helper), which is
 * as far as these tests need to reach; the decode → grain-playback pipeline
 * is out of scope per the plan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHoverScrub } from '../../video/hover-scrub'
import type { AcquiredDemux } from '../index'
import {
  MIX_GRAIN_HIGH_LATENCY_S,
  MIX_GRAIN_S,
  MOVE_EPSILON_S,
  RELEASE_FADE_S,
  THROTTLE_MS,
  createScrubSource,
  hannWindow,
  releaseGrain,
  type ScrubTarget,
} from '../scrub-source'

// ── hannWindow — pure sample math ────────────────────────────────────────────

describe('hannWindow', () => {
  it('starts at 0', () => {
    expect(hannWindow(8)[0]).toBe(0)
  })

  it('peaks at 1 at the midpoint', () => {
    expect(hannWindow(8)[4]).toBeCloseTo(1, 10)
  })

  it('is symmetric around the midpoint (w[i] === w[n-i])', () => {
    const w = hannWindow(16)
    for (let i = 1; i < 16; i++) expect(w[i]).toBeCloseTo(w[16 - i], 10)
  })

  it('is the PERIODIC form: the last sample is not zero, it mirrors w[1]', () => {
    // /n (not /(n-1)) means w[n-1] = 0.5*(1-cos(2π/n)), same as w[1] — small,
    // but nonzero. A test asserting w[n-1]===0 would be asserting the wrong
    // (symmetric, zero-ended) window shape.
    const w = hannWindow(8)
    expect(w[7]).toBeCloseTo(w[1], 10)
    expect(w[7]).not.toBeCloseTo(0, 3)
  })
})

// ── releaseGrain — the release-ramp math `stop()` applies to every live grain

describe('releaseGrain', () => {
  it('ramps gain to zero over RELEASE_FADE_S and schedules stop at the ramp end', () => {
    const gain = { gain: { value: 0.9, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() } }
    const src = { stop: vi.fn() }
    releaseGrain(src as unknown as AudioBufferSourceNode, gain as unknown as GainNode, 10)

    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0.9, 10)
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 10 + RELEASE_FADE_S)
    expect(src.stop).toHaveBeenCalledWith(10 + RELEASE_FADE_S)
  })
})

// ── createScrubSource — throttle, epsilon and the T7 Bluetooth guard ────────

interface FakeCtx {
  state: 'running' | 'suspended' | 'closed'
  outputLatency: number
  baseLatency: number
  currentTime: number
}

function fakeCtx(over: Partial<FakeCtx> = {}): FakeCtx {
  return { state: 'running', outputLatency: 0, baseLatency: 0, currentTime: 0, ...over }
}

function installCtx(ctx: FakeCtx) {
  ;(window as unknown as { __montajSharedCtx?: FakeCtx }).__montajSharedCtx = ctx
}

/** Never resolves — `fireGrain` awaits this and then hangs, so no code past it (the WebCodecs decode) ever runs. */
const hangingAcquireDemux: (src: string) => Promise<AcquiredDemux> = vi.fn(
  () => new Promise<AcquiredDemux>(() => {}),
)

/** Never called — used where `resolve` is expected to be gated out before it would ever run. */
const notCalledAcquireDemux: (src: string) => Promise<AcquiredDemux> = vi.fn(async () => {
  throw new Error('acquireDemux should not be called in this test')
})

/**
 * A target `resolve` can return truthily. `onScrub` only updates its own
 * throttle/epsilon state (`lastFireMs`/`lastFiredMediaS`) AFTER `resolve`
 * returns non-null — a `resolve` that always returns `null` would never let
 * that state advance, which would make every later call look "unthrottled"
 * for the wrong reason. So the throttle/epsilon tests below resolve to a
 * real target (and let `acquireDemux` hang forever) rather than short-
 * circuiting on `null`.
 */
function fixedTarget(mediaS: number): ScrubTarget {
  return { src: '/proxies/a_proxy.mp4', mediaS }
}

let nowSpy: ReturnType<typeof vi.spyOn> | undefined

/** One `performance.now()` reading per onScrub call, in order. */
function scriptNow(times: number[]) {
  let i = 0
  nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => times[Math.min(i++, times.length - 1)])
}

afterEach(() => {
  nowSpy?.mockRestore()
  nowSpy = undefined
  delete (window as unknown as { __montajSharedCtx?: FakeCtx }).__montajSharedCtx
})

describe('throttle + epsilon — stationary hover is silent', () => {
  beforeEach(() => installCtx(fakeCtx()))

  it('does not fire a second grain within THROTTLE_MS of the last, but does once past it', () => {
    scriptNow([1000, 1000 + THROTTLE_MS / 2, 1000 + THROTTLE_MS + 200])
    const resolve = vi.fn((t: number) => fixedTarget(t))
    const source = createScrubSource({ acquireDemux: hangingAcquireDemux, resolve })
    source.setEnabled(true)
    const hover = createHoverScrub()
    source.attach(hover)

    hover.set(1.0) // t=1000ms: first move always fires
    expect(resolve).toHaveBeenCalledTimes(1)

    hover.set(1.05) // t=1000+16ms: inside THROTTLE_MS — silent
    expect(resolve).toHaveBeenCalledTimes(1)

    hover.set(1.1) // well past THROTTLE_MS and past MOVE_EPSILON_S — fires again
    expect(resolve).toHaveBeenCalledTimes(2)

    source.dispose()
  })

  it('does not fire when the move is smaller than MOVE_EPSILON_S, even after THROTTLE_MS has passed', () => {
    scriptNow([1000, 1000 + THROTTLE_MS + 100])
    const resolve = vi.fn((t: number) => fixedTarget(t))
    const source = createScrubSource({ acquireDemux: hangingAcquireDemux, resolve })
    source.setEnabled(true)
    const hover = createHoverScrub()
    source.attach(hover)

    hover.set(1.0)
    expect(resolve).toHaveBeenCalledTimes(1)

    hover.set(1.0 + MOVE_EPSILON_S / 2) // past the throttle window, but the move itself is sub-epsilon
    expect(resolve).toHaveBeenCalledTimes(1)

    source.dispose()
  })

  it('goes silent (stop) on a null hover position without touching resolve', () => {
    scriptNow([1000])
    const resolve = vi.fn((t: number) => fixedTarget(t))
    const source = createScrubSource({ acquireDemux: hangingAcquireDemux, resolve })
    source.setEnabled(true)
    const hover = createHoverScrub()
    source.attach(hover)

    hover.set(1.0)
    expect(resolve).toHaveBeenCalledTimes(1)

    hover.set(null)
    expect(resolve).toHaveBeenCalledTimes(1)

    source.dispose()
  })
})

describe('T7 guard — Bluetooth/high-latency auto-disable', () => {
  it('blocks every scrub above SCRUB_LATENCY_THRESHOLD_S and warns via onError exactly once', () => {
    installCtx(fakeCtx({ outputLatency: 0.15 })) // > the 0.08s threshold
    const resolve = vi.fn(() => null)
    const onError = vi.fn()
    const source = createScrubSource({ acquireDemux: notCalledAcquireDemux, resolve, onError })

    source.setEnabled(true) // the guard also fires its one-time warning right on enable
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toMatch(/latency too high/i)

    const hover = createHoverScrub()
    source.attach(hover)
    hover.set(1.0)
    hover.set(2.0)

    expect(resolve).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1) // still just the one warning, not one per attempt

    source.dispose()
  })
})

// ── Mixer mode (§190 T4) ─────────────────────────────────────────────────────

describe('mixer mode — grains from the mixer, not the main thread', () => {
  function mixed(over: Partial<FakeCtx> = {}) {
    installCtx(fakeCtx(over))
    const mix = vi.fn()
    const resolve = vi.fn(() => null)
    const onError = vi.fn()
    const source = createScrubSource({
      acquireDemux: notCalledAcquireDemux,
      resolve,
      mixerScrub: () => mix,
      onError,
    })
    source.setEnabled(true)
    return { mix, resolve, onError, source }
  }

  it('sends the position, a direction from the move, and the full grain; resolve and demux are never used', () => {
    scriptNow([1000, 1100, 1200, 1300])
    const { mix, resolve, source } = mixed()
    const hover = createHoverScrub()
    source.attach(hover)
    hover.set(2)
    hover.set(2.5)
    hover.set(2.1)
    expect(mix.mock.calls).toEqual([
      [2, 1, MIX_GRAIN_S],
      [2.5, 1, MIX_GRAIN_S],
      [2.1, -1, MIX_GRAIN_S],
    ])
    expect(resolve).not.toHaveBeenCalled()
    source.dispose()
  })

  it('keeps the throttle and the move epsilon', () => {
    scriptNow([1000, 1000 + THROTTLE_MS / 2, 1000 + THROTTLE_MS + 100, 1000 + 2 * THROTTLE_MS + 200])
    const { mix, source } = mixed()
    const hover = createHoverScrub()
    source.attach(hover)
    hover.set(1)
    hover.set(1.05) // inside the throttle
    hover.set(1 + MOVE_EPSILON_S / 2) // past it, but a sub-epsilon move
    expect(mix).toHaveBeenCalledTimes(1)
    hover.set(1.1)
    expect(mix).toHaveBeenCalledTimes(2)
    source.dispose()
  })

  it('does not switch off over a high-latency output: the grain is shorter, and nothing is reported', () => {
    scriptNow([1000, 1100])
    const { mix, onError, source } = mixed({ outputLatency: 0.15 })
    const hover = createHoverScrub()
    source.attach(hover)
    hover.set(1)
    hover.set(1.5)
    expect(mix.mock.calls.map((c) => c[2])).toEqual([MIX_GRAIN_HIGH_LATENCY_S, MIX_GRAIN_HIGH_LATENCY_S])
    expect(MIX_GRAIN_HIGH_LATENCY_S).toBeLessThan(MIX_GRAIN_S)
    expect(onError).not.toHaveBeenCalled()
    source.dispose()
  })

  it('jog (a playhead drag, the reverse shuttle) goes the same way, with the direction it is given', () => {
    scriptNow([1000, 1100, 1200])
    const { mix, source } = mixed()
    source.jog(3)
    source.jog(3.4)
    source.jog(3.0, -1)
    expect(mix.mock.calls).toEqual([
      [3, 1, MIX_GRAIN_S],
      [3.4, 1, MIX_GRAIN_S],
      [3.0, -1, MIX_GRAIN_S],
    ])
    source.dispose()
  })

  it('jog is silent when the scrub setting is off', () => {
    scriptNow([1000])
    const { mix, source } = mixed()
    source.setEnabled(false)
    source.jog(3)
    expect(mix).not.toHaveBeenCalled()
    source.dispose()
  })

  it('outside mixer mode jog does nothing, and hover is today\'s path', () => {
    installCtx(fakeCtx())
    scriptNow([1000, 1100])
    const resolve = vi.fn((t: number) => fixedTarget(t))
    const source = createScrubSource({ acquireDemux: hangingAcquireDemux, resolve, mixerScrub: () => null })
    source.setEnabled(true)
    source.jog(1)
    expect(resolve).not.toHaveBeenCalled()
    const hover = createHoverScrub()
    source.attach(hover)
    hover.set(1)
    expect(resolve).toHaveBeenCalledTimes(1)
    source.dispose()
  })

  it('outside mixer mode the high-latency guard still switches scrub off', () => {
    installCtx(fakeCtx({ outputLatency: 0.15 }))
    const resolve = vi.fn(() => null)
    const onError = vi.fn()
    const source = createScrubSource({ acquireDemux: notCalledAcquireDemux, resolve, mixerScrub: () => null, onError })
    source.setEnabled(true)
    const hover = createHoverScrub()
    source.attach(hover)
    hover.set(1)
    expect(resolve).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    source.dispose()
  })
})
