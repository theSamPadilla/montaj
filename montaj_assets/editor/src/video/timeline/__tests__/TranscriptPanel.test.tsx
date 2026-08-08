import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { Project } from '../../../types'
import type { Captions } from '../../../schema'
import TranscriptPanel from '../TranscriptPanel'

afterEach(() => cleanup())

function makeProject(style: Captions['style'], extra: Partial<Captions> = {}): Project {
  return { id: 'p1', captions: { style, segments: [], ...extra } } as unknown as Project
}

function renderPanel(
  style: Captions['style'],
  extra: Partial<Captions> = {},
  opts: { selectedCaptionId?: string | null } = {},
) {
  const onCaptionEdit = vi.fn()
  const onProjectChange = vi.fn()
  const onCaptionSegmentChange = vi.fn()
  const project = makeProject(style, extra)
  render(
    <TranscriptPanel
      project={project}
      captionTrack={project.captions}
      currentTime={0}
      onCaptionEdit={onCaptionEdit}
      onProjectChange={onProjectChange}
      onCaptionSegmentChange={onCaptionSegmentChange}
      selectedCaptionId={opts.selectedCaptionId ?? null}
      onExpand={() => {}}
    />,
  )
  return { onCaptionEdit, onProjectChange, onCaptionSegmentChange }
}

describe('TranscriptPanel caption color controls', () => {
  it('previews live on change and commits on blur, writing captions.color', () => {
    const { onCaptionEdit, onProjectChange } = renderPanel('karaoke')
    const input = screen.getByLabelText('Caption text color') as HTMLInputElement

    fireEvent.change(input, { target: { value: '#76b900' } })
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onProjectChange.mock.calls[0][0].captions.color).toBe('#76b900')
    expect(onCaptionEdit).not.toHaveBeenCalled() // live preview must not persist

    fireEvent.blur(input, { target: { value: '#76b900' } })
    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0].captions.color).toBe('#76b900')
  })

  it('writes the accent to the field the active style actually reads', () => {
    // karaoke → highlightColor
    let h = renderPanel('karaoke')
    fireEvent.blur(screen.getByLabelText('Caption highlight color'), { target: { value: '#111111' } })
    expect(h.onCaptionEdit.mock.calls[0][0].captions.highlightColor).toBe('#111111')
    cleanup()

    // pop → activeColor
    h = renderPanel('pop')
    fireEvent.blur(screen.getByLabelText('Caption active color'), { target: { value: '#222222' } })
    expect(h.onCaptionEdit.mock.calls[0][0].captions.activeColor).toBe('#222222')
    cleanup()

    // subtitle → backgroundColor
    h = renderPanel('subtitle')
    fireEvent.blur(screen.getByLabelText('Caption box color'), { target: { value: '#333333' } })
    expect(h.onCaptionEdit.mock.calls[0][0].captions.backgroundColor).toBe('#333333')
    cleanup()

    // highlight-box → accentColor
    h = renderPanel('highlight-box')
    fireEvent.blur(screen.getByLabelText('Caption accent color'), { target: { value: '#444444' } })
    expect(h.onCaptionEdit.mock.calls[0][0].captions.accentColor).toBe('#444444')
  })

  it('hides the accent swatch for styles with no accent', () => {
    renderPanel('clean')
    expect(screen.getByLabelText('Caption text color')).toBeTruthy()
    expect(screen.queryByLabelText(/(accent|highlight|active|box) color/i)).toBeNull()
    cleanup()

    renderPanel('word-by-word')
    expect(screen.queryByLabelText(/(accent|highlight|active|box) color/i)).toBeNull()
  })

  it('reflects the stored hex value on the swatch input', () => {
    renderPanel('karaoke', { color: '#abcdef', highlightColor: '#00ff00' })
    expect((screen.getByLabelText('Caption text color') as HTMLInputElement).value).toBe('#abcdef')
    expect((screen.getByLabelText('Caption highlight color') as HTMLInputElement).value).toBe('#00ff00')
  })
})

describe('TranscriptPanel per-segment caption color', () => {
  it('no selection: base swatch is unchanged — still previews/commits the track-level color', () => {
    const { onCaptionEdit, onProjectChange } = renderPanel('karaoke', {
      segments: [{ id: 'cap-0', text: 'hi', start: 0, end: 2 }],
    })
    const input = screen.getByLabelText('Caption text color') as HTMLInputElement

    fireEvent.change(input, { target: { value: '#76b900' } })
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    expect(onProjectChange.mock.calls[0][0].captions.color).toBe('#76b900')

    fireEvent.blur(input, { target: { value: '#76b900' } })
    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0].captions.color).toBe('#76b900')
  })

  it('a selected segment: swatch previews live via onProjectChange (only that segment patched) and commits via onCaptionSegmentChange — never onCaptionEdit', () => {
    const { onCaptionEdit, onProjectChange, onCaptionSegmentChange } = renderPanel('karaoke', {
      color: '#ffffff',
      segments: [
        { id: 'cap-0', text: 'hi', start: 0, end: 2 },
        { id: 'cap-1', text: 'there', start: 2, end: 4 },
      ],
    }, { selectedCaptionId: 'cap-1' })

    const input = screen.getByLabelText('Selected segment text color') as HTMLInputElement

    // Live preview — onChange fires on every pick.
    fireEvent.change(input, { target: { value: '#123456' } })
    expect(onProjectChange).toHaveBeenCalledTimes(1)
    const previewed = onProjectChange.mock.calls[0][0]
    expect(previewed.captions.segments[1].color).toBe('#123456')
    expect(previewed.captions.segments[0].color).toBeUndefined() // only the selected segment changes
    expect(previewed.captions.color).toBe('#ffffff')             // track-level color untouched
    expect(onCaptionSegmentChange).not.toHaveBeenCalled()
    expect(onCaptionEdit).not.toHaveBeenCalled()

    // Commit — onBlur fires once, through the segment-patch channel, not
    // the whole-track onCaptionEdit channel. One commit per gesture.
    fireEvent.blur(input, { target: { value: '#123456' } })
    expect(onCaptionSegmentChange).toHaveBeenCalledTimes(1)
    expect(onCaptionSegmentChange).toHaveBeenCalledWith('cap-1', { color: '#123456' })
    expect(onCaptionEdit).not.toHaveBeenCalled()
  })

  it("the swatch reflects the selected segment's own color when it has one", () => {
    renderPanel('karaoke', {
      color: '#abcdef',
      segments: [{ id: 'cap-0', text: 'hi', start: 0, end: 2, color: '#00ff00' }],
    }, { selectedCaptionId: 'cap-0' })
    expect((screen.getByLabelText('Selected segment text color') as HTMLInputElement).value).toBe('#00ff00')
  })

  it('the swatch falls back to the track color when the selected segment has none of its own', () => {
    renderPanel('karaoke', {
      color: '#abcdef',
      segments: [{ id: 'cap-0', text: 'hi', start: 0, end: 2 }],
    }, { selectedCaptionId: 'cap-0' })
    expect((screen.getByLabelText('Selected segment text color') as HTMLInputElement).value).toBe('#abcdef')
  })

  it('a selectedCaptionId that matches no segment falls back to track-level behavior', () => {
    renderPanel('karaoke', {
      segments: [{ id: 'cap-0', text: 'hi', start: 0, end: 2 }],
    }, { selectedCaptionId: 'cap-does-not-exist' })
    expect(screen.getByLabelText('Caption text color')).toBeTruthy()
    expect(screen.queryByLabelText('Selected segment text color')).toBeNull()
  })
})

describe('TranscriptPanel caption text edits', () => {
  // Regression: makeCaptionEdit fires every callback it's given with the same
  // updated project. TranscriptPanel used to pass BOTH onProjectChange and
  // onCaptionEdit into makeCaptionEdit for a text edit, and — at this
  // component's real call site (VideoEditor's ReviewSurface) — both land on
  // sync.mutate, so one text edit produced two undo entries and two queued
  // saves. Only onCaptionEdit (the commit channel) should fire.
  it('a completed text edit produces exactly one commit, not two', () => {
    const { onCaptionEdit, onProjectChange } = renderPanel('karaoke', {
      segments: [{ id: 'cap-0', text: 'hello world', start: 0, end: 2 }],
    })

    const span = screen.getByText('hello world')
    span.textContent = 'hello there'
    fireEvent.blur(span)

    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0].captions.segments[0].text).toBe('hello there')
    expect(onProjectChange).not.toHaveBeenCalled()
  })
})
