import { useSyncExternalStore } from 'react'

export interface PlaybackClock {
  get(): number
  set(t: number): void
  subscribe(cb: () => void): () => void
}

/** External store for the playhead. Written ~60Hz by the playback engine;
 *  only components that render the time subscribe (usePlaybackTime). Event
 *  handlers that just need "time right now" call clock.get() — no re-renders. */
export function createPlaybackClock(initial = 0): PlaybackClock {
  let time = initial
  const subs = new Set<() => void>()
  return {
    get: () => time,
    set(t) {
      if (t === time) return
      time = t
      subs.forEach((cb) => cb())
    },
    subscribe(cb) {
      subs.add(cb)
      return () => { subs.delete(cb) }
    },
  }
}

export function usePlaybackTime(clock: PlaybackClock): number {
  return useSyncExternalStore(clock.subscribe, clock.get, clock.get)
}
