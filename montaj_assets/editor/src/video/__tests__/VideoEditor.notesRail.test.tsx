import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent, VersionEntry, WaveformChunk } from '../../types'
import VideoEditor from '../VideoEditor'

// A host notes panel is its own Notes page in the left rail (CapCut layout):
// Media, Captions, Notes, Versions. N opens it.

function makeVideoProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'vid-1',
    name: 'Test Video',
    status: 'draft',
    editingPrompt: '',
    projectType: 'video',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [
      [
        { id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4 },
      ],
    ],
    audio: { tracks: [] },
    assets: [],
    ...overrides,
  } as Project
}

function makeFakeAdapter(): EditorAdapter<Project> {
  let subscribers: Array<(project: Project) => void> = []
  return {
    loadProject: vi.fn(async () => makeVideoProject()),
    saveProject: vi.fn(async () => {}),
    subscribe: (_id: string, onFrame: (project: Project) => void) => {
      subscribers.push(onFrame)
      return () => { subscribers = subscribers.filter((s) => s !== onFrame) }
    },
    render: async function* (): AsyncIterable<RenderEvent> {
      yield { type: 'done', outputPath: '/out.mp4' }
    },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (path: string) => path,
    listVersionHistory: vi.fn(async (): Promise<VersionEntry[]> => []),
    restoreVersion: vi.fn(async () => makeVideoProject()),
    getWaveformChunks: vi.fn(async (): Promise<WaveformChunk[]> => []),
    resolveCaptionTemplate: (style: string) => `/caption/${style}`,
    getInfo: vi.fn(async () => ({ root_skill_path: undefined })),
  } as unknown as EditorAdapter<Project>
}

beforeEach(() => {
  // The caption panel now splits into Style / Captions sub-tabs and defaults
  // to Style; these tests select captions from the transcript list, so pin the
  // sub-tab to 'captions' (usePersistentState reads this at mount).
  window.localStorage.setItem('montaj.editor.captionPanelTab', JSON.stringify('captions'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement.prototype.play = vi.fn(async () => {}) as never
  ;(globalThis as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement.prototype.pause = vi.fn(() => {}) as never
  ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
    state = 'running'
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createMediaElementSource() { return { connect() {}, disconnect() {} } }
    get destination() { return {} }
    close() {}
  }
})
afterEach(() => vi.restoreAllMocks())

beforeEach(() => {
  // The caption panel now splits into Style / Captions sub-tabs and defaults
  // to Style; these tests select captions from the transcript list, so pin the
  // sub-tab to 'captions' (usePersistentState reads this at mount).
  window.localStorage.setItem('montaj.editor.captionPanelTab', JSON.stringify('captions'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement.prototype.play = vi.fn(async () => {}) as never
  ;(globalThis as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement.prototype.pause = vi.fn(() => {}) as never
  ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
    state = 'running'
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createMediaElementSource() { return { connect() {}, disconnect() {} } }
    get destination() { return {} }
    close() {}
  }
})
afterEach(() => vi.restoreAllMocks())


const pressN = () =>
  act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', cancelable: true })) })

describe('VideoEditor — Notes page in the left rail', () => {
  it('lists Media, Captions, Notes, Versions in that order when slots.notesPanel is given', async () => {
    render(
      <VideoEditor
        project={makeVideoProject({ captions: { style: 'pop', segments: [{ id: 'cap-0', text: 'one', start: 0, end: 1 }] } } as Partial<Project>)}
        adapter={makeFakeAdapter()}
        onProjectChange={vi.fn()}
        slots={{ mediaPanel: <div>bin</div>, notesPanel: <div data-testid="notes-list">notes</div> }}
      />,
    )
    await waitFor(() => screen.getByRole('tab', { name: 'Notes' }))
    const names = screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label') ?? t.textContent)
    expect(names.filter((n) => ['Media', 'Captions', 'Notes', 'Versions'].includes(n ?? ''))).toEqual(['Media', 'Captions', 'Notes', 'Versions'])
  })

  it('shows no Notes tab without slots.notesPanel', async () => {
    render(
      <VideoEditor project={makeVideoProject()} adapter={makeFakeAdapter()} onProjectChange={vi.fn()} slots={{ mediaPanel: <div>bin</div> }} />,
    )
    await waitFor(() => screen.getByRole('tab', { name: 'Media' }))
    expect(screen.queryByRole('tab', { name: 'Notes' })).toBeNull()
  })

  it('N opens the Notes page when slots.notesPanel is present', async () => {
    render(
      <VideoEditor
        project={makeVideoProject()}
        adapter={makeFakeAdapter()}
        onProjectChange={vi.fn()}
        slots={{ mediaPanel: <div data-testid="media-bin">bin</div>, notesPanel: <div data-testid="notes-list">notes</div> }}
        notes={{ enabled: true }}
      />,
    )
    await screen.findByLabelText('Preview axis')
    expect(screen.queryByTestId('notes-list')).toBeNull()
    await pressN()
    await waitFor(() => expect(screen.getByTestId('notes-list')).toBeTruthy())
    expect(screen.getByRole('tab', { name: 'Notes' }).getAttribute('aria-selected')).toBe('true')
  })

  it('N still opens Media when the host has no notesPanel', async () => {
    render(
      <VideoEditor
        project={makeVideoProject({ captions: { style: 'pop', segments: [{ id: 'cap-0', text: 'one', start: 0, end: 1 }] } } as Partial<Project>)}
        adapter={makeFakeAdapter()}
        onProjectChange={vi.fn()}
        slots={{ mediaPanel: <div data-testid="media-bin">bin</div> }}
        notes={{ enabled: true }}
      />,
    )
    await screen.findByLabelText('Preview axis')
    fireEvent.click(screen.getByRole('tab', { name: 'Captions' }))
    await pressN()
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Media' }).getAttribute('aria-selected')).toBe('true'))
  })
})
