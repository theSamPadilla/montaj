/// <reference types="vitest/globals" />
/**
 * Subcut-regenerate on the CANVAS timeline (the port off the DOM clip rows).
 *
 * The affordance is a Scissors button that toggles Timeline's `subcutClipId`,
 * which in turn opens the host-rendered `renderSubcutRegen` tool. It lived on
 * `VisualTrackRow` and had zero tests; the canvas draws clips as pixels, so
 * the port is an absolutely-positioned HTML button placed by the same layout +
 * viewport math the painter uses (`CanvasClipChrome` in Timeline.tsx).
 *
 * Two things these tests exist to pin down, because both were lost or
 * simplified in earlier attempts at this port:
 *
 * 1. The gate has FOUR independent conditions — selected, host-enabled,
 *    generation provenance present, and a 3-SECOND MINIMUM. Each gets its own
 *    test (and the duration gets its boundary tested both ways) so dropping
 *    any one of them fails here rather than shipping.
 * 2. "Queued" is a BADGE, not a disable. A queued clip's button stays
 *    clickable, and the badge's own visibility does not depend on the button's
 *    gate at all.
 *
 * Plus the hazard the structure exists to avoid: `TimelineCanvas` binds
 * `mousedown` on its own container and a mousedown there STARTS A GESTURE, so
 * a button nested inside it would scrub or drag underneath its own click. The
 * chrome is rendered as a SIBLING of the surface instead — the last test here
 * is what proves the canvas never sees the press.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'
import type { Project } from '../../../types'
import type { VisualItem } from '../../../schema'
import { createPlaybackClock } from '../../playback-clock'
import Timeline, { CLIP_CHROME_RIGHT_PAD_PX } from '../Timeline'
import { computeDerivedTiming } from '../timeline-model'
import { computeTimelineLayout } from '../canvas/draw'
import { ZOOM_BUTTON_FACTOR, timeToX, zoomAtPivot } from '../canvas/viewport'
import {
  SURFACE_WIDTH,
  canvasItemPoint,
  canvasSurface,
  canvasViewport,
  installCanvasHarness,
} from './_canvasSelect'

let uninstallCanvasHarness: () => void
beforeEach(() => { uninstallCanvasHarness = installCanvasHarness() })
afterEach(() => {
  cleanup()
  uninstallCanvasHarness()
})

/** A 10s ai_video clip on track 0, carrying the frozen `generation` provenance
 *  the gate reads. Track 0 on purpose: Timeline's `renderSubcutRegen` guard
 *  resolves `subcutClipId` against the first track, so a fixture anywhere else
 *  would set the state and render nothing. */
function makeProject(overrides: Partial<VisualItem> = {}): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [{
      id: 'trk-0',
      items: [{
        id: 'clip-0', type: 'video', src: 'a.mp4',
        start: 0, end: 10, inPoint: 0, outPoint: 10,
        generation: { sceneId: 'sc-1', prompt: 'a wide shot', provider: 'kling' },
        ...overrides,
      }],
    }],
  } as unknown as Project
}

interface MountOptions {
  selectedIds?: string[]
  regenEnabled?: boolean
  isClipQueued?: (id: string) => boolean
  withSubcutTool?: boolean
}

function mount(project: Project, opts: MountOptions = {}) {
  const clock = createPlaybackClock(0)
  const onSelectIds = vi.fn()
  const renderSubcutRegen = vi.fn(({ clipId }: { clipId: string }) => (
    <div data-testid="subcut-tool">{clipId}</div>
  ))
  const utils = render(
    <Timeline
      project={project}
      clock={clock}
      selectedIds={opts.selectedIds ?? ['clip-0']}
      onSelectIds={onSelectIds}
      regenEnabled={opts.regenEnabled ?? true}
      isClipQueued={opts.isClipQueued}
      renderSubcutRegen={opts.withSubcutTool === false ? undefined : renderSubcutRegen}
    />,
  )
  return { clock, onSelectIds, renderSubcutRegen, ...utils }
}

/** The button, by the accessible name it carries in both the DOM and canvas
 *  implementations. */
function subcutButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: 'Subcut regenerate' })
}

describe('Timeline — subcut regenerate on the canvas timeline', () => {
  // ── The gate, one condition at a time ──────────────────────────────────

  it('shows the button when the clip is selected, regen is enabled, it has generation provenance, and it is at least 3s', () => {
    mount(makeProject())
    expect(subcutButton()).toBeInTheDocument()
  })

  it('hides it when the clip is not selected', () => {
    mount(makeProject(), { selectedIds: [] })
    expect(subcutButton()).not.toBeInTheDocument()
  })

  it('hides it when the host has not enabled regeneration', () => {
    mount(makeProject(), { regenEnabled: false })
    expect(subcutButton()).not.toBeInTheDocument()
  })

  it('hides it on a clip with no generation provenance', () => {
    mount(makeProject({ generation: undefined }))
    expect(subcutButton()).not.toBeInTheDocument()
  })

  // The 3s floor is a real product rule (there is nothing to sub-cut in a
  // shorter clip), so both sides of the boundary are pinned: a simplification
  // that dropped it, or one that used `> 3` instead of `>= 3`, fails here.
  it('hides it just under the 3s floor', () => {
    mount(makeProject({ end: 2.9, outPoint: 2.9 }))
    expect(subcutButton()).not.toBeInTheDocument()
  })

  it('shows it at exactly 3s', () => {
    mount(makeProject({ end: 3, outPoint: 3 }))
    expect(subcutButton()).toBeInTheDocument()
  })

  // ── The trigger ────────────────────────────────────────────────────────

  it('clicking it opens the host subcut tool for that clip', () => {
    const { renderSubcutRegen } = mount(makeProject())
    expect(screen.queryByTestId('subcut-tool')).not.toBeInTheDocument()

    fireEvent.click(subcutButton()!)

    expect(renderSubcutRegen).toHaveBeenCalledWith(expect.objectContaining({ clipId: 'clip-0' }))
    expect(screen.getByTestId('subcut-tool')).toHaveTextContent('clip-0')
  })

  it('clicking it again toggles the tool back off', () => {
    mount(makeProject())
    fireEvent.click(subcutButton()!)
    expect(screen.getByTestId('subcut-tool')).toBeInTheDocument()

    fireEvent.click(subcutButton()!)
    expect(screen.queryByTestId('subcut-tool')).not.toBeInTheDocument()
  })

  // ── Queued is a badge, not a disable ───────────────────────────────────

  it('renders the "queued" badge and leaves the button clickable while queued', () => {
    mount(makeProject(), { isClipQueued: id => id === 'clip-0' })

    expect(screen.getByText('queued')).toBeInTheDocument()
    const button = subcutButton()!
    expect(button).not.toBeDisabled()

    // Still opens the tool — a queued clip can be re-opened and re-submitted.
    fireEvent.click(button)
    expect(screen.getByTestId('subcut-tool')).toHaveTextContent('clip-0')
  })

  it('does not render the badge for a clip the host does not report as queued', () => {
    mount(makeProject(), { isClipQueued: () => false })
    expect(screen.queryByText('queued')).not.toBeInTheDocument()
  })

  // The badge answers "is this clip in the regen queue?", which is true (and
  // worth showing) whether or not the clip happens to be selected. Its gate is
  // independent of the button's on the DOM rows; keep it that way.
  it('renders the badge independently of the button gate — unselected, regen disabled', () => {
    mount(makeProject(), { selectedIds: [], regenEnabled: false, isClipQueued: () => true })
    expect(screen.getByText('queued')).toBeInTheDocument()
    expect(subcutButton()).not.toBeInTheDocument()
  })

  // ── Stays pinned to its clip ───────────────────────────────────────────

  // The chrome is a DOM node over a surface that PANS AND RESCALES without
  // re-rendering React (the canvas redraws from an external viewport store).
  // Timeline's existing `useViewportValue` subscription is what re-lays this
  // out; without it the button detaches from its clip on the first zoom.
  it('re-pins the button to the clip after a zoom change', () => {
    const project = makeProject()
    mount(project)

    const rightBefore = parseFloat(subcutButton()!.parentElement!.style.right)
    // Sanity: the fitted position is the clip's own right edge, inset.
    const fitted = canvasViewport(project)
    expect(rightBefore).toBeCloseTo(
      SURFACE_WIDTH - timeToX(10, fitted) + CLIP_CHROME_RIGHT_PAD_PX, 4,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    // Recomputed through the production math the zoom button itself uses, so
    // this asserts "follows the viewport", not a hardcoded pixel.
    const { totalDuration } = computeDerivedTiming(project)
    const zoomed = zoomAtPivot(fitted, ZOOM_BUTTON_FACTOR, SURFACE_WIDTH / 2, totalDuration)
    const rightAfter = parseFloat(subcutButton()!.parentElement!.style.right)

    expect(zoomed.pxPerSecond).toBeGreaterThan(fitted.pxPerSecond)   // the zoom really moved
    expect(rightAfter).not.toBeCloseTo(rightBefore, 2)
    expect(rightAfter).toBeCloseTo(
      Math.max(CLIP_CHROME_RIGHT_PAD_PX, zoomed.widthPx - timeToX(10, zoomed) + CLIP_CHROME_RIGHT_PAD_PX), 4,
    )
  })

  // The horizontal pin above only proves `right`/`row.y` line up on ONE axis.
  // `top`/`height` track `row.y`/`row.height` independently — this is the axis
  // that breaks if `layout.rows` ordering ever changes, or if the positioning-
  // context assumption (the chrome's parent IS the surface's box) stops
  // holding — so it gets its own pin against the same production layout the
  // painter draws from.
  it('pins the chrome vertically to its row', () => {
    const project = makeProject()
    mount(project)

    const row = computeTimelineLayout(project).rows[0]
    const chrome = subcutButton()!.parentElement!
    expect(parseFloat(chrome.style.top)).toBeCloseTo(row.y, 4)
    expect(parseFloat(chrome.style.height)).toBeCloseTo(row.height, 4)
  })

  // The right-anchored box also carries a LEFT bound (`Math.max(0, x0)`) so
  // `overflow-hidden` clips it to the clip's own span — without it, a narrow
  // clip's right-anchored chrome overhangs leftward past the clip's start and
  // reads as the neighbouring clip's badge (see the comment on `left` in
  // Timeline.tsx). Zooming in centered on this clip's own middle pushes its
  // start well past the surface's left edge while its end stays on-screen,
  // which is exactly the shape that exercises the clamp.
  it('clamps the left edge to the surface when the clip starts off-screen to the left', () => {
    const project = makeProject()
    mount(project)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    // Sanity: production math agrees the clip's UN-clamped left edge is
    // actually negative here — otherwise this assertion would pass trivially.
    const fitted = canvasViewport(project)
    const { totalDuration } = computeDerivedTiming(project)
    const zoomed = zoomAtPivot(fitted, ZOOM_BUTTON_FACTOR, SURFACE_WIDTH / 2, totalDuration)
    expect(timeToX(0, zoomed)).toBeLessThan(0)

    const chrome = subcutButton()!.parentElement!
    expect(parseFloat(chrome.style.left)).toBe(0)
  })

  // A clip panned entirely off the surface (`x1 <= 0 || x0 >= widthPx`) should
  // render no chrome at all — not a box clamped to an edge, which is the
  // previous test's case. A second clip, far enough away that zooming in on
  // the first one's own middle pushes the FIRST clip's whole span behind the
  // surface's left edge, is what gives this a real subject: a single isolated
  // clip always straddles a pivot centered on itself, however far you zoom.
  it('does not render chrome for a clip scrolled entirely off the surface', () => {
    const project: Project = {
      id: 'p1',
      status: 'draft',
      settings: { resolution: [1080, 1920], fps: 30 },
      tracks: [{
        id: 'trk-0',
        items: [
          {
            id: 'clip-0', type: 'video', src: 'a.mp4',
            start: 0, end: 10, inPoint: 0, outPoint: 10,
            generation: { sceneId: 'sc-1', prompt: 'a wide shot', provider: 'kling' },
          },
          {
            id: 'clip-1', type: 'video', src: 'b.mp4',
            start: 500, end: 510, inPoint: 0, outPoint: 10,
          },
        ],
      }],
    } as unknown as Project

    mount(project, { selectedIds: ['clip-0'] })
    expect(subcutButton()).toBeInTheDocument()   // on-screen before any zoom

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    // Sanity: production math agrees clip-0's span is now entirely left of
    // the surface — this is what gives the cull a real subject to remove.
    const fitted = canvasViewport(project)
    const { totalDuration } = computeDerivedTiming(project)
    const zoomed = zoomAtPivot(fitted, ZOOM_BUTTON_FACTOR, SURFACE_WIDTH / 2, totalDuration)
    expect(timeToX(10, zoomed)).toBeLessThanOrEqual(0)

    expect(subcutButton()).not.toBeInTheDocument()
  })

  // ── The event hazard ───────────────────────────────────────────────────

  /**
   * `TimelineCanvas` binds `mousedown` on its container element and treats it
   * as the start of a gesture: it focuses the surface, and it attaches
   * document-level `mousemove`/`mouseup` for the life of the press — the
   * `mouseup` being what selects a clip. So "did a gesture start?" is
   * observable three ways, and this asserts all three.
   *
   * Note a React `onMouseDown={e => e.stopPropagation()}` on the button could
   * NOT have prevented this: React delegates synthetic events to its root
   * container, which sits ABOVE the canvas' own native listener on the
   * propagation path, so the canvas would already have run. The fix is
   * structural — the chrome is not a descendant of `[data-timeline-canvas]` —
   * and this test is what holds that structure in place.
   */
  it('a mousedown on the button does not start a canvas gesture', () => {
    const project = makeProject()
    const { container, clock, onSelectIds } = mount(project)
    const point = canvasItemPoint(project, { id: 'clip-0' })
    const init = { ...point, button: 0, bubbles: true }

    fireEvent.mouseDown(subcutButton()!, init)
    act(() => { document.dispatchEvent(new MouseEvent('mouseup', init)) })

    expect(document.activeElement).not.toBe(canvasSurface(container))
    expect(onSelectIds).not.toHaveBeenCalled()
    expect(clock.get()).toBe(0)
  })

  // Positive control for the test above: the very same press/release, with the
  // very same props and the very same coordinates, dispatched on the SURFACE
  // instead of on the button. It focuses the surface and it reaches the
  // machine's select. Without this the assertion above would also pass if the
  // coordinates were simply dead, or if the canvas had stopped listening.
  it('the same press on the surface itself does start a gesture', () => {
    const project = makeProject()
    const { container, onSelectIds } = mount(project)
    const point = canvasItemPoint(project, { id: 'clip-0' })
    const init = { ...point, button: 0, bubbles: true }

    fireEvent.mouseDown(canvasSurface(container), init)
    act(() => { document.dispatchEvent(new MouseEvent('mouseup', init)) })

    expect(document.activeElement).toBe(canvasSurface(container))
    expect(onSelectIds).toHaveBeenCalledTimes(1)
  })
})
