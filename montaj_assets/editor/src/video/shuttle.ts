import type { PlaybackClock } from './playback-clock'

/**
 * J/K/L shuttle. L plays forward, J plays backward, K stops. Repeating the same
 * direction doubles the rate (1x -> 2x -> 4x, capped); the opposite direction
 * resets to that direction at 1x.
 *
 * Two mechanisms, split by what can carry audio:
 *
 *  - **Forward (1x/2x/4x) IS real playback, with sound.** The engine has a live
 *    transport rate (`deps.setRate`): project time advances R× and audio is
 *    pitch-corrected via a streaming time-stretch, so 2x/4x forward is audible,
 *    not just faster. A forward press ensures the engine transport is running
 *    (via `deps.play()` — the same gesture-anchored path Space uses, AudioContext
 *    resume and all) and sets the rate to the shuttle's magnitude.
 *  - **Reverse is a silent seek-loop.** The engine has no reverse rate (reversed
 *    audio is not a thing), so J can only fast-scrub the shared `PlaybackClock`:
 *    real playback is paused (muting audio) and the transport rate reset to 1x,
 *    then an rAF loop steps `clock.set(clock.get() + rate * dt)`. This touches
 *    only the clock, never the engine or <video> elements directly, so it works
 *    identically over both playback paths.
 */
export type ShuttleRate = -4 | -2 | -1 | 0 | 1 | 2 | 4

/**
 * Pure rate-stepping — unit-testable without rAF. Pressing the same
 * direction again doubles the magnitude (capped at 4x); pressing the
 * opposite direction resets to that direction at 1x.
 */
export function nextShuttleRate(current: ShuttleRate, direction: 1 | -1): ShuttleRate {
  const sign = Math.sign(current)
  if (sign !== 0 && sign === direction) {
    return (Math.min(4, Math.abs(current) * 2) * direction) as ShuttleRate
  }
  return direction
}

export interface ShuttleDeps {
  clock: PlaybackClock
  /** The seekable upper bound — the loop stops when it reaches either end. */
  getDuration: () => number
  /** True while playback is running OUTSIDE the shuttle's own loop. Polled
   *  every tick so a real "user hit play" transport change cancels the
   *  shuttle instead of racing it. */
  isPlaying: () => boolean
  /** Start real forward playback WITH audio — the engine transport (the same
   *  gesture-anchored path Space uses, AudioContext resume included). Called on a
   *  forward press; a no-op if already playing. */
  play: () => void
  /** Pause real playback (audio implicitly muted). Called when entering the
   *  reverse seek-loop, and by stop() when the shuttle itself started playback. */
  pause: () => void
  /** Set the engine's live transport rate R. A forward press sets it to the
   *  shuttle magnitude (1/2/4) for audible fast-forward; reverse and stop reset
   *  it to 1x before pausing/scrubbing so nothing plays at a stale rate. */
  setRate: (rate: number) => void
  /** Injectable for tests; defaults to `requestAnimationFrame`/`cancelAnimationFrame`. */
  raf?: (cb: (ms: number) => void) => number
  caf?: (id: number) => void
}

export interface ShuttleController {
  /** J or L. Forward = real playback at the transport rate; reverse = the silent
   *  seek-loop. */
  press: (direction: 1 | -1) => void
  /** K, or any other transport/seek change — stops the loop. */
  stop: () => void
  getRate: () => ShuttleRate
}

export function createShuttleController(deps: ShuttleDeps): ShuttleController {
  const raf = deps.raf ?? requestAnimationFrame
  const caf = deps.caf ?? cancelAnimationFrame

  let rate: ShuttleRate = 0
  let rafId: number | null = null
  let lastMs: number | null = null
  // The value WE last wrote — lets the tick tell "the clock changed because
  // we changed it" apart from "something external moved the playhead" (a
  // Scrubber click, an arrow-key step, another editor gesture).
  let lastWritten: number | null = null
  // True while the shuttle itself is driving real forward playback (any of
  // 1x/2x/4x). Tells stop() to pause it back, and tells a move to reverse to
  // mute first.
  let realPlaying = false

  function stopLoop() {
    if (rafId !== null) caf(rafId)
    rafId = null
    lastMs = null
  }

  function stop() {
    rate = 0
    stopLoop()
    deps.setRate(1)
    if (realPlaying) { deps.pause(); realPlaying = false }
  }

  // Only ever runs for reverse now (forward is real playback, no loop). Keeps
  // the existing external-change/isPlaying cancellation guards so a real play or
  // an external seek during a reverse scrub cancels the shuttle instead of
  // racing it.
  function tick(ms: number) {
    if (rate === 0) { stopLoop(); return }
    if (deps.isPlaying()) { stop(); return }
    if (lastWritten !== null && deps.clock.get() !== lastWritten) { stop(); return }

    if (lastMs !== null) {
      const dt = (ms - lastMs) / 1000
      const duration = deps.getDuration()
      const next = Math.max(0, Math.min(duration, deps.clock.get() + rate * dt))
      deps.clock.set(next)
      lastWritten = next
      if (next <= 0 || next >= duration) { stop(); return }
    }
    lastMs = ms
    rafId = raf(tick)
  }

  function startLoopIfNeeded() {
    if (rafId !== null) return
    lastMs = null
    lastWritten = deps.clock.get()
    rafId = raf(tick)
  }

  return {
    press(direction: 1 | -1) {
      const next = nextShuttleRate(rate, direction)

      if (next > 0) {
        // FORWARD 1x/2x/4x = REAL playback at the engine transport rate — with
        // audio, pitch-corrected. Drop any reverse seek-loop, make sure the
        // engine is playing (resuming the AudioContext), then set the rate.
        // Ownership (`realPlaying`) is only claimed when the shuttle itself
        // starts playback from idle — if playback was already running (e.g.
        // the user pressed Space first), stop() must leave it running rather
        // than pausing playback the shuttle never started.
        stopLoop()
        if (!deps.isPlaying()) { deps.play(); realPlaying = true }
        deps.setRate(next)
        rate = next
        return
      }

      // REVERSE = the silent seek-loop. Reset the transport rate and pause real
      // playback before scrubbing, so nothing plays at a stale rate and nothing
      // double-drives the clock while the loop fast-scrubs it.
      deps.setRate(1)
      if (deps.isPlaying()) deps.pause()
      realPlaying = false
      rate = next
      startLoopIfNeeded()
    },
    stop,
    getRate: () => rate,
  }
}
