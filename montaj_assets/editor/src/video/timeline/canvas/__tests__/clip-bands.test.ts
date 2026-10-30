/// <reference types="vitest/globals" />
/**
 * The frames/waveform split inside a video clip. Small, but two painters read
 * it independently — if the bands ever overlap or leave a gap, the filmstrip
 * paints over the waveform (or a stripe of clip fill shows through the seam)
 * at every zoom and on every project.
 */
import { describe, it, expect } from 'vitest'
import { CLIP_BAND_INSET_PX, CLIP_WAVEFORM_FRACTION, clipBands } from '../clip-bands'
import { BASE_VISUAL_ROW_RENDER_HEIGHT_PX, VISUAL_ROW_RENDER_HEIGHT_PX } from '../../timeline-model'
import type { Rect } from '../draw'

function rect(over: Partial<Rect> = {}): Rect {
  return { x: 0, y: 0, width: 200, height: BASE_VISUAL_ROW_RENDER_HEIGHT_PX, ...over }
}

describe('clipBands', () => {
  it('gives a base-track clip a slim waveform band: a third, 40 of 120', () => {
    const { frames, waveform } = clipBands(rect())
    expect(frames.height).toBe(80)
    expect(waveform.height).toBe(40)
  })

  it('fills the clip edge to edge: no inset at the top or bottom', () => {
    expect(CLIP_BAND_INSET_PX).toBe(0)
    const r = rect({ y: 40 })
    const { frames, waveform } = clipBands(r)
    expect(frames.y).toBe(40)
    expect(waveform.y + waveform.height).toBe(40 + r.height)
  })

  it('stacks the waveform directly under the frames, with no seam gap', () => {
    const { frames, waveform } = clipBands(rect())
    expect(waveform.y).toBe(frames.y + frames.height)
  })

  it('keeps both bands inside the clip, clear of the border the painter strokes', () => {
    const r = rect({ y: 40 })
    const { frames, waveform } = clipBands(r)
    expect(frames.y).toBe(r.y + CLIP_BAND_INSET_PX)
    expect(waveform.y + waveform.height).toBe(r.y + r.height - CLIP_BAND_INSET_PX)
  })

  it('conserves the full height at an awkward height, rounding into the frames band', () => {
    // 41 / 3 = 13.67: the waveform rounds to 14 and frames absorb the
    // remaining 27, rather than both rounding up and overflowing the clip.
    const { frames, waveform } = clipBands(rect({ height: 41 }))
    expect(frames.height + waveform.height).toBe(41)
    expect(waveform.height).toBe(14)
    expect(frames.height).toBe(27)
  })

  it('spans the clip\'s full width in both bands', () => {
    const r = rect({ x: 17, width: 340 })
    const { frames, waveform } = clipBands(r)
    for (const band of [frames, waveform]) {
      expect(band.x).toBe(r.x)
      expect(band.width).toBe(r.width)
    }
  })

  it('gives a non-base row the same split at its shorter height', () => {
    // Overlay rows carry no waveform, so the split is defined there but the
    // waveform band is never drawn into.
    const { frames, waveform } = clipBands(rect({ height: VISUAL_ROW_RENDER_HEIGHT_PX }))
    expect(frames.height).toBe(32) // 48 - 16
    expect(waveform.height).toBe(16)
  })

  it('drops the inset rather than inverting it on a rect too short to hold one', () => {
    const { frames, waveform } = clipBands(rect({ height: 3 }))
    expect(frames.y).toBe(0)
    expect(frames.height + waveform.height).toBe(3)
  })

  it('yields zero-height bands for a zero-height rect, which every painter skips', () => {
    const { frames, waveform } = clipBands(rect({ height: 0 }))
    expect(frames.height).toBe(0)
    expect(waveform.height).toBe(0)
  })

  it('is a one-third waveform split — the fraction the two painters agree on', () => {
    expect(CLIP_WAVEFORM_FRACTION).toBeCloseTo(1 / 3)
  })
})
