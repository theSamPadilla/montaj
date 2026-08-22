import { useSyncExternalStore } from 'react'
import type { PlaybackClock } from './playback-clock'

/**
 * The preview-axis override: "show the frame at THIS time instead of the
 * playhead's", or null for "show the playhead's frame".
 *
 * Separate from the playback clock on purpose. The clock is the truth — it is
 * where playback resumes, what the red playhead draws from, and what the
 * scrubber and transport move. Hover-scrubbing must not touch any of that; it
 * only changes which frame the preview paints, and only while the pointer is
 * over the timeline. Writing hover into the clock instead would drag the red
 * playhead and the scrubber handle around with the mouse, and Space would then
 * start playing from wherever the pointer happened to rest.
 *
 * An external store rather than React state because it is written on every
 * mousemove: only `PreviewPlayer` subscribes, so the editor shell, the timeline
 * and the caption row don't re-render as the pointer travels.
 */
export interface HoverScrub {
  get(): number | null
  set(t: number | null): void
  subscribe(cb: () => void): () => void
}

export function createHoverScrub(): HoverScrub {
  let time: number | null = null
  const subs = new Set<() => void>()
  return {
    get: () => time,
    set(t) {
      // The no-op guard matters: `clock.subscribe` clears this store on every
      // playback tick (see VideoEditor), which would otherwise notify ~60
      // times a second forever.
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

/** Stable snapshot for an absent store, so `useSyncExternalStore` isn't handed
 *  a fresh closure per render when a host omits hover-scrubbing entirely. */
const NO_SUBSCRIBE = () => () => {}
const NO_TIME = () => null

export function useHoverScrubTime(store?: HoverScrub): number | null {
  return useSyncExternalStore(
    store?.subscribe ?? NO_SUBSCRIBE,
    store?.get ?? NO_TIME,
    store?.get ?? NO_TIME,
  )
}

/**
 * The playback→editor half of the clock bridge, gated on hover-preview.
 *
 * Showing a hovered frame means SEEKING the source to it, and a seek runs a
 * tick that reports the new position back (`useEnginePlayback`'s `emitTime`,
 * the legacy hook's `onTimeUpdate`). Wired straight to `clock.set`, that makes
 * the red playhead chase the yellow cursor across the timeline — the preview
 * would be honest but the playhead would have silently moved, which is the one
 * thing the preview axis promises it will not do.
 *
 * So while an override stands the picture is display-only and the clock is left
 * alone. `handOverToHover` drops the override the moment playback starts, so
 * playback's own emissions always get through.
 */
export function gateTimeSink(clock: PlaybackClock, hover?: HoverScrub): (t: number) => void {
  return (t: number) => {
    if (hover?.get() != null) return
    clock.set(t)
  }
}

/**
 * Play from the yellow line. Called when playback starts: the source is already
 * parked on the hovered frame (that is how it got on screen), so playback
 * continues from there — this makes the RED playhead say so too, instead of
 * leaving it stranded where it sat before the hover.
 *
 * Writing the clock is what makes the hand-over safe rather than cosmetic: with
 * the override gone the preview falls back to the clock, and a clock still
 * holding the pre-hover position reads as an external scrub and seeks the
 * engine backwards mid-playback (`useEnginePlayback`'s scrub effect has no
 * transport guard). Setting it to the hovered time keeps mirror and clock
 * agreeing, so that seek never fires.
 *
 * Returns whether a hand-over happened — false when nothing was hovered, which
 * is every ordinary press of play.
 */
export function handOverToHover(clock: PlaybackClock, hover?: HoverScrub): boolean {
  const t = hover?.get()
  if (t == null) return false
  hover!.set(null)
  clock.set(t)
  return true
}
