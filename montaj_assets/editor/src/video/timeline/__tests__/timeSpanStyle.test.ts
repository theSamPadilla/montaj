/// <reference types="vitest/globals" />
/**
 * Where a DOM row places a time span. Two coordinate spaces share one helper on
 * purpose: the caption row and the playhead line drawn across it must agree, or
 * the line crosses its segments at the wrong instant.
 */
import { describe, it, expect } from 'vitest'
import { timeSpanStyle } from '../utils'
import type { Viewport } from '../canvas/viewport'

const viewport: Viewport = { pxPerSecond: 100, scrollSeconds: 2, widthPx: 1000 }

describe('timeSpanStyle', () => {
  describe('legacy DOM mode (no viewport)', () => {
    it('lays a span out as a percentage of the whole project', () => {
      expect(timeSpanStyle(2, 4, 10, null)).toEqual({ left: '20%', width: '20%' })
    })

    it('gives a zero-width line a left and no width', () => {
      expect(timeSpanStyle(5, null, 10, null)).toEqual({ left: '50%' })
    })
  })

  describe('canvas mode', () => {
    it('lays a span out in pixels off the viewport, honouring its scroll', () => {
      // scrolled to 2s at 100px/s: t=2 is the left edge, t=4 is 200px in.
      expect(timeSpanStyle(2, 4, 10, viewport)).toEqual({ left: '0px', width: '200px' })
    })

    it('places a zero-width line at the same x the canvas would draw it', () => {
      expect(timeSpanStyle(5, null, 10, viewport)).toEqual({ left: '300px' })
    })

    it('ignores totalDuration entirely — zoom, not project length, sets the scale', () => {
      // The bug this fixes: a row laid out as a fraction of the project drifts
      // from the canvas the moment you zoom. Same inputs, different project
      // length, same answer.
      expect(timeSpanStyle(5, 6, 10, viewport)).toEqual(timeSpanStyle(5, 6, 999, viewport))
    })

    it('scrolls off to a negative left rather than clamping, so spans keep their span', () => {
      // Clamping here would stretch a partly-scrolled-off segment instead of
      // sliding it; the row's own `overflow-hidden` does the clipping.
      expect(timeSpanStyle(0, 1, 10, viewport)).toEqual({ left: '-200px', width: '100px' })
    })

    it('never emits a negative width for an inverted span', () => {
      expect(timeSpanStyle(4, 2, 10, viewport)).toEqual({ left: '200px', width: '0px' })
    })
  })
})
