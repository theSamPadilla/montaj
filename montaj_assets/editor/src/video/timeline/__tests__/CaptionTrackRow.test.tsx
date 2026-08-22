/// <reference types="vitest/globals" />
import { render, screen, fireEvent } from '@testing-library/react'
import { createPlaybackClock } from '../../playback-clock'
import { TimelineContext, type TimelineContextValue } from '../TimelineContext'
import CaptionTrackRow from '../CaptionTrackRow'
import type { CaptionSegment } from '../../../schema'

// Content width matches totalDuration 1:1 (1000px / 100s) so a clientX delta
// of N px is exactly N/10 seconds — makes the drag-math assertions readable.
const RECT = {
  width: 1000, height: 40, left: 0, top: 0, right: 1000, bottom: 40, x: 0, y: 0,
  toJSON: () => ({}),
} as DOMRect

function makeCtx(overrides: Partial<TimelineContextValue> = {}): TimelineContextValue {
  return {
    viewport: null,
    totalDuration: 100,
    contentDuration: 100,
    snapBoundaries: [],
    zoom: 1,
    zoomRef: { current: 1 },
    scrollRef: { current: { getBoundingClientRect: () => RECT } as unknown as HTMLDivElement },
    scrubberRef: { current: null },
    overlayDraggedRef: { current: false },
    clock: createPlaybackClock(),
    ...overrides,
  }
}

const seg = (over: Partial<CaptionSegment> = {}): CaptionSegment => ({
  id: 'cap-0', text: 'hello world', start: 10, end: 20, ...over,
})

test('empty state renders when captionTrack is absent', () => {
  render(
    <TimelineContext.Provider value={makeCtx()}>
      <CaptionTrackRow captionTrack={undefined} fps={30} selectedCaptionId={null} />
    </TimelineContext.Provider>,
  )
  expect(screen.getByText('Captions')).toBeTruthy()
})

test('empty state renders when captionTrack has zero segments', () => {
  render(
    <TimelineContext.Provider value={makeCtx()}>
      <CaptionTrackRow captionTrack={{ style: 'clean', segments: [] }} fps={30} selectedCaptionId={null} />
    </TimelineContext.Provider>,
  )
  expect(screen.getByText('Captions')).toBeTruthy()
})

test('clicking a segment selects it and seeks the playhead into it', () => {
  const ctx = makeCtx()
  const onSelectCaption = vi.fn()
  render(
    <TimelineContext.Provider value={ctx}>
      <CaptionTrackRow
        captionTrack={{ style: 'clean', segments: [seg()] }}
        fps={30}
        selectedCaptionId={null}
        onSelectCaption={onSelectCaption}
      />
    </TimelineContext.Provider>,
  )
  // The row itself (trackRow) also carries `cursor-pointer`, so anchor off the
  // segment's text and walk up to its block instead of querying the class.
  const block = screen.getByText('hello world').parentElement as HTMLDivElement
  fireEvent.click(block)
  expect(onSelectCaption).toHaveBeenCalledWith('cap-0')
  expect(ctx.clock.get()).toBeCloseTo(10 + 0.5 / 30)
})

// Regression guard: the seek must survive CaptionPreview's frame quantization.
// The preview computes `t = Math.round(currentTime * fps) / fps` before running
// the templates' `t >= start && t < end` test, so seeking to a `start` that is
// not frame-aligned used to round DOWN into the PREVIOUS segment — the operator
// clicked a caption in the timeline and the preview drew its box over the one
// before it. Whisper emits arbitrary floats, so this hit about half of all
// segments.
test('the seek lands inside the clicked segment even when its start is not frame-aligned', () => {
  const fps = 30
  // 3.44 * 30 = 103.2 → frame 103 → t = 3.4333, which is BEFORE 3.44.
  const segments: CaptionSegment[] = [
    { id: 'cap-0', text: 'first',  start: 0,    end: 3.44 },
    { id: 'cap-1', text: 'second', start: 3.44, end: 6.02 },
  ]
  const ctx = makeCtx()
  render(
    <TimelineContext.Provider value={ctx}>
      <CaptionTrackRow
        captionTrack={{ style: 'clean', segments }}
        fps={fps}
        selectedCaptionId={null}
        onSelectCaption={vi.fn()}
      />
    </TimelineContext.Provider>,
  )
  fireEvent.click(screen.getByText('second').parentElement as HTMLDivElement)

  const t = Math.round(ctx.clock.get() * fps) / fps
  const active = segments.find((s) => t >= s.start && t < s.end)
  expect(active?.id).toBe('cap-1')
})

// Regression guard: `steps/lyrics/caption.py` emits segments with no `id`
// field at all — ids are only minted later by VideoEditor's
// backfillCaptionIds effect. On first render `live` is null, so `live?.id`
// is undefined; an id-less segment's `seg.id` is also undefined, and
// undefined === undefined used to make `isLive` true and dereference `live!`
// while it was still null. This is the normal shape of every real project on
// its first paint, not an edge case.
test('renders without throwing when segments have no id field (pre-backfill shape)', () => {
  const segments = [
    { text: 'hello world', start: 10, end: 20 },
  ] as unknown as CaptionSegment[]
  expect(() =>
    render(
      <TimelineContext.Provider value={makeCtx()}>
        <CaptionTrackRow
          captionTrack={{ style: 'clean', segments }}
          fps={30}
          selectedCaptionId={null}
        />
      </TimelineContext.Provider>,
    ),
  ).not.toThrow()
})

describe('edge-drag retiming', () => {
  // Regression guard for the single easiest way to break this feature: a
  // retime patch must carry ONLY the dragged edge. If `text` ever leaked in,
  // makeCaptionEdit would respread word timings and destroy per-word timing.
  it('dragging the right edge sends { end } only — never text/words/other fields', () => {
    const ctx = makeCtx()
    const onCaptionSegmentChange = vi.fn()
    const { container } = render(
      <TimelineContext.Provider value={ctx}>
        <CaptionTrackRow
          captionTrack={{ style: 'clean', segments: [seg()] }}
          fps={30}
          selectedCaptionId={null}
          onCaptionSegmentChange={onCaptionSegmentChange}
        />
      </TimelineContext.Provider>,
    )
    const handles = container.querySelectorAll('.cursor-ew-resize')
    const rightHandle = handles[1] as HTMLDivElement

    fireEvent.mouseDown(rightHandle, { clientX: 500 })
    fireEvent.mouseMove(document, { clientX: 600 }) // +100px = +10s
    // Not committed until mouseup — retiming must not fire on every tick
    // (unlike VisualTrackRow, onCaptionSegmentChange pushes an undo entry and
    // queues a save PER CALL).
    expect(onCaptionSegmentChange).not.toHaveBeenCalled()

    fireEvent.mouseUp(document)
    expect(onCaptionSegmentChange).toHaveBeenCalledTimes(1)
    const [id, patch] = onCaptionSegmentChange.mock.calls[0]
    expect(id).toBe('cap-0')
    expect(patch).toEqual({ end: 30 })
    expect(Object.keys(patch)).toEqual(['end'])
  })

  // `useItemDragDrop.beginResize` has no travel threshold (unlike `beginDrag`)
  // and calls onCommit unconditionally on mouseup, so a bare click on the 6px
  // edge handle used to commit the edge's unchanged value — one undo entry and
  // one queued save for a project that did not change.
  it('a press-and-release on an edge handle with no movement commits nothing', () => {
    const ctx = makeCtx()
    const onCaptionSegmentChange = vi.fn()
    const { container } = render(
      <TimelineContext.Provider value={ctx}>
        <CaptionTrackRow
          captionTrack={{ style: 'clean', segments: [seg()] }}
          fps={30}
          selectedCaptionId={null}
          onCaptionSegmentChange={onCaptionSegmentChange}
        />
      </TimelineContext.Provider>,
    )
    const rightHandle = container.querySelectorAll('.cursor-ew-resize')[1] as HTMLDivElement

    fireEvent.mouseDown(rightHandle, { clientX: 500 })
    fireEvent.mouseUp(document)
    expect(onCaptionSegmentChange).not.toHaveBeenCalled()
  })

  // A drag that returns to where it started is likewise a no-op — the edge
  // value is what matters, not whether the pointer moved.
  it('a drag that ends back at the original edge commits nothing', () => {
    const ctx = makeCtx()
    const onCaptionSegmentChange = vi.fn()
    const { container } = render(
      <TimelineContext.Provider value={ctx}>
        <CaptionTrackRow
          captionTrack={{ style: 'clean', segments: [seg()] }}
          fps={30}
          selectedCaptionId={null}
          onCaptionSegmentChange={onCaptionSegmentChange}
        />
      </TimelineContext.Provider>,
    )
    const rightHandle = container.querySelectorAll('.cursor-ew-resize')[1] as HTMLDivElement

    fireEvent.mouseDown(rightHandle, { clientX: 500 })
    fireEvent.mouseMove(document, { clientX: 600 })
    fireEvent.mouseMove(document, { clientX: 500 })
    fireEvent.mouseUp(document)
    expect(onCaptionSegmentChange).not.toHaveBeenCalled()
  })

  it('dragging the left edge sends { start } only', () => {
    const ctx = makeCtx()
    const onCaptionSegmentChange = vi.fn()
    const { container } = render(
      <TimelineContext.Provider value={ctx}>
        <CaptionTrackRow
          captionTrack={{ style: 'clean', segments: [seg()] }}
          fps={30}
          selectedCaptionId={null}
          onCaptionSegmentChange={onCaptionSegmentChange}
        />
      </TimelineContext.Provider>,
    )
    const handles = container.querySelectorAll('.cursor-ew-resize')
    const leftHandle = handles[0] as HTMLDivElement

    fireEvent.mouseDown(leftHandle, { clientX: 500 })
    fireEvent.mouseMove(document, { clientX: 400 }) // -100px = -10s
    fireEvent.mouseUp(document)

    expect(onCaptionSegmentChange).toHaveBeenCalledTimes(1)
    const [id, patch] = onCaptionSegmentChange.mock.calls[0]
    expect(id).toBe('cap-0')
    expect(patch).toEqual({ start: 0 })
    expect(Object.keys(patch)).toEqual(['start'])
  })
})
