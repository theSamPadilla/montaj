import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { Project } from '../../../types'
import type { Captions } from '../../../schema'
import TranscriptPanel from '../TranscriptPanel'

afterEach(() => cleanup())

function makeProject(style: Captions['style'], extra: Partial<Captions> = {}): Project {
  return { id: 'p1', captions: { style, segments: [], ...extra } } as unknown as Project
}

function renderPanel(style: Captions['style'], extra: Partial<Captions> = {}) {
  const onCaptionEdit = vi.fn()
  const onProjectChange = vi.fn()
  const project = makeProject(style, extra)
  render(
    <TranscriptPanel
      project={project}
      captionTrack={project.captions}
      currentTime={0}
      onCaptionEdit={onCaptionEdit}
      onProjectChange={onProjectChange}
      onExpand={() => {}}
    />,
  )
  return { onCaptionEdit, onProjectChange }
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
