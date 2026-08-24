/// <reference types="vitest/globals" />
/**
 * The fade-shape picker — a right-click (Vegas' own gesture) on an audio
 * bar's fade GRIP opens a small menu of three ICON options (Linear /
 * Logarithmic / Exponential — see `FadeCurveIcon` in Timeline.tsx), each
 * naming its shape via `title`/`aria-label` rather than visible text;
 * picking one commits `fadeInCurve`/`fadeOutCurve` as ONE undo entry.
 * Options are selected here by their accessible NAME (`getByRole('button',
 * {name: ...})`, which resolves off `aria-label`), not by visible text.
 *
 * `TimelineCanvas`'s `contextmenu` handler does its own hit-test and calls
 * `onFadeCurveMenu` with CLIENT coordinates; `Timeline` owns the menu's
 * open/closed state and renders it as a `position: fixed` DOM overlay. jsdom
 * lays everything out at 0×0, so the surface's rect is stubbed to a real one
 * via `installCanvasHarness` (see `_canvasSelect.ts`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import type { AudioTrack } from '../../../schema'
import type { Project } from '../../../types'
import { createPlaybackClock } from '../../playback-clock'
import Timeline from '../Timeline'
import { AUDIO_ITEM_INSET_PX, computeTimelineLayout } from '../canvas/draw'
import { installCanvasHarness, SURFACE_LEFT, timeToClientX } from './_canvasSelect'

let uninstall: () => void

beforeEach(() => {
  uninstall = installCanvasHarness()
})

afterEach(() => {
  cleanup()
  uninstall()
})

const AUDIO_TRACK: AudioTrack = { id: 'a0', src: 'v.mp3', start: 0, end: 10, fadeIn: 2 }

/** `track` defaults to `AUDIO_TRACK` — only its `fadeInCurve`/`fadeOutCurve`
 *  ever varies between tests (e.g. the highlight test), never its timing, so
 *  `fadeInGripClientPoint` below can keep reading `AUDIO_TRACK`'s own
 *  start/fadeIn unconditionally. */
function makeProject(track: AudioTrack = AUDIO_TRACK): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    audio: { tracks: [track] },
  } as unknown as Project
}

/** The fade-in grip's CLIENT (x, y) for `AUDIO_TRACK`, derived the same way
 *  `hit-test.ts`'s `audioFadeGripX`/`audioFadeGripZone` do — purely from
 *  time and the lane's own y, with no clip-body gutter math (the grip's HIT
 *  zone is defined in time, not pixels; see hit-test.ts). `timeToClientX`
 *  gives the SAME fit-to-view viewport the mounted surface settles to on
 *  render; only the audio-bar's own top inset (`AUDIO_ITEM_INSET_PX`) is
 *  genuinely fade-specific and stays local. */
function fadeInGripClientPoint(project: Project) {
  const clientX = timeToClientX(project, AUDIO_TRACK.start + (AUDIO_TRACK.fadeIn ?? 0))
  const lane = computeTimelineLayout(project).lanes[0]
  const barTop = lane.y + AUDIO_ITEM_INSET_PX
  return { clientX, clientY: barTop + 2 }
}

function mount(track: AudioTrack = AUDIO_TRACK) {
  const clock = createPlaybackClock()
  const onProjectChange = vi.fn()
  const onOverlayEdit = vi.fn()
  const project = makeProject(track)
  const utils = render(
    <Timeline
      project={project}
      clock={clock}
      onProjectChange={onProjectChange}
      onOverlayEdit={onOverlayEdit}
    />,
  )
  const surface = utils.container.querySelector('[data-timeline-canvas]') as HTMLElement
  return { clock, onProjectChange, onOverlayEdit, surface, project, ...utils }
}

/** The picker's three option buttons expose their shape as the ACCESSIBLE
 *  NAME (via `aria-label`, with a matching `title` for the hover tooltip) —
 *  never as visible text — so every lookup here goes through
 *  `getByRole('button', {name})` rather than `getByText`. */
function shapeButton(name: 'Linear' | 'Logarithmic' | 'Exponential') {
  return screen.getByRole('button', { name })
}
function queryShapeButton(name: 'Linear' | 'Logarithmic' | 'Exponential') {
  return screen.queryByRole('button', { name })
}

describe('Timeline — fade-shape picker (right-click a fade grip)', () => {
  it('opens the picker with three shape ICON options on a fade-grip right-click', () => {
    const { surface, project } = mount()
    const point = fadeInGripClientPoint(project)
    fireEvent.contextMenu(surface, point)
    expect(shapeButton('Linear')).toBeInTheDocument()
    expect(shapeButton('Logarithmic')).toBeInTheDocument()
    expect(shapeButton('Exponential')).toBeInTheDocument()
    // Icon-only: the shape name is discoverable via title/aria-label, not as
    // rendered text content anywhere in the menu.
    expect(screen.queryByText('Linear')).not.toBeInTheDocument()
  })

  it('does NOT open the picker from a right-click elsewhere on the bar', () => {
    const { surface } = mount()
    // Well clear of the fade-in grip's small top-corner zone (see
    // FADE_GRIP_ZONE_HEIGHT_PX) — the middle of the bar, vertically.
    fireEvent.contextMenu(surface, { clientX: SURFACE_LEFT + 500, clientY: 100 })
    expect(queryShapeButton('Linear')).not.toBeInTheDocument()
  })

  it('picking a shape commits fadeInCurve as ONE undo entry and closes the menu', () => {
    const { surface, onProjectChange, onOverlayEdit, project } = mount()
    const point = fadeInGripClientPoint(project)
    fireEvent.contextMenu(surface, point)

    fireEvent.click(shapeButton('Logarithmic'))

    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onOverlayEdit).toHaveBeenCalledTimes(1)
    const committed = onOverlayEdit.mock.calls[0][0] as Project
    expect(committed.audio?.tracks[0].fadeInCurve).toBe('log')
    // fadeOutCurve is untouched — only the side that was right-clicked changes.
    expect(committed.audio?.tracks[0].fadeOutCurve).toBeUndefined()
    expect(queryShapeButton('Linear')).not.toBeInTheDocument()
  })

  it('Escape closes the picker without committing anything', () => {
    const { surface, onProjectChange, onOverlayEdit, project } = mount()
    fireEvent.contextMenu(surface, fadeInGripClientPoint(project))
    expect(shapeButton('Linear')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(queryShapeButton('Linear')).not.toBeInTheDocument()
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(onOverlayEdit).not.toHaveBeenCalled()
  })

  it('clicking outside the menu closes it without touching the project', () => {
    const { surface, onProjectChange, onOverlayEdit, project } = mount()
    fireEvent.contextMenu(surface, fadeInGripClientPoint(project))
    expect(shapeButton('Linear')).toBeInTheDocument()

    // The full-viewport backdrop is what "click elsewhere" actually hits —
    // fixed-positioned, so it's the element under the pointer wherever on
    // screen the click lands.
    fireEvent.click(screen.getByTestId('fade-curve-menu-backdrop'))

    expect(queryShapeButton('Linear')).not.toBeInTheDocument()
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(onOverlayEdit).not.toHaveBeenCalled()
  })

  it('highlights the DEFAULT shape (exp) when no curve is set yet', () => {
    const { surface, project } = mount()
    fireEvent.contextMenu(surface, fadeInGripClientPoint(project))
    expect(shapeButton('Exponential')).toHaveAttribute('aria-pressed', 'true')
    expect(shapeButton('Linear')).toHaveAttribute('aria-pressed', 'false')
    expect(shapeButton('Logarithmic')).toHaveAttribute('aria-pressed', 'false')
  })

  it('highlights whichever shape is already set on the track being edited', () => {
    const track: AudioTrack = { ...AUDIO_TRACK, fadeInCurve: 'log' }
    const { surface, project } = mount(track)
    fireEvent.contextMenu(surface, fadeInGripClientPoint(project))
    expect(shapeButton('Logarithmic')).toHaveAttribute('aria-pressed', 'true')
    expect(shapeButton('Linear')).toHaveAttribute('aria-pressed', 'false')
    expect(shapeButton('Exponential')).toHaveAttribute('aria-pressed', 'false')
  })
})
