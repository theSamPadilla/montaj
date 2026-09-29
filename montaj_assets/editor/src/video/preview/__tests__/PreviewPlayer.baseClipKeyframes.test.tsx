/**
 * The tracks[0] base clip's own gestures (non-canvas projects) on an ANIMATED
 * clip, through the real PreviewPlayer.
 *
 * The base clip's move box, corner handles and wheel zoom are PreviewPlayer's,
 * not useDragOverlay's. They read the clip's STATIC fields, while keyframes set
 * what the export draws (encode-segment.js animatedGeometry). So the picture sat
 * at the static position, a drag started there, and the commit keyed a value
 * the picture then ignored: it snapped back on release. The picture and every
 * gesture now start from the value at the playhead, and the commit goes through
 * the same rule as every other preview gesture (`applyOverlayChanges`, the body
 * of VideoEditor's handleOverlayChange), Option included.
 */
import { useRef, useState } from 'react'
import { fireEvent, render } from '@testing-library/react'
import PreviewPlayer from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import { applyOverlayChanges, type OverlayChanges, type OverlayCommitOptions } from '../useDragOverlay'
import { trackFor } from '../../keyframeOps'
import type { EditorProject as Project, KeyframeTrack, VisualItem } from '../../../schema'

// start = 2, deliberately non-zero: keyframe `t` is item-relative.
const PLAYHEAD = 6 // localT = 4
const LOCAL_T = 4
const FRAME = 100 // the preview frame, px square

const POSITION: KeyframeTrack[] = [
  // At localT 4: offsetX -4, offsetY 16. The static 5 / -5 below are hidden.
  { prop: 'offsetX', points: [{ t: 0, value: -20 }, { t: 10, value: 20 }] },
  { prop: 'offsetY', points: [{ t: 0, value: 0 }, { t: 10, value: 40 }] },
]
// At localT 4: 0.7. The static 0.8 below is hidden.
const ZOOM: KeyframeTrack[] = [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 10, value: 1 }] }]

function clip(over: Partial<VisualItem> = {}): VisualItem {
  return { id: 'c0', type: 'video', src: 'a.mp4', start: 2, end: 12, inPoint: 0, offsetX: 5, offsetY: -5, ...over } as VisualItem
}

const commits: Array<[string, OverlayChanges, OverlayCommitOptions | undefined]> = []
let latest: VisualItem

/** PreviewPlayer with VideoEditor's commit: `applyOverlayChanges` at the clock's time. */
function Host({ initial }: { initial: VisualItem }) {
  const [item, setItem] = useState(initial)
  latest = item
  const clock = useRef(createPlaybackClock(PLAYHEAD)).current
  const project = { id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [[item]] } as unknown as Project
  return (
    <PreviewPlayer
      project={project}
      clock={clock}
      selectedOverlayId={item.id}
      onOverlayChange={(id, changes, options) => {
        commits.push([id, changes, options])
        setItem(prev => applyOverlayChanges(prev, changes, clock.get(), options))
      }}
      compileOverlay={async () => (() => null) as never}
      fileUrl={(p) => p}
    />
  )
}

function mount(initial: VisualItem) {
  const utils = render(<Host initial={initial} />)
  const picture = () => ((utils.container.querySelector('video') as HTMLElement).parentElement as HTMLElement).parentElement as HTMLElement
  const moveBox = () => Array.from(utils.container.querySelectorAll<HTMLElement>('div')).find(d => d.style.cursor === 'move') as HTMLElement
  const cornerSE = () => Array.from(utils.container.querySelectorAll<HTMLElement>('div')).filter(d => d.style.cursor === 'nwse-resize')[3]
  return { ...utils, picture, moveBox, cornerSE }
}

/** Press, move, release on one handle (the base clip's handlers are on the element). */
function drag(el: () => HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }, pictureOf: () => HTMLElement, release: { altKey?: boolean } = {}) {
  fireEvent.pointerDown(el(), { clientX: from.x, clientY: from.y, pointerId: 1 })
  fireEvent.pointerMove(el(), { clientX: to.x, clientY: to.y, pointerId: 1 })
  const midDrag = pictureOf().style.transform
  fireEvent.pointerUp(el(), { clientX: to.x, clientY: to.y, pointerId: 1, ...release })
  return { midDrag, afterRelease: pictureOf().style.transform }
}

beforeAll(() => {
  // jsdom has no PointerEvent; without one RTL builds a bare Event that drops
  // clientX and altKey.
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
  // The frame's measured size: the move gesture converts pixels to % of it.
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private cb: (entries: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: FRAME, height: FRAME } }]) }
    unobserve() {}
    disconnect() {}
  }
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => (
    { width: FRAME, height: FRAME, left: 0, top: 0, right: FRAME, bottom: FRAME, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
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

describe('base clip drag on an animated position', () => {
  it('starts from the animated position on screen, lands where it is dropped, and stays there after release', () => {
    const { picture, moveBox } = mount(clip({ keyframes: POSITION }))
    // The picture shows the curve at the playhead, not the hidden static 5 / -5.
    expect(picture().style.transform).toBe('translate(-4%, 16%) scale(1, 1)')

    const { midDrag, afterRelease } = drag(moveBox, { x: 50, y: 50 }, { x: 60, y: 45 }, picture)

    expect(midDrag).toBe('translate(6%, 11%) scale(1, 1)')
    expect(afterRelease).toBe(midDrag)
    // Keyed at the playhead; the static fields are not the edit.
    expect(trackFor(latest, 'offsetX')!.points).toEqual([{ t: 0, value: -20 }, { t: LOCAL_T, value: 6 }, { t: 10, value: 20 }])
    expect(trackFor(latest, 'offsetY')!.points).toEqual([{ t: 0, value: 0 }, { t: LOCAL_T, value: 11 }, { t: 10, value: 40 }])
    expect([latest.offsetX, latest.offsetY]).toEqual([5, -5])
    expect(commits[0][2]).toEqual({ shiftAnimation: false })
  })

  it('Option at release shifts every keyframe by the drag, and the clip stays where it was dropped', () => {
    const { picture, moveBox } = mount(clip({ keyframes: POSITION }))

    const { midDrag, afterRelease } = drag(moveBox, { x: 50, y: 50 }, { x: 60, y: 45 }, picture, { altKey: true })

    expect(commits[0][2]).toEqual({ shiftAnimation: true })
    expect(trackFor(latest, 'offsetX')!.points).toEqual([{ t: 0, value: -10 }, { t: 10, value: 30 }])
    expect(trackFor(latest, 'offsetY')!.points).toEqual([{ t: 0, value: -5 }, { t: 10, value: 35 }])
    expect([latest.offsetX, latest.offsetY]).toEqual([5, -5])
    expect(afterRelease).toBe(midDrag)
  })

  it('a corner drag scales from the animated scale on screen and keys it at the playhead', () => {
    const { picture, cornerSE } = mount(clip({ offsetX: 0, offsetY: 0, scale: 0.8, keyframes: ZOOM }))
    expect(picture().style.transform).toBe('translate(0%, 0%) scale(0.7, 0.7)')

    // The frame's centre is (50, 50): 1.5x the press distance is 1.5x the scale.
    const { midDrag, afterRelease } = drag(cornerSE, { x: 100, y: 100 }, { x: 125, y: 125 }, picture)

    const keyed = trackFor(latest, 'scale')!.points.find(p => p.t === LOCAL_T)!.value
    expect(keyed).toBeCloseTo(0.7 * 1.5, 10)
    expect(latest.scale).toBe(0.8)
    expect(afterRelease).toBe(midDrag)
  })
})

describe('base clip drag with no animation', () => {
  it('still writes the static position and creates no keyframes', () => {
    const { picture, moveBox } = mount(clip())
    expect(picture().style.transform).toBe('translate(5%, -5%) scale(1, 1)')

    const { midDrag, afterRelease } = drag(moveBox, { x: 50, y: 50 }, { x: 60, y: 45 }, picture)

    expect(latest.keyframes).toBeUndefined()
    expect([latest.offsetX, latest.offsetY]).toEqual([15, -10])
    expect(afterRelease).toBe(midDrag)
  })
})

describe('base clip wheel zoom on an animated scale', () => {
  it('zooms from the scale on screen and keys it at the playhead', () => {
    const { picture, moveBox } = mount(clip({ offsetX: 0, offsetY: 0, scale: 0.8, keyframes: ZOOM }))

    fireEvent.wheel(moveBox(), { deltaY: -1 })

    expect(commits[0][1].scale).toBeCloseTo(0.7 * 1.06, 12)
    expect(trackFor(latest, 'scale')!.points).toHaveLength(3)
    expect(trackFor(latest, 'scale')!.points.find(p => p.t === LOCAL_T)!.value).toBeCloseTo(0.7 * 1.06, 12)
    expect(latest.scale).toBe(0.8)
    expect(picture().style.transform).toBe(`translate(0%, 0%) scale(${0.7 * 1.06}, ${0.7 * 1.06})`)
  })

  it('with Option, scales the whole animation instead', () => {
    const { moveBox } = mount(clip({ offsetX: 0, offsetY: 0, scale: 0.8, keyframes: ZOOM }))

    fireEvent.wheel(moveBox(), { deltaY: -1, altKey: true })

    const points = trackFor(latest, 'scale')!.points
    expect(points.map(p => p.t)).toEqual([0, 10])
    expect(points[0].value).toBeCloseTo(0.5 * 1.06, 12)
    expect(points[1].value).toBeCloseTo(1 * 1.06, 12)
    expect(latest.scale).toBe(0.8)
  })
})
