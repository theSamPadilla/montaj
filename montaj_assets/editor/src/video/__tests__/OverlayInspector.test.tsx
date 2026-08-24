/// <reference types="vitest/globals" />
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { VisualItem } from '../../schema'
import { createPlaybackClock } from '../playback-clock'
import { hasKeyframes, valueAt } from '../keyframeOps'
import OverlayInspector from '../OverlayInspector'

// Mirrors keyframeOps.test.ts's `overlay()` helper: start=5 deliberately
// non-zero, so any spot that treats absolute playhead time as item-relative
// `t` produces an obviously wrong number rather than passing by accident.
function overlayItem(over: Partial<VisualItem> = {}): VisualItem {
  return {
    id: 'o1',
    type: 'overlay',
    src: 'o.jsx',
    start: 5,
    end: 15,
    props: {},
    offsetX: 10,
    offsetY: -5,
    scale: 1.2,
    rotation: 45,
    opacity: 0.5,
    ...over,
  } as VisualItem
}

function renderInspector(item: VisualItem | null, playhead: number) {
  const clock = createPlaybackClock(playhead)
  const onPreview = vi.fn()
  const onCommit = vi.fn()
  const onChange = vi.fn()
  const utils = render(
    <OverlayInspector item={item} clock={clock} onPreview={onPreview} onCommit={onCommit} onChange={onChange} />,
  )
  return { ...utils, clock, onPreview, onCommit, onChange }
}

describe('OverlayInspector — rendering', () => {
  it('renders a row per property with the current values', () => {
    renderInspector(overlayItem(), 5) // localT = 0, all static

    expect(screen.getByLabelText('Offset X')).toHaveValue(10)
    expect(screen.getByLabelText('Offset Y')).toHaveValue(-5)
    expect(screen.getByLabelText('Scale')).toHaveValue(1.2)
    expect(screen.getByLabelText('Rotation')).toHaveValue(45)
    expect(screen.getByLabelText('Opacity')).toHaveValue(0.5)
  })

  it('does not render when nothing is selected', () => {
    const { container } = renderInspector(null, 5)
    expect(container.firstChild).toBeNull()
  })

  it('does not render for a non-overlay item', () => {
    const item = { id: 'v1', type: 'video', src: 'v.mp4', start: 0, end: 10 } as VisualItem
    const { container } = renderInspector(item, 5)
    expect(container.firstChild).toBeNull()
  })
})

describe('OverlayInspector — keyframe diamond', () => {
  it('reflects keyframed state per property', () => {
    const item = overlayItem({ keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 10 }] }] })
    renderInspector(item, 5)

    expect(screen.getByRole('button', { name: /Remove Offset X keyframe/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Add Scale keyframe/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('toggling an unkeyframed property enables keyframing without moving the overlay', () => {
    const item = overlayItem() // scale: 1.2, static
    const { onChange } = renderInspector(item, 5) // localT = 0

    fireEvent.click(screen.getByRole('button', { name: /Add Scale keyframe/ }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as VisualItem
    expect(hasKeyframes(next, 'scale')).toBe(true)
    // The seeded keyframe must hold the SAME value the overlay already had —
    // enabling keyframing must never move it.
    expect(valueAt(next, 'scale', 0)).toBe(valueAt(item, 'scale', 0))
    expect(valueAt(next, 'scale', 0)).toBe(1.2)
  })

  it('toggling a keyframed property disables keyframing and freezes the current value', () => {
    const item = overlayItem({
      offsetX: 999, // stale static field — disableKeyframing must overwrite it from the curve
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] }],
    })
    const { onChange } = renderInspector(item, 5) // localT = 0 -> curve value 0

    fireEvent.click(screen.getByRole('button', { name: /Remove Offset X keyframe/ }))

    const next = onChange.mock.calls[0][0] as VisualItem
    expect(hasKeyframes(next, 'offsetX')).toBe(false)
    expect(next.offsetX).toBe(0)
  })
})

describe('OverlayInspector — auto-keyframe on change', () => {
  it('writes the static scalar when the property is NOT keyframed', () => {
    const item = overlayItem() // offsetX static
    const { onPreview } = renderInspector(item, 5)

    fireEvent.change(screen.getByLabelText('Offset X'), { target: { value: '42' } })

    expect(onPreview).toHaveBeenCalledTimes(1)
    const next = onPreview.mock.calls[0][0] as VisualItem
    expect(next.offsetX).toBe(42)
    expect(hasKeyframes(next, 'offsetX')).toBe(false)
  })

  it('writes a keyframe at (playhead - item.start) when the property IS keyframed', () => {
    const item = overlayItem({
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] }],
    })
    // item.start = 5, playhead = 8 -> localT = 3, a point NOT already on the track.
    const { onPreview } = renderInspector(item, 8)

    fireEvent.change(screen.getByLabelText('Offset X'), { target: { value: '77' } })

    expect(onPreview).toHaveBeenCalledTimes(1)
    const next = onPreview.mock.calls[0][0] as VisualItem
    const track = next.keyframes!.find(t => t.prop === 'offsetX')!
    const point = track.points.find(p => p.t === 3)
    expect(point).toBeDefined()
    expect(point!.value).toBe(77)
    // The original endpoints are untouched — this ADDS a keyframe, not replaces the track.
    expect(track.points.find(p => p.t === 0)?.value).toBe(0)
    expect(track.points.find(p => p.t === 10)?.value).toBe(100)
  })
})

describe('OverlayInspector — clamped localT (selecting an overlay does not move the playhead)', () => {
  // item.start = 5, item.end = 15 (overlayItem's defaults) — a 10s span.
  it('clamps writes to t=0 when the playhead sits BEFORE the item start', () => {
    const item = overlayItem({
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] }],
    })
    // Unclamped this would be playhead(0) - start(5) = -5.
    const { onPreview } = renderInspector(item, 0)

    fireEvent.change(screen.getByLabelText('Offset X'), { target: { value: '42' } })

    const next = onPreview.mock.calls[0][0] as VisualItem
    const track = next.keyframes!.find(t => t.prop === 'offsetX')!
    expect(track.points.find(p => p.t === 0)?.value).toBe(42)
    expect(track.points.some(p => p.t < 0)).toBe(false)
  })

  it('clamps writes to t=item.end-item.start when the playhead sits AFTER the item end', () => {
    const item = overlayItem({
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] }],
    })
    // Unclamped this would be playhead(30) - start(5) = 25.
    const { onPreview } = renderInspector(item, 30)

    fireEvent.change(screen.getByLabelText('Offset X'), { target: { value: '77' } })

    const next = onPreview.mock.calls[0][0] as VisualItem
    const track = next.keyframes!.find(t => t.prop === 'offsetX')!
    expect(track.points.find(p => p.t === 10)?.value).toBe(77)
    expect(track.points.some(p => p.t > 10)).toBe(false)
  })

  it('leaves a playhead INSIDE the span unaffected by the clamp', () => {
    const item = overlayItem({
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] }],
    })
    const { onPreview } = renderInspector(item, 8) // localT = 3, well inside [0, 10]

    fireEvent.change(screen.getByLabelText('Offset X'), { target: { value: '55' } })

    const next = onPreview.mock.calls[0][0] as VisualItem
    const track = next.keyframes!.find(t => t.prop === 'offsetX')!
    expect(track.points.find(p => p.t === 3)?.value).toBe(55)
  })

  it('the keyframe diamond toggle also clamps its seed time to the span', () => {
    const item = overlayItem() // scale: 1.2, unkeyframed
    const { onChange } = renderInspector(item, 0) // playhead before start (start=5)

    fireEvent.click(screen.getByRole('button', { name: /Add Scale keyframe/ }))

    const next = onChange.mock.calls[0][0] as VisualItem
    const track = next.keyframes!.find(t => t.prop === 'scale')!
    expect(track.points).toEqual([{ t: 0, value: 1.2 }])
  })
})

describe('OverlayInspector — playhead scrubbing', () => {
  it('updates a keyframed field’s displayed value as the playhead moves', () => {
    const item = overlayItem({
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] }],
    })
    const { clock } = renderInspector(item, 5) // localT = 0

    expect(screen.getByLabelText('Offset X')).toHaveValue(0)

    act(() => { clock.set(15) }) // localT = 10

    expect(screen.getByLabelText('Offset X')).toHaveValue(100)
  })
})

describe('OverlayInspector — a mid-typed value survives a playhead tick (FIX 10)', () => {
  it('does not clobber a mid-typed value when the clock ticks before blur', () => {
    const item = overlayItem() // offsetX: 10, static
    const { clock } = renderInspector(item, 5)
    const input = screen.getByLabelText('Offset X')

    fireEvent.change(input, { target: { value: '4' } }) // mid-typing "4" of "42"
    expect(input).toHaveValue(4)

    // A tick arrives while the field is still mid-edit (unblurred) — this
    // used to force the controlled input's value back to the stale prop,
    // clobbering the keystroke.
    act(() => { clock.set(6) })
    expect(input).toHaveValue(4)

    fireEvent.change(input, { target: { value: '42' } })
    expect(input).toHaveValue(42)
  })

  it('commits on blur, closing the typing gesture', () => {
    const item = overlayItem()
    const { onCommit } = renderInspector(item, 5)
    const input = screen.getByLabelText('Offset X')

    fireEvent.change(input, { target: { value: '42' } })
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('Enter commits it too, via the same blur path', () => {
    const item = overlayItem()
    const { onCommit } = renderInspector(item, 5)
    const input = screen.getByLabelText('Offset X') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '42' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(document.activeElement).not.toBe(input)
  })

  it('after commit, the field goes back to tracking the live (now-updated) value', () => {
    const item = overlayItem()
    const { onCommit } = renderInspector(item, 5)
    const input = screen.getByLabelText('Offset X')

    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledTimes(1)
    // draft cleared -> falls back to the (still 10, since this test's parent
    // never re-supplies a changed `item`) prop-derived value, proving blur
    // actually released the draft rather than freezing the typed text forever.
    expect(input).toHaveValue(10)
  })
})
