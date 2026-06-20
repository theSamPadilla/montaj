import { describe, it, expect } from 'vitest'
import { effectiveInPoint, effectiveOutPoint } from '../useVideoPlayback'

// These helpers mirror render's collectAllItems rebase (render.js): when the
// preview loads a normalizedSrc window cache (which starts at 0 and covers
// [inPoint, outPoint] of the original), the effective seek inPoint is 0 and the
// outPoint is rebased to the window length. nobg_preview_src is the full source
// and must NOT rebase.

describe('effectiveInPoint', () => {
  it('rebases to 0 when normalizedSrc is the chosen src', () => {
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
})

describe('effectiveOutPoint', () => {
  it('rebases to the window length (outPoint - inPoint) for a normalizedSrc cache', () => {
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
})
