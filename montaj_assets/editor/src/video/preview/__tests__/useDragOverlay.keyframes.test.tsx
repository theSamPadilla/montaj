/// <reference types="vitest/globals" />
import { useRef, useState } from 'react'
import { act, render, renderHook } from '@testing-library/react'
import { geometryAt } from '@bycrux/timeline-core'
import type { EditorProject, KeyframeTrack, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import { trackFor, valueAt } from '../../keyframeOps'
import { applyOverlayChanges, useDragOverlay, type OverlayChanges, type OverlayCommitOptions } from '../useDragOverlay'
import OverlayItemsLayer from '../OverlayItemsLayer'

// A preview gesture (move, resize, rotate) on an ANIMATED property.
//
// The bug this file pins: the drag used to commit through a plain
// `{ ...item, ...changes }` merge, which writes STATIC scalars. Every frame
// resolves keyframe over static (timeline-core geometry.js), so on a keyframed
// property the drag was hidden, the item snapped back on release, and the
// export ignored it too. A drag now obeys the same rule as every inspector
// control: an animated property gets a keyframe at the playhead, and Option
// (Alt) at release shifts the whole animation instead.
//
// `applyOverlayChanges` is the commit VideoEditor's `handleOverlayChange` runs,
// so these tests exercise the real commit path rather than a copy of it.

// start = 2, deliberately non-zero: a keyframe `t` is item-relative, and a
// commit that used the absolute playhead would land at the wrong time.
const PLAYHEAD = 6 // localT = 4
const LOCAL_T = 4

function clip(over: Partial<VisualItem> = {}): VisualItem {
  return { id: 'v1', type: 'video', src: 'v.mp4', start: 2, end: 12, offsetX: 5, offsetY: -5, ...over } as VisualItem
}

const POSITION: KeyframeTrack[] = [
  { prop: 'offsetX', points: [{ t: 0, value: -20 }, { t: 10, value: 20 }] },
  { prop: 'offsetY', points: [{ t: 0, value: 0 }, { t: 10, value: 40 }] },
]

describe('a preview drag on an animated property keys at the playhead', () => {
  it('move: adds a keyframe holding the dragged value at the playhead, and the frame there shows it', () => {
    const item = clip({ keyframes: POSITION })

    const next = applyOverlayChanges(item, { offsetX: 30, offsetY: 7 }, PLAYHEAD)

    expect(trackFor(next, 'offsetX')!.points).toEqual([{ t: 0, value: -20 }, { t: LOCAL_T, value: 30 }, { t: 10, value: 20 }])
    expect(trackFor(next, 'offsetY')!.points).toEqual([{ t: 0, value: 0 }, { t: LOCAL_T, value: 7 }, { t: 10, value: 40 }])
    // What the preview and the export both resolve at that instant.
    const g = geometryAt(next, 'video', LOCAL_T)
    expect(g.offsetX).toBe(30)
    expect(g.offsetY).toBe(7)
    // The static scalars are not the edit: keyframes hide them.
    expect(next.offsetX).toBe(5)
    expect(next.offsetY).toBe(-5)
  })

  it('updates the keyframe already at the playhead instead of adding a second one', () => {
    const item = clip({ keyframes: POSITION })

    const next = applyOverlayChanges(item, { offsetX: 30, offsetY: 7 }, 2) // localT = 0

    expect(trackFor(next, 'offsetX')!.points).toEqual([{ t: 0, value: 30 }, { t: 10, value: 20 }])
  })

  it('clamps the playhead into the item span, as the inspector does', () => {
    const item = clip({ keyframes: POSITION })

    const next = applyOverlayChanges(item, { offsetX: 30, offsetY: 7 }, 99) // past the end: t = 10

    expect(trackFor(next, 'offsetX')!.points).toEqual([{ t: 0, value: -20 }, { t: 10, value: 30 }])
  })

  it('an axis the drag did not change gets no keyframe', () => {
    const item = clip({ keyframes: POSITION })
    const unchangedY = valueAt(item, 'offsetY', LOCAL_T)

    const next = applyOverlayChanges(item, { offsetX: 30, offsetY: unchangedY }, PLAYHEAD)

    expect(trackFor(next, 'offsetX')!.points).toHaveLength(3)
    expect(trackFor(next, 'offsetY')).toEqual(POSITION[1])
  })

  it('works the same on an overlay', () => {
    const item = { ...clip({ keyframes: POSITION }), type: 'overlay', src: 'o.jsx', props: {} } as VisualItem

    const next = applyOverlayChanges(item, { offsetX: 30, offsetY: 7 }, PLAYHEAD)

    expect(geometryAt(next, 'overlay', LOCAL_T).offsetX).toBe(30)
  })

  it('resize: keys `scale` at the playhead', () => {
    const item = clip({ scale: 0.8, keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 10, value: 1 }] }] })

    const next = applyOverlayChanges(item, { scale: 1.5 }, PLAYHEAD)

    expect(trackFor(next, 'scale')!.points).toEqual([{ t: 0, value: 0.5 }, { t: LOCAL_T, value: 1.5 }, { t: 10, value: 1 }])
    expect(geometryAt(next, 'video', LOCAL_T).scale).toBe(1.5)
    expect(next.scale).toBe(0.8)
  })

  it('resize: an edge drag keys the axis it changed and leaves the other alone', () => {
    const item = clip({
      scaleX: 1, scaleY: 1,
      keyframes: [
        { prop: 'scaleX', points: [{ t: 0, value: 1 }, { t: 10, value: 2 }] },
        { prop: 'scaleY', points: [{ t: 0, value: 1 }, { t: 10, value: 2 }] },
      ],
    })
    const sampledY = valueAt(item, 'scaleY', LOCAL_T)

    // The hook's edge-drag commit shape: the unchanged uniform knob rides along.
    const next = applyOverlayChanges(item, { scale: 1, scaleX: 3, scaleY: sampledY }, PLAYHEAD)

    expect(geometryAt(next, 'video', LOCAL_T).scaleX).toBe(3)
    expect(trackFor(next, 'scaleX')!.points).toHaveLength(3)
    expect(trackFor(next, 'scaleY')!.points).toHaveLength(2)
  })

  it('rotate: keys `rotation` at the playhead', () => {
    const item = clip({ rotation: 0, keyframes: [{ prop: 'rotation', points: [{ t: 0, value: 0 }, { t: 10, value: 90 }] }] })

    const next = applyOverlayChanges(item, { rotation: 80 }, PLAYHEAD)

    expect(trackFor(next, 'rotation')!.points).toEqual([{ t: 0, value: 0 }, { t: LOCAL_T, value: 80 }, { t: 10, value: 90 }])
    expect(geometryAt(next, 'video', LOCAL_T).rotation).toBe(80)
  })

  it('rotate: keeps the animation\'s winding, although the drag reports degrees in [0, 360)', () => {
    // Two full turns. Mid-way the curve reads 360; nudging it 10 degrees reads
    // 10 off the drag handle. Keying a literal 10 would unwind the spin.
    const item = clip({ keyframes: [{ prop: 'rotation', points: [{ t: 0, value: 0 }, { t: 8, value: 720 }] }] })
    expect(valueAt(item, 'rotation', LOCAL_T)).toBe(360)

    const next = applyOverlayChanges(item, { rotation: 10 }, PLAYHEAD)

    expect(trackFor(next, 'rotation')!.points.find(p => p.t === LOCAL_T)?.value).toBe(370)
  })
})

describe('Option-drag shifts the whole animation', () => {
  const SHIFT: OverlayCommitOptions = { shiftAnimation: true }

  it('move: every keyframe shifts by the drag delta, and the static value is untouched', () => {
    const item = clip({ keyframes: POSITION })
    const dx = 30 - valueAt(item, 'offsetX', LOCAL_T)
    const dy = 7 - valueAt(item, 'offsetY', LOCAL_T)

    const next = applyOverlayChanges(item, { offsetX: 30, offsetY: 7 }, PLAYHEAD, SHIFT)

    expect(trackFor(next, 'offsetX')!.points).toEqual([{ t: 0, value: -20 + dx }, { t: 10, value: 20 + dx }])
    expect(trackFor(next, 'offsetY')!.points).toEqual([{ t: 0, value: 0 + dy }, { t: 10, value: 40 + dy }])
    expect(geometryAt(next, 'video', LOCAL_T).offsetX).toBeCloseTo(30, 10)
    expect(geometryAt(next, 'video', LOCAL_T).offsetY).toBeCloseTo(7, 10)
    expect(next.offsetX).toBe(5)
    expect(next.offsetY).toBe(-5)
  })

  it('resize: every scale keyframe is multiplied by the ratio at the playhead', () => {
    const item = clip({ scale: 0.8, keyframes: [{ prop: 'scale', points: [{ t: 0, value: 0.5 }, { t: 10, value: 1 }] }] })
    const ratio = 1.4 / valueAt(item, 'scale', LOCAL_T)

    const next = applyOverlayChanges(item, { scale: 1.4 }, PLAYHEAD, SHIFT)

    const points = trackFor(next, 'scale')!.points
    expect(points.map(p => p.t)).toEqual([0, 10])
    expect(points[0].value).toBeCloseTo(0.5 * ratio, 10)
    expect(points[1].value).toBeCloseTo(1 * ratio, 10)
    expect(geometryAt(next, 'video', LOCAL_T).scale).toBeCloseTo(1.4, 10)
    expect(next.scale).toBe(0.8)
  })

  it('rotate: every keyframe shifts by the shortest turn to the dragged angle', () => {
    const item = clip({ rotation: 0, keyframes: [{ prop: 'rotation', points: [{ t: 0, value: 0 }, { t: 8, value: 720 }] }] })

    // The curve reads 360 at the playhead; the handle reports 10.
    const next = applyOverlayChanges(item, { rotation: 10 }, PLAYHEAD, SHIFT)

    expect(trackFor(next, 'rotation')!.points).toEqual([{ t: 0, value: 10 }, { t: 8, value: 730 }])
    expect(next.rotation).toBe(0)
  })

  it('a property with no animation just takes the static value', () => {
    const item = clip({ keyframes: [POSITION[0]] }) // offsetX animated, offsetY static

    const next = applyOverlayChanges(item, { offsetX: 30, offsetY: 9 }, PLAYHEAD, SHIFT)

    expect(next.offsetY).toBe(9)
    expect(trackFor(next, 'offsetY')).toBeUndefined()
  })
})

describe('a drag on an item with no animation', () => {
  it('writes static scalars exactly as before, and creates no keyframes', () => {
    const item = clip()
    const changes: OverlayChanges = { offsetX: 12, offsetY: 3, scale: 1.3, rotation: 45 }

    expect(applyOverlayChanges(item, changes, PLAYHEAD)).toEqual({ ...item, ...changes })
    expect(applyOverlayChanges(item, changes, PLAYHEAD, { shiftAnimation: true })).toEqual({ ...item, ...changes })
  })

  it('merges non-transform changes (fit, crop, props) as before, even on an animated item', () => {
    const item = clip({ keyframes: POSITION })
    const changes: OverlayChanges = { fit: 'contain', sourceCrop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, sourceWidth: 640 }

    const next = applyOverlayChanges(item, changes, PLAYHEAD)

    expect(next).toEqual({ ...item, ...changes })
  })
})

// ---------------------------------------------------------------------------
// Option is read off the release event, inside the hook.
// ---------------------------------------------------------------------------

function makeContainer() {
  return {
    current: { getBoundingClientRect: () => ({ width: 100, height: 100, left: 0, top: 0, right: 100, bottom: 100 }) },
  } as unknown as React.RefObject<HTMLDivElement | null>
}

function moveGesture(release: MouseEventInit) {
  const onOverlayChange = vi.fn()
  const hook = renderHook(() => useDragOverlay(makeContainer(), onOverlayChange))
  act(() => {
    hook.result.current.setDragState({
      id: 'i1', type: 'move', initX: 0, initY: 0,
      initOffsetX: 0, initOffsetY: 0, initScale: 1, initRotation: 0,
    })
  })
  act(() => { document.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 30 })) })
  act(() => { document.dispatchEvent(new MouseEvent('mouseup', release)) })
  return onOverlayChange
}

describe('useDragOverlay — Option at release', () => {
  it('asks for the whole animation to shift when Option is held on release', () => {
    const onOverlayChange = moveGesture({ altKey: true })
    expect(onOverlayChange).toHaveBeenCalledWith('i1', { offsetX: 20, offsetY: 30 }, { shiftAnimation: true })
  })

  it('asks for a keyframe at the playhead without Option', () => {
    const onOverlayChange = moveGesture({})
    expect(onOverlayChange).toHaveBeenCalledWith('i1', { offsetX: 20, offsetY: 30 }, { shiftAnimation: false })
  })
})

// ---------------------------------------------------------------------------
// End to end through the real layer and hook: what the live preview shows
// mid-drag is what stays on screen after release, in both modes. Before the
// fix the item snapped back to its keyframed position here.
// ---------------------------------------------------------------------------

const RECT = { width: 100, height: 100, left: 0, top: 0, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
const emptyProject = {
  id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [[]],
} as unknown as EditorProject

function Harness({ initial }: { initial: VisualItem }) {
  const [item, setItem] = useState(initial)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const drag = useDragOverlay(containerRef, (_id, changes, options) => {
    // What VideoEditor.handleOverlayChange does, minus the sync core.
    setItem(prev => applyOverlayChanges(prev, changes, PLAYHEAD, options))
  })
  return (
    <div ref={(el) => { if (el) el.getBoundingClientRect = () => RECT; containerRef.current = el }}>
      <OverlayItemsLayer
        project={emptyProject}
        currentTime={PLAYHEAD}
        isPlaying={false}
        isCanvasProject={false}
        overlayTracks={[[item]]}
        tracks0NonVideo={[]}
        renderScale={0.2}
        selectedOverlayId={item.id}
        containerRef={containerRef}
        dragState={drag.dragState}
        setDragState={drag.setDragState}
        liveOffset={drag.liveOffset}
        liveScale={drag.liveScale}
        liveRotation={drag.liveRotation}
        snapGuides={drag.snapGuides}
        snapRotation={drag.snapRotation}
        compileOverlay={vi.fn(async (): Promise<OverlayFactory> => () => null)}
        fileUrl={(pth: string) => pth}
      />
    </div>
  )
}

function wrapperOf(container: HTMLElement): HTMLElement {
  return (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement
}

function dragWrapper(container: HTMLElement, to: { x: number; y: number }, release: MouseEventInit) {
  const wrapper = wrapperOf(container)
  act(() => { wrapper.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 })) })
  act(() => { document.dispatchEvent(new MouseEvent('mousemove', { clientX: to.x, clientY: to.y })) })
  const midDrag = wrapperOf(container).style.transform
  act(() => { document.dispatchEvent(new MouseEvent('mouseup', release)) })
  return { midDrag, afterRelease: wrapperOf(container).style.transform }
}

describe('the live preview during a drag matches what the release commits', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  const animatedOverlay = () => ({
    id: 'ov', type: 'overlay', src: 'o.jsx', props: {}, start: 2, end: 12,
    // Off every snap line, so the drag lands where the pointer does.
    keyframes: [
      { prop: 'offsetX', points: [{ t: 0, value: -40 }, { t: 10, value: 0 }] },
      { prop: 'offsetY', points: [{ t: 0, value: 20 }, { t: 10, value: 30 }] },
    ],
  } as VisualItem)

  it('default: the item stays where it was dropped (no snap back)', () => {
    const { container } = render(<Harness initial={animatedOverlay()} />)
    const before = wrapperOf(container).style.transform

    const { midDrag, afterRelease } = dragWrapper(container, { x: 10, y: 5 }, {})

    expect(midDrag).not.toBe(before)
    expect(afterRelease).toBe(midDrag)
  })

  it('Option: the item stays where it was dropped (no snap back)', () => {
    const { container } = render(<Harness initial={animatedOverlay()} />)

    const { midDrag, afterRelease } = dragWrapper(container, { x: 10, y: 5 }, { altKey: true })

    expect(afterRelease).toBe(midDrag)
  })
})
