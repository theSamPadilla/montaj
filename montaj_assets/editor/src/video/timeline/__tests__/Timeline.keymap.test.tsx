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

  // Shift is TEN FRAMES, not one second. At this fixture's 10fps the two
  // happen to coincide at 1.0s, so both directions are asserted at a second
  // fps below where they diverge — otherwise the old wall-clock behaviour
  // would pass this test unchanged.
  it('Shift+ArrowRight steps ten frames forward, and Shift+ArrowLeft ten back', () => {
    const clock = createPlaybackClock(2)
    render(<Timeline project={makeProject()} clock={clock} />)
    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowRight', shiftKey: true }) })
    expect(clock.get()).toBeCloseTo(3, 5)
    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowLeft', shiftKey: true }) })
    expect(clock.get()).toBeCloseTo(2, 5)
  })

  it('the shifted step is ten FRAMES, so it scales with fps rather than being a flat second', () => {
    const clock = createPlaybackClock(2)
    const project = makeProject()
    render(<Timeline project={{ ...project, settings: { ...project.settings!, fps: 25 } }} clock={clock} />)
    // 10 frames at 25fps is 0.4s. The old `shiftKey ? 1` would give 3.0.
    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowRight', shiftKey: true }) })
    expect(clock.get()).toBeCloseTo(2.4, 5)
  })

  // Content end = the furthest item's end across ALL clips/overlays/audio
  // (`contentDuration` from computeDerivedTiming), not the zoom/scroll
  // headroom-padded `totalDuration`. This fixture's video track ends at 4s,
  // but a later audio track pushes the real content end out to 7s — proving
  // the jump lands on the furthest ELEMENT, not just the longest video clip.
  // totalDuration would pad that out further still (7 + max(5, 7*0.2) = 12),
  // so asserting 7 (not 12, not 4) pins down both distinctions at once.
  function makeProjectWithFurtherAudio(): Project {
    const project = makeProject()
    return {
      ...project,
      audio: { tracks: [{ id: 'a0', src: 'v.mp3', start: 5, end: 7, lane: 0 }] },
    } as unknown as Project
  }

  it('Cmd/Ctrl+ArrowLeft jumps the playhead to the start (0)', () => {
    const clock = createPlaybackClock(3)
    render(<Timeline project={makeProjectWithFurtherAudio()} clock={clock} />)
    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowLeft', metaKey: true }) })
    expect(clock.get()).toBe(0)
  })

  it('Ctrl+ArrowLeft (non-Mac mod) also jumps to the start', () => {
    const clock = createPlaybackClock(3)
    render(<Timeline project={makeProjectWithFurtherAudio()} clock={clock} />)
    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowLeft', ctrlKey: true }) })
    expect(clock.get()).toBe(0)
  })

  it('Cmd/Ctrl+ArrowRight jumps the playhead to the content end (furthest element, not headroom)', () => {
    const clock = createPlaybackClock(0)
    render(<Timeline project={makeProjectWithFurtherAudio()} clock={clock} />)
    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowRight', metaKey: true }) })
    // 7, not 4 (the video clip alone) and not 12 (totalDuration's headroom).
    expect(clock.get()).toBe(7)
  })

  it('a plain ArrowLeft/ArrowRight still frame-steps and does NOT jump, even with the further-audio fixture', () => {
    const clock = createPlaybackClock(2)
    render(<Timeline project={makeProjectWithFurtherAudio()} clock={clock} />)
    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowRight' }) })
    expect(clock.get()).toBeCloseTo(2.1, 5)
    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowLeft' }) })
    expect(clock.get()).toBeCloseTo(2, 5)
  })

  it('Cmd+ArrowLeft/Right does not ALSO fire the frame-step binding (no double-action)', () => {
    const clock = createPlaybackClock(3)
    render(<Timeline project={makeProjectWithFurtherAudio()} clock={clock} />)
    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowRight', metaKey: true }) })
    // If frame-step also fired, this would be 7 + 0.1 instead of 7.
    expect(clock.get()).toBe(7)
  })

  it('Cmd/Ctrl+Arrow jump is inert on an empty project (guard: totalDuration > 0)', () => {
    const clock = createPlaybackClock(0)
    const emptyProject = { ...makeProject(), tracks: [] } as unknown as Project
    render(<Timeline project={emptyProject} clock={clock} />)
    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowRight', metaKey: true }) })
    expect(clock.get()).toBe(0)
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

  // Caption rows: emptying one leaves a HOLE lane, and the row has to collapse
  // in the SAME commit as the delete that emptied it — otherwise the operator's
  // Cmd-Z brings the caption back but leaves the row renumbering behind (or
  // undoes it separately, one keystroke later).
  it('Delete collapses and renumbers a caption row it empties, in the same commit', () => {
    const clock = createPlaybackClock(0)
    const onProjectChange = vi.fn()
    const onOverlayEdit = vi.fn()
    const project = {
      ...makeProject(),
      captions: {
        style: 'clean',
        segments: [
          { id: 'cap-0', text: 'ground', start: 0, end: 1 },              // lane 0
          { id: 'cap-1', text: 'middle', start: 0, end: 1, lane: 1 },     // lane 1, alone
          { id: 'cap-2', text: 'top', start: 0, end: 1, lane: 2 },        // lane 2
        ],
      },
    } as unknown as Project
    const { container } = render(
      <Timeline
        project={project}
        clock={clock}
        selectedIds={['cap-1']}
        onSelectIds={vi.fn()}
        onProjectChange={onProjectChange}
        onOverlayEdit={onOverlayEdit}
      />,
    )
    focusTimelineRoot(container)
    fireEvent.keyDown(document.body, { key: 'Delete' })
    // ONE commit — the strip and the renumbering are a single undo entry.
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onOverlayEdit).toHaveBeenCalledTimes(1)
    const updated = onProjectChange.mock.calls[0][0] as Project
    expect(updated.captions?.segments.map((s) => s.id)).toEqual(['cap-0', 'cap-2'])
    // cap-2 was on lane 2 with a hole below it; it drops into the vacated row.
    expect(updated.captions?.segments.map((s) => s.lane ?? 0)).toEqual([0, 1])
  })

  it('Delete leaves the other rows alone when the row it empties is the TOP one', () => {
    // Removing the highest lane leaves no hole, so nothing renumbers.
    const clock = createPlaybackClock(0)
    const onProjectChange = vi.fn()
    const project = {
      ...makeProject(),
      captions: {
        style: 'clean',
        segments: [
          { id: 'cap-0', text: 'ground', start: 0, end: 1 },
          { id: 'cap-1', text: 'top', start: 0, end: 1, lane: 1 },
        ],
      },
    } as unknown as Project
    const { container } = render(
      <Timeline
        project={project}
        clock={clock}
        selectedIds={['cap-1']}
        onSelectIds={vi.fn()}
        onProjectChange={onProjectChange}
      />,
    )
    focusTimelineRoot(container)
    fireEvent.keyDown(document.body, { key: 'Delete' })
    const updated = onProjectChange.mock.calls[0][0] as Project
    expect(updated.captions?.segments.map((s) => s.id)).toEqual(['cap-0'])
    expect(updated.captions?.segments[0].lane).toBeUndefined()
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
