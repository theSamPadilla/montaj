import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type {
  EditorAdapter,
  ImageElement,
  Project,
  RenderEvent,
  VersionEntry,
  WaveformChunk,
} from '../../types'
import VideoEditor from '../VideoEditor'

// ── Fake adapter ──────────────────────────────────────────────────────────────
// Full EditorAdapter with the video-editor capabilities VideoEditor threads:
// listVersionHistory / restoreVersion / getWaveformChunks / compileOverlay /
// fileUrl / resolveCaptionTemplate. No host (`@/`) modules are mocked — the
// package owns the assembled editor.

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
        {
          id: 'clip-0',
          type: 'video',
          src: 'a.mp4',
          start: 0,
          end: 4,
          inPoint: 0,
          outPoint: 4,
        },
      ],
    ],
    audio: { tracks: [] },
    assets: [],
    ...overrides,
  } as Project
}

interface FakeAdapter extends EditorAdapter<Project> {
  saveCalls: Array<{ id: string; project: Project }>
}

function makeFakeAdapter(): FakeAdapter {
  const saveCalls: Array<{ id: string; project: Project }> = []
  return {
    loadProject: vi.fn(async () => makeVideoProject()),
    saveProject: vi.fn(async (id: string, project: Project) => { saveCalls.push({ id, project }) }),
    subscribe: () => () => {},
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
    restoreVersion: vi.fn(async (_id: string, _hash: string) => makeVideoProject()),
    getWaveformChunks: vi.fn(async (): Promise<WaveformChunk[]> => []),
    resolveCaptionTemplate: (style: string) => `/caption/${style}`,
    saveCalls,
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // jsdom doesn't implement media element playback.
  ;(globalThis as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement.prototype.play = vi.fn(async () => {}) as never
  ;(globalThis as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement.prototype.pause = vi.fn(() => {}) as never
  // jsdom has no Web Audio API; the video player wires per-clip gain through it.
  ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
    state = 'running'
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createMediaElementSource() { return { connect() {}, disconnect() {} } }
    get destination() { return {} }
    close() {}
  }
})
afterEach(() => vi.restoreAllMocks())

describe('VideoEditor — editor-package integration', () => {
  it('renders the timeline and preview for a draft project', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeVideoProject()
    const { container } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ pendingStatus: <div data-testid="pending" />, exportActions: <div data-testid="export" /> }}
      />,
    )

    // Timeline: the zoom control reads "1×" once totalDuration > 0.
    await waitFor(() => {
      expect(container.textContent).toContain('×')
    })
    // Preview: the video player mounts <video> elements for the clips.
    await waitFor(() => {
      expect(container.querySelector('video')).not.toBeNull()
    })
  })

  it('shows the host pendingStatus slot for a pending project', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeVideoProject({ status: 'pending', tracks: [[]] })
    const { getByTestId } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ pendingStatus: <div data-testid="pending" />, exportActions: <div data-testid="export" /> }}
      />,
    )
    await waitFor(() => getByTestId('pending'))
  })

  it('queries version history via adapter.listVersionHistory', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeVideoProject()
    render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ pendingStatus: <div data-testid="pending" />, exportActions: <div data-testid="export" /> }}
      />,
    )
    await waitFor(() => {
      expect(adapter.listVersionHistory).toHaveBeenCalledWith('vid-1')
    })
  })

  it('invokes onBackToSetup affordance only when the host supplies it', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeVideoProject({ status: 'pending', tracks: [[]] })
    const onBackToSetup = vi.fn()
    const { findByText } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        onBackToSetup={onBackToSetup}
      />,
    )
    const back = await findByText(/Back to setup/i)
    back.click()
    expect(onBackToSetup).toHaveBeenCalledTimes(1)
  })
})
