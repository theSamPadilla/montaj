import { useRef } from 'react'

/**
 * The timeline column's horizontal scroll container.
 *
 * All this hook has left is the ref. It used to own a whole zoom model: a
 * `zoom` multiplier, a pivot-preserving `zoomTo` that wrote `scrollLeft` in the
 * same layout pass as the new width, and a non-passive wheel listener for
 * ⌘/Ctrl+wheel zoom and Alt+wheel pan. That model existed because the DOM
 * track rows laid items out as percentages of the whole project, so the only
 * way to zoom them was to widen their container and scroll over it.
 *
 * The canvas surface zooms a px-per-second viewport held in an external store
 * (`canvas/viewport.ts`) instead, and owns its own wheel handling — it even
 * `stopPropagation`s the wheel events it consumes, specifically so this
 * container could not zoom its multiplier off the same gesture. With the rows
 * gone there is no second zoom model left to drive: the surface always fits
 * the width it is given, so the container never overflows and its scroll
 * position is always 0.
 *
 * It is kept as a hook (rather than inlined) because the ref is what makes the
 * container addressable, and a wide child appearing here should scroll rather
 * than stretch the page.
 */
export function useTimelineZoom() {
  const scrollRef = useRef<HTMLDivElement>(null)
  return { scrollRef }
}
