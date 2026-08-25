import { useSyncExternalStore } from 'react'

/**
 * The source-preview override: "show this OFF-TIMELINE clip's frame in the main
 * preview instead of the timeline's picture", or null for "show the timeline".
 *
 * A sibling of `hover-scrub.ts`, and for the same structural reason: it repaints
 * the preview on every hover move without touching the playback clock. But where
 * hover-scrub resolves a NUMBER against the timeline, this carries a directly
 * loadable proxy `url` and a `fraction` into it — a clip the timeline knows
 * nothing about, driven by a host's footage bin as the pointer travels one of
 * its cards.
 *
 * The seam is entirely opt-in. A host that never creates the store (Hub, LP, the
 * classic layout) passes nothing; `useSourcePreview(undefined)` returns null and
 * no overlay is ever mounted, so the main preview behaves exactly as before.
 *
 * An external store rather than React state because it is written on every
 * mousemove: only the preview-stage overlay subscribes, so the editor shell, the
 * timeline and the caption row don't re-render as the pointer travels a card.
 */
export interface SourcePreviewValue {
  /** A directly-loadable proxy URL (the host resolves it before setting). */
  url: string
  /** Position within the source, in [0, 1]. */
  fraction: number
}

export interface SourcePreviewStore {
  get(): SourcePreviewValue | null
  set(v: SourcePreviewValue | null): void
  subscribe(cb: () => void): () => void
}

export function createSourcePreviewStore(): SourcePreviewStore {
  let value: SourcePreviewValue | null = null
  const subs = new Set<() => void>()
  return {
    get: () => value,
    set(v) {
      // Skip the notify when nothing actually changed — a host may re-set the
      // same url+fraction on repeated pointer events over the same tile.
      if (v === value) return
      if (v && value && v.url === value.url && v.fraction === value.fraction) return
      value = v
      subs.forEach((cb) => cb())
    },
    subscribe(cb) {
      subs.add(cb)
      return () => { subs.delete(cb) }
    },
  }
}

/** Stable snapshot for an absent store, so `useSyncExternalStore` isn't handed
 *  a fresh closure per render when a host omits source-preview entirely. */
const NO_SUBSCRIBE = () => () => {}
const NO_VALUE = () => null

export function useSourcePreview(store?: SourcePreviewStore): SourcePreviewValue | null {
  return useSyncExternalStore(
    store?.subscribe ?? NO_SUBSCRIBE,
    store?.get ?? NO_VALUE,
    store?.get ?? NO_VALUE,
  )
}
