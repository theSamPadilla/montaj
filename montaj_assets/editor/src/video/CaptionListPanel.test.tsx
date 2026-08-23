import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import type { Project } from '../types'
import type { Captions, CaptionSegment } from '../schema'
import type { PlaybackClock } from './playback-clock'
import CaptionListPanel, { type CaptionListPanelProps, nextEditFocus } from './CaptionListPanel'
import { formatTime } from './timeline/utils'

// The "Caption style" subsection's expanded/collapsed state persists to
// localStorage (usePersistentState) — clear it between tests or an earlier
// test's `expandStyle()` leaks into the next one and TOGGLES it shut instead
// (see ui/__tests__/usePersistentState.test.tsx for the same convention).
beforeEach(() => window.localStorage.clear())
afterEach(() => cleanup())

// jsdom doesn't implement scrollIntoView; the editFocusId effect calls it.
Element.prototype.scrollIntoView = vi.fn()

function makeProject(style: Captions['style'], segments: CaptionSegment[], extra: Partial<Captions> = {}): Project {
  return { id: 'p1', captions: { style, segments, ...extra } } as unknown as Project
}

function makeClock(): PlaybackClock {
  return { get: () => 0, set: vi.fn(), subscribe: () => () => {} }
}

const THREE_SEGS: CaptionSegment[] = [
  { id: 'cap-0', text: 'hello world', start: 0, end: 2 },
  { id: 'cap-1', text: 'goodbye now', start: 2, end: 4 },
  { id: 'cap-2', text: 'the end', start: 4, end: 6 },
]

function renderPanel(opts: {
  style?: Captions['style']
  segments?: CaptionSegment[]
  extra?: Partial<Captions>
  currentTime?: number
  selectedIds?: string[]
  fps?: number
  editFocusId?: CaptionListPanelProps['editFocusId']
  withRegenerate?: boolean
} = {}) {
  const {
    style = 'karaoke',
    segments = THREE_SEGS,
    extra = {},
    currentTime = 0,
    selectedIds = [],
    fps = 30,
    editFocusId = null,
    withRegenerate = true,
  } = opts

  const project = makeProject(style, segments, extra)
  const clock = makeClock()
  const onSelectCaption = vi.fn()
  const onCaptionSegmentChange = vi.fn()
  const onCaptionEdit = vi.fn()
  const onProjectChange = vi.fn()
  const onCaptionSegmentDelete = vi.fn()
  const onRegenerateCaptions = withRegenerate ? vi.fn() : undefined

  const view = render(
    <CaptionListPanel
      captionTrack={project.captions}
      project={project}
      currentTime={currentTime}
      selectedIds={selectedIds}
      onSelectCaption={onSelectCaption}
      onCaptionSegmentChange={onCaptionSegmentChange}
      onCaptionEdit={onCaptionEdit}
      onProjectChange={onProjectChange}
      onCaptionSegmentDelete={onCaptionSegmentDelete}
      onRegenerateCaptions={onRegenerateCaptions}
      fps={fps}
      clock={clock}
      editFocusId={editFocusId}
    />,
  )

  return {
    ...view,
    project,
    clock,
    onSelectCaption,
    onCaptionSegmentChange,
    onCaptionEdit,
    onProjectChange,
    onCaptionSegmentDelete,
    onRegenerateCaptions,
  }
}

describe('CaptionListPanel list', () => {
  it('renders every segment, numbered', () => {
    renderPanel()
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByText('1')).toBeTruthy()
    expect(within(rows[1]).getByText('2')).toBeTruthy()
    expect(within(rows[2]).getByText('3')).toBeTruthy()
    expect(screen.getByText('hello world')).toBeTruthy()
    expect(screen.getByText('goodbye now')).toBeTruthy()
    expect(screen.getByText('the end')).toBeTruthy()
  })

  // R3: the retired TranscriptPanel/TranscriptModal both showed each segment's
  // start time — restored alongside the index badge (not instead of it) since
  // an index gives ordinal position while a timestamp gives where in the video
  // the line actually lands, which is what you navigate by.
  it('renders every segment\'s start timestamp alongside its index', () => {
    renderPanel()
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0]).getByText(formatTime(THREE_SEGS[0].start))).toBeTruthy()
    expect(within(rows[1]).getByText(formatTime(THREE_SEGS[1].start))).toBeTruthy()
    expect(within(rows[2]).getByText(formatTime(THREE_SEGS[2].start))).toBeTruthy()
  })

  it('with no captionTrack but a regenerate capability, offers only Regenerate + the empty message — no style controls, no search, no count', () => {
    const project = { id: 'p1' } as unknown as Project
    const clock = makeClock()
    render(
      <CaptionListPanel
        captionTrack={undefined}
        project={project}
        currentTime={0}
        selectedIds={[]}
        onSelectCaption={vi.fn()}
        onRegenerateCaptions={vi.fn()}
        fps={30}
        clock={clock}
      />,
    )
    expect(screen.getByText('Regenerate')).toBeTruthy()
    expect(screen.getByText(/no captions yet/i)).toBeTruthy()
    expect(screen.queryByLabelText('Caption style controls')).toBeNull()
    expect(screen.queryByLabelText('Search captions')).toBeNull()
    expect(screen.queryByText('Remove all')).toBeNull()
  })

  it('renders nothing at all when there are no captions and no way to generate them', () => {
    const project = { id: 'p1' } as unknown as Project
    const clock = makeClock()
    const { container } = render(
      <CaptionListPanel
        captionTrack={undefined}
        project={project}
        currentTime={0}
        selectedIds={[]}
        onSelectCaption={vi.fn()}
        fps={30}
        clock={clock}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('search filters the list by segment text, case-insensitively', () => {
    renderPanel()
    const search = screen.getByLabelText('Search captions')
    fireEvent.change(search, { target: { value: 'GOODBYE' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('goodbye now')).toBeTruthy()
    expect(screen.queryByText('hello world')).toBeNull()
  })

  it('search preserves each row\'s true position number even when filtered', () => {
    renderPanel()
    fireEvent.change(screen.getByLabelText('Search captions'), { target: { value: 'the end' } })
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('3')).toBeTruthy()
  })

  it('the selected row reflects selectedIds', () => {
    renderPanel({ selectedIds: ['cap-1'] })
    const rows = screen.getAllByRole('listitem')
    // `aria-current`, not `aria-selected` — the row is `role="listitem"`, not
    // `option`, since each one contains a contenteditable and a delete
    // button and ARIA forbids interactive descendants inside `option`.
    // Unselected rows omit the attribute entirely rather than carrying
    // `aria-current="false"`.
    expect(rows[0].getAttribute('aria-current')).toBeNull()
    expect(rows[1].getAttribute('aria-current')).toBe('true')
    expect(rows[2].getAttribute('aria-current')).toBeNull()
  })

  it('has no add button anywhere — captions come from transcription only', () => {
    renderPanel()
    expect(screen.queryByRole('button', { name: /^add$/i })).toBeNull()
    expect(screen.queryByLabelText(/add caption/i)).toBeNull()
  })
})

describe('CaptionListPanel row interactions', () => {
  it('a row click selects the segment and seeks to start + 0.5/fps (half-frame nudge past the frame-snap boundary)', () => {
    const { clock, onSelectCaption } = renderPanel({ fps: 30 })
    fireEvent.click(screen.getByText('goodbye now'))
    expect(onSelectCaption).toHaveBeenCalledWith('cap-1')
    expect(clock.set).toHaveBeenCalledWith(2 + 0.5 / 30)
  })

  it('a text edit fires onCaptionSegmentChange(id, { text }) and nothing else', () => {
    const { onCaptionSegmentChange, onCaptionEdit, onProjectChange } = renderPanel()
    const span = screen.getByText('hello world')
    span.textContent = 'hello universe'
    fireEvent.blur(span)
    expect(onCaptionSegmentChange).toHaveBeenCalledTimes(1)
    expect(onCaptionSegmentChange).toHaveBeenCalledWith('cap-0', { text: 'hello universe' })
    expect(onCaptionEdit).not.toHaveBeenCalled()
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it('a trash click fires the whole-track delete channel with the segment id, and does not also select/seek', () => {
    const { onCaptionSegmentDelete, onSelectCaption, clock } = renderPanel()
    const rows = screen.getAllByRole('listitem')
    fireEvent.click(within(rows[1]).getByLabelText('Delete caption'))
    expect(onCaptionSegmentDelete).toHaveBeenCalledTimes(1)
    expect(onCaptionSegmentDelete).toHaveBeenCalledWith('cap-1')
    expect(onSelectCaption).not.toHaveBeenCalled()
    expect(clock.set).not.toHaveBeenCalled()
  })
})

describe('CaptionListPanel relocated style controls', () => {
  function expandStyle() {
    fireEvent.click(screen.getByLabelText('Caption style controls'))
  }

  it('a style preset click commits via onCaptionEdit, writing captions.style', () => {
    const { onCaptionEdit } = renderPanel({ style: 'pop' })
    expandStyle()
    fireEvent.click(screen.getByText('subtitle'))
    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0].captions.style).toBe('subtitle')
  })

  it('fontsize slider previews live on change and commits once on pointer-up — exactly one channel per gesture', () => {
    const { onProjectChange, onCaptionEdit } = renderPanel()
    expandStyle()
    const slider = screen.getByLabelText('Caption font size')

    fireEvent.change(slider, { target: { value: '60' } })
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onProjectChange.mock.calls[0][0].captions.fontsize).toBe(60)
    expect(onCaptionEdit).not.toHaveBeenCalled()

    fireEvent.pointerUp(slider, { target: { value: '60' } })
    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0].captions.fontsize).toBe(60)
    // The commit did not also fire another live preview.
    expect(onProjectChange).toHaveBeenCalledTimes(1)
  })

  it('base text color previews live via onProjectChange and commits via onCaptionEdit when no segment is selected', () => {
    const { onProjectChange, onCaptionEdit } = renderPanel()
    expandStyle()
    const input = screen.getByLabelText('Caption text color') as HTMLInputElement

    fireEvent.change(input, { target: { value: '#76b900' } })
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onProjectChange.mock.calls[0][0].captions.color).toBe('#76b900')
    expect(onCaptionEdit).not.toHaveBeenCalled()

    fireEvent.blur(input, { target: { value: '#76b900' } })
    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0].captions.color).toBe('#76b900')
    // The commit did not also fire another live preview.
    expect(onProjectChange).toHaveBeenCalledTimes(1)
  })

  it("the swatch reflects the selected segment's own color when it has one, not the track color", () => {
    renderPanel({
      style: 'karaoke',
      segments: [{ id: 'cap-0', text: 'hi', start: 0, end: 2, color: '#00ff00' }],
      extra: { color: '#abcdef' },
      selectedIds: ['cap-0'],
    })
    expandStyle()
    expect((screen.getByLabelText('Selected segment text color') as HTMLInputElement).value).toBe('#00ff00')
  })

  it('when a segment is selected, the base swatch previews via onProjectChange (segment-scoped) and commits via onCaptionSegmentChange — never onCaptionEdit', () => {
    const { onProjectChange, onCaptionEdit, onCaptionSegmentChange } = renderPanel({
      selectedIds: ['cap-1'],
      extra: { color: '#ffffff' },
    })
    expandStyle()
    const input = screen.getByLabelText('Selected segment text color') as HTMLInputElement

    fireEvent.change(input, { target: { value: '#123456' } })
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    const previewed = onProjectChange.mock.calls[0][0]
    expect(previewed.captions.segments[1].color).toBe('#123456')
    expect(previewed.captions.segments[0].color).toBeUndefined()
    expect(previewed.captions.color).toBe('#ffffff')
    expect(onCaptionSegmentChange).not.toHaveBeenCalled()
    expect(onCaptionEdit).not.toHaveBeenCalled()

    fireEvent.blur(input, { target: { value: '#123456' } })
    expect(onCaptionSegmentChange).toHaveBeenCalledTimes(1)
    expect(onCaptionSegmentChange).toHaveBeenCalledWith('cap-1', { color: '#123456' })
    expect(onCaptionEdit).not.toHaveBeenCalled()
    // The commit did not also fire another live preview.
    expect(onProjectChange).toHaveBeenCalledTimes(1)
  })

  // ACCENT is a 5-entry lookup (see CaptionListPanel.tsx) binding each caption
  // style to the ONE prop its render template actually reads. A wrong entry
  // means the swatch writes a field the template ignores — nothing errors,
  // the preview just silently doesn't change — so this is exercised
  // exhaustively across ALL FIVE entries, `outline` included. `outline` and
  // `highlight-box` happen to agree on `accentColor` today, but that
  // agreement is a property of the current table, not one this test may
  // assume — a fat-fingered `outline` entry would be invisible from
  // `highlight-box`'s case alone, so each style gets its own row regardless
  // of what any other row asserts.
  describe.each([
    { style: 'karaoke' as const, label: 'Caption highlight color', field: 'highlightColor' },
    { style: 'pop' as const, label: 'Caption active color', field: 'activeColor' },
    { style: 'subtitle' as const, label: 'Caption box color', field: 'backgroundColor' },
    { style: 'highlight-box' as const, label: 'Caption accent color', field: 'accentColor' },
    { style: 'outline' as const, label: 'Caption accent color', field: 'accentColor' },
  ])('accent color for style $style', ({ style, label, field }) => {
    it(`writes to captions.${field}, live then commit, exactly once each`, () => {
      const { onProjectChange, onCaptionEdit } = renderPanel({ style })
      expandStyle()
      const input = screen.getByLabelText(label) as HTMLInputElement

      fireEvent.change(input, { target: { value: '#111111' } })
      expect(onProjectChange).toHaveBeenCalledTimes(1)
      expect(onProjectChange.mock.calls[0][0].captions[field]).toBe('#111111')
      expect(onCaptionEdit).not.toHaveBeenCalled()

      fireEvent.blur(input, { target: { value: '#111111' } })
      expect(onCaptionEdit).toHaveBeenCalledTimes(1)
      expect(onCaptionEdit.mock.calls[0][0].captions[field]).toBe('#111111')
      // The commit did not also fire another live preview.
      expect(onProjectChange).toHaveBeenCalledTimes(1)
    })
  })

  it.each(['clean', 'word-by-word'] as const)('hides the accent swatch for styles with no accent: %s', (style) => {
    renderPanel({ style })
    expandStyle()
    expect(screen.getByLabelText('Caption text color')).toBeTruthy()
    expect(screen.queryByLabelText(/(accent|highlight|active|box) color/i)).toBeNull()
  })
})

describe('CaptionListPanel toolbar actions', () => {
  it('Regenerate fires onRegenerateCaptions and is hidden when the prop is absent', () => {
    const { onRegenerateCaptions } = renderPanel({ withRegenerate: true })
    fireEvent.click(screen.getByText('Regenerate'))
    expect(onRegenerateCaptions).toHaveBeenCalledTimes(1)
    cleanup()

    renderPanel({ withRegenerate: false })
    expect(screen.queryByText('Regenerate')).toBeNull()
  })

  it('Remove all requires two clicks and commits captions: null on the second', () => {
    const { onCaptionEdit } = renderPanel()
    const removeBtn = screen.getByText('Remove all')
    fireEvent.click(removeBtn)
    expect(onCaptionEdit).not.toHaveBeenCalled()
    expect(screen.getByText('Really remove?')).toBeTruthy()

    fireEvent.click(screen.getByText('Really remove?'))
    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0].captions).toBeNull()
  })
})

// Producer side (VideoEditor.tsx's `handleEditCaption` calls this directly) —
// the receiving-end tests below prove CaptionListPanel re-focuses correctly
// GIVEN a fresh nonce; this proves the nonce actually gets produced fresh.
// Behavioural, not source-text matching: a wrong-operator bug (`?? 1` instead
// of `?? 0`, or a dropped `+ 1`) would read as plausible source but fail here.
describe('nextEditFocus', () => {
  it('starts a fresh request at nonce 1 when there was no previous one', () => {
    expect(nextEditFocus(null, 'a')).toEqual({ id: 'a', nonce: 1 })
  })

  it('bumps the nonce by 1 on a repeat double-click of the SAME segment', () => {
    expect(nextEditFocus({ id: 'a', nonce: 1 }, 'a')).toEqual({ id: 'a', nonce: 2 })
  })

  it('keeps climbing across DIFFERENT ids — the nonce is global, not per-id', () => {
    expect(nextEditFocus({ id: 'a', nonce: 5 }, 'b')).toEqual({ id: 'b', nonce: 6 })
  })
})

describe('CaptionListPanel editFocusId (Phase 6 receiving end)', () => {
  it('scrolls the target row into view and focuses its EditableSegment when the nonce changes', () => {
    const { rerender, project, clock } = (() => {
      const project = makeProject('karaoke', THREE_SEGS)
      const clock = makeClock()
      const utils = render(
        <CaptionListPanel
          captionTrack={project.captions}
          project={project}
          currentTime={0}
          selectedIds={[]}
          onSelectCaption={vi.fn()}
          onCaptionSegmentChange={vi.fn()}
          fps={30}
          clock={clock}
          editFocusId={null}
        />,
      )
      return { ...utils, project, clock }
    })()

    rerender(
      <CaptionListPanel
        captionTrack={project.captions}
        project={project}
        currentTime={0}
        selectedIds={[]}
        onSelectCaption={vi.fn()}
        onCaptionSegmentChange={vi.fn()}
        fps={30}
        clock={clock}
        editFocusId={{ id: 'cap-1', nonce: 1 }}
      />,
    )

    const editable = screen.getByText('goodbye now')
    expect(document.activeElement).toBe(editable)
  })

  // The test above only proves a FIRST arrival (`null` → a real request)
  // re-focuses — on that transition the id changes too, so it would pass
  // even if `lastHandledNonceRef` were keyed on `id` instead of `nonce`. This
  // test isolates the nonce itself: same id throughout, only the nonce moves,
  // which is the one axis an id-keyed guard could not get right.
  it('re-focuses on a same-id nonce bump, but not on a re-render with an unchanged nonce', () => {
    const project = makeProject('karaoke', THREE_SEGS)
    const clock = makeClock()
    const commonProps = {
      captionTrack: project.captions,
      project,
      currentTime: 0,
      selectedIds: [],
      onSelectCaption: vi.fn(),
      onCaptionSegmentChange: vi.fn(),
      fps: 30,
      clock,
    }

    const { rerender } = render(
      <CaptionListPanel {...commonProps} editFocusId={{ id: 'cap-1', nonce: 1 }} />,
    )
    const editable = screen.getByText('goodbye now')
    expect(document.activeElement).toBe(editable)

    // A REAL DOM blur, not `fireEvent.blur` — the latter only dispatches the
    // event and does not move jsdom's `document.activeElement`, which would
    // let every assertion below pass on residual focus from the render above
    // regardless of what the effect actually does.
    editable.blur()
    expect(document.activeElement).not.toBe(editable)

    // Negative: the SAME { id, nonce } — a new object, same values — must NOT
    // re-focus. This is `lastHandledNonceRef` doing its job; without it, any
    // unrelated parent re-render while this request is still current would
    // re-steal focus out from under whatever the operator is doing next.
    rerender(<CaptionListPanel {...commonProps} editFocusId={{ id: 'cap-1', nonce: 1 }} />)
    expect(document.activeElement).not.toBe(editable)

    // Positive: SAME id, INCREMENTED nonce — must re-focus. An id-keyed guard
    // (the bug this test exists to catch) would ALSO treat this as "already
    // handled", since the id never changed, and wrongly stay silent here —
    // this is the one assertion only a nonce-keyed guard can pass.
    rerender(<CaptionListPanel {...commonProps} editFocusId={{ id: 'cap-1', nonce: 2 }} />)
    expect(document.activeElement).toBe(editable)
  })
})
