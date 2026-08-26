/// <reference types="vitest/globals" />
import { useRef } from 'react'
import { act, render } from '@testing-library/react'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import { useDragOverlay, type OverlayChanges } from '../useDragOverlay'
import OverlayItemsLayer from '../OverlayItemsLayer'

// The selected-overlay treatment (Part C).
//
// A selected OVERLAY and a selected base CLIP must look like the same object:
// one 2px `--editor-selection` outline plus white square handles. The clip's
// box is PreviewPlayer.tsx (~:526-559) and it was already there; this file
// pins the overlay onto the same language, and pins the thing that treatment
// exists to expose — EIGHT handles, four of which resize a SINGLE axis.
//
// Two of these describes drive real gestures rather than inspecting markup,
// because the wiring is what can silently break: `useDragOverlay` has known
// per-axis math (useDragOverlay.perAxis.test.ts proves it in isolation), so
// the only thing left to get wrong is which drag type each handle sends. The
// gestures dispatch native MouseEvents with explicit coordinates — the same
// approach useDragOverlay.perAxis.test.ts takes, and for the same reason: the
// hook listens on `document`, and fireEvent's synthetic path is not a reliable
// carrier for clientX/clientY in this setup. A gesture test that asserts
// nothing is worse than no gesture test at all.

const _emptySnap = { x: false, y: false, left: false, right: false, top: false, bottom: false }

// 100×100 makes one pixel of mouse travel exactly 1%, so every delta below
// reads directly as a percentage of scale.
const RECT = { width: 100, height: 100, left: 0, top: 0, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect

function makeProject(): EditorProject {
  return {
    id: 'p',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [[]],
  } as unknown as EditorProject
}

/**
 * The layer wired to the REAL drag hook, so a mousedown on a handle travels the
 * whole path a user's does: handle → setDragState → document listeners →
 * onOverlayChange. Passing a stubbed hook here would let a mis-wired handle
 * pass.
 */
function Harness({ item, selected = true, onTrack0 = false, onOverlayChange }: {
  item: VisualItem
  selected?: boolean
  /** Route the item through the tracks[0] background-image branch instead. */
  onTrack0?: boolean
  onOverlayChange?: (id: string, changes: OverlayChanges) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const drag = useDragOverlay(containerRef, onOverlayChange)
  return (
    <div
      ref={(el) => {
        // jsdom lays nothing out, so the hook's percentage math would divide by
        // a zero-width rect without this.
        if (el) el.getBoundingClientRect = () => RECT
        containerRef.current = el
      }}
    >
      <OverlayItemsLayer
        project={makeProject()}
        currentTime={1}
        isPlaying={false}
        isCanvasProject={false}
        overlayTracks={onTrack0 ? [] : [[item]]}
        tracks0NonVideo={onTrack0 ? [item] : []}
        renderScale={0.2}
        selectedOverlayId={selected ? item.id : undefined}
        containerRef={containerRef}
        dragState={drag.dragState}
        setDragState={drag.setDragState}
        liveOffset={drag.liveOffset}
        liveScale={drag.liveScale}
        liveRotation={drag.liveRotation}
        snapGuides={drag.snapGuides}
        snapRotation={drag.snapRotation}
        onOverlayChange={onOverlayChange}
        compileOverlay={vi.fn(async (): Promise<OverlayFactory> => () => null)}
        fileUrl={(pth: string) => pth}
      />
    </div>
  )
}

const overlay = (over: Partial<VisualItem> = {}): VisualItem => ({
  id: 'sel', type: 'overlay', src: 'o.jsx', start: 0, end: 10, props: {}, ...over,
} as VisualItem)

/**
 * The item's wrapper. `container` is RTL's own div, whose only child is the
 * harness's container div; the wrapper is that div's first child.
 */
function wrapperOf(container: HTMLElement): HTMLElement {
  const harness = container.firstElementChild as HTMLElement
  return harness.firstElementChild as HTMLElement
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('OverlayItemsLayer — selection box', () => {
  it('draws a 2px --editor-selection outline on the selected item', () => {
    const { container } = render(<Harness item={overlay()} />)
    expect(wrapperOf(container).style.outline).toBe('2px solid var(--editor-selection)')
  })

  it('draws NO outline when the item is not selected', () => {
    const { container } = render(<Harness item={overlay()} selected={false} />)
    expect(wrapperOf(container).style.outline).toBe('')
  })

  it('renders EIGHT resize handles — four corners and four edge midpoints', () => {
    const { container } = render(<Harness item={overlay()} />)
    const handles = Array.from(container.querySelectorAll('[data-handle]'))
    expect(handles).toHaveLength(8)
    expect(handles.map(h => h.getAttribute('data-handle')).sort())
      .toEqual(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w'])
  })

  it('gives each handle the cursor its axis implies', () => {
    const { container } = render(<Harness item={overlay()} />)
    const cursorOf = (h: string) =>
      (container.querySelector(`[data-handle="${h}"]`) as HTMLElement).className
    expect(cursorOf('n')).toContain('cursor-ns-resize')
    expect(cursorOf('s')).toContain('cursor-ns-resize')
    expect(cursorOf('e')).toContain('cursor-ew-resize')
    expect(cursorOf('w')).toContain('cursor-ew-resize')
    // Corners keep their diagonal cursors.
    expect(cursorOf('nw')).toContain('cursor-nw-resize')
    expect(cursorOf('se')).toContain('cursor-se-resize')
  })

  it('handles are white squares bordered in the selection token, not amber', () => {
    const { container } = render(<Harness item={overlay()} />)
    for (const h of Array.from(container.querySelectorAll('[data-handle]'))) {
      const el = h as HTMLElement
      expect(el.style.backgroundColor).toBe('rgb(255, 255, 255)')
      expect(el.style.border).toBe('1.5px solid var(--editor-selection)')
      expect(el.style.width).toBe('12px')
      expect(el.style.height).toBe('12px')
    }
  })

  it('leaves NO amber anywhere in the selected-overlay subtree', () => {
    // Covers the box, all eight handles, the rotate handle and the fit control
    // in one sweep — an image item so the fit control is on screen too.
    const item = { id: 'sel-img', type: 'image', src: 'i.png', start: 0, end: 10 } as VisualItem
    const { container } = render(<Harness item={item} onOverlayChange={vi.fn()} />)

    expect(container.querySelectorAll('[class*="amber"]')).toHaveLength(0)
    expect(container.innerHTML).not.toContain('amber')
    // …and the amber literal the rotation guide used to hardcode.
    expect(container.innerHTML).not.toContain('251 191 36')
    // Positive control: the treatment really is drawn, so the assertions above
    // cannot pass simply because nothing rendered.
    expect(container.querySelectorAll('[data-handle]')).toHaveLength(8)
    expect(container.innerHTML).toContain('var(--editor-selection)')
  })

  it('gives a tracks[0] background image the SAME treatment', () => {
    // That branch draws its own selection box and handles, separately from the
    // interactive-tracks branch every other test here exercises — so it can
    // drift back to amber on its own.
    const item = { id: 'bg', type: 'image', src: 'bg.png', start: 0, end: 10 } as VisualItem
    const { container } = render(<Harness item={item} onTrack0 onOverlayChange={vi.fn()} />)

    expect(wrapperOf(container).style.outline).toBe('2px solid var(--editor-selection)')
    expect(container.querySelectorAll('[data-handle]')).toHaveLength(8)
    expect(container.querySelectorAll('[class*="amber"]')).toHaveLength(0)
    expect(container.innerHTML).not.toContain('amber')
  })

  it('a tracks[0] edge handle also drives a single axis', () => {
    const onOverlayChange = vi.fn()
    const item = { id: 'bg', type: 'image', src: 'bg.png', start: 0, end: 10, scaleX: 2, scaleY: 0.5 } as VisualItem
    const { container } = render(<Harness item={item} onTrack0 onOverlayChange={onOverlayChange} />)

    dragHandle(container, 'e', { x: 10, y: 40 })

    const changes = onOverlayChange.mock.calls[0][1] as OverlayChanges
    expect(changes.scaleX).toBeCloseTo(2.2)
    expect(changes.scaleY).toBe(0.5)
  })

  it('counter-scales every handle per axis so it stays SQUARE under scaleX ≠ scaleY', () => {
    const { container } = render(<Harness item={overlay({ scaleX: 4, scaleY: 0.5 } as Partial<VisualItem>)} />)
    for (const h of Array.from(container.querySelectorAll('[data-handle]'))) {
      // 1/4 on X and 1/0.5 on Y. Counter-scaling one axis only — the bug this
      // guards — would read `scale(0.25, 0.25)` and render a 12×96 sliver.
      expect((h as HTMLElement).style.transform).toBe('scale(0.25, 2) translate(-50%, -50%)')
    }
    const rotate = container.querySelector('.cursor-grab.flex-col') as HTMLElement
    expect(rotate.style.transform).toBe('translateX(-50%) translateY(-100%) scale(0.25, 2)')
  })
})

// ---------------------------------------------------------------------------
// Gestures. `initX`/`initY` come from the mousedown, so every drag below starts
// at (0,0) and the mousemove coordinate IS the delta in percent.
// ---------------------------------------------------------------------------

/** Full gesture on one handle: mousedown → mousemove → mouseup. */
function dragHandle(container: HTMLElement, handle: string, to: { x: number; y: number }) {
  const el = container.querySelector(`[data-handle="${handle}"]`) as HTMLElement
  expect(el).toBeTruthy()
  act(() => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 }))
  })
  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: to.x, clientY: to.y }))
  })
  const midDrag = wrapperOf(container).style.transform
  act(() => { document.dispatchEvent(new MouseEvent('mouseup')) })
  return { midDrag }
}

describe('OverlayItemsLayer — edge handles drive a SINGLE axis', () => {
  // Per-axis from the start, so the commit writes both fields and each one's
  // value is directly checkable (a legacy uniform item would commit `scale`
  // alone on a corner drag — covered separately below).
  const perAxis = () => overlay({ scaleX: 2, scaleY: 0.5 } as Partial<VisualItem>)

  it('`e` writes scaleX and leaves scaleY at its starting value', () => {
    const onOverlayChange = vi.fn()
    const { container } = render(<Harness item={perAxis()} onOverlayChange={onOverlayChange} />)

    // 10% right AND 40% down: the vertical travel must be ignored entirely.
    const { midDrag } = dragHandle(container, 'e', { x: 10, y: 40 })

    const changes = onOverlayChange.mock.calls[0][1] as OverlayChanges
    expect(changes.scaleX).toBeCloseTo(2.2)   // 2 × (1 + 0.10)
    expect(changes.scaleY).toBe(0.5)          // untouched
    expect(changes.scale).toBe(1)             // the uniform knob is corner-only
    // The box the user is watching moved on X only.
    expect(midDrag).toContain('scale(2.2, 0.5)')
  })

  it('`w` writes scaleX in the opposite direction, still leaving scaleY alone', () => {
    const onOverlayChange = vi.fn()
    const { container } = render(<Harness item={perAxis()} onOverlayChange={onOverlayChange} />)

    dragHandle(container, 'w', { x: 10, y: 0 })

    const changes = onOverlayChange.mock.calls[0][1] as OverlayChanges
    expect(changes.scaleX).toBeCloseTo(1.8)   // 2 × (1 − 0.10)
    expect(changes.scaleY).toBe(0.5)
  })

  it('`s` writes scaleY and leaves scaleX at its starting value', () => {
    const onOverlayChange = vi.fn()
    const { container } = render(<Harness item={perAxis()} onOverlayChange={onOverlayChange} />)

    // 40% right AND 10% down: the horizontal travel must be ignored entirely.
    const { midDrag } = dragHandle(container, 's', { x: 40, y: 10 })

    const changes = onOverlayChange.mock.calls[0][1] as OverlayChanges
    expect(changes.scaleY).toBeCloseTo(0.55)  // 0.5 × (1 + 0.10)
    expect(changes.scaleX).toBe(2)            // untouched
    expect(midDrag).toContain('scale(2, 0.55)')
  })

  it('`n` writes scaleY in the opposite direction, still leaving scaleX alone', () => {
    const onOverlayChange = vi.fn()
    const { container } = render(<Harness item={perAxis()} onOverlayChange={onOverlayChange} />)

    dragHandle(container, 'n', { x: 0, y: 10 })

    const changes = onOverlayChange.mock.calls[0][1] as OverlayChanges
    expect(changes.scaleY).toBeCloseTo(0.45)  // 0.5 × (1 − 0.10)
    expect(changes.scaleX).toBe(2)
  })
})

describe('OverlayItemsLayer — corner handles scale BOTH axes', () => {
  it('`se` moves scaleX and scaleY together, preserving aspect ratio', () => {
    const onOverlayChange = vi.fn()
    const { container } = render(
      <Harness item={overlay({ scaleX: 2, scaleY: 0.5 } as Partial<VisualItem>)} onOverlayChange={onOverlayChange} />,
    )

    const { midDrag } = dragHandle(container, 'se', { x: 10, y: 10 })

    const changes = onOverlayChange.mock.calls[0][1] as OverlayChanges
    // One shared delta of (10 + 10)/100 = 0.2 applied to both axes.
    expect(changes.scaleX).toBeCloseTo(2.4)
    expect(changes.scaleY).toBeCloseTo(0.6)
    expect(changes.scaleX! / changes.scaleY!).toBeCloseTo(4)
    expect(midDrag).toContain('scale(2.4, 0.6)')
  })

  it('a corner drag of a LEGACY uniform item still commits `scale` alone', () => {
    // The asymmetry is deliberate (see useDragOverlay `onUp`): the new edge
    // handles must not drag legacy items into per-axis storage behind a corner
    // gesture that never asked for it.
    const onOverlayChange = vi.fn()
    const { container } = render(
      <Harness item={overlay({ scale: 1 } as Partial<VisualItem>)} onOverlayChange={onOverlayChange} />,
    )

    dragHandle(container, 'nw', { x: -10, y: -10 })

    const changes = onOverlayChange.mock.calls[0][1] as OverlayChanges
    expect(Object.keys(changes).sort()).toEqual(['scale'])
    expect(changes.scale).toBeCloseTo(1.2)
  })

  it('an EDGE drag of a legacy uniform item commits both axes', () => {
    const onOverlayChange = vi.fn()
    const { container } = render(
      <Harness item={overlay({ scale: 1 } as Partial<VisualItem>)} onOverlayChange={onOverlayChange} />,
    )

    dragHandle(container, 'e', { x: 10, y: 0 })

    const changes = onOverlayChange.mock.calls[0][1] as OverlayChanges
    expect(Object.keys(changes).sort()).toEqual(['scale', 'scaleX', 'scaleY'])
    expect(changes.scaleX).toBeCloseTo(1.1)
    expect(changes.scaleY).toBe(1)
  })
})
