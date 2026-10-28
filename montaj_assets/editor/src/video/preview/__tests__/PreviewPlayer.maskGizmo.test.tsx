/**
 * §616 U2: the mask gizmo on the tracks[0] base clip, through the real
 * PreviewPlayer. The base clip's handles are PreviewPlayer's own (not
 * OverlayItemsLayer's), so the gizmo is mounted there too, in the base clip's
 * box, above the clip's move box: a press inside the mask outline moves the
 * mask, not the clip. Commits go through `applyOverlayChanges`, the body of
 * VideoEditor's handleOverlayChange.
 */
import { useRef, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import PreviewPlayer from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import { applyOverlayChanges, type OverlayChanges } from '../useDragOverlay'
import type { EditorProject as Project, VisualItem } from '../../../schema'

const PLAYHEAD = 6
// The preview frame, px: the 1080 x 1920 canvas at 0.1.
const FRAME_W = 108
const FRAME_H = 192

function clip(over: Partial<VisualItem> = {}): VisualItem {
  return {
    id: 'c0', type: 'video', src: 'a.mp4', start: 2, end: 12, inPoint: 0,
    mask: { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.25 },
    ...over,
  } as VisualItem
}

const commits: OverlayChanges[] = []
let latest: VisualItem

function Host({ initial, selected = true }: { initial: VisualItem; selected?: boolean }) {
  const [item, setItem] = useState(initial)
  latest = item
  const clock = useRef(createPlaybackClock(PLAYHEAD)).current
  const project = { id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [[item]] } as unknown as Project
  return (
    <PreviewPlayer
      project={project}
      clock={clock}
      selectedOverlayId={selected ? item.id : undefined}
      onOverlayChange={(_id, changes, options) => {
        commits.push(changes)
        setItem(prev => applyOverlayChanges(prev, changes, clock.get(), options))
      }}
      compileOverlay={async () => (() => null) as never}
      fileUrl={(p) => p}
    />
  )
}

beforeAll(() => {
  if (typeof window.PointerEvent === 'undefined') {
    class PointerEvent extends MouseEvent {
      pointerId: number
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0 }
    }
    ;(window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEvent
  }
})

beforeEach(() => {
  commits.length = 0
  vi.spyOn(console, 'info').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private cb: (entries: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: FRAME_W, height: FRAME_H } }]) }
    unobserve() {}
    disconnect() {}
  }
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => (
    { width: FRAME_W, height: FRAME_H, left: 0, top: 0, right: FRAME_W, bottom: FRAME_H, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  ))
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
    state = 'running'
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createMediaElementSource() { return { connect() {}, disconnect() {} } }
    get destination() { return {} }
    close() {}
  }
})

afterEach(() => vi.restoreAllMocks())

describe('base clip mask gizmo', () => {
  it('shows when the masked base clip is selected', () => {
    render(<Host initial={clip()} />)
    expect(screen.getByLabelText('Move mask')).toBeTruthy()
    expect(screen.getAllByLabelText('Resize mask')).toHaveLength(8)
    expect(screen.getByLabelText('Rotate mask')).toBeTruthy()
    expect(screen.getByLabelText('Mask feather')).toBeTruthy()
  })

  it('is absent when the base clip is not selected, or has no mask', () => {
    const a = render(<Host initial={clip()} selected={false} />)
    expect(screen.queryByLabelText('Move mask')).toBeNull()
    a.unmount()
    render(<Host initial={clip({ mask: undefined })} />)
    expect(screen.queryByLabelText('Move mask')).toBeNull()
  })

  it('sits in the base clip box: its viewBox is the box at the zoom on screen', () => {
    const { container } = render(<Host initial={clip({ scale: 0.5 })} />)
    const svg = container.querySelector('[data-mask-gizmo] svg')!
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${FRAME_W * 0.5} ${FRAME_H * 0.5}`)
  })

  it('a drag inside the outline moves the mask, not the clip', () => {
    render(<Host initial={clip({ offsetX: 0, offsetY: 0 })} />)
    const move = screen.getByLabelText('Move mask')
    fireEvent.pointerDown(move, { clientX: 54, clientY: 96, pointerId: 1, button: 0 })
    fireEvent.pointerMove(move, { clientX: 54 + 0.1 * FRAME_W, clientY: 96, pointerId: 1 })
    fireEvent.pointerUp(move, { clientX: 54 + 0.1 * FRAME_W, clientY: 96, pointerId: 1 })
    expect(commits).toHaveLength(1)
    expect(commits[0].offsetX).toBeUndefined()
    expect(latest.mask!.x).toBeCloseTo(0.6)
    expect(latest.offsetX).toBe(0)
  })
})
