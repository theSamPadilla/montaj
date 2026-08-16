import { describe, it, expect } from 'vitest'
import { sourceWindow } from '@bycrux/timeline-core'
import { effectiveInPoint, effectiveOutPoint } from '../useVideoPlayback'

// `effectiveInPoint` / `effectiveOutPoint` are thin wrappers over
// @bycrux/timeline-core's `sourceWindow(clip, 'preview')` — the single
// implementation shared with render's collectAllItems (render.js). When the
// preview loads a normalizedSrc window cache (which plays from its own 0 and
// covers [normalizedInPoint, +duration] of the original), the points are
// rebased by the cache origin. nobg_preview_src is the full source and must NOT
// rebase.
//
// The cases below are unchanged from before the timeline-core rebase and are
// kept here as the EDITOR's own guard: they pin the numbers the preview seeks
// to, whatever the wrappers delegate to. The equivalence block at the bottom
// pins the delegation itself. timeline-core/test/source-window.test.mjs owns the
// exhaustive matrix (both variants, degenerate items, bad-variant throws).

describe('effectiveInPoint', () => {
  it('rebases to 0 when normalizedSrc is the chosen src (legacy: no normalizedInPoint)', () => {
    // Legacy: no normalizedInPoint → origin defaults to inPoint → effectiveInPoint = 0
    expect(effectiveInPoint({ inPoint: 496.92, normalizedSrc: '/cache/window.mp4' })).toBe(0)
  })

  it('returns clip.inPoint when there is no normalizedSrc', () => {
    expect(effectiveInPoint({ inPoint: 496.92, src: '/orig.mov' })).toBe(496.92)
  })

  it('does NOT rebase when nobg_preview_src takes precedence over normalizedSrc', () => {
    // nobg_preview_src wins in playbackSrcFor and covers the full source.
    expect(
      effectiveInPoint({ inPoint: 496.92, nobg_preview_src: '/nobg.webm', normalizedSrc: '/cache/window.mp4' }),
    ).toBe(496.92)
  })

  it('defaults to 0 when inPoint is absent and no cache', () => {
    expect(effectiveInPoint({ src: '/orig.mov' })).toBe(0)
  })

  // Regression: trim-after-cache — cache origin 0, inPoint trimmed to 0.9157
  it('rebases by normalizedInPoint=0 after a start-trim (cache origin 0, inPoint 0.9157)', () => {
    // Cache was built at origin 0. User trimmed the start to 0.9157.
    // effectiveInPoint should be 0.9157 - 0 = 0.9157, NOT 0.
    expect(
      effectiveInPoint({ inPoint: 0.9157, normalizedInPoint: 0, normalizedSrc: '/cache/window.mp4' }),
    ).toBeCloseTo(0.9157, 5)
  })

  it('rebases by a non-zero normalizedInPoint (cache origin 5, inPoint 6)', () => {
    expect(
      effectiveInPoint({ inPoint: 6, normalizedInPoint: 5, normalizedSrc: '/cache/window.mp4' }),
    ).toBeCloseTo(1, 5)
  })
})

describe('effectiveOutPoint', () => {
  it('rebases to the window length (outPoint - inPoint) for a normalizedSrc cache (legacy: no normalizedInPoint)', () => {
    // original inPoint 496.92, outPoint 514.92 → 18s window cache
    expect(
      effectiveOutPoint({ inPoint: 496.92, outPoint: 514.92, normalizedSrc: '/cache/window.mp4' }),
    ).toBeCloseTo(18, 5)
  })

  it('returns the stored outPoint when there is no cache', () => {
    expect(effectiveOutPoint({ inPoint: 496.92, outPoint: 514.92, src: '/orig.mov' })).toBe(514.92)
  })

  it('does NOT rebase when nobg_preview_src takes precedence', () => {
    expect(
      effectiveOutPoint({ inPoint: 496.92, outPoint: 514.92, nobg_preview_src: '/nobg.webm', normalizedSrc: '/c.mp4' }),
    ).toBe(514.92)
  })

  it('returns undefined when no outPoint is stored', () => {
    expect(effectiveOutPoint({ inPoint: 496.92, normalizedSrc: '/cache/window.mp4' })).toBeUndefined()
  })

  // Regression: trim-after-cache — cache origin 0, inPoint 0.9157, outPoint 16.97
  it('rebases outPoint by normalizedInPoint=0 after a start-trim', () => {
    // Cache was built at origin 0. User trimmed start to 0.9157.
    // effectiveOutPoint = 16.97 - 0 = 16.97, NOT 16.97 - 0.9157.
    expect(
      effectiveOutPoint({ inPoint: 0.9157, outPoint: 16.97, normalizedInPoint: 0, normalizedSrc: '/cache/window.mp4' }),
    ).toBeCloseTo(16.97, 5)
  })

  it('rebases outPoint by a non-zero normalizedInPoint (cache origin 5, outPoint 20)', () => {
    expect(
      effectiveOutPoint({ inPoint: 6, outPoint: 20, normalizedInPoint: 5, normalizedSrc: '/cache/window.mp4' }),
    ).toBeCloseTo(15, 5)
  })
})

// The wrappers must stay wrappers: if someone reintroduces a local copy of the
// rebase math here, this block fails the moment the two implementations drift.
describe('delegation to @bycrux/timeline-core', () => {
  const CLIPS = [
    { inPoint: 496.92, src: '/orig.mov' },
    { inPoint: 496.92, outPoint: 514.92, normalizedSrc: '/cache/window.mp4' },
    { inPoint: 496.92, outPoint: 514.92, nobg_preview_src: '/nobg.webm', normalizedSrc: '/c.mp4' },
    { inPoint: 0.9157, outPoint: 16.97, normalizedInPoint: 0, normalizedSrc: '/cache/window.mp4' },
    { inPoint: 6, outPoint: 20, normalizedInPoint: 5, normalizedSrc: '/cache/window.mp4' },
    { src: '/orig.mov' },
    {},
  ]

  it.each(CLIPS)('matches sourceWindow(clip, "preview") for %j', (clip) => {
    const w = sourceWindow(clip, 'preview')
    expect(effectiveInPoint(clip)).toBe(w.inPoint)
    expect(effectiveOutPoint(clip)).toBe(w.outPoint)
  })
})
