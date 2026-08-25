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
    const setRate = vi.fn<(rate: number) => void>()
    const fake = makeFakeRaf()
    return {
      play, pause, setRate, fake,
      setPlaying: (v: boolean) => { playing = v },
      deps: {
        clock, getDuration,
        isPlaying: () => playing,
        play, pause, setRate,
        raf: fake.raf, caf: fake.caf,
      },
    }
  }

  it('forward from idle: real playback @1x with audio, setRate(1), no seek-loop', () => {
    const clock = createPlaybackClock(10)
    const { deps, play, pause, setRate, fake } = makeDeps(clock)
    const controller = createShuttleController(deps)

    controller.press(1)
    expect(play).toHaveBeenCalledTimes(1)      // engine transport (audio) started
    expect(pause).not.toHaveBeenCalled()
    expect(setRate).toHaveBeenLastCalledWith(1) // 1x re-anchor (harmless no-op)
    expect(controller.getRate()).toBe(1)
    expect(fake.hasPending()).toBe(false)      // NOT the silent seek-loop
    expect(clock.get()).toBe(10)               // the shuttle isn't driving the clock
  })

  it('repeating forward bumps the engine rate 1x -> 2x -> 4x (audible), never the seek-loop', () => {
    const clock = createPlaybackClock(0)
    const { deps, play, setRate, fake } = makeDeps(clock)
    const controller = createShuttleController(deps)

    controller.press(1)                          // real play @1x
    controller.press(1)                          // -> 2x, STILL real playback
    expect(setRate).toHaveBeenLastCalledWith(2)
    expect(controller.getRate()).toBe(2)
    expect(fake.hasPending()).toBe(false)        // audible, not a seek-loop
    expect(play).toHaveBeenCalledTimes(1)        // already playing — not re-started

    controller.press(1)                          // -> 4x
    expect(setRate).toHaveBeenLastCalledWith(4)
    expect(controller.getRate()).toBe(4)

    controller.press(1)                          // capped at 4x
    expect(setRate).toHaveBeenLastCalledWith(4)
    expect(controller.getRate()).toBe(4)
  })

  it('forward press while already playing (user-started via Space) does not claim ownership: stop() leaves it running', () => {
    const clock = createPlaybackClock(0)
    const { deps, play, pause, setRate, setPlaying } = makeDeps(clock)
    const controller = createShuttleController(deps)

    setPlaying(true)                             // the user hit Space before shuttling
    controller.press(1)
    expect(play).not.toHaveBeenCalled()          // already playing — shuttle didn't start it
    expect(setRate).toHaveBeenLastCalledWith(1)
    expect(controller.getRate()).toBe(1)

    controller.stop()                            // K
    expect(pause).not.toHaveBeenCalled()         // ownership never claimed — user's playback survives
    expect(setRate).toHaveBeenLastCalledWith(1)  // rate still resets to 1x
    expect(controller.getRate()).toBe(0)
  })

  it('reverse is a silent seek-loop: resets the rate, pauses real playback, never plays', () => {
    const clock = createPlaybackClock(50)
    const { deps, play, pause, setRate, fake, setPlaying } = makeDeps(clock)
    const controller = createShuttleController(deps)

    setPlaying(true)                             // e.g. the user hit Space first
    controller.press(-1)
    expect(setRate).toHaveBeenLastCalledWith(1)  // no stale forward rate during the scrub
    expect(pause).toHaveBeenCalledTimes(1)       // real playback muted before scrubbing
    expect(play).not.toHaveBeenCalled()          // reverse never plays
    expect(controller.getRate()).toBe(-1)
    expect(fake.hasPending()).toBe(true)
  })

  it('resetting from a reverse loop back to forward returns to real playback', () => {
    const clock = createPlaybackClock(50)
    const { deps, play, setRate, fake } = makeDeps(clock)
    const controller = createShuttleController(deps)

    controller.press(-1)                    // reverse loop (rate reset to 1, paused)
    expect(fake.hasPending()).toBe(true)
    controller.press(1)                     // opposite dir -> forward -> real play
    expect(play).toHaveBeenCalledTimes(1)
    expect(setRate).toHaveBeenLastCalledWith(1)
    expect(controller.getRate()).toBe(1)
    expect(fake.hasPending()).toBe(false)   // loop cancelled
  })

  it('stop() resets the transport rate and pauses shuttle-started real playback', () => {
    const clock = createPlaybackClock(0)
    const { deps, pause, setRate } = makeDeps(clock)
    const controller = createShuttleController(deps)
    controller.press(1)          // real play @1x (shuttle-started)
    controller.stop()
    expect(setRate).toHaveBeenLastCalledWith(1)
    expect(pause).toHaveBeenCalledTimes(1)
    expect(controller.getRate()).toBe(0)
  })

  it('K (stop) zeroes the rate, resets the transport rate and cancels a running seek-loop', () => {
    const clock = createPlaybackClock(10)
    const { deps, setRate, fake } = makeDeps(clock)
    const controller = createShuttleController(deps)
    controller.press(-1)         // reverse seek-loop
    expect(fake.hasPending()).toBe(true)
    controller.stop()
    expect(setRate).toHaveBeenLastCalledWith(1)
    expect(controller.getRate()).toBe(0)
    expect(fake.hasPending()).toBe(false)
  })

  it('steps the clock down in the reverse seek-loop, clamped at 0', () => {
    const clock = createPlaybackClock(4)
    const { deps, fake } = makeDeps(clock, () => 100)
    const controller = createShuttleController(deps)
    controller.press(-1)  // -1x reverse seek-loop
    controller.press(-1)  // -> -2x
    expect(controller.getRate()).toBe(-2)
    fake.pump(0)          // establishes the frame baseline, no time delta yet
    fake.pump(1000)       // -1s at 2x -> clock should be ~2
    expect(clock.get()).toBeCloseTo(2, 5)
    fake.pump(3000)       // -2s at 2x would undershoot below 0 -> clamped, loop stops
    expect(clock.get()).toBe(0)
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
