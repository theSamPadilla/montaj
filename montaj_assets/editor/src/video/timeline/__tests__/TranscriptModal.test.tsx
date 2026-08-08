import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { Project } from '../../../types'
import type { CaptionSegment } from '../../../schema'
import TranscriptModal from '../TranscriptModal'

afterEach(() => cleanup())

function makeProject(segments: CaptionSegment[]): Project {
  return { id: 'p1', captions: { style: 'word-by-word', segments } } as unknown as Project
}

describe('TranscriptModal caption text edits', () => {
  // Regression: makeCaptionEdit fires every callback it's given with the same
  // updated project. TranscriptModal used to pass BOTH onProjectChange and
  // onCaptionEdit into makeCaptionEdit for a text edit, and — at this
  // component's real call site (VideoEditor's ReviewSurface, via Timeline) —
  // both land on sync.mutate, so one text edit produced two undo entries and
  // two queued saves. Only onCaptionEdit (the commit channel) should fire;
  // onProjectChange is no longer even an accepted prop (see TranscriptModal.tsx).
  it('a completed text edit produces exactly one commit, not two', () => {
    const onCaptionEdit = vi.fn()
    const project = makeProject([{ id: 'cap-0', text: 'hello world', start: 0, end: 2 }])
    render(
      <TranscriptModal
        captionTrack={project.captions}
        currentTime={0}
        project={project}
        onCaptionEdit={onCaptionEdit}
        onClose={() => {}}
      />,
    )

    const span = screen.getByText('hello world')
    span.textContent = 'hello there'
    fireEvent.blur(span)

    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0].captions.segments[0].text).toBe('hello there')
  })
})
