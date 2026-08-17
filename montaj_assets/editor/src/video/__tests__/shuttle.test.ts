import { describe, it, expect, vi } from 'vitest'
import { nextShuttleRate, createShuttleController } from '../shuttle'
import { createPlaybackClock } from '../playback-clock'

describe('nextShuttleRate — pure rate-stepping', () => {
  it('steps the same direction 1x -> 2x -> 4x, capped at 4x', () => {
    let rate = nextShuttleRate(0, 1)
    expect(rate).toBe(1)
    rate = nextShuttleRate(rate, 1)
    expect(rate).toBe(2)
    rate = nextShuttleRate(rate, 1)
    expect(rate).toBe(4)
    rate = nextShuttleRate(rate, 1) // capped
    expect(rate).toBe(4)
  })

  it('mirrors the same stepping backward', () => {
    let rate = nextShuttleRate(0, -1)
    expect(rate).toBe(-1)
    rate = nextShuttleRate(rate, -1)
    expect(rate).toBe(-2)
    rate = nextShuttleRate(rate, -1)
    expect(rate).toBe(-4)
  })

  it('the opposite direction resets to that direction at 1x', () => {
    const forward2x = nextShuttleRate(nextShuttleRate(0, 1), 1)
    expect(forward2x).toBe(2)
    expect(nextShuttleRate(forward2x, -1)).toBe(-1)

    const backward4x = nextShuttleRate(nextShuttleRate(nextShuttleRate(0, -1), -1), -1)
    expect(backward4x).toBe(-4)
    expect(nextShuttleRate(backward4x, 1)).toBe(1)
  })
})

describe('createShuttleController', () => {
  // Deterministic fake rAF: callbacks queue up and only run when the test
  // pumps them, so the rate-stepping/cancellation contract is tested without
  // depending on real frame timing.
  function makeFakeRaf() {
    let pending: ((ms: number) => void) | null = null
    return {
      raf: (cb: (ms: number) => void) => { pending = cb; return 1 },
      caf: () => { pending = null },
      pump: (ms: number) => { const cb = pending; pending = null; cb?.(ms) },
      hasPending: () => pending !== null,
    }
  }

  it('press() pauses playback once, from idle, and starts the loop', () => {
    const clock = createPlaybackClock(10)
    const pause = vi.fn()
    const { raf, caf } = makeFakeRaf()
    const controller = createShuttleController({
      clock, getDuration: () => 100, isPlaying: () => false, pause, raf, caf,
    })

    controller.press(1)
    expect(pause).toHaveBeenCalledTimes(1)
    expect(controller.getRate()).toBe(1)

    // A same-direction repeat only bumps the rate — it must NOT pause again.
    controller.press(1)
    expect(pause).toHaveBeenCalledTimes(1)
    expect(controller.getRate()).toBe(2)
  })

  it('K (stop) zeroes the rate and cancels the loop', () => {
    const clock = createPlaybackClock(10)
    const { raf, caf, hasPending } = makeFakeRaf()
    const controller = createShuttleController({
      clock, getDuration: () => 100, isPlaying: () => false, pause: () => {}, raf, caf,
    })
    controller.press(1)
    expect(hasPending()).toBe(true)
    controller.stop()
    expect(controller.getRate()).toBe(0)
    expect(hasPending()).toBe(false)
  })

  it('steps the clock forward on each pumped frame, clamped at the duration', () => {
    const clock = createPlaybackClock(0)
    const { raf, caf, pump } = makeFakeRaf()
    const controller = createShuttleController({
      clock, getDuration: () => 2, isPlaying: () => false, pause: () => {}, raf, caf,
    })
    controller.press(1) // rate = 1x
    pump(0)      // establishes the frame baseline, no time delta yet
    pump(1000)   // +1s at 1x -> clock should be ~1
    expect(clock.get()).toBeCloseTo(1, 5)
    pump(3000)   // +2s at 1x would overshoot past duration=2 -> clamped, loop stops
    expect(clock.get()).toBe(2)
    expect(controller.getRate()).toBe(0)
  })

  it('cancels when an external transport change starts real playback', () => {
    const clock = createPlaybackClock(0)
    const { raf, caf, pump } = makeFakeRaf()
    let playing = false
    const controller = createShuttleController({
      clock, getDuration: () => 100, isPlaying: () => playing, pause: () => {}, raf, caf,
    })
    controller.press(1)
    pump(0)
    playing = true // user hit play, outside the shuttle
    pump(16)
    expect(controller.getRate()).toBe(0)
  })

  it('cancels when the clock is moved externally (a seek)', () => {
    const clock = createPlaybackClock(0)
    const { raf, caf, pump } = makeFakeRaf()
    const controller = createShuttleController({
      clock, getDuration: () => 100, isPlaying: () => false, pause: () => {}, raf, caf,
    })
    controller.press(1)
    pump(0)
    clock.set(50) // an external seek, not written by the shuttle itself
    pump(16)
    expect(controller.getRate()).toBe(0)
  })
})
