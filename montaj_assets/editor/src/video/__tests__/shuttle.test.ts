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

  // Model real playback as a flag the play/pause deps flip, so isPlaying()
  // reflects what the shuttle just did — exactly like the engine transport.
  function makeDeps(clock: ReturnType<typeof createPlaybackClock>, getDuration = () => 100) {
    let playing = false
    const play = vi.fn(() => { playing = true })
    const pause = vi.fn(() => { playing = false })
    const fake = makeFakeRaf()
    return {
      play, pause, fake,
      setPlaying: (v: boolean) => { playing = v },
      deps: {
        clock, getDuration,
        isPlaying: () => playing,
        play, pause,
        raf: fake.raf, caf: fake.caf,
      },
    }
  }

  it('+1x is real playback with audio: press(1) from idle plays, no seek-loop', () => {
    const clock = createPlaybackClock(10)
    const { deps, play, pause, fake } = makeDeps(clock)
    const controller = createShuttleController(deps)

    controller.press(1)
    expect(play).toHaveBeenCalledTimes(1)  // engine transport (audio) started
    expect(pause).not.toHaveBeenCalled()
    expect(controller.getRate()).toBe(1)
    expect(fake.hasPending()).toBe(false)  // NOT the silent seek-loop
    expect(clock.get()).toBe(10)           // the shuttle isn't driving the clock
  })

  it('pressing L again leaves +1x for the silent 2x seek-loop, muting audio', () => {
    const clock = createPlaybackClock(0)
    const { deps, pause, fake } = makeDeps(clock)
    const controller = createShuttleController(deps)

    controller.press(1)                     // real play @1x
    controller.press(1)                     // -> 2x seek-loop
    expect(pause).toHaveBeenCalledTimes(1)  // real playback muted before scrubbing
    expect(controller.getRate()).toBe(2)
    expect(fake.hasPending()).toBe(true)

    // A same-direction repeat only bumps the rate — it must NOT pause again.
    controller.press(1)
    expect(pause).toHaveBeenCalledTimes(1)
    expect(controller.getRate()).toBe(4)
  })

  it('reverse is always a silent seek-loop, never real playback', () => {
    const clock = createPlaybackClock(50)
    const { deps, play, fake } = makeDeps(clock)
    const controller = createShuttleController(deps)

    controller.press(-1)
    expect(play).not.toHaveBeenCalled()
    expect(controller.getRate()).toBe(-1)
    expect(fake.hasPending()).toBe(true)
  })

  it('resetting from a reverse loop back to +1x returns to real playback', () => {
    const clock = createPlaybackClock(50)
    const { deps, play, fake } = makeDeps(clock)
    const controller = createShuttleController(deps)

    controller.press(-1)                   // reverse loop
    expect(fake.hasPending()).toBe(true)
    controller.press(1)                    // opposite dir -> +1x -> real play
    expect(play).toHaveBeenCalledTimes(1)
    expect(controller.getRate()).toBe(1)
    expect(fake.hasPending()).toBe(false)  // loop cancelled
  })

  it('stop() pauses shuttle-started real playback', () => {
    const clock = createPlaybackClock(0)
    const { deps, pause } = makeDeps(clock)
    const controller = createShuttleController(deps)
    controller.press(1)          // real play @1x
    controller.stop()
    expect(pause).toHaveBeenCalledTimes(1)
    expect(controller.getRate()).toBe(0)
  })

  it('K (stop) zeroes the rate and cancels a running seek-loop', () => {
    const clock = createPlaybackClock(10)
    const { deps, fake } = makeDeps(clock)
    const controller = createShuttleController(deps)
    controller.press(-1)         // reverse seek-loop
    expect(fake.hasPending()).toBe(true)
    controller.stop()
    expect(controller.getRate()).toBe(0)
    expect(fake.hasPending()).toBe(false)
  })

  it('steps the clock in the seek-loop, clamped at the duration', () => {
    const clock = createPlaybackClock(0)
    const { deps, fake } = makeDeps(clock, () => 4)
    const controller = createShuttleController(deps)
    controller.press(1)   // real play @1x — does NOT step the clock
    controller.press(1)   // -> 2x seek-loop
    fake.pump(0)          // establishes the frame baseline, no time delta yet
    fake.pump(1000)       // +1s at 2x -> clock should be ~2
    expect(clock.get()).toBeCloseTo(2, 5)
    fake.pump(3000)       // +2s at 2x would overshoot past duration=4 -> clamped, loop stops
    expect(clock.get()).toBe(4)
    expect(controller.getRate()).toBe(0)
  })

  it('cancels the seek-loop when an external transport change starts real playback', () => {
    const clock = createPlaybackClock(0)
    const { deps, fake, setPlaying } = makeDeps(clock)
    const controller = createShuttleController(deps)
    controller.press(-1)   // reverse seek-loop
    fake.pump(0)
    setPlaying(true)       // user hit play, outside the shuttle
    fake.pump(16)
    expect(controller.getRate()).toBe(0)
  })

  it('cancels the seek-loop when the clock is moved externally (a seek)', () => {
    const clock = createPlaybackClock(0)
    const { deps, fake } = makeDeps(clock)
    const controller = createShuttleController(deps)
    controller.press(-1)   // reverse seek-loop
    fake.pump(0)
    clock.set(50)         // an external seek, not written by the shuttle itself
    fake.pump(16)
    expect(controller.getRate()).toBe(0)
  })
})
