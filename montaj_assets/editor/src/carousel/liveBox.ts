import { useCallback, useSyncExternalStore } from 'react'

/**
 * An overlay's box while a resize is held (§587 F-E): the size the gesture
 * previews, in slide px, and the ratio a corner resize scales its text by (1
 * for everything else). The canvas writes the wrapper and chrome straight to
 * the DOM, but an overlay template draws FROM its box (`boxWidth`/
 * `boxHeight`: the shapes, lines, frames, charts) and text wraps to it, so
 * the overlay has to render again at that size on every move.
 */
export type LiveBox = { w: number; h: number; ratio: number }

/**
 * Live boxes by element id, each subscribed to on its own, so a move renders
 * the one overlay being resized and not the slide.
 */
export interface LiveBoxes {
  get(id: string): LiveBox | undefined
  set(id: string, box: LiveBox): void
  clear(): void
  subscribe(id: string, listener: () => void): () => void
}

export function createLiveBoxes(): LiveBoxes {
  const boxes = new Map<string, LiveBox>()
  const listeners = new Map<string, Set<() => void>>()
  const notify = (id: string) => listeners.get(id)?.forEach((l) => l())
  return {
    get: (id) => boxes.get(id),
    set(id, box) {
      const was = boxes.get(id)
      if (was && was.w === box.w && was.h === box.h && was.ratio === box.ratio) return
      boxes.set(id, box)
      notify(id)
    },
    clear() {
      const ids = [...boxes.keys()]
      boxes.clear()
      ids.forEach(notify)
    },
    subscribe(id, listener) {
      let set = listeners.get(id)
      if (!set) listeners.set(id, (set = new Set()))
      set.add(listener)
      return () => {
        set.delete(listener)
        if (!set.size) listeners.delete(id)
      }
    },
  }
}

/** The live box of `id`, or undefined when no resize holds it. */
export function useLiveBox(boxes: LiveBoxes, id: string): LiveBox | undefined {
  const subscribe = useCallback((l: () => void) => boxes.subscribe(id, l), [boxes, id])
  const get = () => boxes.get(id)
  return useSyncExternalStore(subscribe, get, get)
}
