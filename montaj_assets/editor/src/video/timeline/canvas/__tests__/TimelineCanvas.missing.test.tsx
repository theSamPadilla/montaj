/// <reference types="vitest/globals" />
/**
 * `missingClips`: edits that need no pixels (drag-move, trim) keep working on a
 * clip whose footage is absent. Same harness as TimelineCanvas.pointer.test.tsx.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { createPlaybackClock } from '../../../playback-clock'
import type { Project } from '../../../../types'
import TimelineCanvas from '../TimelineCanvas'
import { createViewportStore } from '../viewport'
import { computeTimelineLayout } from '../draw'
import { trackItems } from '../../timeline-model'
import { MissingClipsProvider } from '../../../missingClips'

let realGetContext: typeof HTMLCanvasElement.prototype.getContext
let realGetRect: typeof Element.prototype.getBoundingClientRect

beforeEach(() => {
  realGetContext = HTMLCanvasElement.prototype.getContext
  realGetRect = Element.prototype.getBoundingClientRect
  HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'createLinearGradient') return () => ({ addColorStop: () => {} })
      return () => {}
    },
    set() { return true },
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return { x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 100, width: 1000, height: 100, toJSON: () => ({}) } as DOMRect
  }
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  HTMLCanvasElement.prototype.getContext = realGetContext
  Element.prototype.getBoundingClientRect = realGetRect
})

const project = {
  id: 'p',
  tracks: [{
    id: 'trk-0',
    items: [
      { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4, sourceDuration: 20 },
      { id: 'c1', type: 'video', src: 'b.mp4', start: 4, end: 8, inPoint: 0, outPoint: 4, sourceDuration: 20 },
    ],
  }],
} as unknown as Project

const ROW_Y = (() => {
  const row = computeTimelineLayout(project).rows[0]
  return Math.round(row.y + row.height / 2)
})()

function mount() {
  const store = createViewportStore()
  const onProjectChange = vi.fn()
  const onOverlayEdit = vi.fn()
  const utils = render(
    <MissingClipsProvider ids={new Set(['c0'])} notify={undefined}>
      <TimelineCanvas
        project={project}
        clock={createPlaybackClock()}
        store={store}
        totalDuration={13}
        fps={30}
        selectedIds={[]}
        snapBoundaries={[0, 4, 8]}
        onSelectItem={vi.fn()}
        onSelectItems={vi.fn()}
        onProjectChange={onProjectChange}
        onOverlayEdit={onOverlayEdit}
      />
    </MissingClipsProvider>,
  )
  act(() => { vi.advanceTimersByTime(32) })
  act(() => { store.set({ pxPerSecond: 100, scrollSeconds: 0, widthPx: 1000 }) })
  act(() => { vi.advanceTimersByTime(32) })
  return { onProjectChange, onOverlayEdit, surface: utils.container.querySelector('[data-timeline-canvas]') as HTMLElement }
}

function mouse(type: string, x: number, y: number) {
  return new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 })
}

describe('missingClips: edits still work on a missing clip', () => {
  it('moves it by dragging', () => {
    const { surface, onOverlayEdit } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', 200, ROW_Y)) })
    act(() => { document.dispatchEvent(mouse('mousemove', 250, ROW_Y)) })
    act(() => { document.dispatchEvent(mouse('mousemove', 300, ROW_Y)) })
    act(() => { document.dispatchEvent(mouse('mouseup', 300, ROW_Y)) })
    const committed = onOverlayEdit.mock.calls[0][0] as Project
    expect(trackItems(committed).flat().find(i => i.id === 'c0')).toMatchObject({ start: 1, end: 5 })
  })

  it('trims it from the out handle', () => {
    const { surface, onProjectChange } = mount()
    act(() => { surface.dispatchEvent(mouse('mousedown', 396, ROW_Y)) })
    act(() => { document.dispatchEvent(mouse('mousemove', 296, ROW_Y)) })
    act(() => { document.dispatchEvent(mouse('mouseup', 296, ROW_Y)) })
    const edited = onProjectChange.mock.calls[0][0] as Project
    expect(trackItems(edited).flat().find(i => i.id === 'c0')).toMatchObject({ end: 3, outPoint: 3 })
  })
})
