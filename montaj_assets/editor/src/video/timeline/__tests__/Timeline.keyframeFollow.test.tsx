/// <reference types="vitest/globals" />
/**
 * Selection follows a retimed diamond (CapCut-correct operator decision):
 * dragging the SELECTED diamond to a new time must keep it selected AT THAT
 * NEW TIME — not drop the selection because `selectedKeyframe` still names
 * the OLD `t`, which `moveKeyframe` has just vacated.
 *
 * Exercised end to end with a REAL drag (mousedown → mousemove(s) →
 * mouseup on `document`, exactly as `TimelineCanvas` wires its own gesture —
 * see `_canvasSelect.ts`'s `dragCanvasItem`), then a REAL `Delete` keypress,
 * mirroring how `Timeline.keyframeDelete.test.tsx` proves selection through
 * the actual gesture rather than by reaching into Timeline's state.
 *
 * `Harness` below is a CONTROLLED host, not a bare `<Timeline>` — it feeds
 * `onProjectChange`/`onOverlayEdit` straight back into the `project` prop,
 * exactly as the real host (`VideoEditor.tsx`) does. Without that, the mid-
 * drag retime would never reach Timeline's own re-render, and the Delete
 * guard (`keyframeUnionTimes(item).includes(selectedKeyframe.t)` — see
 * Timeline.tsx) would check the followed `t` against the STALE, un-retimed
 * project and (correctly, on its own terms) find nothing there — which
 * would look identical to the bug this file exists to catch, for the wrong
 * reason. `Timeline.keyframeDelete.test.tsx`'s own last test hits the same
 * seam with a manual `rerender`; a controlled component is the equivalent
 * for a gesture that retimes mid-test rather than being swapped in whole.
 *
 * Delete removing the point that's still there (not the whole clip, and not
 * a no-op) is the only externally observable proof that `selectedKeyframe`
 * followed the diamond — `pointer-machine.test.ts`'s "selection follows a
 * retimed diamond" tests cover the effect itself, in isolation.
 *
 * Deliberately NOT `fireEvent.pointerDown`/`pointerMove` — this repo's jsdom
 * silently drops `clientX`/`clientY` off synthetic PointerEvents, which would
 * make a drag never leave its press-time point without failing loudly. Raw
 * `MouseEvent`s dispatched straight onto `document` (`TimelineCanvas` listens
 * there for the life of a gesture) are what every other canvas gesture test
 * in this package uses instead.
 */
import { useState } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, cleanup, fireEvent } from '@testing-library/react'
import type { Project } from '../../../types'
import { createPlaybackClock } from '../../playback-clock'
import Timeline from '../Timeline'
import { computeTimelineLayout } from '../canvas/draw'
import { canvasSurface, focusCanvasRoot, installCanvasHarness, timeToClientX } from './_canvasSelect'

let uninstall: () => void

beforeEach(() => {
  uninstall = installCanvasHarness()
})

afterEach(() => {
  cleanup()
  uninstall()
})

/**
 * clip-0 (0s-2s, video, plain) + o0 (2s-4s, overlay) keyframed on `scale` at
 * item-relative t=0.5 AND t=1.5 — the same fixture shape
 * `Timeline.keyframeDelete.test.tsx` uses, so a diamond drag here lands on
 * familiar ground: two points on one track, neither the union-of-props case.
 */
function makeProject(): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [{
      id: 'trk-0',
      items: [
        { id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 2, inPoint: 0, outPoint: 2 },
        {
          id: 'o0', type: 'overlay', start: 2, end: 4,
          keyframes: [
            { prop: 'scale', points: [{ t: 0.5, value: 1 }, { t: 1.5, value: 2 }] },
          ],
        },
      ],
    }],
  } as unknown as Project
}

/** A controlled host: `project`/`selectedIds` live in real React state and
 *  are written back on every `onProjectChange`/`onOverlayEdit`/`onSelectIds`,
 *  same wiring `VideoEditor.tsx` gives Timeline in the real app. The spy
 *  functions record every call for assertions without replacing this
 *  feedback loop. */
function Harness(props: {
  initial: Project
  selectedIds: string[]
  onProjectChange: (p: Project) => void
  onOverlayEdit: (p: Project) => void
  onSelectIds: (ids: string[]) => void
}) {
  const [clock] = useState(() => createPlaybackClock())
  const [project, setProject] = useState(props.initial)
  const [selectedIds, setSelectedIds] = useState(props.selectedIds)
  return (
    <Timeline
      project={project}
      clock={clock}
      onProjectChange={p => { setProject(p); props.onProjectChange(p) }}
      onOverlayEdit={p => { setProject(p); props.onOverlayEdit(p) }}
      selectedIds={selectedIds}
      onSelectIds={ids => { setSelectedIds(ids); props.onSelectIds(ids) }}
    />
  )
}

function mount(project: Project, selectedIds: string[]) {
  const onProjectChange = vi.fn()
  const onOverlayEdit = vi.fn()
  const onSelectIds = vi.fn()
  const utils = render(
    <Harness
      initial={project}
      selectedIds={selectedIds}
      onProjectChange={onProjectChange}
      onOverlayEdit={onOverlayEdit}
      onSelectIds={onSelectIds}
    />,
  )
  return { onProjectChange, onOverlayEdit, onSelectIds, surface: canvasSurface(utils.container), ...utils }
}

/** CLIENT (x, y) for o0's diamond at item-relative `t` — the same math
 *  `Timeline.keyframeDelete.test.tsx`'s own `keyframeClientPoint` uses.
 *  Computed once, off the ORIGINAL project: `_canvasSelect.ts`'s viewport
 *  helpers fit to `computeDerivedTiming`, and neither this fixture's total
 *  duration nor its row layout changes as `o0`'s keyframes move, so the same
 *  coordinates stay valid for the whole test. */
function keyframeClientPoint(project: Project, t: number) {
  const row = computeTimelineLayout(project).rows[0]
  const clientX = timeToClientX(project, 2 + t)   // o0.start is 2
  return { clientX, clientY: row.y + row.height - 2 }
}

/** Select a keyframe diamond the honest way: a real double-click. */
function selectKeyframeAt(surface: HTMLElement, project: Project, t: number) {
  fireEvent.doubleClick(surface, keyframeClientPoint(project, t))
}

function mouseInit(p: { clientX: number; clientY: number }) {
  return { clientX: p.clientX, clientY: p.clientY, button: 0, bubbles: true }
}

/** Drag o0's diamond at item-relative `fromT` by `dxPx` client pixels: press
 *  on the surface, two intermediate moves and a release dispatched straight
 *  onto `document` — `TimelineCanvas`'s own gesture wiring — mirroring
 *  `_canvasSelect.ts`'s `dragCanvasItem` (which cannot itself target a
 *  keyframe diamond; `resolveCanvasTarget` only resolves clips/audio/
 *  captions). `act` wraps the raw `document.dispatchEvent` calls for the
 *  same reason `dragCanvasItem`'s `dispatchOnDocument` does — those two
 *  aren't one of RTL's own wrapped fire helpers. */
function dragKeyframe(surface: HTMLElement, project: Project, fromT: number, dxPx: number) {
  const from = keyframeClientPoint(project, fromT)
  fireEvent.mouseDown(surface, mouseInit(from))
  const mid = { clientX: from.clientX + dxPx / 2, clientY: from.clientY }
  act(() => { document.dispatchEvent(new MouseEvent('mousemove', mouseInit(mid))) })
  const to = { clientX: from.clientX + dxPx, clientY: from.clientY }
  act(() => { document.dispatchEvent(new MouseEvent('mousemove', mouseInit(to))) })
  act(() => { document.dispatchEvent(new MouseEvent('mouseup', mouseInit(to))) })
}

describe('Timeline — keyframe selection follows a retimed diamond', () => {
  it('Delete removes the point the diamond landed on after a drag, not the clip — proving the selection followed', () => {
    const project = makeProject()
    const { surface, container, onProjectChange } = mount(project, ['o0'])
    selectKeyframeAt(surface, project, 0.5)
    focusCanvasRoot(container)

    // Drag the SELECTED t=0.5 diamond well clear of both its own start and
    // the untouched t=1.5 point, so there is no ambiguity about which point
    // Delete removed.
    dragKeyframe(surface, project, 0.5, 30)

    fireEvent.keyDown(document.body, { key: 'Delete' })

    // The clip-delete fallback (`timeline.delete-selection`) would have
    // removed 'o0' outright instead of just a keyframe point — it did not.
    const updated = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
    const items = updated.tracks![0].items
    expect(items.map(i => i.id)).toEqual(['clip-0', 'o0'])

    const overlay = items.find(i => i.id === 'o0')!
    const scaleTrack = overlay.keyframes!.find(t => t.prop === 'scale')!
    // Exactly one point survives: t=1.5, which the drag never touched. The
    // point the drag moved to is gone — proof Delete's target followed the
    // diamond rather than staying pinned to the vacated t=0.5 (which, with
    // the bug, would have found nothing there and fallen through to
    // deleting the whole clip instead — the assertion above already rules
    // that out, this one pins down which point actually went).
    expect(scaleTrack.points).toHaveLength(1)
    expect(scaleTrack.points[0].t).toBeCloseTo(1.5)
  })

  it('a second Delete now hits the clip — the followed selection was consumed, not left dangling', () => {
    const project = makeProject()
    const { surface, container, onProjectChange, onSelectIds } = mount(project, ['o0'])
    selectKeyframeAt(surface, project, 0.5)
    focusCanvasRoot(container)

    dragKeyframe(surface, project, 0.5, 30)

    fireEvent.keyDown(document.body, { key: 'Delete' })   // removes the followed keyframe
    const afterFirst = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
    expect(afterFirst.tracks![0].items.find(i => i.id === 'o0')).toBeDefined()

    fireEvent.keyDown(document.body, { key: 'Delete' })   // no keyframe selected anymore
    expect(onSelectIds).toHaveBeenCalledWith([])
    const afterSecond = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
    expect(afterSecond.tracks![0].items.find(i => i.id === 'o0')).toBeUndefined()
  })
})
