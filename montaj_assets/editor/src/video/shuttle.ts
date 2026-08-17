import type { PlaybackClock } from './playback-clock'

/**
 * J/K/L seek-loop shuttle — v1, fixed-step semantics (this is deliberately
 * NOT real variable-rate playback; the engine has no rate API — see
 * `useEnginePlayback.ts`'s file header). L steps forward, J steps backward, K
 * stops. Repeating the same direction doubles the rate (1x -> 2x -> 4x,
 * capped); the opposite direction resets to that direction at 1x.
 *
 * Implementation: pause real playback first (audio implicitly muted by
 * pause), then an rAF loop steps `clock.set(clock.get() + rate * dt)`. This
 * works identically over both playback paths because it only touches the
 * shared `PlaybackClock`, never the engine or the <video> elements directly.
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
  /** Pause real playback. Called once, when the shuttle starts from idle
   *  (rate 0) — never on a same-direction rate bump. */
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

  function stopLoop() {
    if (rafId !== null) caf(rafId)
    rafId = null
    lastMs = null
  }

  function stop() {
    rate = 0
    stopLoop()
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
      if (rate === 0) deps.pause()
      rate = nextShuttleRate(rate, direction)
      startLoopIfNeeded()
    },
    stop,
    getRate: () => rate,
  }
}
