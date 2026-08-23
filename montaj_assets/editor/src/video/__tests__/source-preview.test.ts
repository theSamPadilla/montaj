/// <reference types="vitest/globals" />
/**
 * The source-preview override store. A sibling of `hover-scrub.ts`: it repaints
 * the main preview with an OFF-TIMELINE clip's frame on hover and NOTHING else —
 * it holds a proxy url + a fraction, notifies only on real change, and is inert
 * for a host that never wires it.
 */
import { describe, it, expect, vi } from 'vitest'
import { createSourcePreviewStore } from '../source-preview'

describe('createSourcePreviewStore', () => {
  it('starts empty — the main preview follows the timeline', () => {
    expect(createSourcePreviewStore().get()).toBeNull()
  })

  it('notifies subscribers when the value changes', () => {
    const store = createSourcePreviewStore()
    const sub = vi.fn()
    store.subscribe(sub)

    store.set({ url: 'a.mp4', fraction: 0.5 })
    expect(store.get()).toEqual({ url: 'a.mp4', fraction: 0.5 })
    expect(sub).toHaveBeenCalledTimes(1)

    store.set(null)
    expect(store.get()).toBeNull()
    expect(sub).toHaveBeenCalledTimes(2)
  })

  it('stays silent on a repeat write of the same url+fraction', () => {
    // The host may re-set the same value on repeated pointer events over one
    // tile; without the guard that would notify (and repaint) needlessly.
    const store = createSourcePreviewStore()
    const sub = vi.fn()
    store.subscribe(sub)

    store.set(null)
    expect(sub).not.toHaveBeenCalled()

    store.set({ url: 'a.mp4', fraction: 0.2 })
    store.set({ url: 'a.mp4', fraction: 0.2 })
    expect(sub).toHaveBeenCalledTimes(1)

    // A moved fraction (same clip) is a real change.
    store.set({ url: 'a.mp4', fraction: 0.6 })
    expect(sub).toHaveBeenCalledTimes(2)

    // A different clip is a real change.
    store.set({ url: 'b.mp4', fraction: 0.6 })
    expect(sub).toHaveBeenCalledTimes(3)
  })

  it('unsubscribes cleanly', () => {
    const store = createSourcePreviewStore()
    const sub = vi.fn()
    store.subscribe(sub)()
    store.set({ url: 'a.mp4', fraction: 0.1 })
    expect(sub).not.toHaveBeenCalled()
  })
})
