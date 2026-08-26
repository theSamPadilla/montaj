/// <reference types="vitest/globals" />
/**
 * The pending-import ghost band — the placeholder drawn at the drop point
 * while the host is still probing/ingesting a file dropped from the OS.
 *
 * Driven through a recording context (the same technique draw.test.ts uses:
 * the rectangle a painter lands in IS its observable behaviour) rather than a
 * real canvas, so every assertion is on a specific rect, colour or string.
 *
 * Three things here can only be shown at the draw level, and each one is a
 * real bug if it regresses:
 *  - the band lands on the rect the caller asked for, at the viewport's own
 *    time→x mapping (a ghost drawn anywhere else points at the wrong second);
 *  - the dash is RESET before the painter returns — a leaked `setLineDash`
 *    would give this layer a dashed playhead;
 *  - an absent/empty `pendingDrops` paints nothing at all, which is what keeps
 *    the overlay layer byte-identical for every host that never passes one.
 */
import { describe, it, expect } from 'vitest'
import {
  DARK_TIMELINE_PALETTE,
  LIGHT_TIMELINE_PALETTE,
  PENDING_DROP_BORDER_PX,
  PENDING_DROP_DASH,
  PENDING_DROP_INSET_PX,
  PLAYHEAD_WIDTH_PX,
  drawPendingDropBand,
  drawTimelineOverlay,
  type DrawContext,
  type PendingDropBand,
} from '../draw'
import type { Viewport } from '../viewport'

// ── Recording context (draw.test.ts's, kept local so this file stands alone) ──

interface RecordedCall { method: string; args: unknown[] }

interface Recorder {
  ctx: DrawContext
  calls: RecordedCall[]
  of: (method: string) => RecordedCall[]
  count: (method: string) => number
}

function recordingContext(): Recorder {
  const calls: RecordedCall[] = []
  const props: Record<string, unknown> = {}

  const proxy = new Proxy({}, {
    get(_target, prop: string) {
      if (prop in props) return props[prop]
      return (...args: unknown[]) => { calls.push({ method: prop, args }) }
    },
    set(_target, prop: string, value: unknown) {
      props[prop] = value
      calls.push({ method: `set:${prop}`, args: [value] })
      return true
    },
  }) as unknown as DrawContext

  return {
    ctx: proxy,
    calls,
    of: (method: string) => calls.filter(c => c.method === method),
    count: (method: string) => calls.filter(c => c.method === method).length,
  }
}

function viewport(over: Partial<Viewport> = {}): Viewport {
  return { pxPerSecond: 10, scrollSeconds: 0, widthPx: 1000, ...over }
}

function band(over: Partial<PendingDropBand> = {}): PendingDropBand {
  return { start: 2, end: 5, y: 40, height: 120, ...over }
}

describe('drawPendingDropBand', () => {
  it('fills the band at the viewport position, inset inside its row', () => {
    const r = recordingContext()
    // 2s..5s at 10px/s → x=20, width=30. The row is 120 tall at y=40, so the
    // band takes 40+2 .. 158 (2px clear top and bottom).
    drawPendingDropBand(r.ctx, band(), viewport(), 1000)
    const fills = r.of('fill')
    expect(fills).toHaveLength(1)
    // roundRectPath starts at (x + radius, y).
    const [move] = r.of('moveTo')
    expect(move.args).toEqual([20 + 4, 40 + PENDING_DROP_INSET_PX])
    expect(r.of('set:fillStyle')[0].args[0]).toBe(DARK_TIMELINE_PALETTE.colors.pendingDropFill)
  })

  it('strokes the outline DASHED — the one mark that says "not real yet"', () => {
    const r = recordingContext()
    drawPendingDropBand(r.ctx, band(), viewport(), 1000)
    const dashes = r.of('setLineDash')
    expect(dashes[0].args[0]).toEqual([...PENDING_DROP_DASH])
    expect(r.of('set:strokeStyle')[0].args[0]).toBe(DARK_TIMELINE_PALETTE.colors.pendingDropStroke)
    expect(r.of('set:lineWidth')[0].args[0]).toBe(PENDING_DROP_BORDER_PX)
    expect(r.count('stroke')).toBe(1)
  })

  it('resets the dash before returning, so nothing painted later inherits it', () => {
    const r = recordingContext()
    drawPendingDropBand(r.ctx, band(), viewport(), 1000)
    const dashes = r.of('setLineDash')
    expect(dashes).toHaveLength(2)
    expect(dashes[1].args[0]).toEqual([])
    // And it happened after the stroke it was set for, not before it.
    const dashIdx = r.calls.findIndex((c, i) => c.method === 'setLineDash' && i > r.calls.findIndex(x => x.method === 'stroke'))
    expect(dashIdx).toBeGreaterThan(-1)
  })

  it('draws the label inside the band, clipped so a long filename cannot bleed out', () => {
    const r = recordingContext()
    drawPendingDropBand(r.ctx, band({ label: 'C0042.MP4' }), viewport(), 1000)
    const text = r.of('fillText')
    expect(text).toHaveLength(1)
    expect(text[0].args[0]).toBe('C0042.MP4')
    // Clipped to the band's own rect — the clip path is the plain rect, not
    // the rounded one the fill used.
    expect(r.of('rect')[0].args).toEqual([20, 42, 30, 116])
    expect(r.count('clip')).toBe(1)
  })

  it('draws no label at all when the band carries none', () => {
    const r = recordingContext()
    drawPendingDropBand(r.ctx, band(), viewport(), 1000)
    expect(r.count('fillText')).toBe(0)
    expect(r.count('clip')).toBe(0)
  })

  it('skips a band scrolled entirely off-screen', () => {
    const r = recordingContext()
    // 2s..5s with the view starting at 400s is 3980px to the left of x=0.
    drawPendingDropBand(r.ctx, band(), viewport({ scrollSeconds: 400 }), 1000)
    expect(r.count('fill')).toBe(0)
    expect(r.count('stroke')).toBe(0)
  })

  it('takes its colours from the palette it is handed, in both modes', () => {
    const dark = recordingContext()
    const light = recordingContext()
    drawPendingDropBand(dark.ctx, band({ label: 'a.mov' }), viewport(), 1000, DARK_TIMELINE_PALETTE)
    drawPendingDropBand(light.ctx, band({ label: 'a.mov' }), viewport(), 1000, LIGHT_TIMELINE_PALETTE)
    expect(dark.of('set:fillStyle').map(c => c.args[0])).toEqual([
      DARK_TIMELINE_PALETTE.colors.pendingDropFill,
      DARK_TIMELINE_PALETTE.colors.pendingDropText,
    ])
    expect(light.of('set:fillStyle').map(c => c.args[0])).toEqual([
      LIGHT_TIMELINE_PALETTE.colors.pendingDropFill,
      LIGHT_TIMELINE_PALETTE.colors.pendingDropText,
    ])
  })
})

describe('drawTimelineOverlay — pending drops', () => {
  it('paints a ghost band for each pending drop', () => {
    const r = recordingContext()
    drawTimelineOverlay(r.ctx, {
      viewport: viewport(),
      currentTime: 0,
      surfaceWidth: 1000,
      surfaceHeight: 200,
      pendingDrops: [band(), band({ start: 20, end: 24, y: 164, height: 40 })],
    })
    // Two ghost fills, each starting its rounded path at its own rect. Each
    // band lays TWO paths — the fill's, then the dashed outline's, inset by
    // half the stroke — so the fill paths are the even entries.
    const fillPaths = r.of('moveTo').filter((_, i) => i % 2 === 0).map(c => c.args)
    expect(fillPaths).toEqual([
      [24, 42],
      [204, 166],
    ])
    expect(r.of('fill')).toHaveLength(2)
  })

  it('paints nothing extra when there are no pending drops', () => {
    for (const pendingDrops of [undefined, []]) {
      const r = recordingContext()
      drawTimelineOverlay(r.ctx, {
        viewport: viewport(),
        currentTime: 5,
        surfaceWidth: 1000,
        surfaceHeight: 200,
        pendingDrops,
      })
      // The playhead's `fillRect` and nothing else: no path, no dash, no
      // stroke — this layer is byte-identical to what it was before ghosts.
      expect(r.count('fill')).toBe(0)
      expect(r.count('stroke')).toBe(0)
      expect(r.count('setLineDash')).toBe(0)
      expect(r.of('fillRect')).toHaveLength(1)
      expect(r.of('fillRect')[0].args).toEqual([50 - PLAYHEAD_WIDTH_PX / 2, 0, PLAYHEAD_WIDTH_PX, 200])
    }
  })

  it('draws the ghosts UNDER the playhead, which must stay legible over one', () => {
    const r = recordingContext()
    drawTimelineOverlay(r.ctx, {
      viewport: viewport(),
      currentTime: 3,
      surfaceWidth: 1000,
      surfaceHeight: 200,
      pendingDrops: [band()],
    })
    const ghostFill = r.calls.findIndex(c => c.method === 'fill')
    const playhead = r.calls.findIndex(c => c.method === 'fillRect')
    expect(ghostFill).toBeGreaterThan(-1)
    expect(playhead).toBeGreaterThan(ghostFill)
  })
})
