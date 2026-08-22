import type { PlaybackClock } from './playback-clock'

/**
 * J/K/L shuttle. L plays forward, J plays backward, K stops. Repeating the same
 * direction doubles the rate (1x -> 2x -> 4x, capped); the opposite direction
 * resets to that direction at 1x.
 *
 * Two mechanisms, split by what can carry audio:
 *
 *  - **1x forward IS real playback, with sound.** The engine only decodes at 1x
 *    real-time forward, so that is the one place audio is possible. The first L
 *    press (and any reset back to +1x) calls `deps.play()` — the same engine
 *    transport Space uses, AudioContext resume and all — instead of the loop.
 *  - **Everything else is a silent seek-loop** (2x/4x forward, and all reverse).
 *    The engine has no variable-rate API, so these can only fast-scrub the
 *    shared `PlaybackClock`: pause real playback first (muting audio), then an
 *    rAF loop steps `clock.set(clock.get() + rate * dt)`. This touches only the
 *    clock, never the engine or <video> elements directly, so it works
 *    identically over both playback paths. Real 2x+/reverse audio would need an
 *    audio time-stretch/resample pipeline that does not exist yet.
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
  /** Start real 1x forward playback WITH audio — the engine transport (the
   *  same gesture-anchored path Space uses, AudioContext resume included).
   *  Called when the shuttle enters +1x; a no-op if already playing. */
  play: () => void
  /** Pause real playback (audio implicitly muted). Called when entering a silent
   *  seek-loop speed, and by stop() when the shuttle itself started playback. */
  pause: () => void
  /** Injectable for tests; defaults to `requestAnimationFrame`/`cancelAnimationFrame`. */
  raf?: (cb: (ms: number) => void) => number
  caf?: (id: number) => void
}

export interface ShuttleController {
  /** J or L. Starts the loop (pausing playback first) if idle. */
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
  // True while the shuttle itself is driving real 1x forward playback (the +1x
  // case). Tells stop() to pause it back, and tells a move OFF +1x to mute first.
  let realPlaying = false

  function stopLoop() {
    if (rafId !== null) caf(rafId)
    rafId = null
    lastMs = null
  }

  function stop() {
    rate = 0
    stopLoop()
    if (realPlaying) { deps.pause(); realPlaying = false }
  }

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

      if (next === 1) {
        // +1x = REAL playback, with audio. Drop any silent seek-loop and hand
        // off to the engine transport. If the user is already playing (e.g. they
        // hit Space first), leave that playback owned by them — don't claim it.
        stopLoop()
        rate = 1
        if (!deps.isPlaying()) { deps.play(); realPlaying = true }
        return
      }

      // A silent seek-loop speed: 2x/4x forward, or any reverse. Real playback
      // must be off so nothing double-drives the clock and audio is muted.
      const wasLooping = rafId !== null
      if (realPlaying) { deps.pause(); realPlaying = false }
      else if (!wasLooping) deps.pause() // cancel any user-started real playback
      rate = next
      startLoopIfNeeded()
    },
    stop,
    getRate: () => rate,
  }
}
