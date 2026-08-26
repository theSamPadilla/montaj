/// <reference types="vite/client" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import type { Project } from '../types'
import type { Captions, CaptionSegment } from '../schema'
import type { PlaybackClock } from './playback-clock'
import CaptionListPanel, { type CaptionListPanelProps, nextEditFocus, reviveCaptionTab } from './CaptionListPanel'
import { formatTime } from './timeline/utils'
import src from './CaptionListPanel.tsx?raw'

// The panel's active sub-tab (Format / Styles / Captions) persists to
// localStorage (usePersistentState). Clear it between tests, then SEED it to
// 'captions' so the bulk of the suites below — which inspect the transcript
// list, search, row filters, and footer actions — render on the tab those
// live on. The dedicated 'tabs' suite at the bottom clears this seed itself
// to exercise the real default ('format').
beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('montaj.editor.captionPanelTab', JSON.stringify('captions'))
})
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

// Two lanes (SP5-captions Phase 5's `groupCaptionLanes` grouping). Lane 0
// ("Row 1") is nearest the video; lane 1 ("Row 2") sits above it. Named
// alpha/beta per lane so a search query can target exactly one row's segment
// without also matching the other row's.
const TWO_LANE_SEGS: CaptionSegment[] = [
  { id: 'r1-a', text: 'lower caption alpha', start: 0, end: 2, lane: 0 },
  { id: 'r2-a', text: 'upper caption alpha', start: 0, end: 2, lane: 1 },
  { id: 'r1-b', text: 'lower caption beta', start: 2, end: 4, lane: 0 },
  { id: 'r2-b', text: 'upper caption beta', start: 2, end: 4, lane: 1 },
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

  // Regression guard, source-level rather than rendered: Tailwind cannot
  // generate a rule for an opacity modifier on an arbitrary var() color
  // (`text-[var(--editor-text)]/40`) — the class is a silent no-op, so the
  // element inherits whatever color its ancestor has instead. That shipped
  // invisibly on these exact two spans (index number + start timestamp):
  // measured in a real browser at rgb(17,24,39) text on an rgb(17,24,39) row,
  // a 1.00:1 contrast ratio, across all 39 rows of a real caption list. jsdom
  // doesn't evaluate Tailwind, so `getByText(...)` above passes either way —
  // only a source-text check on the actual class string catches it.
  //
  // Scoped to just these two spans, not "no `/<number>` modifier anywhere in
  // the file": ~12 OTHER `text-[var(--editor-text)]/N` uses remain elsewhere
  // in this component (toolbar, buttons, search, empty states) and are
  // equally no-ops, but they were individually measured to render legibly in
  // their positions and are out of scope for this fix. A file-wide ban here
  // would either force touching all of them unverified or need a fragile
  // "count didn't grow" check that can't tell one class moving from banning
  // one occurrence while a new one appears elsewhere.
  it('the row index and timestamp spans do not use a no-op opacity-modifier color class', () => {
    const indexSpan = src.match(/<span className="[^"]*">\{index \+ 1\}<\/span>/)?.[0] ?? ''
    const timestampSpan = src.match(/<span className="[^"]*">\{formatTime\(seg\.start\)\}<\/span>/)?.[0] ?? ''
    expect(indexSpan).toBeTruthy()
    expect(timestampSpan).toBeTruthy()
    expect(indexSpan).not.toMatch(/text-\[var\(--editor-text\)\]\/\d+/)
    expect(timestampSpan).not.toMatch(/text-\[var\(--editor-text\)\]\/\d+/)
  })

  it('with no captionTrack but a regenerate capability, offers only Generate captions + the empty message — no style controls, no search, no count', () => {
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
    // No captions yet, so the trigger is the empty state's primary
    // "Generate captions" button, not the header's "Regenerate captions".
    expect(screen.getByText('Generate captions')).toBeTruthy()
    expect(screen.getByText(/generated from/i)).toBeTruthy()
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
  // The style controls used to hide behind a collapse toggle, then behind a
  // single "Style" tab; they now split across two tabs — "Format" (the fine
  // controls: size, colors, font, Bold, case, alignment, spacing;
  // the panel's default) and "Styles" (the gallery of live style previews,
  // see CaptionStyleGallery.tsx / .test.tsx). Selecting a tab is what makes
  // its controls visible — these suites seed 'captions' in `beforeEach`, so
  // each helper's click actually flips tabs here.
  function expandFormat() {
    fireEvent.click(screen.getByRole('button', { name: 'Format' }))
  }
  function expandStyles() {
    fireEvent.click(screen.getByRole('button', { name: 'Styles' }))
  }

  // Was: click a style preset CHIP on the old single "Style" tab. The chip
  // row is retired (CaptionStyleGallery replaces it); this proves the PANEL
  // wires the gallery's click-to-commit through onCaptionEdit exactly as the
  // chip row did — the gallery's own test file covers the gallery in
  // isolation, this is the integration seam between the two.
  it('a style gallery card click commits via onCaptionEdit, writing captions.style', () => {
    const { onCaptionEdit } = renderPanel({ style: 'pop' })
    expandStyles()
    fireEvent.click(screen.getByRole('button', { name: 'Subtitle' }))
    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0].captions.style).toBe('subtitle')
  })

  it('fontsize previews live on change and commits once on blur — exactly one channel per gesture', () => {
    // Was a `type="range"` slider (commit on pointer-up/key-up); now the
    // shared NumberField box, whose commit gesture is blur/Enter instead —
    // see NumberField's own doc comment for why.
    const { onProjectChange, onCaptionEdit } = renderPanel()
    expandFormat()
    // Two controls now share this name (the shared Slider + the NumberField box);
    // target the box (spinbutton) — this test types/commits an exact value.
    const field = screen.getByRole('spinbutton', { name: 'Caption font size' })

    fireEvent.change(field, { target: { value: '60' } })
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onProjectChange.mock.calls[0][0].captions.fontsize).toBe(60)
    expect(onCaptionEdit).not.toHaveBeenCalled()

    fireEvent.blur(field)
    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0].captions.fontsize).toBe(60)
    // The commit did not also fire another live preview.
    expect(onProjectChange).toHaveBeenCalledTimes(1)
  })

  // NumberField never clamps a TYPED value against its own min/max (those are
  // a native spinner hint only) — the call site is what enforces the ceiling,
  // via `clampToRange`. 400 is CAPTION_FONT_SIZE_MAX, the widened ceiling this
  // feature's changelog entry advertises; this is the only test proving the
  // call-site clamp actually catches a value typed past it.
  it('fontsize typed past the ceiling clamps to 400 on commit', () => {
    const { onCaptionEdit } = renderPanel()
    expandFormat()
    // Two controls now share this name (the shared Slider + the NumberField box);
    // target the box (spinbutton) — this test types/commits an exact value.
    const field = screen.getByRole('spinbutton', { name: 'Caption font size' })

    fireEvent.change(field, { target: { value: '500' } })
    fireEvent.blur(field)

    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0].captions.fontsize).toBe(400)
  })

  it('base text color previews live via onProjectChange and commits via onCaptionEdit when no segment is selected', () => {
    const { onProjectChange, onCaptionEdit } = renderPanel()
    expandFormat()
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
    expandFormat()
    expect((screen.getByLabelText('Selected segment text color') as HTMLInputElement).value).toBe('#00ff00')
  })

  it('when a segment is selected, the base swatch previews via onProjectChange (segment-scoped) and commits via onCaptionSegmentChange — never onCaptionEdit', () => {
    const { onProjectChange, onCaptionEdit, onCaptionSegmentChange } = renderPanel({
      selectedIds: ['cap-1'],
      extra: { color: '#ffffff' },
    })
    expandFormat()
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
      expandFormat()
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
    expandFormat()
    expect(screen.getByLabelText('Caption text color')).toBeTruthy()
    expect(screen.queryByLabelText(/(accent|highlight|active|box) color/i)).toBeNull()
  })
})

describe('CaptionListPanel toolbar actions', () => {
  it('Regenerate fires onRegenerateCaptions and is hidden when the prop is absent', () => {
    const { onRegenerateCaptions } = renderPanel({ withRegenerate: true })
    fireEvent.click(screen.getByText('Regenerate captions'))
    expect(onRegenerateCaptions).toHaveBeenCalledTimes(1)
    cleanup()

    renderPanel({ withRegenerate: false })
    expect(screen.queryByText('Regenerate captions')).toBeNull()
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

// SP5-captions Phase 5: multi-lane captions (`CaptionSegment.lane`, grouped
// via captionLanes.ts's `groupCaptionLanes`) get their own row headers,
// per-lane numbering, and a row-filter chip strip. THREE_SEGS (used by every
// test above) has no `lane` field on any segment, so it is — and stays — the
// single-lane case: every project ever saved before this phase looks exactly
// like it.
describe('CaptionListPanel lanes (Phase 5)', () => {
  it('single lane: no row headers, no row-filter chips, and the list has ONLY listitem children — the Fragment wrapper adds no DOM node', () => {
    renderPanel() // THREE_SEGS: no `lane` field on any segment ⇒ one group
    expect(screen.queryByRole('group', { name: 'Filter captions by row' })).toBeNull()
    expect(screen.queryByText(/^Row \d+$/)).toBeNull()

    const list = screen.getByRole('list', { name: 'Caption segments' })
    const children = Array.from(list.children)
    expect(children).toHaveLength(3)
    children.forEach(child => expect(child.getAttribute('role')).toBe('listitem'))
  })

  it('a multi-lane project shows a sticky "Row N" header per lane, Row 1 (lane 0, nearest the video) first, each restarting its own 1-based numbering', () => {
    renderPanel({ segments: TWO_LANE_SEGS })

    // Distinguish the sticky LIST headers from the chip-strip BUTTONS that
    // happen to carry the same "Row N" text.
    const row1Header = screen.getAllByText('Row 1').find(el => el.tagName !== 'BUTTON')
    const row2Header = screen.getAllByText('Row 2').find(el => el.tagName !== 'BUTTON')
    expect(row1Header).toBeTruthy()
    expect(row2Header).toBeTruthy()
    // Row 1 (lane 0) lists FIRST, ahead of Row 2 (lane 1), in document order.
    expect(row1Header!.compareDocumentPosition(row2Header!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    // Row 1's two captions are numbered 1, 2 — their position within lane 0.
    // Row 2's RESTART at 1, 2 too — their position within lane 1 — not 3, 4,
    // which a single counter running across every lane would have produced.
    expect(within(rows[0]).getByText('1')).toBeTruthy() // r1-a
    expect(within(rows[1]).getByText('2')).toBeTruthy() // r1-b
    expect(within(rows[2]).getByText('1')).toBeTruthy() // r2-a
    expect(within(rows[3]).getByText('2')).toBeTruthy() // r2-b
    expect(rows[0]).toHaveTextContent('lower caption alpha')
    expect(rows[3]).toHaveTextContent('upper caption beta')
  })

  it('shows an All / Row 1 / Row 2 chip strip only once there is more than one lane, "All" active by default', () => {
    renderPanel({ segments: TWO_LANE_SEGS })
    const group = screen.getByRole('group', { name: 'Filter captions by row' })
    const chips = within(group).getAllByRole('button')
    expect(chips.map(c => c.textContent)).toEqual(['All', 'Row 1', 'Row 2'])
    expect(within(group).getByText('All')).toHaveAttribute('aria-pressed', 'true')
    expect(within(group).getByText('Row 1')).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking a "Row N" chip filters the list down to just that lane, and "All" restores it', () => {
    renderPanel({ segments: TWO_LANE_SEGS })

    fireEvent.click(screen.getByRole('button', { name: 'Row 2' }))
    expect(screen.getByRole('button', { name: 'Row 2' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('lower caption alpha')).toBeNull()
    expect(screen.queryByText('lower caption beta')).toBeNull()
    expect(screen.getByText('upper caption alpha')).toBeTruthy()
    expect(screen.getByText('upper caption beta')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
  })

  it('the row chip and search compose — both narrow the same list, neither disables the other', () => {
    renderPanel({ segments: TWO_LANE_SEGS })

    fireEvent.click(screen.getByRole('button', { name: 'Row 1' }))
    fireEvent.change(screen.getByLabelText('Search captions'), { target: { value: 'beta' } })

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('lower caption beta')).toBeTruthy()
    // Its per-lane index badge is unaffected by its lane-mate (r1-a) being
    // filtered out by search — still "2", its true position within lane 0.
    expect(within(rows[0]).getByText('2')).toBeTruthy()
  })

  it('text edit, delete, and row-click-to-select still commit through the existing channels for a row-2 (lane 1) caption', () => {
    const { onCaptionSegmentChange, onCaptionSegmentDelete, onSelectCaption, clock } = renderPanel({ segments: TWO_LANE_SEGS })

    // rows[2] is r2-a: Row 2's first caption (Row 1's two captions list first).
    const row2A = screen.getAllByRole('listitem')[2]

    fireEvent.click(within(row2A).getByText('upper caption alpha'))
    expect(onSelectCaption).toHaveBeenCalledWith('r2-a')
    expect(clock.set).toHaveBeenCalledWith(0 + 0.5 / 30)

    const span = within(row2A).getByText('upper caption alpha')
    span.textContent = 'upper caption ALPHA'
    fireEvent.blur(span)
    expect(onCaptionSegmentChange).toHaveBeenCalledWith('r2-a', { text: 'upper caption ALPHA' })

    fireEvent.click(within(row2A).getByLabelText('Delete caption'))
    expect(onCaptionSegmentDelete).toHaveBeenCalledTimes(1)
    expect(onCaptionSegmentDelete).toHaveBeenCalledWith('r2-a')
  })

  it('double-clicking a row-2 caption on the canvas clears an active "Row 1" chip filter, then scrolls to and focuses it', () => {
    const {
      rerender, project, clock, onSelectCaption, onCaptionSegmentChange, onCaptionEdit,
      onProjectChange, onCaptionSegmentDelete, onRegenerateCaptions,
    } = renderPanel({ segments: TWO_LANE_SEGS })

    // Activate "Row 1" — Row 2's captions, including the canvas double-click
    // target below, drop out of the DOM entirely.
    fireEvent.click(screen.getByRole('button', { name: 'Row 1' }))
    expect(screen.queryByText('upper caption alpha')).toBeNull()

    rerender(
      <CaptionListPanel
        captionTrack={project.captions}
        project={project}
        currentTime={0}
        selectedIds={[]}
        onSelectCaption={onSelectCaption}
        onCaptionSegmentChange={onCaptionSegmentChange}
        onCaptionEdit={onCaptionEdit}
        onProjectChange={onProjectChange}
        onCaptionSegmentDelete={onCaptionSegmentDelete}
        onRegenerateCaptions={onRegenerateCaptions}
        fps={30}
        clock={clock}
        editFocusId={{ id: 'r2-a', nonce: 1 }}
      />,
    )

    // The chip filter fell back to "All" (the same guard the search query
    // already carries, extended to the row chip)...
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Row 1' })).toHaveAttribute('aria-pressed', 'false')
    // ...and the target row is now visible, scrolled into view, and focused.
    const editable = screen.getByText('upper caption alpha')
    expect(document.activeElement).toBe(editable)
  })

  // The chip-filter test above is a 2-pass convergence (one guard clears, the
  // effect re-runs, the target is found). The pre-existing SEARCH guard this
  // one composes with had no direct test of its own anywhere in this file —
  // both editFocusId tests predating Phase 5 leave `search` empty throughout.
  // Pin it now that a second guard's correctness depends on it actually
  // clearing and re-running rather than swallowing the request.
  it('editFocusId cleared by SEARCH ALONE (single lane): the effect clears the query, then converges on the target', () => {
    const {
      rerender, project, clock, onSelectCaption, onCaptionSegmentChange, onCaptionEdit,
      onProjectChange, onCaptionSegmentDelete, onRegenerateCaptions,
    } = renderPanel({ segments: THREE_SEGS })

    // "hello" filters the list down to cap-0 only — cap-1, the canvas
    // double-click target below, drops out of the DOM.
    fireEvent.change(screen.getByLabelText('Search captions'), { target: { value: 'hello' } })
    expect(screen.queryByText('goodbye now')).toBeNull()

    rerender(
      <CaptionListPanel
        captionTrack={project.captions}
        project={project}
        currentTime={0}
        selectedIds={[]}
        onSelectCaption={onSelectCaption}
        onCaptionSegmentChange={onCaptionSegmentChange}
        onCaptionEdit={onCaptionEdit}
        onProjectChange={onProjectChange}
        onCaptionSegmentDelete={onCaptionSegmentDelete}
        onRegenerateCaptions={onRegenerateCaptions}
        fps={30}
        clock={clock}
        editFocusId={{ id: 'cap-1', nonce: 1 }}
      />,
    )

    // The query cleared (the pre-existing guard, still doing its job)...
    expect(screen.getByLabelText('Search captions')).toHaveValue('')
    // ...and the target row is now visible, scrolled into view, and focused.
    const editable = screen.getByText('goodbye now')
    expect(document.activeElement).toBe(editable)
  })

  // The true 3-pass sequence: BOTH guards block the target on the first
  // effect run, so it must clear one, re-run (still blocked), clear the
  // other, re-run again, and only THEN reach the scroll+focus call. This is
  // the case the multi-pass "one setState per invocation" design exists for
  // — a version of the effect that resolved only one guard per nonce (or
  // wrote `lastHandledNonceRef` too early) would stall here even though the
  // chip-only and search-only cases above both still pass.
  it('editFocusId blocked by BOTH search and the row chip: the effect clears each in turn and converges', () => {
    const {
      rerender, project, clock, onSelectCaption, onCaptionSegmentChange, onCaptionEdit,
      onProjectChange, onCaptionSegmentDelete, onRegenerateCaptions,
    } = renderPanel({ segments: TWO_LANE_SEGS })

    // "Row 1" hides every Row 2 caption, including the target (r2-a). "beta"
    // additionally excludes r2-a's own text ("upper caption alpha") from a
    // search match, so if the chip were somehow not blocking it, the search
    // guard would catch it anyway — both guards are independently active
    // against this exact target, not just one of them incidentally.
    fireEvent.click(screen.getByRole('button', { name: 'Row 1' }))
    fireEvent.change(screen.getByLabelText('Search captions'), { target: { value: 'beta' } })
    expect(screen.queryByText('upper caption alpha')).toBeNull()
    // Only r1-b ("lower caption beta") survives both filters.
    expect(screen.getAllByRole('listitem')).toHaveLength(1)

    rerender(
      <CaptionListPanel
        captionTrack={project.captions}
        project={project}
        currentTime={0}
        selectedIds={[]}
        onSelectCaption={onSelectCaption}
        onCaptionSegmentChange={onCaptionSegmentChange}
        onCaptionEdit={onCaptionEdit}
        onProjectChange={onProjectChange}
        onCaptionSegmentDelete={onCaptionSegmentDelete}
        onRegenerateCaptions={onRegenerateCaptions}
        fps={30}
        clock={clock}
        editFocusId={{ id: 'r2-a', nonce: 1 }}
      />,
    )

    // Both guards fired and converged: query cleared, chip back to "All",
    // target visible, scrolled into view, and focused.
    expect(screen.getByLabelText('Search captions')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Row 1' })).toHaveAttribute('aria-pressed', 'false')
    const editable = screen.getByText('upper caption alpha')
    expect(document.activeElement).toBe(editable)
  })
})

// The panel splits into three sub-tabs once captions exist: "Format" (the
// default — the fine look-and-feel controls: size, colors, font, case,
// alignment, spacing), "Styles" (a gallery of live style previews, see
// CaptionStyleGallery.tsx) and "Captions" (the transcript, search, and
// actions). These tests clear the 'captions' seed the suites above set, so
// they see the REAL default. See CaptionListPanel.tsx's CAPTION_TABS and
// reviveCaptionTab.
describe('CaptionListPanel tabs', () => {
  it('defaults to the Format tab; the transcript, search, and footer live under the Captions tab', () => {
    window.localStorage.clear() // no seed → the real default ('format')
    renderPanel()

    // Format tab is active: the fine controls are visible, the style gallery
    // and the transcript are not.
    expect(screen.getByRole('spinbutton', { name: 'Caption font size' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Caption style' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Subtitle' })).toBeNull()
    expect(screen.queryByRole('listitem')).toBeNull()
    expect(screen.queryByLabelText('Search captions')).toBeNull()
    expect(screen.queryByText('Regenerate captions')).toBeNull()
    expect(screen.getByRole('button', { name: 'Format' })).toHaveAttribute('aria-pressed', 'true')

    // Switching to Captions reveals the list, search, and the footer actions.
    fireEvent.click(screen.getByRole('button', { name: 'Captions' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByLabelText('Search captions')).toBeTruthy()
    expect(screen.getByText('Regenerate captions')).toBeTruthy()
    // The format controls are gone now.
    expect(screen.queryByRole('spinbutton', { name: 'Caption font size' })).toBeNull()
  })

  it('shows all three tabs, in order Format, Styles, Captions', () => {
    window.localStorage.clear()
    renderPanel()
    const tabGroup = screen.getByRole('group', { name: 'Caption panel view' })
    const tabs = within(tabGroup).getAllByRole('button')
    expect(tabs.map(t => t.textContent)).toEqual(['Format', 'Styles', 'Captions'])
  })

  // 'format' is BOTH the migration target for a stale pre-split 'style'
  // value AND usePersistentState's fallback `initial` for an unrecognised
  // one (see usePersistentState.ts: revive() -> null falls back to
  // `initial`). So a DOM render can't tell "migrated" from "rejected and
  // defaulted" — both land on the exact same Format tab. This test only
  // proves a stale value never crashes and renders Format either way; it is
  // NOT proof the migration line exists. The real migration coverage is the
  // direct reviveCaptionTab() unit test in the 'reviveCaptionTab' describe
  // below.
  it('a stale persisted "style" value (pre-split) renders the Format tab without crashing', () => {
    window.localStorage.setItem('montaj.editor.captionPanelTab', JSON.stringify('style'))
    renderPanel()

    expect(screen.getByRole('button', { name: 'Format' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('spinbutton', { name: 'Caption font size' })).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('the chosen tab persists across remounts (localStorage-backed)', () => {
    window.localStorage.clear()
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Captions' }))
    cleanup()

    renderPanel()
    expect(screen.getByRole('button', { name: 'Captions' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('shows a loading placeholder (not the Generate button) in the empty state while captions are generating', () => {
    const project = { id: 'p1' } as unknown as Project
    render(
      <CaptionListPanel
        captionTrack={undefined}
        project={project}
        currentTime={0}
        selectedIds={[]}
        onSelectCaption={vi.fn()}
        onRegenerateCaptions={vi.fn()}
        captionsGenerating
        fps={30}
        clock={makeClock()}
      />,
    )
    expect(screen.getByText(/Generating captions/i)).toBeTruthy()
    expect(screen.getByText(/Transcribing the timeline's audio/i)).toBeTruthy()
    // While a job is running the idle prompt and its Generate trigger are gone.
    expect(screen.queryByRole('button', { name: 'Generate captions' })).toBeNull()
    expect(screen.queryByText(/generated from the timeline/i)).toBeNull()
  })

  it('a canvas edit-focus request flips from the Format tab to the Captions tab and focuses the target row', () => {
    window.localStorage.clear() // real default = Format, where the row is NOT rendered
    const project = makeProject('karaoke', THREE_SEGS)
    const clock = makeClock()
    const commonProps = {
      captionTrack: project.captions,
      project,
      currentTime: 0,
      selectedIds: [] as string[],
      onSelectCaption: vi.fn(),
      onCaptionSegmentChange: vi.fn(),
      fps: 30,
      clock,
    }

    const { rerender } = render(<CaptionListPanel {...commonProps} editFocusId={null} />)
    // On the Format tab the transcript rows are not mounted at all.
    expect(screen.queryByText('goodbye now')).toBeNull()

    rerender(<CaptionListPanel {...commonProps} editFocusId={{ id: 'cap-1', nonce: 1 }} />)
    // The effect flipped to the Captions tab so the row exists, then focused it.
    expect(screen.getByRole('button', { name: 'Captions' })).toHaveAttribute('aria-pressed', 'true')
    const editable = screen.getByText('goodbye now')
    expect(document.activeElement).toBe(editable)
  })
})

// Direct unit tests for reviveCaptionTab, exercised in isolation rather than
// through a DOM render. This matters specifically for the 'style' -> 'format'
// migration: 'format' is ALSO usePersistentState's `initial` fallback for a
// value revive() rejects (see usePersistentState.ts), so a rendered panel
// looks identical whether 'style' was migrated or simply rejected and
// defaulted. Only calling reviveCaptionTab() directly and checking its
// return value can tell those two cases apart — that's what proves the
// migration line in CaptionListPanel.tsx is actually there.
describe('reviveCaptionTab', () => {
  it('migrates the pre-split "style" value to "format"', () => {
    expect(reviveCaptionTab('style')).toBe('format')
  })

  it('passes "styles" through unchanged (not double-migrated)', () => {
    expect(reviveCaptionTab('styles')).toBe('styles')
  })

  it('passes the other current tab values through unchanged', () => {
    expect(reviveCaptionTab('format')).toBe('format')
    expect(reviveCaptionTab('captions')).toBe('captions')
  })

  it('rejects unrecognised values to null (caller falls back to the default)', () => {
    expect(reviveCaptionTab('bogus')).toBeNull()
    expect(reviveCaptionTab(null)).toBeNull()
    expect(reviveCaptionTab(42)).toBeNull()
  })
})
