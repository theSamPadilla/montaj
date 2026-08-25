/// <reference types="vitest/globals" />
/**
 * The keyframe-strip popup (SP9b T3.3) — `Timeline.fadeCurveMenu.test.tsx`'s
 * exact sibling. A right-click on a keyframe-strip diamond (selected,
 * keyframed overlay only — see hit-test.ts's `'keyframe'` kind) opens a small
 * menu of the six `EASING_NAMES` plus a "Remove keyframe" action; picking an
 * easing or removing applies to EVERY prop the diamond represents (the
 * "union of times" the strip draws — see `keyframe-strip.ts`), as ONE undo
 * entry.
 *
 * `TimelineCanvas`'s `contextmenu` handler does its own hit-test and calls
 * `onKeyframeMenu` with CLIENT coordinates; `Timeline` owns the menu's
 * open/closed state and renders it as a `position: fixed` DOM overlay —
 * mirrors `Timeline.fadeCurveMenu.test.tsx`'s own stubbing (`installCanvasHarness`,
 * see `_canvasSelect.ts`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import type { Project } from '../../../types'
import { createPlaybackClock } from '../../playback-clock'
import Timeline from '../Timeline'
import { computeTimelineLayout } from '../canvas/draw'
import { installCanvasHarness, SURFACE_LEFT, timeToClientX } from './_canvasSelect'

let uninstall: () => void

beforeEach(() => {
  uninstall = installCanvasHarness()
})

afterEach(() => {
  cleanup()
  uninstall()
})

/** o0 (2s-4s, overlay) keyframed on offsetX at t=0.5 AND t=1.5, and on
 *  opacity at t=0.5 only. Union of times is {0.5, 1.5} (`keyframe-strip.ts`'s
 *  merged strip): the diamond at t=0.5 represents BOTH props (used to prove
 *  an action fans out to every prop sharing an instant), the diamond at
 *  t=1.5 represents offsetX alone AND is the item's LAST keyframe (used for
 *  the disabled-easing-picker test). */
function makeProject(): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [{
      id: 'trk-0',
      items: [{
        id: 'o0', type: 'overlay', start: 2, end: 4,
        keyframes: [
          { prop: 'offsetX', points: [{ t: 0.5, value: 0 }, { t: 1.5, value: 10 }] },
          { prop: 'opacity', points: [{ t: 0.5, value: 1 }] },
        ],
      }],
    }],
  } as unknown as Project
}

function mount(project: Project = makeProject()) {
  const clock = createPlaybackClock()
  const onProjectChange = vi.fn()
  const onOverlayEdit = vi.fn()
  const utils = render(
    <Timeline
      project={project}
      clock={clock}
      onProjectChange={onProjectChange}
      onOverlayEdit={onOverlayEdit}
      selectedIds={['o0']}
    />,
  )
  const surface = utils.container.querySelector('[data-timeline-canvas]') as HTMLElement
  return { clock, onProjectChange, onOverlayEdit, surface, project, ...utils }
}

/** CLIENT (x, y) for the diamond at item-relative `t` on `project`'s o0,
 *  computed the same way `hit-test.ts`'s keyframe zone does: `item.start + t`
 *  through `timeToClientX` — the SAME fit-to-view viewport the mounted
 *  surface settles to on render — at a y a couple px above the row's own
 *  bottom edge (inside the bottom strip zone the diamond hit-tests in). */
function keyframeClientPoint(project: Project, t: number) {
  const row = computeTimelineLayout(project).rows[0]
  const clientX = timeToClientX(project, 2 + t)   // o0.start is 2
  return { clientX, clientY: row.y + row.height - 2 }
}

/** Easing buttons render VISIBLE text (unlike the icon-only fade picker), so
 *  their accessible name is that text — same `getByRole` lookup either way. */
function easingButton(name: string) {
  return screen.getByRole('button', { name })
}
function queryEasingButton(name: string) {
  return screen.queryByRole('button', { name })
}
function removeButton() {
  return screen.getByRole('button', { name: 'Remove keyframe' })
}

describe('Timeline — keyframe-strip popup (right-click a keyframe diamond)', () => {
  it('opens the picker with all six easing options and a remove action on a diamond right-click', () => {
    const { surface, project } = mount()
    fireEvent.contextMenu(surface, keyframeClientPoint(project, 0.5))
    for (const name of ['Linear', 'Ease', 'Ease In', 'Ease Out', 'Ease In Out', 'Hold']) {
      expect(easingButton(name)).toBeInTheDocument()
    }
    expect(removeButton()).toBeInTheDocument()
  })

  it('does NOT open the picker from a right-click elsewhere on the clip', () => {
    const { surface, project } = mount()
    // Same x as a diamond, but well above the strip's bottom zone.
    const row = computeTimelineLayout(project).rows[0]
    fireEvent.contextMenu(surface, { clientX: SURFACE_LEFT + 300, clientY: row.y + 2 })
    expect(queryEasingButton('Linear')).not.toBeInTheDocument()
  })

  it('picking an easing applies it to every prop sharing the diamond’s t, as ONE undo entry, and closes the menu', () => {
    const { surface, onProjectChange, onOverlayEdit, project } = mount()
    fireEvent.contextMenu(surface, keyframeClientPoint(project, 0.5))

    fireEvent.click(easingButton('Ease In'))

    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onOverlayEdit).toHaveBeenCalledTimes(1)
    const committed = onOverlayEdit.mock.calls[0][0] as Project
    const item = committed.tracks![0].items[0]
    const offsetX = item.keyframes!.find(t => t.prop === 'offsetX')!
    const opacity = item.keyframes!.find(t => t.prop === 'opacity')!
    expect(offsetX.points.find(p => p.t === 0.5)?.easing).toBe('ease-in')
    expect(opacity.points.find(p => p.t === 0.5)?.easing).toBe('ease-in')
    // The OTHER keyframe on offsetX (t=1.5) is untouched.
    expect(offsetX.points.find(p => p.t === 1.5)?.easing).toBeUndefined()
    expect(queryEasingButton('Linear')).not.toBeInTheDocument()
  })

  it('removing clears every prop at that t, dropping a track entirely once it has no points left', () => {
    const { surface, onProjectChange, onOverlayEdit, project } = mount()
    fireEvent.contextMenu(surface, keyframeClientPoint(project, 0.5))

    fireEvent.click(removeButton())

    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onOverlayEdit).toHaveBeenCalledTimes(1)
    const committed = onOverlayEdit.mock.calls[0][0] as Project
    const item = committed.tracks![0].items[0]
    // offsetX keeps its OTHER point (t=1.5); its t=0.5 point is gone.
    const offsetX = item.keyframes!.find(t => t.prop === 'offsetX')!
    expect(offsetX.points.map(p => p.t)).toEqual([1.5])
    // opacity had ONLY the t=0.5 point — the whole track is gone, not just
    // emptied (see keyframeOps.ts's `removeKeyframe`/`withTrack`).
    expect(item.keyframes!.find(t => t.prop === 'opacity')).toBeUndefined()
    expect(queryEasingButton('Linear')).not.toBeInTheDocument()
  })

  it('disables the easing picker on the LAST diamond, but removal still works there', () => {
    const { surface, onProjectChange, onOverlayEdit, project } = mount()
    // t=1.5 is offsetX's last (and only remaining) keyframe once t=0.5 is
    // accounted for by the fixture — the item's overall last keyframe too.
    fireEvent.contextMenu(surface, keyframeClientPoint(project, 1.5))

    expect(easingButton('Linear')).toBeDisabled()
    expect(easingButton('Hold')).toBeDisabled()
    fireEvent.click(easingButton('Linear'))
    // Disabled buttons don't fire clicks — nothing committed.
    expect(onProjectChange).not.toHaveBeenCalled()

    fireEvent.click(removeButton())
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onOverlayEdit).toHaveBeenCalledTimes(1)
    const committed = onOverlayEdit.mock.calls[0][0] as Project
    const item = committed.tracks![0].items[0]
    const offsetX = item.keyframes!.find(t => t.prop === 'offsetX')!
    expect(offsetX.points.map(p => p.t)).toEqual([0.5])
  })

  it('highlights the shared easing when every prop at t agrees, and none when they disagree', () => {
    const project = makeProject()
    // Pre-set offsetX and opacity's t=0.5 points to the SAME easing.
    project.tracks![0].items[0].keyframes![0].points[0].easing = 'hold'
    project.tracks![0].items[0].keyframes![1].points[0].easing = 'hold'
    const { surface } = mount(project)
    fireEvent.contextMenu(surface, keyframeClientPoint(project, 0.5))
    expect(easingButton('Hold')).toHaveAttribute('aria-pressed', 'true')
    expect(easingButton('Linear')).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByTestId('keyframe-menu-backdrop'))

    // Now disagree: offsetX stays 'hold', opacity becomes 'ease'.
    const disagreeing = makeProject()
    disagreeing.tracks![0].items[0].keyframes![0].points[0].easing = 'hold'
    disagreeing.tracks![0].items[0].keyframes![1].points[0].easing = 'ease'
    const remount = mount(disagreeing)
    fireEvent.contextMenu(remount.surface, keyframeClientPoint(disagreeing, 0.5))
    for (const name of ['Linear', 'Ease', 'Ease In', 'Ease Out', 'Ease In Out', 'Hold']) {
      expect(easingButton(name)).toHaveAttribute('aria-pressed', 'false')
    }
  })

  it('Escape closes the picker without committing anything', () => {
    const { surface, onProjectChange, onOverlayEdit, project } = mount()
    fireEvent.contextMenu(surface, keyframeClientPoint(project, 0.5))
    expect(easingButton('Linear')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(queryEasingButton('Linear')).not.toBeInTheDocument()
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(onOverlayEdit).not.toHaveBeenCalled()
  })

  it('clicking outside the menu closes it without touching the project', () => {
    const { surface, onProjectChange, onOverlayEdit, project } = mount()
    fireEvent.contextMenu(surface, keyframeClientPoint(project, 0.5))
    expect(easingButton('Linear')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('keyframe-menu-backdrop'))

    expect(queryEasingButton('Linear')).not.toBeInTheDocument()
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(onOverlayEdit).not.toHaveBeenCalled()
  })

  it('freezes the value when the removed keyframe was a track\'s LAST point', () => {
    // Plain `removeKeyframe` drops the track WITHOUT writing the sampled value
    // into the static scalar, so the overlay would snap back to the stale
    // `opacity: 0.1`. Both removal paths share `removeKeyframesAt` precisely so
    // this menu and Delete cannot disagree.
    const base = makeProject()
    const stale = {
      ...base,
      tracks: [{
        ...base.tracks![0],
        items: [{
          ...base.tracks![0].items[0],
          opacity: 0.1,
          keyframes: [
            { prop: 'offsetX', points: [{ t: 0.5, value: 0 }, { t: 1.5, value: 10 }] },
            { prop: 'opacity', points: [{ t: 0.5, value: 0.4 }] },
          ],
        }],
      }],
    } as unknown as Project
    const { surface, onOverlayEdit, project } = mount(stale)
    fireEvent.contextMenu(surface, keyframeClientPoint(project, 0.5))

    fireEvent.click(removeButton())

    const item = (onOverlayEdit.mock.calls[0][0] as Project).tracks![0].items[0]
    expect(item.keyframes!.find(t => t.prop === 'opacity')).toBeUndefined()
    expect(item.opacity).toBeCloseTo(0.4, 5)   // the curve's value, NOT the stale 0.1
  })
})
