/// <reference types="vitest/globals" />
import { render, act } from '@testing-library/react'
import { createPlaybackClock } from '../../playback-clock'
import { TimelineContext, type TimelineContextValue } from '../TimelineContext'
import PlayheadLine from '../PlayheadLine'

function makeCtx(overrides: Partial<TimelineContextValue> = {}): TimelineContextValue {
  return {
    totalDuration: 10,
    contentDuration: 10,
    snapBoundaries: [],
    zoom: 1,
    zoomRef: { current: 1 },
    scrollRef: { current: null },
    scrubberRef: { current: null },
    overlayDraggedRef: { current: false },
    clock: createPlaybackClock(),
    markers: [null, null],
    setMarkers: () => {},
    selection: null,
    ...overrides,
  }
}

test('PlayheadLine moves on clock.set without re-rendering a sibling row', () => {
  const ctx = makeCtx()
  let siblingRenders = 0

  function Sibling() {
    siblingRenders++
    return null
  }
  function Root() {
    return (
      <TimelineContext.Provider value={ctx}>
        <PlayheadLine />
        <Sibling />
      </TimelineContext.Provider>
    )
  }

  const { container } = render(<Root />)
  const before = siblingRenders

  act(() => { ctx.clock.set(4) })

  const line = container.querySelector('div') as HTMLDivElement
  expect(line.style.left).toBe('40%')
  expect(siblingRenders).toBe(before)
})

test('renders nothing when totalDuration is 0', () => {
  const ctx = makeCtx({ totalDuration: 0 })
  const { container } = render(
    <TimelineContext.Provider value={ctx}>
      <PlayheadLine />
    </TimelineContext.Provider>,
  )
  expect(container.firstChild).toBeNull()
})
