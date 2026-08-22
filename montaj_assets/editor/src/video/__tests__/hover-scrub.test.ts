/// <reference types="vitest/globals" />
/**
 * The preview-axis override store. Small, but it carries the invariant the
 * whole feature rests on: hover changes which frame the preview paints and
 * NOTHING else — not the playhead, not where playback resumes.
 */
import { describe, it, expect, vi } from 'vitest'
import { createHoverScrub, gateTimeSink, handOverToHover } from '../hover-scrub'
import { createPlaybackClock } from '../playback-clock'

describe('createHoverScrub', () => {
  it('starts with no override — the preview follows the playhead', () => {
    expect(createHoverScrub().get()).toBeNull()
  })

  it('notifies subscribers when the hovered time changes', () => {
    const store = createHoverScrub()
    const sub = vi.fn()
    store.subscribe(sub)

    store.set(4)
    expect(store.get()).toBe(4)
    expect(sub).toHaveBeenCalledTimes(1)

    store.set(null)
    expect(store.get()).toBeNull()
    expect(sub).toHaveBeenCalledTimes(2)
  })

  it('stays silent on a repeat write', () => {
    // Load-bearing: the clock subscription clears this on every playback tick,
    // which without the guard would notify ~60 times a second forever.
    const store = createHoverScrub()
    const sub = vi.fn()
    store.subscribe(sub)

    store.set(null)
    expect(sub).not.toHaveBeenCalled()

    store.set(2)
    store.set(2)
    expect(sub).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes cleanly', () => {
    const store = createHoverScrub()
    const sub = vi.fn()
    store.subscribe(sub)()
    store.set(1)
    expect(sub).not.toHaveBeenCalled()
  })

  it('never touches the playback clock', () => {
    // The invariant in one assertion: hovering must not move the playhead, or
    // the red line and the scrubber handle would chase the pointer and Space
    // would start playing from wherever it happened to rest.
    const clock = createPlaybackClock()
    const store = createHoverScrub()
    clock.set(7)

    store.set(1)
    store.set(2)
    expect(clock.get()).toBe(7)
  })

  it('is cleared by a clock move, the way VideoEditor wires it', () => {
    // Any real playhead movement — a playback tick, an arrow step, a seek —
    // cancels the hover preview, so a stale override can never pin the picture
    // to a frame the playhead has left.
    const clock = createPlaybackClock()
    const store = createHoverScrub()
    clock.subscribe(() => store.set(null))

    store.set(3)
    expect(store.get()).toBe(3)

    clock.set(9)
    expect(store.get()).toBeNull()
  })
})

describe('the clock bridge, gated on hover-preview', () => {
  // These drive the SAME functions `PreviewPlayer` wires in, rather than a copy
  // of the rule — mounting the preview stack would need a real canvas and a
  // decoder, but the rule itself is pure and belongs under test either way.
  const makeTimeSink = gateTimeSink

  it('drops the seek echo while hover-previewing, so the playhead stays put', () => {
    // Showing a hovered frame seeks the source, and that seek reports its new
    // position back. Unguarded, that is exactly what dragged the red playhead
    // after the yellow cursor.
    const clock = createPlaybackClock()
    const hover = createHoverScrub()
    const sink = makeTimeSink(clock, hover)
    clock.set(10)

    hover.set(42)
    sink(42)   // the echo of the hover seek
    sink(42.5) // and the tick after it

    expect(clock.get()).toBe(10)
  })

  it('lets playback through once the override is gone', () => {
    const clock = createPlaybackClock()
    const hover = createHoverScrub()
    const sink = makeTimeSink(clock, hover)
    clock.set(10)

    hover.set(42)
    sink(42)
    expect(clock.get()).toBe(10)

    hover.set(null)
    sink(42.1)
    expect(clock.get()).toBe(42.1)
  })

  it('hands the playhead over to the hovered frame when playback starts', () => {
    // Play from the yellow line, and bring the red one with it, so the two
    // agree rather than the playhead being stranded at its pre-hover position.
    const clock = createPlaybackClock()
    const hover = createHoverScrub()
    clock.set(10)
    hover.set(42)

    expect(handOverToHover(clock, hover)).toBe(true)
    expect(clock.get()).toBe(42)
    expect(hover.get()).toBeNull()
  })

  it('leaves the playhead alone when play starts with no hover standing', () => {
    // Every ordinary press of play: nothing hovered, nothing to hand over.
    const clock = createPlaybackClock()
    const hover = createHoverScrub()
    clock.set(10)

    expect(handOverToHover(clock, hover)).toBe(false)
    expect(clock.get()).toBe(10)
  })

  it('is a no-op for a host that never wired the store', () => {
    const clock = createPlaybackClock()
    clock.set(10)
    expect(handOverToHover(clock, undefined)).toBe(false)
    gateTimeSink(clock, undefined)(3)
    expect(clock.get()).toBe(3)
  })

  it('resumes writing straight after the hand-over', () => {
    // The tick right after play must land, or the playhead would freeze at the
    // hand-over point while the picture kept moving.
    const clock = createPlaybackClock()
    const hover = createHoverScrub()
    const sink = gateTimeSink(clock, hover)
    hover.set(42)
    handOverToHover(clock, hover)

    sink(42.2)
    sink(42.4)
    expect(clock.get()).toBe(42.4)
  })
})
