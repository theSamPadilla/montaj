/// <reference types="vitest/globals" />
/**
 * Delete removes the selected keyframe (SP9b T3.6) — the precedence seam
 * between `timeline.delete-keyframe` and the pre-existing
 * `timeline.delete-selection` binding (see `Timeline.keymap.test.tsx`).
 * `useKeymap` is first-match-wins: with a keyframe diamond selected, Delete
 * must remove ONLY that keyframe and leave the clip alone; with no keyframe
 * selected it must fall straight through to the existing clip/caption/audio
 * delete, unchanged.
 *
 * A keyframe diamond is selected via the REAL gesture — a double-click on it
 * (`pointer-machine.ts`'s `doubleClick` case, `'keyframe'` hit → the
 * `selectKeyframe` effect → `TimelineCanvas`'s `onSelectKeyframe` →
 * `Timeline`'s `setSelectedKeyframe`) — mirroring how
 * `Timeline.keyframeMenu.test.tsx` drives its own right-click gesture rather
 * than reaching into Timeline's state directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
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
 * item-relative t=0.5 AND t=1.5. Two points on the one track that's ever
 * touched by the "ordinary" tests below, so removing one point never hits
 * the last-point/freeze branch — that branch gets its own dedicated fixture
 * (`makeProjectWithFreezeCandidate`) rather than being an incidental side
 * effect here.
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

/**
 * o0 additionally keyframed on `opacity` with a SINGLE point at t=0.5 — the
 * same instant `scale` also holds a point at, so the diamond there is the
 * union of both props (`keyframeUnionTimes`). `opacity`'s stale static
 * scalar (0.1) is deliberately far from the curve's value (0.4): if removal
 * routed through the plain multi-point path instead of
 * `removeKeyframesAt`'s last-point/`disableKeyframing` branch, the item would
 * snap back to the stale 0.1 the instant the keyframe went away.
 */
function makeProjectWithFreezeCandidate(): Project {
  const project = makeProject()
  const overlay = project.tracks![0].items[1]
  return {
    ...project,
    tracks: [{
      ...project.tracks![0],
      items: [
        project.tracks![0].items[0],
        {
          ...overlay,
          opacity: 0.1,
          keyframes: [
            ...overlay.keyframes!,
            { prop: 'opacity', points: [{ t: 0.5, value: 0.4 }] },
          ],
        },
      ],
    }],
  } as unknown as Project
}

function mount(project: Project, selectedIds: string[]) {
  const clock = createPlaybackClock()
  const onProjectChange = vi.fn()
  const onOverlayEdit = vi.fn()
  const onSelectIds = vi.fn()
  const utils = render(
    <Timeline
      project={project}
      clock={clock}
      onProjectChange={onProjectChange}
      onOverlayEdit={onOverlayEdit}
      selectedIds={selectedIds}
      onSelectIds={onSelectIds}
    />,
  )
  return { clock, onProjectChange, onOverlayEdit, onSelectIds, surface: canvasSurface(utils.container), ...utils }
}

/** CLIENT (x, y) for o0's diamond at item-relative `t` — the same "fit-to-view
 *  viewport a freshly mounted surface settles to, plus a couple px above the
 *  row's bottom edge" math `Timeline.keyframeMenu.test.tsx`'s own
 *  `keyframeClientPoint` uses. */
function keyframeClientPoint(project: Project, t: number) {
  const row = computeTimelineLayout(project).rows[0]
  const clientX = timeToClientX(project, 2 + t)   // o0.start is 2
  return { clientX, clientY: row.y + row.height - 2 }
}

/** Select a keyframe diamond the honest way: a real double-click dispatched
 *  on the canvas surface, driving `pointer-machine.ts`'s `doubleClick` →
 *  `selectKeyframe` → `TimelineCanvas`'s `onSelectKeyframe` →
 *  `Timeline`'s `setSelectedKeyframe`. Never reaches into Timeline's state. */
function selectKeyframeAt(surface: HTMLElement, project: Project, t: number) {
  fireEvent.doubleClick(surface, keyframeClientPoint(project, t))
}

describe('Timeline — Delete removes the selected keyframe', () => {
  it('Delete removes the selected keyframe and leaves the clip alone', () => {
    const project = makeProject()
    const { surface, container, onProjectChange, onOverlayEdit } = mount(project, ['o0'])
    selectKeyframeAt(surface, project, 0.5)
    focusCanvasRoot(container)

    fireEvent.keyDown(document.body, { key: 'Delete' })

    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onOverlayEdit).toHaveBeenCalledTimes(1)
    const updated = onProjectChange.mock.calls[0][0] as Project
    const items = updated.tracks![0].items
    // Both items survive — nothing was deleted from the track.
    expect(items.map(i => i.id)).toEqual(['clip-0', 'o0'])
    const overlay = items.find(i => i.id === 'o0')!
    const scaleTrack = overlay.keyframes!.find(t => t.prop === 'scale')!
    // Only the t=0.5 point is gone; t=1.5 remains untouched.
    expect(scaleTrack.points.map(p => p.t)).toEqual([1.5])
  })

  it('Delete still deletes the clip when NO keyframe is selected', () => {
    const project = makeProject()
    const { surface: _surface, container, onProjectChange, onOverlayEdit, onSelectIds } = mount(project, ['clip-0'])
    // No double-click — selectedKeyframe stays null, so the fall-through
    // to `timeline.delete-selection` is exercised.
    focusCanvasRoot(container)

    fireEvent.keyDown(document.body, { key: 'Delete' })

    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onOverlayEdit).toHaveBeenCalledTimes(1)
    expect(onSelectIds).toHaveBeenCalledWith([])
    const updated = onProjectChange.mock.calls[0][0] as Project
    expect(updated.tracks![0].items.find(i => i.id === 'clip-0')).toBeUndefined()
  })

  it('Delete removes only the keyframe, not the clip, when both are selected', () => {
    // A keyframe can only be selected while its OWNING item is also selected
    // (Timeline.tsx clears `selectedKeyframe` the instant its item leaves
    // `selectedIds` — see the effect right after the `useState`), so "both
    // selected" is the NORMAL case here, not a rare edge case. If
    // `timeline.delete-keyframe` were ordered AFTER `timeline.delete-selection`
    // (or its guard were wrong), first-match-wins would hand every one of
    // these presses to the clip-delete binding instead, deleting o0 outright.
    const project = makeProject()
    const { surface, container, onProjectChange } = mount(project, ['o0'])
    selectKeyframeAt(surface, project, 1.5)
    focusCanvasRoot(container)

    fireEvent.keyDown(document.body, { key: 'Delete' })

    const updated = onProjectChange.mock.calls[0][0] as Project
    const items = updated.tracks![0].items
    expect(items).toHaveLength(2)
    expect(items.map(i => i.id)).toContain('o0')
    const overlay = items.find(i => i.id === 'o0')!
    const scaleTrack = overlay.keyframes!.find(t => t.prop === 'scale')
    expect(scaleTrack?.points.map(p => p.t)).toEqual([0.5])
  })

  it('clears the keyframe selection after removing it, so a second Delete hits the clip', () => {
    const project = makeProject()
    const { surface, container, onProjectChange, onSelectIds } = mount(project, ['o0'])
    selectKeyframeAt(surface, project, 0.5)
    focusCanvasRoot(container)

    fireEvent.keyDown(document.body, { key: 'Delete' })   // removes the keyframe
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    // The FIRST press must NOT have touched the clip — this is what
    // distinguishes "selection was cleared" from "Delete just deletes the
    // clip regardless," which would make the second assertion below pass
    // even if this whole feature were unwired.
    const firstCommit = onProjectChange.mock.calls[0][0] as Project
    expect(firstCommit.tracks![0].items.find(i => i.id === 'o0')).toBeDefined()

    fireEvent.keyDown(document.body, { key: 'Delete' })   // second press: no keyframe selected anymore
    expect(onProjectChange).toHaveBeenCalledTimes(2)
    expect(onSelectIds).toHaveBeenCalledWith([])
    const secondCommit = onProjectChange.mock.calls[1][0] as Project
    expect(secondCommit.tracks![0].items.find(i => i.id === 'o0')).toBeUndefined()
  })

  it('freezes the value when the removed keyframe was a track\'s last point', () => {
    const project = makeProjectWithFreezeCandidate()
    const { surface, container, onProjectChange } = mount(project, ['o0'])
    // t=0.5 is the union of scale's (multi-point) and opacity's (single-point,
    // "last point") tracks — one diamond, one Delete, two different removal
    // branches inside `removeKeyframesAt` exercised at once.
    selectKeyframeAt(surface, project, 0.5)
    focusCanvasRoot(container)

    fireEvent.keyDown(document.body, { key: 'Delete' })

    const updated = onProjectChange.mock.calls[0][0] as Project
    const overlay = updated.tracks![0].items.find(i => i.id === 'o0')!
    // opacity's only point is gone — its track is dropped entirely...
    expect(overlay.keyframes?.find(t => t.prop === 'opacity')).toBeUndefined()
    // ...and item.opacity holds the CURVE's sampled value at t=0.5 (0.4), not
    // the stale pre-keyframing scalar (0.1) that was sitting there before.
    expect(overlay.opacity).toBeCloseTo(0.4, 5)
    // scale is unaffected: it had a SECOND point (t=1.5) at removal time, so
    // it takes the ordinary multi-point branch and survives with that point.
    const scaleTrack = overlay.keyframes!.find(t => t.prop === 'scale')!
    expect(scaleTrack.points.map(p => p.t)).toEqual([1.5])
  })

  it('falls through to clip deletion when the selected keyframe no longer exists', () => {
    // The selection can go stale WITHOUT its item leaving `selectedIds` —
    // a diamond drag, the right-click menu, undo. Nothing draws as selected
    // then, so Delete must delete the clip rather than silently do nothing.
    const project = makeProject()
    const props = {
      clock: createPlaybackClock(),
      onProjectChange: vi.fn(),
      onOverlayEdit: vi.fn(),
      selectedIds: ['o0'],
      onSelectIds: vi.fn(),
    }
    const { container, rerender } = render(<Timeline project={project} {...props} />)
    selectKeyframeAt(canvasSurface(container), project, 0.5)

    // Same item, still selected — but its t=0.5 keyframe is gone.
    const pruned = {
      ...project,
      tracks: [{
        ...project.tracks![0],
        items: project.tracks![0].items.map(i => i.id === 'o0'
          ? { ...i, keyframes: [{ prop: 'scale', points: [{ t: 1.5, value: 2 }] }] }
          : i),
      }],
    } as unknown as Project
    rerender(<Timeline project={pruned} {...props} />)
    focusCanvasRoot(container)

    fireEvent.keyDown(document.body, { key: 'Delete' })

    expect(props.onProjectChange).toHaveBeenCalledTimes(1)
    const updated = props.onProjectChange.mock.calls[0][0] as Project
    expect(updated.tracks![0].items.find(i => i.id === 'o0')).toBeUndefined()
  })
})
