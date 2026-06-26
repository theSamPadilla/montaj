import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useItemDragDrop } from '../useItemDragDrop'

// A press that drifts < 4px must stay a CLICK (so the timeline's click-to-select
// fires); only a press that travels past the threshold becomes a drag. Regression
// guard for the bug where any pixel of jitter suppressed clip selection.

const RECT = {
  width: 1000, height: 100, left: 0, top: 0, right: 1000, bottom: 100, x: 0, y: 0,
  toJSON: () => ({}),
} as DOMRect

function setup() {
  const draggedFlagRef = { current: false }
  const scrollRef = { current: { getBoundingClientRect: () => RECT } }
  const { result } = renderHook(() =>
    useItemDragDrop({
      totalDuration: 100,
      snapBoundaries: [],
      scrollRef: scrollRef as unknown as React.RefObject<HTMLDivElement>,
      draggedFlagRef: draggedFlagRef as unknown as React.MutableRefObject<boolean>,
    }),
  )
  return { beginDrag: result.current.beginDrag, draggedFlagRef }
}

const ITEM = { id: 'a', start: 10, end: 20 }

function press(beginDrag: ReturnType<typeof setup>['beginDrag']) {
  const onLivePreview = vi.fn()
  const onCommit = vi.fn()
  beginDrag(
    { stopPropagation: vi.fn(), clientX: 200, clientY: 200 } as unknown as React.MouseEvent,
    ITEM,
    { onLivePreview, onCommit },
  )
  return { onLivePreview, onCommit }
}

afterEach(() => {
  // ensure no stray listeners between tests
  document.dispatchEvent(new MouseEvent('mouseup'))
  vi.restoreAllMocks()
})

describe('useItemDragDrop — click vs drag threshold', () => {
  it('sub-threshold drift stays a click: no drag flag, no move, no commit', () => {
    const { beginDrag, draggedFlagRef } = setup()
    const { onLivePreview, onCommit } = press(beginDrag)

    // ~2.2px of jitter (hypot(2,1)) — under the 4px threshold
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 202, clientY: 201 }))
    document.dispatchEvent(new MouseEvent('mouseup'))

    expect(draggedFlagRef.current).toBe(false) // click-to-select is NOT suppressed
    expect(onLivePreview).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('moving past the threshold becomes a drag: flag set, move + commit fire', () => {
    const { beginDrag, draggedFlagRef } = setup()
    const { onLivePreview, onCommit } = press(beginDrag)

    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 240, clientY: 200 })) // 40px → drag
    expect(draggedFlagRef.current).toBe(true)
    expect(onLivePreview).toHaveBeenCalled()

    document.dispatchEvent(new MouseEvent('mouseup'))
    expect(onCommit).toHaveBeenCalled()
  })
})
