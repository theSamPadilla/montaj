/// <reference types="vitest/globals" />
/**
 * Coverage for the canvas test helpers themselves (`_canvasSelect.ts`).
 *
 * These helpers are about to become the way every migrated DOM-era test
 * addresses a clip, so a silent mis-aim in here would show up downstream as
 * "the assertion is wrong" rather than "the click missed". Each thing the
 * helpers promise is therefore checked against the REAL mounted timeline, not
 * against a restatement of the same arithmetic:
 *
 * - the pinned surface rect is what the mounted surface actually reports;
 * - the fit viewport the helpers compute is the one the surface settled on
 *   (proved by seeking: a press at `timeToClientX(t)` lands the clock on `t`);
 * - a press selects the item the caller named, by kind and by id;
 * - `metaKey` extends rather than replaces;
 * - a drag is a drag (many live edits, ONE commit) and a click is a click.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import type { Project } from '../../../types'
import { createPlaybackClock } from '../../playback-clock'
import Timeline from '../Timeline'
import { computeDerivedTiming, trackItems } from '../timeline-model'
import { PLAYHEAD_GRAB_PX } from '../canvas/hit-test'
import { fitPxPerSecond } from '../canvas/viewport'
import {
  SURFACE_LEFT,
  SURFACE_WIDTH,
  canvasItemPoint,
  canvasSurface,
  canvasViewport,
  dragCanvasItem,
  focusCanvasRoot,
  installCanvasHarness,
  resolveCanvasTarget,
  selectCanvasItem,
  timeToClientX,
} from './_canvasSelect'

let uninstall: () => void

beforeEach(() => { uninstall = installCanvasHarness() })
afterEach(() => { cleanup(); uninstall() })

/** The same two-track shape `VideoEditor.keymap.test.tsx` uses, so what is
 *  proved here is what the migrated tests rely on. Content runs 0–4s, so
 *  `totalDuration` is 4 + max(5, 0.8) = 9s — the number the fit is against. */
function makeProject(): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [
      [{ id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4 }],
      [{ id: 'overlay-1', type: 'overlay', src: 'overlay.jsx', start: 0, end: 4, props: { text: 'Hello' } }],
    ],
  } as unknown as Project
}

function mount(project: Project, selectedIds: string[] = [], clockAt = 0) {
  const clock = createPlaybackClock(clockAt)
  const onSelectIds = vi.fn()
  const onProjectChange = vi.fn()
  const onOverlayEdit = vi.fn()
  const utils = render(
    <Timeline
      project={project}
      clock={clock}
      selectedIds={selectedIds}
      onSelectIds={onSelectIds}
      onProjectChange={onProjectChange}
      onOverlayEdit={onOverlayEdit}
    />,
  )
  return { clock, onSelectIds, onProjectChange, onOverlayEdit, ...utils }
}

/** A bare press/release at a page point, bypassing the selector plumbing —
 *  used only to prove the coordinate math against the surface's own viewport. */
function pressAndRelease(surface: HTMLElement, clientX: number, clientY: number) {
  fireEvent.mouseDown(surface, { clientX, clientY, button: 0, bubbles: true })
  act(() => { document.dispatchEvent(new MouseEvent('mouseup', { clientX, clientY, bubbles: true })) })
}

describe('_canvasSelect — harness', () => {
  it('pins the canvas surface to a real rect and leaves everything else spanning the column', () => {
    const { container } = mount(makeProject())
    const surface = canvasSurface(container)

    expect(surface.getBoundingClientRect().left).toBe(SURFACE_LEFT)
    expect(surface.getBoundingClientRect().width).toBe(SURFACE_WIDTH)
    // Anything that isn't the surface starts at the left of the column.
    expect((container.firstElementChild as HTMLElement).getBoundingClientRect().left).toBe(0)
  })

  it('restores the real getContext / getBoundingClientRect on teardown', () => {
    const beforeCtx = HTMLCanvasElement.prototype.getContext
    const beforeRect = Element.prototype.getBoundingClientRect

    const teardown = installCanvasHarness()
    expect(HTMLCanvasElement.prototype.getContext).not.toBe(beforeCtx)
    expect(Element.prototype.getBoundingClientRect).not.toBe(beforeRect)

    teardown()
    expect(HTMLCanvasElement.prototype.getContext).toBe(beforeCtx)
    expect(Element.prototype.getBoundingClientRect).toBe(beforeRect)
  })

  // The DOM timeline is retired, so a mounted `<Timeline>` ALWAYS has a canvas
  // surface — the only way to miss it now is aiming the helper at a container
  // that holds no timeline, which is what this guard is left to catch.
  it('canvasSurface says what is wrong when the container holds no timeline', () => {
    const { container } = render(<div />)
    expect(() => canvasSurface(container)).toThrow(/data-timeline-canvas/)
  })

  it('focusCanvasRoot focuses the tabIndex=0 root the Delete/Enter bindings are scoped to', () => {
    const { container } = mount(makeProject())
    focusCanvasRoot(container)
    expect(document.activeElement).toBe(container.querySelector('[tabindex="0"]'))
  })
})

describe('_canvasSelect — coordinates', () => {
  it('fits the whole timeline INCLUDING drag headroom, not just the content', () => {
    const project = makeProject()
    const { contentDuration, totalDuration } = computeDerivedTiming(project)

    expect(contentDuration).toBe(4)
    expect(totalDuration).toBe(9)
    // The scale is 1000px / 9s, NOT 1000px / 4s — the fit is against the
    // padded duration. Anyone hardcoding a round px/second is wrong.
    expect(canvasViewport(project).pxPerSecond).toBe(fitPxPerSecond(SURFACE_WIDTH, totalDuration))
    expect(canvasViewport(project).pxPerSecond).toBeCloseTo(1000 / 9, 10)
  })

  it('maps t=0 to the surface origin and the full duration to its right edge', () => {
    const project = makeProject()
    const { totalDuration } = computeDerivedTiming(project)
    expect(timeToClientX(project, 0)).toBe(SURFACE_LEFT)
    expect(timeToClientX(project, totalDuration)).toBeCloseTo(SURFACE_LEFT + SURFACE_WIDTH, 10)
  })

  it('agrees with the viewport the MOUNTED surface actually settled on', () => {
    // The real proof: press on empty track area at the x the helper computes
    // for t=6 and the surface's own `xToTime` must land the playhead there. If
    // the helper's fit differed from the mounted one by so much as a percent,
    // this seek would miss.
    const project = makeProject()
    const { container, clock } = mount(project)
    const surface = canvasSurface(container)
    const videoRow = resolveCanvasTarget(project, { type: 'video' })

    pressAndRelease(surface, timeToClientX(project, 6), videoRow.y + videoRow.height / 2)
    expect(clock.get()).toBeCloseTo(6, 6)
  })

  it('resolves a target by kind and by id, and names the ids it knows when it cannot', () => {
    const project = makeProject()
    expect(resolveCanvasTarget(project, { type: 'video' }).id).toBe('clip-0')
    expect(resolveCanvasTarget(project, { type: 'overlay' }).id).toBe('overlay-1')
    expect(resolveCanvasTarget(project, { id: 'overlay-1' }).start).toBe(0)
    expect(() => resolveCanvasTarget(project, { id: 'nope' })).toThrow(/clip-0/)
  })

  it('dodges the playhead grab band so a press on a clip selects instead of scrubbing', () => {
    const project = makeProject()
    const centred = canvasItemPoint(project, { type: 'video' })
    // Park the playhead exactly on the clip's middle — where the press would
    // otherwise land, and where `grabsPlayhead` would turn it into a scrub.
    const dodged = canvasItemPoint(project, { type: 'video' }, { playheadTime: 2 })
    expect(centred.clientX).toBeCloseTo(timeToClientX(project, 2), 6)
    expect(dodged.clientX - centred.clientX).toBeCloseTo(PLAYHEAD_GRAB_PX + 1, 6)
  })

  it('honours an explicit `at` time instead of the item middle', () => {
    const project = makeProject()
    const point = canvasItemPoint(project, { type: 'video' }, { at: 1 })
    expect(point.clientX).toBeCloseTo(timeToClientX(project, 1), 6)
  })
})

describe('_canvasSelect — selectCanvasItem', () => {
  it('selects the first item of a kind — the canvas equivalent of clicking "▪ video"', () => {
    const project = makeProject()
    const { container, onSelectIds } = mount(project)
    selectCanvasItem(container, project, { type: 'video' })
    expect(onSelectIds).toHaveBeenCalledWith(['clip-0'])
  })

  it('selects by id', () => {
    const project = makeProject()
    const { container, onSelectIds } = mount(project)
    selectCanvasItem(container, project, { id: 'overlay-1' })
    expect(onSelectIds).toHaveBeenCalledWith(['overlay-1'])
  })

  it('replaces the selection on a plain click', () => {
    const project = makeProject()
    const { container, onSelectIds } = mount(project, ['overlay-1'])
    selectCanvasItem(container, project, { type: 'video' })
    expect(onSelectIds).toHaveBeenCalledWith(['clip-0'])
  })

  it('EXTENDS the selection with metaKey — the modifier the DOM helper used', () => {
    const project = makeProject()
    const { container, onSelectIds } = mount(project, ['clip-0'])
    selectCanvasItem(container, project, { type: 'overlay' }, { metaKey: true })
    expect(onSelectIds).toHaveBeenCalledWith(['clip-0', 'overlay-1'])
  })

  it('still selects when the playhead is parked on the clip it is aiming at', () => {
    const project = makeProject()
    const { container, onSelectIds } = mount(project, [], 2)
    selectCanvasItem(container, project, { type: 'video' }, { playheadTime: 2 })
    expect(onSelectIds).toHaveBeenCalledWith(['clip-0'])
  })

  it('is a CLICK, not a drag: it never commits an edit', () => {
    const project = makeProject()
    const { container, onProjectChange, onOverlayEdit } = mount(project)
    selectCanvasItem(container, project, { type: 'video' })
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(onOverlayEdit).not.toHaveBeenCalled()
  })
})

describe('_canvasSelect — dragCanvasItem', () => {
  it('is a DRAG: many live edits, exactly ONE commit', () => {
    const project = makeProject()
    const { container, onProjectChange, onOverlayEdit } = mount(project)

    dragCanvasItem(container, project, { type: 'video' }, { dxPx: 200, steps: 5 })

    // One live edit per intermediate move — the property the "a whole drag
    // undoes in one step" regression test depends on.
    expect(onProjectChange.mock.calls.length).toBeGreaterThan(1)
    expect(onOverlayEdit).toHaveBeenCalledTimes(1)

    const committed = onOverlayEdit.mock.calls[0][0] as Project
    const moved = trackItems(committed).flat().find((i) => i.id === 'clip-0')
    expect(moved?.start).toBeGreaterThan(0)
  })

  it('lands the item near the requested time', () => {
    const project = makeProject()
    const { container, onOverlayEdit } = mount(project)

    // The clip's body point sits at its middle (t=2); asking to release two
    // seconds later moves the whole clip two seconds later.
    dragCanvasItem(container, project, { type: 'video' }, { toTime: 4 })

    const committed = onOverlayEdit.mock.calls[0][0] as Project
    const moved = trackItems(committed).flat().find((i) => i.id === 'clip-0')
    expect(moved?.start).toBeCloseTo(2, 1)
  })

  it('refuses travel that would never cross the drag threshold', () => {
    const project = makeProject()
    const { container, onOverlayEdit } = mount(project)
    expect(() => dragCanvasItem(container, project, { type: 'video' }, { dxPx: 2 }))
      .toThrow(/DRAG_THRESHOLD_PX/)
    // Nothing was dispatched — it bailed before the press.
    expect(onOverlayEdit).not.toHaveBeenCalled()
  })

  it('needs a destination', () => {
    const project = makeProject()
    const { container } = mount(project)
    expect(() => dragCanvasItem(container, project, { type: 'video' }, {}))
      .toThrow(/toTime.*dxPx/)
  })
})
