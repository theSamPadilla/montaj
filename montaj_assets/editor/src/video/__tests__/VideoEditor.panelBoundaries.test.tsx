import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { EditorAdapter, Project, RenderEvent, VersionEntry, WaveformChunk, ImageElement } from '../../types'

// Panel boundaries (§351): one panel that throws is replaced by a short error
// and Retry in its own area, the other panels keep rendering, and Retry mounts
// the panel again. The preview and the timeline are stubbed so each can be made
// to throw; the side panel and the inspector throw from the host slots that fill
// them (mediaPanel, propertiesEmptyState).

const boom = vi.hoisted(() => ({ on: '' as '' | 'preview' | 'timeline' | 'side' | 'inspector' }))

vi.mock('../preview/PreviewPlayer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../preview/PreviewPlayer')>()
  return { ...actual, default: () => { if (boom.on === 'preview') throw new Error('preview exploded'); return <div data-testid="preview-ok" /> } }
})
vi.mock('../timeline/Timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../timeline/Timeline')>()
  return { ...actual, default: () => { if (boom.on === 'timeline') throw new Error('timeline exploded'); return <div data-testid="timeline-ok" /> } }
})

import VideoEditor from '../VideoEditor'

function Side() { if (boom.on === 'side') throw new Error('side exploded'); return <div data-testid="side-ok" /> }
function Inspector() { if (boom.on === 'inspector') throw new Error('inspector exploded'); return <div data-testid="inspector-ok" /> }

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
  boom.on = ''
  window.localStorage.clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement.prototype.play = vi.fn(async () => {}) as never
  ;(globalThis as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement.prototype.pause = vi.fn(() => {}) as never
})
afterEach(() => vi.restoreAllMocks())

const OK = ['preview-ok', 'timeline-ok', 'side-ok', 'inspector-ok'] as const
const NAME = { preview: 'Preview', timeline: 'Timeline', side: 'Side panel', inspector: 'Inspector' } as const
const OWN = { preview: 'preview-ok', timeline: 'timeline-ok', side: 'side-ok', inspector: 'inspector-ok' } as const

function mount() {
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const utils = render(
    <VideoEditor
      project={makeVideoProject()}
      adapter={makeFakeAdapter()}
      onProjectChange={vi.fn()}
      slots={{ mediaPanel: <Side />, propertiesEmptyState: <Inspector /> }}
    />,
  )
  return { ...utils, errSpy }
}

describe('VideoEditor panel boundaries (§351)', () => {
  for (const which of ['preview', 'timeline', 'side', 'inspector'] as const) {
    it(`a throwing ${which} shows its own error, leaves the other panels up, and Retry remounts it`, async () => {
      boom.on = which
      const { errSpy } = mount()
      const alert = await screen.findByTestId('panel-error')
      expect(alert).toHaveTextContent(`${NAME[which]} hit an error.`)
      expect(screen.getAllByTestId('panel-error')).toHaveLength(1)
      // The rest of the editor is still there.
      for (const id of OK.filter((x) => x !== OWN[which])) expect(await screen.findByTestId(id)).toBeInTheDocument()
      expect(screen.queryByTestId(OWN[which])).toBeNull()
      // Logged for the app's log.
      expect(errSpy.mock.calls.some((c) => String(c[0]).startsWith(`[editor panel crash] ${NAME[which]}: ${which} exploded`))).toBe(true)

      boom.on = ''
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await waitFor(() => expect(screen.queryByTestId('panel-error')).toBeNull())
      expect(await screen.findByTestId(OWN[which])).toBeInTheDocument()
    })
  }

  it('the classic layout (no media panel) is wrapped too: a throwing timeline leaves the preview up', async () => {
    boom.on = 'timeline'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<VideoEditor project={makeVideoProject()} adapter={makeFakeAdapter()} onProjectChange={vi.fn()} />)
    expect(await screen.findByTestId('panel-error')).toHaveTextContent('Timeline hit an error.')
    expect(await screen.findByTestId('preview-ok')).toBeInTheDocument()
    boom.on = ''
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('timeline-ok')).toBeInTheDocument()
  })
})
