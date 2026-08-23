import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import type { Project } from '../../../types'
import { createPlaybackClock } from '../../playback-clock'
import Timeline, { type TimelineActions } from '../Timeline'

afterEach(() => cleanup())

function makeProject(): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 10 }, // 10fps -> 0.1s frame step, easy to assert
    tracks: [[{ id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4 }]],
  } as unknown as Project
}

function makeProjectWithCaptions(): Project {
  return {
    ...makeProject(),
    captions: {
      style: 'clean',
      segments: [
        { id: 'cap-0', text: 'hello', start: 0, end: 1 },
        { id: 'cap-1', text: 'world', start: 1, end: 2 },
      ],
    },
  } as unknown as Project
}

/** Delete/Enter are focus-scoped to Timeline's own root (the `tabIndex={0}`
 *  container), mirroring pre-SP5 behavior — unlike arrows/Escape, which stay
 *  document-level. Timeline's root is the outermost DOM node it renders
 *  (`TimelineContext.Provider` contributes no element of its own), so it's
 *  always `container.firstElementChild` in these tests. */
function focusTimelineRoot(container: HTMLElement) {
  (container.firstElementChild as HTMLElement).focus()
}

describe('Timeline — T9 keymap (arrows / delete / enter / escape)', () => {
  it('ArrowRight steps the clock forward by one frame on a plain target', () => {
    const clock = createPlaybackClock(0)
    render(<Timeline project={makeProject()} clock={clock} />)
    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowRight' }) })
    expect(clock.get()).toBeCloseTo(0.1, 5)
  })

  it('does not step when the target is an input', () => {
    const clock = createPlaybackClock(0)
    const { container } = render(
      <div>
        <input data-testid="somewhere-else" />
        <Timeline project={makeProject()} clock={clock} />
      </div>,
    )
    const input = container.querySelector('input') as HTMLInputElement
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(clock.get()).toBe(0)
  })

  it('does not step when `modalOpen` is true (a host-level dialog is up)', () => {
    const clock = createPlaybackClock(0)
    render(<Timeline project={makeProject()} clock={clock} modalOpen />)
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(clock.get()).toBe(0)
  })

  // Enter and Escape used to place and clear the A/B range markers. That
  // feature is gone, so the timeline binds neither: pressing them with the
  // timeline focused must not move the playhead or touch the project.
  it('Enter and Escape are not bound', () => {
    const clock = createPlaybackClock(2)
    const onProjectChange = vi.fn()
    const { container } = render(
      <Timeline project={makeProject()} clock={clock} onProjectChange={onProjectChange} />,
    )
    focusTimelineRoot(container)
    fireEvent.keyDown(document.body, { key: 'Enter' })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(clock.get()).toBe(2)
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it('Delete/Backspace two-step delete: fires only with a selection, commits via onProjectChange + onOverlayEdit + clears selection', () => {
    const clock = createPlaybackClock(0)
    const onProjectChange = vi.fn()
    const onOverlayEdit = vi.fn()
    const onSelectIds = vi.fn()
    const { container } = render(
      <Timeline
        project={makeProject()}
        clock={clock}
        selectedIds={['clip-0']}
        onSelectIds={onSelectIds}
        onProjectChange={onProjectChange}
        onOverlayEdit={onOverlayEdit}
      />,
    )
    focusTimelineRoot(container)
    fireEvent.keyDown(document.body, { key: 'Delete' })
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onOverlayEdit).toHaveBeenCalledTimes(1)
    expect(onSelectIds).toHaveBeenCalledWith([])
    const updated = onProjectChange.mock.calls[0][0] as Project
    expect(updated.tracks?.[0]?.items.find((i) => i.id === 'clip-0')).toBeUndefined()
  })

  // D1: a caption id can sit in `selectedIds` alongside a clip id (selected on
  // the canvas timeline like any other item — see Timeline.tsx's
  // handleSelectItem). `deleteSelection` only knows tracks/audio vocabulary, so
  // the keymap action must strip selected caption segments itself, folded into
  // the SAME onProjectChange/onOverlayEdit commit as the clip delete — one undo
  // entry covering the mixed selection, not two.
  it('Delete strips a selected caption segment AND a selected clip in one commit', () => {
    const clock = createPlaybackClock(0)
    const onProjectChange = vi.fn()
    const onOverlayEdit = vi.fn()
    const onSelectIds = vi.fn()
    const { container } = render(
      <Timeline
        project={makeProjectWithCaptions()}
        clock={clock}
        selectedIds={['clip-0', 'cap-0']}
        onSelectIds={onSelectIds}
        onProjectChange={onProjectChange}
        onOverlayEdit={onOverlayEdit}
      />,
    )
    focusTimelineRoot(container)
    fireEvent.keyDown(document.body, { key: 'Delete' })
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onOverlayEdit).toHaveBeenCalledTimes(1)
    expect(onSelectIds).toHaveBeenCalledWith([])
    const updated = onProjectChange.mock.calls[0][0] as Project
    expect(updated.tracks?.[0]?.items.find((i) => i.id === 'clip-0')).toBeUndefined()
    expect(updated.captions?.segments.map((s) => s.id)).toEqual(['cap-1'])
  })

  // Deleting every remaining caption segment must leave `captions` as an
  // empty-segments object, not null the whole track — nulling it is the
  // sidebar's explicit "Remove all" action, not a side effect of Delete.
  it('Delete leaves an empty captions object when the last segment is removed, never nulls the track', () => {
    const clock = createPlaybackClock(0)
    const onProjectChange = vi.fn()
    const project = makeProjectWithCaptions()
    project.captions!.segments = [{ id: 'cap-0', text: 'hello', start: 0, end: 1 }]
    const { container } = render(
      <Timeline
        project={project}
        clock={clock}
        selectedIds={['cap-0']}
        onSelectIds={vi.fn()}
        onProjectChange={onProjectChange}
      />,
    )
    focusTimelineRoot(container)
    fireEvent.keyDown(document.body, { key: 'Delete' })
    const updated = onProjectChange.mock.calls[0][0] as Project
    expect(updated.captions).not.toBeNull()
    expect(updated.captions?.segments).toEqual([])
  })

  it('Delete does NOT delete the selection when focus is outside the timeline (restored pre-SP5 scoping)', () => {
    const clock = createPlaybackClock(0)
    const onProjectChange = vi.fn()
    render(
      <Timeline
        project={makeProject()}
        clock={clock}
        selectedIds={['clip-0']}
        onProjectChange={onProjectChange}
      />,
    )
    // Focus left on document.body (or anywhere outside Timeline's own root) —
    // never inside the timeline. T9 briefly widened Delete/Enter to fire from
    // anywhere on the page; this proves that regression stays fixed.
    ;(document.body as HTMLElement).focus()
    fireEvent.keyDown(document.body, { key: 'Delete' })
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it('Delete with no selection is a no-op', () => {
    const clock = createPlaybackClock(0)
    const onProjectChange = vi.fn()
    render(<Timeline project={makeProject()} clock={clock} onProjectChange={onProjectChange} />)
    fireEvent.keyDown(document.body, { key: 'Delete' })
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it('Shift+Delete does NOT trigger Timeline\'s own delete binding (reserved for ripple-delete upstream)', () => {
    const clock = createPlaybackClock(0)
    const onProjectChange = vi.fn()
    render(
      <Timeline project={makeProject()} clock={clock} selectedIds={['clip-0']} onProjectChange={onProjectChange} />,
    )
    fireEvent.keyDown(document.body, { key: 'Delete', shiftKey: true })
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it('exposes zoomFit through actionsRef for a host-level palette', () => {
    const clock = createPlaybackClock(1)
    const actionsRef: { current: TimelineActions | null } = { current: null }
    render(<Timeline project={makeProject()} clock={clock} actionsRef={actionsRef} />)
    expect(actionsRef.current).not.toBeNull()
    act(() => { actionsRef.current!.zoomFit() })
    // Smoke test: it doesn't throw, and the ref stays populated.
    expect(actionsRef.current).not.toBeNull()
  })
})
