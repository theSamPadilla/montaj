import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type { EditorAdapter, Project, RenderEvent, VersionEntry, WaveformChunk } from '../../types'
import type { ImageElement } from '../../types'
import VideoEditor from '../VideoEditor'

// ── Layout gating: classic vs. CapCut media-panel branch ─────────────────────
// ReviewSurface renders the classic layout (preview above a timeline pane, plus
// the version rail) UNLESS the host supplies `slots.mediaPanel`, which switches
// it to the CapCut layout: [media | preview | rail] across the top with a
// full-width timeline strip below. These tests assert the gate both directions —
// the media panel appears/disappears, and (in CapCut) the timeline strip is a
// sibling below the top row rather than nested inside the preview column.

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

describe('VideoEditor — layout gating (classic vs. CapCut media panel)', () => {
  it('renders the CapCut layout when slots.mediaPanel is provided', async () => {
    const adapter = makeFakeAdapter()
    const { getByTestId, getByLabelText } = render(
      <VideoEditor
        project={makeVideoProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ mediaPanel: <div data-testid="media-panel">Footage bin</div> }}
      />,
    )

    // The host's media panel is rendered (its content is present).
    const media = await waitFor(() => getByTestId('media-panel'))
    // The CapCut-only media-column resize divider exists.
    expect(getByLabelText('Resize media panel')).toBeTruthy()

    // Structural: the timeline strip (its Controls button lives in the timeline
    // pane) is a SIBLING below the top row, not nested inside it or the preview.
    const controls = getByLabelText('Editor controls & shortcuts')
    expect(media.contains(controls)).toBe(false)
    expect(controls.contains(media)).toBe(false)
    // Top row (media | preview | rail) comes before the timeline strip in the DOM.
    expect(
      media.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('renders the classic layout (no media panel) when slots.mediaPanel is absent', async () => {
    const adapter = makeFakeAdapter()
    const { queryByTestId, queryByLabelText, getByLabelText } = render(
      <VideoEditor
        project={makeVideoProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
      />,
    )

    // The classic timeline pane still renders (its Controls button is present)…
    await waitFor(() => getByLabelText('Editor controls & shortcuts'))
    // …and the CapCut media panel is entirely inert: no media-panel content and
    // no media-column resize divider.
    expect(queryByTestId('media-panel')).toBeNull()
    expect(queryByLabelText('Resize media panel')).toBeNull()
  })
})
