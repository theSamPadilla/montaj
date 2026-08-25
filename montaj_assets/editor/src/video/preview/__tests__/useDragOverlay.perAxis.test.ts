import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { useDragOverlay, type OverlayChanges } from '../useDragOverlay'

// Per-axis resize (scaleX/scaleY) in the preview drag hook.
//
// Two things are load-bearing here and neither is visible from the component:
//
//  1. The RESIZE MATH. A corner drag scales both axes by one shared delta —
//     which on a uniform item reduces to the exact pre-per-axis formula, so the
//     existing feel is unchanged. An edge drag scales ONE axis: e/w the X axis,
//     n/s the Y axis.
//  2. The COMMIT SHAPE. A corner drag of an item that has never carried
//     scaleX/scaleY writes only `scale`, so nudging a legacy item does not
//     silently migrate it to per-axis storage. An edge drag, or any drag of an
//     item that already carries per-axis values, writes both axes.
//
// The hook listens on `document` for native mouse events, so these dispatch real
// MouseEvents rather than going through fireEvent (which drops clientX/clientY).

// 100×100 container makes a 1px move exactly 1% — every delta below reads
// directly as a percentage.
function makeContainer() {
  return {
    current: {
      getBoundingClientRect: () => ({ width: 100, height: 100, left: 0, top: 0, right: 100, bottom: 100 }),
    },
  } as unknown as React.RefObject<HTMLDivElement | null>
}

interface StartOpts {
  type: string
  initScale?: number
  initScaleX?: number
  initScaleY?: number
  initHasPerAxis?: boolean
  initOffsetX?: number
  initOffsetY?: number
}

/** Run one full gesture: mousedown state → mousemove(to) → mouseup. */
function drag(start: StartOpts, to: { x: number; y: number }) {
  const onOverlayChange = vi.fn()
  const hook = renderHook(() => useDragOverlay(makeContainer(), onOverlayChange))

  act(() => {
    hook.result.current.setDragState({
      id: 'i1',
      type: start.type as never,
      initX: 0,
      initY: 0,
      initOffsetX: start.initOffsetX ?? 0,
      initOffsetY: start.initOffsetY ?? 0,
      initScale: start.initScale ?? 1,
      initScaleX: start.initScaleX,
      initScaleY: start.initScaleY,
      initHasPerAxis: start.initHasPerAxis,
      initRotation: 0,
    })
  })

  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: to.x, clientY: to.y }))
  })
  const liveScale = hook.result.current.liveScale
  const snapGuides = hook.result.current.snapGuides

  act(() => { document.dispatchEvent(new MouseEvent('mouseup')) })

  const changes: OverlayChanges | undefined = onOverlayChange.mock.calls[0]?.[1]
  return { changes, liveScale, snapGuides, onOverlayChange }
}

describe('useDragOverlay — corner resize (uniform gesture, unchanged)', () => {
  it('scales both axes by the same delta', () => {
    // se: dirX=+1, dirY=+1 → delta = (10 + 10)/100 = 0.2
    const { liveScale } = drag({ type: 'resize-se' }, { x: 10, y: 10 })
    expect(liveScale!.scaleX).toBeCloseTo(1.2)
    expect(liveScale!.scaleY).toBeCloseTo(1.2)
    expect(liveScale!.scale).toBeCloseTo(1.2)
  })

  it('still reproduces the pre-per-axis formula exactly', () => {
    const initScale = 1.7
    const { liveScale } = drag({ type: 'resize-nw', initScale }, { x: -6, y: -4 })
    // nw: dirX=-1, dirY=-1 → delta = ((-6)*-1 + (-4)*-1)/100 = 0.1
    expect(liveScale!.scale).toBeCloseTo(initScale * 1.1)
    expect(liveScale!.scaleX).toBeCloseTo(initScale * 1.1)
  })

  it('COMMITS ONLY `scale` for an item with no per-axis values (legacy stays legacy)', () => {
    const { changes } = drag({ type: 'resize-se' }, { x: 10, y: 10 })
    expect(Object.keys(changes!).sort()).toEqual(['scale'])
    expect(changes!.scale).toBeCloseTo(1.2)
    expect(changes!.scaleX).toBeUndefined()
    expect(changes!.scaleY).toBeUndefined()
  })

  it('commits both axes for an item that ALREADY carries per-axis values', () => {
    const { changes } = drag(
      { type: 'resize-se', initScale: 1, initScaleX: 2, initScaleY: 0.5, initHasPerAxis: true },
      { x: 10, y: 10 },
    )
    expect(changes!.scaleX).toBeCloseTo(2.4)
    expect(changes!.scaleY).toBeCloseTo(0.6)
    // Aspect ratio survives a corner drag of a non-uniform item.
    expect(changes!.scaleX! / changes!.scaleY!).toBeCloseTo(4)
  })
})

describe('useDragOverlay — edge resize (single axis)', () => {
  it('`e` grows X only and leaves Y alone', () => {
    const { changes } = drag({ type: 'resize-e' }, { x: 10, y: 40 })
    expect(changes!.scaleX).toBeCloseTo(1.1)
    expect(changes!.scaleY).toBe(1)          // vertical mouse travel is ignored
  })

  it('`w` inverts the direction', () => {
    const { changes } = drag({ type: 'resize-w' }, { x: 10, y: 0 })
    expect(changes!.scaleX).toBeCloseTo(0.9)
    expect(changes!.scaleY).toBe(1)
  })

  it('`s` grows Y only', () => {
    const { changes } = drag({ type: 'resize-s' }, { x: 40, y: 10 })
    expect(changes!.scaleX).toBe(1)          // horizontal mouse travel is ignored
    expect(changes!.scaleY).toBeCloseTo(1.1)
  })

  it('`n` inverts the direction', () => {
    const { changes } = drag({ type: 'resize-n' }, { x: 0, y: 10 })
    expect(changes!.scaleY).toBeCloseTo(0.9)
  })

  it('COMMITS BOTH AXES even on a legacy item — an edge drag is per-axis by definition', () => {
    const { changes } = drag({ type: 'resize-e' }, { x: 10, y: 0 })
    expect(Object.keys(changes!).sort()).toEqual(['scale', 'scaleX', 'scaleY'])
    // The uniform knob is untouched: only a corner drag moves it.
    expect(changes!.scale).toBe(1)
  })

  it('starts from the resolved per-axis base, not the uniform scale', () => {
    const { changes } = drag(
      { type: 'resize-e', initScale: 1, initScaleX: 3, initScaleY: 0.25, initHasPerAxis: true },
      { x: 10, y: 0 },
    )
    expect(changes!.scaleX).toBeCloseTo(3.3)
    expect(changes!.scaleY).toBeCloseTo(0.25)
  })
})

describe('useDragOverlay — resize floor', () => {
  it('floors each axis at 0.1 independently', () => {
    const corner = drag({ type: 'resize-se' }, { x: -100, y: -100 })
    expect(corner.changes!.scale).toBe(0.1)

    const edge = drag({ type: 'resize-e' }, { x: -500, y: 0 })
    expect(edge.changes!.scaleX).toBe(0.1)
    expect(edge.changes!.scaleY).toBe(1)     // the untouched axis is not floored
  })
})

describe('useDragOverlay — per-axis edge snap while moving', () => {
  // Element is inset-0 then scaled from center, so its edge meets the frame's at
  // offset ±(0.5 - s/2)*100. At s=1 that is 0 — indistinguishable from the center
  // snap — so an axis at scale 1 has no edge snap at all. Per axis, that means a
  // half-width/full-height item snaps left/right but never top/bottom.
  it('a narrow item snaps on X and not on Y', () => {
    const { changes, snapGuides } = drag(
      { type: 'move', initScale: 1, initScaleX: 0.5, initScaleY: 1 },
      { x: -24, y: 40 },
    )
    expect(snapGuides.left).toBe(true)
    expect(changes!.offsetX).toBeCloseTo(-25)   // snapped to the left edge
    expect(snapGuides.top).toBe(false)
    expect(snapGuides.bottom).toBe(false)
    expect(changes!.offsetY).toBeCloseTo(40)    // untouched
  })

  it('a short item snaps on Y and not on X', () => {
    const { changes, snapGuides } = drag(
      { type: 'move', initScale: 1, initScaleX: 1, initScaleY: 0.5 },
      { x: -24, y: -24 },
    )
    expect(snapGuides.top).toBe(true)
    expect(changes!.offsetY).toBeCloseTo(-25)
    expect(snapGuides.left).toBe(false)
    expect(changes!.offsetX).toBeCloseTo(-24)   // no X edge to snap to at scale 1
  })

  it('a uniform scaled-down item still snaps on both axes (no regression)', () => {
    const { snapGuides } = drag({ type: 'move', initScale: 0.5 }, { x: -24, y: -24 })
    expect(snapGuides.left).toBe(true)
    expect(snapGuides.top).toBe(true)
  })
})
