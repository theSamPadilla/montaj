/// <reference types="vitest/globals" />
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { KeyframeProp, VisualItem } from '../../schema'
import { createPlaybackClock } from '../playback-clock'
import { hasKeyframes, trackFor, valueAt } from '../keyframeOps'
import OverlayInspector, { alignedOffset } from '../OverlayInspector'

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

/** The header's all-props list for a UNIFORM item — what every suite below
 *  that drives the header diamond uses, since they all render uniform items.
 *  An item carrying scaleX/scaleY gets PER_AXIS_PROPS instead; see the
 *  "uniform scale lock" suite. Deliberately still hard-coded rather than
 *  imported: it is the contract the panel is being held to. */
const ALL_PROPS: KeyframeProp[] = ['offsetX', 'offsetY', 'scale', 'rotation', 'opacity']
const PER_AXIS_PROPS: KeyframeProp[] = ['offsetX', 'offsetY', 'scaleX', 'scaleY', 'rotation', 'opacity']

const LOCK = 'Uniform scale'

function renderInspector(
  item: VisualItem | null,
  playhead: number,
  opts: { onSeek?: (time: number) => void } = {},
) {
  const clock = createPlaybackClock(playhead)
  const onPreview = vi.fn()
  const onCommit = vi.fn()
  const onChange = vi.fn()
  const utils = render(
    <OverlayInspector
      item={item}
      clock={clock}
      onPreview={onPreview}
      onCommit={onCommit}
      onChange={onChange}
      onSeek={opts.onSeek}
    />,
  )
  return { ...utils, clock, onPreview, onCommit, onChange }
}

/** The one item the header's keyframe-all "pressed" state needs: every
 *  transform prop animated, each with a point at item-relative t=0. */
function allKeyedItem(over: Partial<VisualItem> = {}): VisualItem {
  return overlayItem({
    keyframes: [
      { prop: 'offsetX',  points: [{ t: 0, value: 10 },  { t: 10, value: 100 }] },
      { prop: 'offsetY',  points: [{ t: 0, value: -5 },  { t: 10, value: 50 }] },
      { prop: 'scale',    points: [{ t: 0, value: 1.2 }, { t: 10, value: 2 }] },
      { prop: 'rotation', points: [{ t: 0, value: 45 },  { t: 10, value: 90 }] },
      { prop: 'opacity',  points: [{ t: 0, value: 0.5 }, { t: 10, value: 1 }] },
    ],
    ...over,
  })
}

const HEADER_DIAMOND = 'Keyframe all transform properties at playhead'

/**
 * Fire a pointer event that actually CARRIES coordinates.
 *
 * jsdom ships no `PointerEvent`, so `fireEvent.pointerDown(el, { clientX })`
 * falls back to a bare `Event` and silently drops clientX/clientY — the
 * handler runs with `undefined` coordinates. A `MouseEvent` named
 * `pointerdown` is what React's synthetic pointer event reads, and it does
 * carry them. (`pointerId` is still undefined, which is why the dial's
 * `setPointerCapture` call is optional — jsdom implements neither.)
 */
function firePointer(el: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', clientX: number, clientY: number) {
  fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }))
}

const dial = () => screen.getByRole('slider', { name: 'Rotation dial' })

/** jsdom lays nothing out, so every `getBoundingClientRect` is 0x0. Stand in
 *  a real 40x40 box at the origin so the dial's atan2 math is exercised. */
function stubDialRect(el: Element) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect)
}

describe('OverlayInspector — rendering', () => {
  it('renders a row per property with the current values', () => {
    renderInspector(overlayItem(), 5) // localT = 0, all static

    expect(screen.getByLabelText('Offset X')).toHaveValue(10)
    expect(screen.getByLabelText('Offset Y')).toHaveValue(-5)
    expect(screen.getByLabelText('Scale')).toHaveValue(120) // shown as a percentage now
    expect(screen.getByLabelText('Rotation')).toHaveValue(45)
    expect(screen.getByLabelText('Opacity')).toHaveValue(0.5)
  })

  it('renders the empty state when nothing is selected', () => {
    renderInspector(null, 5)

    expect(screen.getByText('Select an overlay to edit its properties.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Offset X')).toBeNull()
  })

  it('renders the panel for a VIDEO clip now that clips are keyframeable (SP9d)', () => {
    const item = { id: 'v1', type: 'video', src: 'v.mp4', start: 0, end: 10 } as VisualItem
    renderInspector(item, 5)

    expect(screen.queryByText('Select an overlay to edit its properties.')).toBeNull()
    expect(screen.queryByLabelText('Offset X')).not.toBeNull()
  })

  it("disables a clip's OPACITY keyframe diamond, with a reason, rather than hiding it", () => {
    // ffmpeg's colorchannelmixer takes its alpha gain as a <double> and accepts
    // no expression, so clip opacity cannot animate. A missing control reads as
    // a bug; a disabled one that says why reads as the limitation it is.
    const item = { id: 'v1', type: 'video', src: 'v.mp4', start: 0, end: 10 } as VisualItem
    renderInspector(item, 5)

    const diamond = screen.getByLabelText(/Opacity keyframe at playhead/)
    expect(diamond).toBeDisabled()
    expect(diamond.getAttribute('title')).toMatch(/cannot be animated/i)
  })

  it('leaves an overlay\'s opacity diamond fully enabled', () => {
    renderInspector(overlayItem(), 5)
    expect(screen.getByLabelText(/Opacity keyframe at playhead/)).not.toBeDisabled()
  })

  it('renders the empty state for a kind that cannot be keyframed at all', () => {
    const item = { id: 'a1', type: 'audio', src: 'a.wav', start: 0, end: 10 } as unknown as VisualItem
    renderInspector(item, 5)

    expect(screen.getByText('Select an overlay to edit its properties.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Offset X')).toBeNull()
  })

  it('renders the transform body unconditionally (no title, no collapse toggle)', () => {
    renderInspector(overlayItem(), 5)

    // The pane carries no "Transform" heading (the CONTENT/TRANSFORM tab names
    // it) and no collapse toggle — so there is no title text and nothing to
    // click to hide the body.
    expect(screen.queryByText('Transform')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Transform' })).toBeNull()

    // The body is visible immediately, with no interaction required.
    expect(screen.getByLabelText('Offset X')).toHaveValue(10)
  })
})

describe('OverlayInspector — keyframe diamond', () => {
  it('reflects keyframed state per property', () => {
    const item = overlayItem({ keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1.2 }] }] })
    renderInspector(item, 5)

    expect(screen.getByRole('button', { name: /Remove Scale keyframe/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Add Rotation keyframe/ })).toHaveAttribute('aria-pressed', 'false')
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
      rotation: 999, // stale static field — disableKeyframing must overwrite it from the curve
      keyframes: [{ prop: 'rotation', points: [{ t: 0, value: 0 }, { t: 10, value: 90 }] }],
    })
    const { onChange } = renderInspector(item, 5) // localT = 0 -> curve value 0

    fireEvent.click(screen.getByRole('button', { name: /Remove Rotation keyframe/ }))

    const next = onChange.mock.calls[0][0] as VisualItem
    expect(hasKeyframes(next, 'rotation')).toBe(false)
    expect(next.rotation).toBe(0)
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

// Same writeProp rule as the suite above, pinned for a CLIP specifically —
// clips are about to start using this panel (canKeyframe already accepts
// 'video'/'image', see the "renders the panel for a VIDEO clip" test), and
// nothing previously locked the static-vs-keyframe behavior in for that kind.
describe('OverlayInspector — auto-keyframe on change (video clip)', () => {
  function clipItem(over: Partial<VisualItem> = {}): VisualItem {
    return { id: 'v1', type: 'video', src: 'v.mp4', start: 0, end: 10, ...over } as VisualItem
  }

  it('writes the static scalar when the property is NOT keyframed', () => {
    const item = clipItem({ rotation: 0 })
    const { onPreview } = renderInspector(item, 5) // localT = 5

    fireEvent.change(screen.getByLabelText('Rotation'), { target: { value: '45' } })

    expect(onPreview).toHaveBeenCalledTimes(1)
    const next = onPreview.mock.calls[0][0] as VisualItem
    expect(next.rotation).toBe(45)
    expect(hasKeyframes(next, 'rotation')).toBe(false)
    expect(next.keyframes).toBeUndefined() // no implicit keyframe track appears
  })

  it('writes a keyframe at the playhead when the property IS keyframed', () => {
    const item = clipItem({
      keyframes: [{ prop: 'rotation', points: [{ t: 0, value: 0 }, { t: 10, value: 90 }] }],
    })
    const { onPreview } = renderInspector(item, 3) // localT = 3, not already on the track

    fireEvent.change(screen.getByLabelText('Rotation'), { target: { value: '45' } })

    expect(onPreview).toHaveBeenCalledTimes(1)
    const next = onPreview.mock.calls[0][0] as VisualItem
    const track = next.keyframes!.find(t => t.prop === 'rotation')!
    const point = track.points.find(p => p.t === 3)
    expect(point).toBeDefined()
    expect(point!.value).toBe(45)
    // The static scalar is NOT overwritten — the write went to the curve instead.
    expect(next.rotation).toBeUndefined()
    // The original endpoints are untouched — this ADDS a keyframe, not replaces the track.
    expect(track.points.find(p => p.t === 0)?.value).toBe(0)
    expect(track.points.find(p => p.t === 10)?.value).toBe(90)
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

describe('OverlayInspector — scale slider', () => {
  it('reflects the sampled scale as a percentage, in sync with the slider', () => {
    renderInspector(overlayItem(), 5)

    const slider = screen.getByRole('slider', { name: 'Scale slider' }) as HTMLInputElement
    expect(slider.value).toBe('1.2')
    expect(screen.getByLabelText('Scale')).toHaveValue(120) // 1.2x => 120%
  })

  it('tracks a keyframed scale as the playhead moves', () => {
    const item = overlayItem({
      keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 10, value: 2 }] }],
    })
    const { clock } = renderInspector(item, 5) // localT = 0
    const slider = screen.getByRole('slider', { name: 'Scale slider' }) as HTMLInputElement

    expect(slider.value).toBe('0.5')

    act(() => { clock.set(15) }) // localT = 10

    expect(slider.value).toBe('2')
    expect(screen.getByLabelText('Scale')).toHaveValue(200) // 2x => 200%
  })

  it('previews the slider value on every change', () => {
    const { onPreview } = renderInspector(overlayItem(), 5)
    const slider = screen.getByRole('slider', { name: 'Scale slider' })

    fireEvent.change(slider, { target: { value: '1.5' } })
    fireEvent.change(slider, { target: { value: '1.6' } })

    expect(onPreview).toHaveBeenCalledTimes(2)
    expect((onPreview.mock.calls[0][0] as VisualItem).scale).toBe(1.5)
    expect((onPreview.mock.calls[1][0] as VisualItem).scale).toBe(1.6)
  })

  it('commits ONCE on pointer up, not on every change, and not again on the trailing blur', () => {
    const { onCommit } = renderInspector(overlayItem(), 5)
    const slider = screen.getByRole('slider', { name: 'Scale slider' })

    fireEvent.change(slider, { target: { value: '1.5' } })
    fireEvent.change(slider, { target: { value: '1.6' } })
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.pointerUp(slider)
    expect(onCommit).toHaveBeenCalledTimes(1)

    // A pointerup is normally followed by a blur — that must not stack a
    // second undo entry onto the same gesture.
    fireEvent.blur(slider)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('commits a keyboard adjustment on key up', () => {
    const { onCommit } = renderInspector(overlayItem(), 5)
    const slider = screen.getByRole('slider', { name: 'Scale slider' })

    fireEvent.change(slider, { target: { value: '1.3' } })
    fireEvent.keyUp(slider, { key: 'ArrowRight' })

    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('obeys the auto-keyframe rule like every other control', () => {
    const item = overlayItem({
      keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 10, value: 2 }] }],
    })
    const { onPreview } = renderInspector(item, 8) // localT = 3
    const slider = screen.getByRole('slider', { name: 'Scale slider' })

    fireEvent.change(slider, { target: { value: '1.5' } })

    const next = onPreview.mock.calls[0][0] as VisualItem
    expect(trackFor(next, 'scale')!.points.find(p => p.t === 3)?.value).toBe(1.5)
  })
})

describe('OverlayInspector — uniform scale lock', () => {
  it('renders checked and ENABLED for an item with no per-axis scale', () => {
    renderInspector(overlayItem(), 5)

    const lock = screen.getByRole('checkbox', { name: LOCK })
    expect(lock).toHaveAttribute('aria-checked', 'true')
    expect(lock).not.toHaveAttribute('aria-disabled')
    expect(lock).toBeEnabled()
  })

  it('renders UNCHECKED for an item that carries scaleX/scaleY', () => {
    renderInspector(overlayItem({ scaleX: 1.2, scaleY: 0.8 }), 5)

    expect(screen.getByRole('checkbox', { name: LOCK })).toHaveAttribute('aria-checked', 'false')
  })

  it('reads unchecked off a per-axis KEYFRAME TRACK, not just the scalar', () => {
    const item = overlayItem({
      keyframes: [{ prop: 'scaleX', points: [{ t: 0, value: 1 }, { t: 10, value: 2 }] }],
    })
    renderInspector(item, 5)

    expect(screen.getByRole('checkbox', { name: LOCK })).toHaveAttribute('aria-checked', 'false')
  })

  it('stays unchecked for a deliberately-unlocked item whose axes happen to be equal', () => {
    // Equality is NOT the test — `scaleX === scaleY` on an item the operator
    // unlocked on purpose must not silently re-lock it.
    renderInspector(overlayItem({ scaleX: 1.2, scaleY: 1.2 }), 5)

    expect(screen.getByRole('checkbox', { name: LOCK })).toHaveAttribute('aria-checked', 'false')
  })

  it('re-derives its state when a DIFFERENT overlay is selected', () => {
    // The reason the state is derived from `item` rather than held in
    // useState: this panel is reconciled in place across selection changes, so
    // component state would keep showing the previous overlay's answer.
    const clock = createPlaybackClock(5)
    const props = { clock, onPreview: vi.fn(), onCommit: vi.fn(), onChange: vi.fn() }
    const { rerender } = render(<OverlayInspector item={overlayItem({ scaleX: 2, scaleY: 0.5 })} {...props} />)
    expect(screen.getByRole('checkbox', { name: LOCK })).toHaveAttribute('aria-checked', 'false')

    rerender(<OverlayInspector item={overlayItem({ id: 'o2' })} {...props} />)

    expect(screen.getByRole('checkbox', { name: LOCK })).toHaveAttribute('aria-checked', 'true')
  })

  it('is operable from the keyboard', () => {
    const { onChange } = renderInspector(overlayItem(), 5)

    // role=checkbox on a <button> fires click for Space/Enter natively; jsdom
    // does not synthesize that, so the click IS the keyboard activation here.
    // What this asserts is that nothing disables the control or swallows it.
    const lock = screen.getByRole('checkbox', { name: LOCK })
    lock.focus()
    expect(lock).toHaveFocus()
    fireEvent.click(lock)

    expect(onChange).toHaveBeenCalledTimes(1)
  })

  describe('unlocking (ON → OFF)', () => {
    it('splits the Scale row into Scale X / Scale Y boxes', () => {
      renderInspector(overlayItem({ scaleX: 1.2, scaleY: 0.8 }), 5)

      expect(screen.getByLabelText('Scale X')).toHaveValue(120)
      expect(screen.getByLabelText('Scale Y')).toHaveValue(80)
      // The single uniform row — box AND slider — is gone.
      expect(screen.queryByLabelText('Scale')).toBeNull()
      expect(screen.queryByRole('slider', { name: 'Scale slider' })).toBeNull()
    })

    it('seeds BOTH axes from the current scale, so nothing jumps', () => {
      const item = overlayItem({ scale: 1.2 })
      const { onChange } = renderInspector(item, 5) // localT = 0

      fireEvent.click(screen.getByRole('checkbox', { name: LOCK }))

      expect(onChange).toHaveBeenCalledTimes(1)
      const next = onChange.mock.calls[0][0] as VisualItem
      expect(next.scaleX).toBe(1.2)
      expect(next.scaleY).toBe(1.2)
      // The actual no-jump proof: the EFFECTIVE per-axis scale the renderer
      // resolves is identical either side of the transition.
      expect(valueAt(next, 'scaleX', 0)).toBe(valueAt(item, 'scaleX', 0))
      expect(valueAt(next, 'scaleY', 0)).toBe(valueAt(item, 'scaleY', 0))
    })

    it('seeds from the ANIMATED scale at the playhead, not the static scalar', () => {
      const item = overlayItem({
        scale: 999, // stale scalar the track shadows — seeding from it would jump
        keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }, { t: 10, value: 2 }] }],
      })
      const { onChange } = renderInspector(item, 10) // localT = 5, halfway => 1.5

      fireEvent.click(screen.getByRole('checkbox', { name: LOCK }))

      const next = onChange.mock.calls[0][0] as VisualItem
      expect(next.scaleX).toBe(1.5)
      expect(next.scaleY).toBe(1.5)
      expect(valueAt(next, 'scaleX', 5)).toBe(valueAt(item, 'scaleX', 5))
      expect(valueAt(next, 'scaleY', 5)).toBe(valueAt(item, 'scaleY', 5))
    })

    it('writes the per-axis boxes back as multipliers', () => {
      const { onPreview } = renderInspector(overlayItem({ scaleX: 1, scaleY: 1 }), 5)

      fireEvent.change(screen.getByLabelText('Scale X'), { target: { value: '200' } })
      fireEvent.change(screen.getByLabelText('Scale Y'), { target: { value: '50' } })

      expect((onPreview.mock.calls[0][0] as VisualItem).scaleX).toBe(2)
      expect((onPreview.mock.calls[1][0] as VisualItem).scaleY).toBe(0.5)
    })

    it('steps each axis independently', () => {
      const { onChange } = renderInspector(overlayItem({ scaleX: 1.2, scaleY: 1.2 }), 5)

      fireEvent.click(screen.getByRole('button', { name: 'Increase Scale X' }))
      expect((onChange.mock.calls[0][0] as VisualItem).scaleX).toBe(1.21)

      fireEvent.click(screen.getByRole('button', { name: 'Decrease Scale Y' }))
      expect((onChange.mock.calls[1][0] as VisualItem).scaleY).toBe(1.19)
    })
  })

  describe('locking (OFF → ON)', () => {
    it('collapses to `scale` keeping the X value, and clears both axes', () => {
      const item = overlayItem({ scaleX: 1.5, scaleY: 0.25 })
      const { onChange } = renderInspector(item, 5)

      fireEvent.click(screen.getByRole('checkbox', { name: LOCK }))

      expect(onChange).toHaveBeenCalledTimes(1)
      const next = onChange.mock.calls[0][0] as VisualItem
      expect(next.scale).toBe(1.5) // X wins — arbitrary but documented and stable
      expect('scaleX' in next).toBe(false)
      expect('scaleY' in next).toBe(false)
      // And the resolver agrees: both axes fall back to the uniform value.
      expect(valueAt(next, 'scaleX', 0)).toBe(1.5)
      expect(valueAt(next, 'scaleY', 0)).toBe(1.5)
    })

    it('clears per-axis keyframe TRACKS too, not just the scalars', () => {
      const item = overlayItem({
        scaleX: 9,
        keyframes: [
          { prop: 'scaleX', points: [{ t: 0, value: 1.5 }, { t: 10, value: 3 }] },
          { prop: 'scaleY', points: [{ t: 0, value: 0.25 }, { t: 10, value: 4 }] },
          { prop: 'opacity', points: [{ t: 0, value: 0.5 }] },
        ],
      })
      const { onChange } = renderInspector(item, 5) // localT = 0

      fireEvent.click(screen.getByRole('checkbox', { name: LOCK }))

      const next = onChange.mock.calls[0][0] as VisualItem
      expect(next.scale).toBe(1.5) // the X CURVE's value at the playhead
      expect('scaleX' in next).toBe(false)
      expect(trackFor(next, 'scaleX')).toBeUndefined()
      expect(trackFor(next, 'scaleY')).toBeUndefined()
      // An unrelated track is untouched — this clears two props, not the item.
      expect(trackFor(next, 'opacity')!.points).toEqual([{ t: 0, value: 0.5 }])
    })

    it('drops `item.keyframes` entirely when the per-axis tracks were the only ones', () => {
      const item = overlayItem({
        keyframes: [
          { prop: 'scaleX', points: [{ t: 0, value: 1.5 }] },
          { prop: 'scaleY', points: [{ t: 0, value: 0.5 }] },
        ],
      })
      const { onChange } = renderInspector(item, 5)

      fireEvent.click(screen.getByRole('checkbox', { name: LOCK }))

      // Not a lingering `[]` — downstream treats "no keyframes" as the static
      // path and the two must behave identically (withTrack's contract).
      expect((onChange.mock.calls[0][0] as VisualItem).keyframes).toBeUndefined()
    })

    it('keyframes `scale` instead of writing the scalar when it is already animated', () => {
      // The collapse is a normal panel write, so writeProp's auto-keyframe rule
      // applies to it exactly as it does to typing in the Scale box.
      const item = overlayItem({
        scaleX: 2,
        keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 10, value: 1 }] }],
      })
      const { onChange } = renderInspector(item, 8) // localT = 3

      fireEvent.click(screen.getByRole('checkbox', { name: LOCK }))

      const next = onChange.mock.calls[0][0] as VisualItem
      expect(trackFor(next, 'scale')!.points.find(p => p.t === 3)?.value).toBe(2)
      expect('scaleX' in next).toBe(false)
    })

    it('round-trips: unlock then lock returns the original scale', () => {
      const item = overlayItem({ scale: 1.2 })
      const first = renderInspector(item, 5)
      fireEvent.click(screen.getByRole('checkbox', { name: LOCK }))
      const unlocked = first.onChange.mock.calls[0][0] as VisualItem
      first.unmount()

      const second = renderInspector(unlocked, 5)
      fireEvent.click(screen.getByRole('checkbox', { name: LOCK }))
      const relocked = second.onChange.mock.calls[0][0] as VisualItem

      expect(relocked.scale).toBe(1.2)
      expect('scaleX' in relocked).toBe(false)
      expect('scaleY' in relocked).toBe(false)
    })
  })

  describe('per-axis keyframes', () => {
    it('gives each axis its OWN keyframe unit', () => {
      renderInspector(overlayItem({ scaleX: 1, scaleY: 1 }), 5)

      expect(screen.getByRole('button', { name: 'Add Scale X keyframe at playhead' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Add Scale Y keyframe at playhead' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Previous Scale X keyframe' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Next Scale Y keyframe' })).toBeInTheDocument()
      // The uniform row's diamond is gone with the row.
      expect(screen.queryByRole('button', { name: 'Add Scale keyframe at playhead' })).toBeNull()
    })

    it('a diamond animates ONE axis, leaving the other static', () => {
      const { onChange } = renderInspector(overlayItem({ scaleX: 1.5, scaleY: 0.5 }), 8) // localT = 3

      fireEvent.click(screen.getByRole('button', { name: 'Add Scale X keyframe at playhead' }))

      const next = onChange.mock.calls[0][0] as VisualItem
      expect(trackFor(next, 'scaleX')!.points).toEqual([{ t: 3, value: 1.5 }])
      expect(hasKeyframes(next, 'scaleY')).toBe(false)
      expect(next.scaleY).toBe(0.5)
    })

    it('a pressed diamond turns that axis back into a static scalar', () => {
      const item = overlayItem({
        scaleX: 999, // stale — disableKeyframing must overwrite it, not restore it
        keyframes: [{ prop: 'scaleX', points: [{ t: 0, value: 1.5 }] }],
      })
      const { onChange } = renderInspector(item, 5) // localT = 0

      const diamond = screen.getByRole('button', { name: 'Remove Scale X keyframe at playhead' })
      expect(diamond).toHaveAttribute('aria-pressed', 'true')
      fireEvent.click(diamond)

      const next = onChange.mock.calls[0][0] as VisualItem
      expect(trackFor(next, 'scaleX')).toBeUndefined()
      expect(next.scaleX).toBe(1.5) // nothing moves
    })

    it('the per-axis boxes keyframe (in percent) when that axis is animated', () => {
      const item = overlayItem({
        keyframes: [{ prop: 'scaleY', points: [{ t: 0, value: 0.5 }, { t: 10, value: 2 }] }],
      })
      const { onPreview } = renderInspector(item, 8) // localT = 3

      fireEvent.change(screen.getByLabelText('Scale Y'), { target: { value: '150' } })

      const next = onPreview.mock.calls[0][0] as VisualItem
      expect(trackFor(next, 'scaleY')!.points.find(p => p.t === 3)?.value).toBe(1.5)
    })
  })

  describe('the header all-props actions follow the lock', () => {
    it('keyframe-all on a UNIFORM item keys `scale` and never seeds scaleX/scaleY', () => {
      // The whole point of the two-list split: a one-point scaleX track would
      // shadow the `scale` track and silently freeze the uniform zoom.
      const item = overlayItem({
        keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }, { t: 10, value: 2 }] }],
      })
      const { onChange } = renderInspector(item, 8) // localT = 3

      fireEvent.click(screen.getByRole('button', { name: HEADER_DIAMOND }))

      const next = onChange.mock.calls[0][0] as VisualItem
      expect(trackFor(next, 'scale')!.points.some(p => p.t === 3)).toBe(true)
      expect(trackFor(next, 'scaleX')).toBeUndefined()
      expect(trackFor(next, 'scaleY')).toBeUndefined()
      // The uniform animation still animates.
      expect(valueAt(next, 'scaleX', 0)).toBe(1)
      expect(valueAt(next, 'scaleX', 10)).toBe(2)
    })

    it('keyframe-all on an UNLOCKED item keys both axes and not `scale`', () => {
      const item = overlayItem({ scaleX: 1.5, scaleY: 0.5 })
      const { onChange } = renderInspector(item, 8) // localT = 3

      fireEvent.click(screen.getByRole('button', { name: HEADER_DIAMOND }))

      const next = onChange.mock.calls[0][0] as VisualItem
      for (const prop of PER_AXIS_PROPS) {
        expect(trackFor(next, prop)!.points.some(p => p.t === 3)).toBe(true)
        expect(valueAt(next, prop, 3)).toBe(valueAt(item, prop, 3))
      }
      expect(trackFor(next, 'scale')).toBeUndefined()
    })

    it('reset-all on an UNLOCKED item resets the axes, not the shadowed `scale`', () => {
      const item = overlayItem({ scale: 1.2, scaleX: 3, scaleY: 0.25 })
      const { onChange } = renderInspector(item, 5)

      fireEvent.click(screen.getByRole('button', { name: 'Reset transform' }))

      const next = onChange.mock.calls[0][0] as VisualItem
      expect(next.scaleX).toBe(1)
      expect(next.scaleY).toBe(1)
      expect(next.scale).toBe(1.2) // untouched, and shadowed anyway
      // Reset is not a re-lock: the item stays authored per-axis.
      expect(screen.getByRole('checkbox', { name: LOCK })).toHaveAttribute('aria-checked', 'false')
    })

    it('the header diamond reflects both axes on an unlocked item', () => {
      const keyed = (props: KeyframeProp[]) =>
        overlayItem({ scaleX: 1, scaleY: 1, keyframes: props.map(prop => ({ prop, points: [{ t: 0, value: 1 }] })) })

      const { unmount } = renderInspector(keyed(PER_AXIS_PROPS), 5) // localT = 0
      expect(screen.getByRole('button', { name: HEADER_DIAMOND })).toHaveAttribute('aria-pressed', 'true')
      unmount()

      // Everything but scaleY: the header must NOT read as fully keyed.
      renderInspector(keyed(PER_AXIS_PROPS.filter(p => p !== 'scaleY')), 5)
      expect(screen.getByRole('button', { name: HEADER_DIAMOND })).toHaveAttribute('aria-pressed', 'false')
    })
  })

  it('the scale box takes a percentage and writes it back as a multiplier', () => {
    const { onPreview } = renderInspector(overlayItem(), 5)

    fireEvent.change(screen.getByLabelText('Scale'), { target: { value: '200' } })

    expect(onPreview).toHaveBeenCalledTimes(1)
    expect((onPreview.mock.calls[0][0] as VisualItem).scale).toBe(2)
  })

  it('the scale box keyframes `scale` (in percent) when it is animated', () => {
    const item = overlayItem({
      keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 10, value: 2 }] }],
    })
    const { onPreview } = renderInspector(item, 8) // localT = 3

    fireEvent.change(screen.getByLabelText('Scale'), { target: { value: '150' } })

    const next = onPreview.mock.calls[0][0] as VisualItem
    expect(trackFor(next, 'scale')!.points.find(p => p.t === 3)?.value).toBe(1.5)
  })
})

describe('OverlayInspector — steppers', () => {
  it('nudges up by the row step in one discrete change', () => {
    const { onChange, onPreview, onCommit } = renderInspector(overlayItem(), 5)

    fireEvent.click(screen.getByRole('button', { name: 'Increase Offset X' }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onPreview).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
    expect((onChange.mock.calls[0][0] as VisualItem).offsetX).toBe(11)
  })

  it('nudges down by the row step', () => {
    const { onChange } = renderInspector(overlayItem(), 5)

    fireEvent.click(screen.getByRole('button', { name: 'Decrease Offset X' }))

    expect((onChange.mock.calls[0][0] as VisualItem).offsetX).toBe(9)
  })

  it('rounds away float noise (1.2 + 0.01 is not 1.2100000000000002)', () => {
    const { onChange } = renderInspector(overlayItem(), 5)

    fireEvent.click(screen.getByRole('button', { name: 'Increase Scale' }))

    expect((onChange.mock.calls[0][0] as VisualItem).scale).toBe(1.21)
  })

  it('clamps at the row max', () => {
    const { onChange } = renderInspector(overlayItem({ opacity: 1 }), 5)

    fireEvent.click(screen.getByRole('button', { name: 'Increase Opacity' }))

    expect((onChange.mock.calls[0][0] as VisualItem).opacity).toBe(1)
  })

  it('clamps at the row min', () => {
    const { onChange } = renderInspector(overlayItem({ scale: 0.01 }), 5)

    fireEvent.click(screen.getByRole('button', { name: 'Decrease Scale' }))

    expect((onChange.mock.calls[0][0] as VisualItem).scale).toBe(0.01)
  })

  it('writes a keyframe at the playhead when the prop is keyframed', () => {
    const item = overlayItem({
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] }],
    })
    const { onChange } = renderInspector(item, 8) // localT = 3 -> sampled 30

    fireEvent.click(screen.getByRole('button', { name: 'Increase Offset X' }))

    const next = onChange.mock.calls[0][0] as VisualItem
    expect(trackFor(next, 'offsetX')!.points.find(p => p.t === 3)?.value).toBe(31)
  })
})

describe('OverlayInspector — rotation dial', () => {
  it('exposes the current rotation as aria-valuenow, tracking the playhead', () => {
    const item = overlayItem({
      keyframes: [{ prop: 'rotation', points: [{ t: 0, value: 0 }, { t: 10, value: 90 }] }],
    })
    const { clock } = renderInspector(item, 5) // localT = 0
    const dial = screen.getByRole('slider', { name: 'Rotation dial' })

    expect(dial).toHaveAttribute('aria-valuemin', '0')
    expect(dial).toHaveAttribute('aria-valuemax', '360')
    expect(dial).toHaveAttribute('aria-valuenow', '0')

    act(() => { clock.set(10) }) // localT = 5 -> halfway -> 45
    expect(dial).toHaveAttribute('aria-valuenow', '45')

    act(() => { clock.set(15) }) // localT = 10
    expect(dial).toHaveAttribute('aria-valuenow', '90')
  })

  it('nudges one degree per arrow key', () => {
    const { onChange } = renderInspector(overlayItem(), 5) // rotation 45
    const dial = screen.getByRole('slider', { name: 'Rotation dial' })

    fireEvent.keyDown(dial, { key: 'ArrowRight' })
    expect((onChange.mock.calls[0][0] as VisualItem).rotation).toBe(46)

    fireEvent.keyDown(dial, { key: 'ArrowLeft' })
    expect((onChange.mock.calls[1][0] as VisualItem).rotation).toBe(44)

    fireEvent.keyDown(dial, { key: 'ArrowUp' })
    expect((onChange.mock.calls[2][0] as VisualItem).rotation).toBe(46)

    fireEvent.keyDown(dial, { key: 'ArrowDown' })
    expect((onChange.mock.calls[3][0] as VisualItem).rotation).toBe(44)
  })

  it('Shift multiplies the nudge to 15 degrees', () => {
    const { onChange } = renderInspector(overlayItem(), 5) // rotation 45
    const dial = screen.getByRole('slider', { name: 'Rotation dial' })

    fireEvent.keyDown(dial, { key: 'ArrowRight', shiftKey: true })
    expect((onChange.mock.calls[0][0] as VisualItem).rotation).toBe(60)

    fireEvent.keyDown(dial, { key: 'ArrowLeft', shiftKey: true })
    expect((onChange.mock.calls[1][0] as VisualItem).rotation).toBe(30)
  })

  it('wraps into [0, 360) rather than going negative', () => {
    const { onChange } = renderInspector(overlayItem({ rotation: 0 }), 5)
    const dial = screen.getByRole('slider', { name: 'Rotation dial' })

    fireEvent.keyDown(dial, { key: 'ArrowLeft' })

    expect((onChange.mock.calls[0][0] as VisualItem).rotation).toBe(359)
  })

  it('ignores keys it does not handle', () => {
    const { onChange } = renderInspector(overlayItem(), 5)
    const dial = screen.getByRole('slider', { name: 'Rotation dial' })

    fireEvent.keyDown(dial, { key: 'a' })
    fireEvent.keyDown(dial, { key: 'Enter' })

    expect(onChange).not.toHaveBeenCalled()
  })

  it('writes the static scalar when rotation is NOT keyframed', () => {
    const { onChange } = renderInspector(overlayItem(), 5)

    fireEvent.keyDown(screen.getByRole('slider', { name: 'Rotation dial' }), { key: 'ArrowRight' })

    const next = onChange.mock.calls[0][0] as VisualItem
    expect(next.rotation).toBe(46)
    expect(hasKeyframes(next, 'rotation')).toBe(false)
  })

  it('writes a keyframe at localT when rotation IS keyframed', () => {
    const item = overlayItem({
      keyframes: [{ prop: 'rotation', points: [{ t: 0, value: 0 }, { t: 10, value: 90 }] }],
    })
    const { onChange } = renderInspector(item, 8) // localT = 3 -> sampled 27

    fireEvent.keyDown(screen.getByRole('slider', { name: 'Rotation dial' }), { key: 'ArrowRight' })

    const next = onChange.mock.calls[0][0] as VisualItem
    const track = trackFor(next, 'rotation')!
    expect(track.points.find(p => p.t === 3)?.value).toBe(28)
    expect(track.points.find(p => p.t === 0)?.value).toBe(0)
    expect(track.points.find(p => p.t === 10)?.value).toBe(90)
  })

  it('emits nothing from a drag on a zero-size rect rather than a NaN', () => {
    const { onPreview, onCommit } = renderInspector(overlayItem(), 5)
    const el = dial()
    // No stubDialRect here: the real jsdom rect is 0x0, exactly the case
    // `angleFrom` bails on. A NaN reaching `setKeyframe` would be swallowed by
    // its finite guard, but the STATIC path (`{ ...item, rotation: NaN }`) has
    // no such guard, so bailing here is what actually protects the item.
    firePointer(el, 'pointerdown', 30, 10)
    firePointer(el, 'pointermove', 40, 20)
    firePointer(el, 'pointerup', 40, 20)

    expect(onPreview).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('maps a pointer to degrees clockwise-from-up once the rect has a size', () => {
    const { onPreview, onCommit } = renderInspector(overlayItem(), 5)
    const el = dial()
    stubDialRect(el)

    const degrees = () => {
      const calls = onPreview.mock.calls
      return (calls[calls.length - 1][0] as VisualItem).rotation
    }

    firePointer(el, 'pointerdown', 20, 0)  // straight up -> 0
    expect(degrees()).toBe(0)

    firePointer(el, 'pointermove', 40, 20) // right       -> 90
    expect(degrees()).toBe(90)

    firePointer(el, 'pointermove', 20, 40) // down        -> 180
    expect(degrees()).toBe(180)

    firePointer(el, 'pointermove', 0, 20)  // left        -> 270, not -90
    expect(degrees()).toBe(270)

    // The drag is ONE gesture: previews throughout, a single commit at the end.
    expect(onCommit).not.toHaveBeenCalled()
    firePointer(el, 'pointerup', 0, 20)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('keyframes the dragged angle when rotation is keyframed', () => {
    const item = overlayItem({
      keyframes: [{ prop: 'rotation', points: [{ t: 0, value: 0 }, { t: 10, value: 90 }] }],
    })
    const { onPreview } = renderInspector(item, 8) // localT = 3
    const el = dial()
    stubDialRect(el)

    firePointer(el, 'pointerdown', 40, 20) // right -> 90

    const next = onPreview.mock.calls[0][0] as VisualItem
    expect(trackFor(next, 'rotation')!.points.find(p => p.t === 3)?.value).toBe(90)
  })

  it('ignores a pointer move with no preceding pointer down', () => {
    const { onPreview } = renderInspector(overlayItem(), 5)
    const el = dial()
    stubDialRect(el)

    firePointer(el, 'pointermove', 40, 20)

    expect(onPreview).not.toHaveBeenCalled()
  })

  it('does not spend an undo entry on a pointer up that never previewed', () => {
    const { onCommit } = renderInspector(overlayItem(), 5)
    const el = dial()
    stubDialRect(el)

    // Pressing exactly on the centre has no direction, so nothing is emitted;
    // releasing must not then commit an edit that never happened.
    firePointer(el, 'pointerdown', 20, 20)
    firePointer(el, 'pointerup', 20, 20)

    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('alignedOffset', () => {
  it('puts a scaled-down overlay’s edge on the frame edge', () => {
    expect(alignedOffset(0.5, -1)).toBe(-25)
    expect(alignedOffset(0.5, 0)).toBe(0)
    expect(alignedOffset(0.5, 1)).toBe(25)
  })

  it('collapses to centered at scale 1, where the overlay exactly fills the frame', () => {
    expect(alignedOffset(1, -1)).toBe(0)
    expect(alignedOffset(1, 0)).toBe(0)
    expect(alignedOffset(1, 1)).toBe(0)
  })

  it('clamps an over-scaled overlay to centered rather than pushing it further off-frame', () => {
    expect(alignedOffset(2, -1)).toBe(0)
    expect(alignedOffset(2, 0)).toBe(0)
    expect(alignedOffset(2, 1)).toBe(0)
  })
})

describe('OverlayInspector — align row', () => {
  const CASES: { label: string; prop: 'offsetX' | 'offsetY'; expected: number }[] = [
    { label: 'Align left',   prop: 'offsetX', expected: -25 },
    { label: 'Align center', prop: 'offsetX', expected: 0 },
    { label: 'Align right',  prop: 'offsetX', expected: 25 },
    { label: 'Align top',    prop: 'offsetY', expected: -25 },
    { label: 'Align middle', prop: 'offsetY', expected: 0 },
    { label: 'Align bottom', prop: 'offsetY', expected: 25 },
  ]

  for (const { label, prop, expected } of CASES) {
    it(`${label} writes ${expected} on ${prop} and leaves the other axis alone`, () => {
      const item = overlayItem({ scale: 0.5 }) // edge offset magnitude = 25
      const { onChange, unmount } = renderInspector(item, 5)

      fireEvent.click(screen.getByRole('button', { name: label }))

      expect(onChange).toHaveBeenCalledTimes(1)
      const next = onChange.mock.calls[0][0] as VisualItem
      expect(next[prop]).toBe(expected)
      const other = prop === 'offsetX' ? 'offsetY' : 'offsetX'
      expect(next[other]).toBe(item[other])
      unmount()
    })
  }

  it('uses the SAMPLED scale mid-animation, not the stale static scalar', () => {
    const item = overlayItem({
      scale: 999, // never read: the prop is keyframed
      keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 10, value: 0.5 }] }],
    })
    const { onChange } = renderInspector(item, 8) // localT = 3 -> scale 0.5

    fireEvent.click(screen.getByRole('button', { name: 'Align right' }))

    expect((onChange.mock.calls[0][0] as VisualItem).offsetX).toBe(25)
  })

  it('keyframes the offset when the offset prop is keyframed', () => {
    const item = overlayItem({
      scale: 0.5,
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] }],
    })
    const { onChange } = renderInspector(item, 8) // localT = 3

    fireEvent.click(screen.getByRole('button', { name: 'Align left' }))

    const next = onChange.mock.calls[0][0] as VisualItem
    expect(trackFor(next, 'offsetX')!.points.find(p => p.t === 3)?.value).toBe(-25)
  })

  it('uses the X scale for horizontal alignment and the Y scale for vertical', () => {
    // A non-uniform overlay's left edge is set by its WIDTH and its top edge by
    // its HEIGHT, so one shared scale would put one of the two axes wrong.
    const item = overlayItem({ scaleX: 0.5, scaleY: 0.25 })
    const { onChange } = renderInspector(item, 5)

    fireEvent.click(screen.getByRole('button', { name: 'Align left' }))
    expect((onChange.mock.calls[0][0] as VisualItem).offsetX).toBe(-25) // (1 - 0.5) / 2

    fireEvent.click(screen.getByRole('button', { name: 'Align bottom' }))
    expect((onChange.mock.calls[1][0] as VisualItem).offsetY).toBe(37.5) // (1 - 0.25) / 2
  })

  it('samples each axis independently mid-animation', () => {
    const item = overlayItem({
      scaleX: 999,
      scaleY: 999,
      keyframes: [
        { prop: 'scaleX', points: [{ t: 0, value: 0.5 }, { t: 10, value: 0.5 }] },
        { prop: 'scaleY', points: [{ t: 0, value: 0.2 }, { t: 10, value: 0.2 }] },
      ],
    })
    const { onChange } = renderInspector(item, 8) // localT = 3

    fireEvent.click(screen.getByRole('button', { name: 'Align right' }))
    expect((onChange.mock.calls[0][0] as VisualItem).offsetX).toBe(25)

    fireEvent.click(screen.getByRole('button', { name: 'Align top' }))
    expect((onChange.mock.calls[1][0] as VisualItem).offsetY).toBe(-40)
  })

  it('is unchanged for a legacy uniform item, where both axes resolve to `scale`', () => {
    const item = overlayItem({ scale: 0.5 })
    const { onChange } = renderInspector(item, 5)

    fireEvent.click(screen.getByRole('button', { name: 'Align top' }))

    expect((onChange.mock.calls[0][0] as VisualItem).offsetY).toBe(-25)
  })
})

describe('OverlayInspector — reset', () => {
  it('writes all five defaults in a single change', () => {
    const { onChange } = renderInspector(overlayItem(), 5)

    fireEvent.click(screen.getByRole('button', { name: 'Reset transform' }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as VisualItem
    expect(next.offsetX).toBe(0)
    expect(next.offsetY).toBe(0)
    expect(next.scale).toBe(1)
    expect(next.rotation).toBe(0)
    expect(next.opacity).toBe(1)
  })

  it('drops a default-valued keyframe on a keyframed prop instead of deleting the track', () => {
    const item = overlayItem({
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] }],
    })
    const { onChange } = renderInspector(item, 8) // localT = 3

    fireEvent.click(screen.getByRole('button', { name: 'Reset transform' }))

    const next = onChange.mock.calls[0][0] as VisualItem
    expect(hasKeyframes(next, 'offsetX')).toBe(true)
    const track = trackFor(next, 'offsetX')!
    expect(track.points.find(p => p.t === 3)?.value).toBe(0)
    // The animation itself survives — reset is non-destructive.
    expect(track.points.find(p => p.t === 0)?.value).toBe(0)
    expect(track.points.find(p => p.t === 10)?.value).toBe(100)
    // Unkeyframed props still take the plain scalar.
    expect(next.scale).toBe(1)
    expect(hasKeyframes(next, 'scale')).toBe(false)
  })
})

describe('OverlayInspector — header keyframe navigation', () => {
  function multiPropKeyed() {
    return overlayItem({
      keyframes: [
        { prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 6, value: 100 }] },
        { prop: 'opacity', points: [{ t: 2, value: 0 }, { t: 8, value: 1 }] },
      ],
    })
  }

  it('seeks to the previous keyframe across ALL props, in absolute timeline time', () => {
    const onSeek = vi.fn()
    renderInspector(multiPropKeyed(), 10, { onSeek }) // localT = 5

    fireEvent.click(screen.getByRole('button', { name: 'Previous keyframe' }))

    // Largest t < 5 across both tracks is 2, and the seek is item.start + t.
    expect(onSeek).toHaveBeenCalledTimes(1)
    expect(onSeek).toHaveBeenCalledWith(7)
  })

  it('seeks to the next keyframe across ALL props', () => {
    const onSeek = vi.fn()
    renderInspector(multiPropKeyed(), 10, { onSeek }) // localT = 5

    fireEvent.click(screen.getByRole('button', { name: 'Next keyframe' }))

    // Smallest t > 5 across both tracks is 6.
    expect(onSeek).toHaveBeenCalledWith(11)
  })

  it('renders the arrows disabled when the host supplies no onSeek', () => {
    renderInspector(multiPropKeyed(), 10)

    expect(screen.getByRole('button', { name: 'Previous keyframe' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next keyframe' })).toBeDisabled()
  })

  it('disables an arrow when there is no keyframe in that direction', () => {
    const onSeek = vi.fn()
    renderInspector(multiPropKeyed(), 5, { onSeek }) // localT = 0, nothing before it

    expect(screen.getByRole('button', { name: 'Previous keyframe' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next keyframe' })).toBeEnabled()
  })

  it('gives each row its own arrows, scoped to that prop', () => {
    const onSeek = vi.fn()
    renderInspector(multiPropKeyed(), 10, { onSeek }) // localT = 5

    // The Position pair covers offsetX (points 0, 6); largest t < 5 is 0, and
    // the seek is item.start + t = 5. opacity's 2 and 8 are not its business.
    fireEvent.click(screen.getByRole('button', { name: 'Previous Position keyframe' }))
    expect(onSeek).toHaveBeenCalledWith(5)

    // Scale has no track at all.
    expect(screen.getByRole('button', { name: 'Previous Scale keyframe' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next Scale keyframe' })).toBeDisabled()
  })
})

describe('OverlayInspector — keyframe all transform properties', () => {
  it('is not pressed unless EVERY prop has a point at the playhead', () => {
    const item = overlayItem({ keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 10 }] }] })
    renderInspector(item, 5) // localT = 0

    expect(screen.getByRole('button', { name: HEADER_DIAMOND })).toHaveAttribute('aria-pressed', 'false')
  })

  it('is pressed when all five have a point at the playhead', () => {
    renderInspector(allKeyedItem(), 5) // localT = 0

    expect(screen.getByRole('button', { name: HEADER_DIAMOND })).toHaveAttribute('aria-pressed', 'true')
  })

  it('is not pressed when the playhead sits between the points', () => {
    renderInspector(allKeyedItem(), 8) // localT = 3, no track has a point there

    expect(screen.getByRole('button', { name: HEADER_DIAMOND })).toHaveAttribute('aria-pressed', 'false')
  })

  it('adds a point at the playhead to all five without moving anything', () => {
    const item = overlayItem({
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] }],
    })
    const { onChange } = renderInspector(item, 8) // localT = 3

    fireEvent.click(screen.getByRole('button', { name: HEADER_DIAMOND }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as VisualItem
    for (const prop of ALL_PROPS) {
      expect(hasKeyframes(next, prop)).toBe(true)
      expect(trackFor(next, prop)!.points.some(p => p.t === 3)).toBe(true)
      // Nothing on screen moves: every sampled value is exactly what it was.
      expect(valueAt(next, prop, 3)).toBe(valueAt(item, prop, 3))
    }
    // The prop that was ALREADY animated keeps its curve — enableKeyframing's
    // no-op contract is what protects it.
    expect(valueAt(next, 'offsetX', 0)).toBe(0)
    expect(valueAt(next, 'offsetX', 10)).toBe(100)
  })

  it('removes just the point at the playhead from multi-point tracks', () => {
    const { onChange } = renderInspector(allKeyedItem(), 5) // localT = 0, all pressed

    fireEvent.click(screen.getByRole('button', { name: HEADER_DIAMOND }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as VisualItem
    for (const prop of ALL_PROPS) {
      expect(hasKeyframes(next, prop)).toBe(true) // still animated
      expect(trackFor(next, prop)!.points.some(p => p.t === 0)).toBe(false)
    }
    expect(trackFor(next, 'offsetX')!.points).toEqual([{ t: 10, value: 100 }])
  })

  it('writes the static scalar for a prop whose ONLY point is at the playhead', () => {
    const item = overlayItem({
      // Stale scalars: whatever was left behind when keyframing was switched
      // on. `removeKeyframe` would drop the track and let these snap back.
      offsetX: 999,
      offsetY: 999,
      scale: 999,
      rotation: 999,
      opacity: 999,
      keyframes: [
        { prop: 'offsetX',  points: [{ t: 0, value: 3 }] },
        { prop: 'offsetY',  points: [{ t: 0, value: 4 }] },
        { prop: 'scale',    points: [{ t: 0, value: 0.5 }] },
        { prop: 'rotation', points: [{ t: 0, value: 30 }] },
        { prop: 'opacity',  points: [{ t: 0, value: 0.25 }] },
      ],
    })
    const { onChange } = renderInspector(item, 5) // localT = 0, all pressed

    fireEvent.click(screen.getByRole('button', { name: HEADER_DIAMOND }))

    const next = onChange.mock.calls[0][0] as VisualItem
    expect(next.keyframes).toBeUndefined()
    expect(next.offsetX).toBe(3)
    expect(next.offsetY).toBe(4)
    expect(next.scale).toBe(0.5)
    expect(next.rotation).toBe(30)
    expect(next.opacity).toBe(0.25)
    // The overlay does not move: every value survived the round trip.
    for (const prop of ALL_PROPS) {
      expect(valueAt(next, prop, 0)).toBe(valueAt(item, prop, 0))
    }
  })
})
