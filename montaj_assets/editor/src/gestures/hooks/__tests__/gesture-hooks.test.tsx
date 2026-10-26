import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useOverlayDrag } from '../useOverlayDrag'
import { useOverlayResize } from '../useOverlayResize'
import { useOverlayRotate } from '../useOverlayRotate'

// A press and release with no movement between them is a click: no gesture
// hook commits for it, so a click on an element records no undo step.

const BOX = { x: 100, y: 100, w: 200, h: 100, rotation: 0 }

describe('useOverlayResize', () => {
  function setup() {
    const onPreview = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() => useOverlayResize({ scale: 1, onPreview, onCommit }))
    return { gesture: () => result.current, onPreview, onCommit }
  }

  it('a press and release in place commits nothing', () => {
    const { gesture, onCommit } = setup()
    act(() => {
      gesture().onPointerDown('el', 'se', { x: 10, y: 10 }, BOX)
      gesture().onPointerUp()
    })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a move that ends where it started commits nothing', () => {
    const { gesture, onCommit } = setup()
    act(() => {
      gesture().onPointerDown('el', 'e', { x: 10, y: 10 }, BOX)
      gesture().onPointerMove({ x: 50, y: 10 })
      gesture().onPointerMove({ x: 10, y: 10 })
      gesture().onPointerUp()
    })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a corner keeps the box ratio when the caller passes modifiers without Shift; Shift held frees it', () => {
    const { gesture, onPreview } = setup()
    act(() => {
      gesture().onPointerDown('el', 'se', { x: 10, y: 10 }, BOX)
      gesture().onPointerMove({ x: 130, y: 20 }, { shiftKey: false })
    })
    // The corner goes to the cursor's projection onto the diagonal:
    // 1 + (200 * 120 + 100 * 10) / (200² + 100²) = 1.5 times the box.
    expect(onPreview).toHaveBeenLastCalledWith('el', { x: 100, y: 100, w: 300, h: 150 }, 0, expect.objectContaining({ keptRatio: true }))
    act(() => { gesture().onPointerMove({ x: 130, y: 20 }, { shiftKey: true }) })
    expect(onPreview).toHaveBeenLastCalledWith('el', { x: 100, y: 100, w: 320, h: 110 }, 0, expect.objectContaining({ keptRatio: false }))
  })

  it('tells the commit whether the final box kept the ratio: a corner without Shift does, a side handle never (§586 M8)', () => {
    const { gesture, onCommit } = setup()
    act(() => {
      gesture().onPointerDown('el', 'se', { x: 10, y: 10 }, BOX)
      gesture().onPointerMove({ x: 130, y: 20 }, { shiftKey: true })
      gesture().onPointerMove({ x: 130, y: 20 }, { shiftKey: false })
      gesture().onPointerUp()
      gesture().onPointerDown('el', 'e', { x: 10, y: 10 }, BOX)
      gesture().onPointerMove({ x: 130, y: 20 }, { shiftKey: false })
      gesture().onPointerUp()
    })
    expect(onCommit.mock.calls.map((call) => call[2].keptRatio)).toEqual([true, false])
  })

  it('a caller that passes no modifiers still resizes a corner freely, as before (§556 review: the hook\'s API stays additive)', () => {
    const { gesture, onPreview, onCommit } = setup()
    act(() => {
      gesture().onPointerDown('el', 'se', { x: 10, y: 10 }, BOX)
      gesture().onPointerMove({ x: 130, y: 20 })
    })
    expect(onPreview).toHaveBeenLastCalledWith('el', { x: 100, y: 100, w: 320, h: 110 }, 0, expect.objectContaining({ keptRatio: false }))
    act(() => { gesture().onPointerUp() })
    expect(onCommit.mock.calls[0][1]).toEqual({ x: 100, y: 100, w: 320, h: 110 })
  })

  it('commits once, with the final box and the gesture it came from', () => {
    const { gesture, onCommit } = setup()
    act(() => {
      gesture().onPointerDown('el', 'e', { x: 10, y: 10 }, BOX)
      gesture().onPointerMove({ x: 40, y: 10 })
      gesture().onPointerUp()
      gesture().onPointerUp()
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
    const [id, box, info] = onCommit.mock.calls[0]
    expect(id).toBe('el')
    expect(box).toEqual({ x: 100, y: 100, w: 230, h: 100 })
    expect(info).toMatchObject({ handle: 'e', startBox: BOX, keptRatio: false })
  })
})

describe('useOverlayDrag', () => {
  function setup() {
    const onPreview = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() => useOverlayDrag({ scale: 1, slide: { w: 1080, h: 1080 }, onPreview, onCommit }))
    return { gesture: () => result.current, onCommit }
  }

  it('a press and release in place commits nothing', () => {
    const { gesture, onCommit } = setup()
    act(() => {
      gesture().onPointerDown('el', { x: 10, y: 10 }, BOX)
      gesture().onPointerUp()
    })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a move that ends where it started commits nothing', () => {
    const { gesture, onCommit } = setup()
    act(() => {
      gesture().onPointerDown('el', { x: 10, y: 10 }, BOX)
      gesture().onPointerMove({ x: 14, y: 13 })
      gesture().onPointerMove({ x: 10, y: 10 })
      gesture().onPointerUp()
    })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a move commits once', () => {
    const { gesture, onCommit } = setup()
    act(() => {
      gesture().onPointerDown('el', { x: 10, y: 10 }, BOX)
      gesture().onPointerMove({ x: 14, y: 13 })
      gesture().onPointerUp()
      gesture().onPointerUp()
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('el', 104, 103)
  })
})

describe('useOverlayRotate', () => {
  function setup() {
    const onPreview = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() => useOverlayRotate({ onPreview, onCommit }))
    return { gesture: () => result.current, onCommit }
  }

  it('a press and release in place commits nothing', () => {
    const { gesture, onCommit } = setup()
    act(() => {
      gesture().onPointerDown('el', { x: 0, y: 0 }, { x: 0, y: -20 }, 0, { x: 100, y: 100 })
      gesture().onPointerUp()
    })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('a move commits once', () => {
    const { gesture, onCommit } = setup()
    act(() => {
      gesture().onPointerDown('el', { x: 0, y: 0 }, { x: 0, y: -20 }, 0, { x: 100, y: 100 })
      gesture().onPointerMove({ x: 20, y: 0 })
      gesture().onPointerUp()
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('el', 90)
  })
})
