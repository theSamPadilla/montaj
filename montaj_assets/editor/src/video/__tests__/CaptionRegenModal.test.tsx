import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import type { CaptionEvent, EditorAdapter, ImageElement, Project } from '../../types'
import type { Captions } from '../../schema'
import CaptionRegenModal from '../CaptionRegenModal'

afterEach(() => cleanup())

const doneCaptions: Captions = {
  style: 'pop',
  segments: [{ text: 'hola', start: 0, end: 1, words: [] }],
}

function makeAdapter(): EditorAdapter<Project> {
  return {
    loadProject: vi.fn(),
    saveProject: vi.fn(),
    subscribe: () => () => {},
    render: async function* () {},
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => ''),
    fileUrl: (p: string) => p,
    generateCaptions: async function* (): AsyncIterable<CaptionEvent> {
      yield { type: 'log', message: 'transcribing audio…' }
      yield { type: 'done', captions: doneCaptions }
    },
  } as unknown as EditorAdapter<Project>
}

describe('CaptionRegenModal', () => {
  it('streams a log line and calls onDone with the final captions', async () => {
    const onDone = vi.fn()
    const onClose = vi.fn()
    render(
      <CaptionRegenModal
        adapter={makeAdapter()}
        projectId="vid-1"
        onDone={onDone}
        onClose={onClose}
      />,
    )

    await waitFor(() => expect(screen.getByText(/transcribing audio/i)).toBeTruthy())
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(doneCaptions))
  })

  it('shows an error message verbatim on error', async () => {
    const errorAdapter = makeAdapter()
    errorAdapter.generateCaptions = async function* (): AsyncIterable<CaptionEvent> {
      yield { type: 'error', message: 'multi_source' }
    }
    render(
      <CaptionRegenModal
        adapter={errorAdapter}
        projectId="vid-1"
        onDone={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText('multi_source')).toBeTruthy())
  })
})
