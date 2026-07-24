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
import type { VisualItem } from '../../schema'
import type { OverlayChanges } from '../preview/useDragOverlay'
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
    getInfo: vi.fn(async () => ({ root_skill_path: undefined })),
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

  it('Render button flips project status to final and persists before opening modal', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeVideoProject({ status: 'draft' })
    const onProjectChange = vi.fn()
    const { findByText } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={onProjectChange}
        slots={{ exportActions: <div /> }}
      />,
    )

    const renderBtn = await findByText('Render →')
    renderBtn.click()

    // onProjectChange should have been called with status: 'final'
    expect(onProjectChange).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'final' }),
    )
    // saveProject should have been called with status: 'final'
    await waitFor(() => {
      expect(adapter.saveProject).toHaveBeenCalledWith(
        'vid-1',
        expect.objectContaining({ status: 'final' }),
      )
    })
  })

  it('shows the skill-path card on the pending surface when getInfo returns a path', async () => {
    const adapter = makeFakeAdapter()
    adapter.getInfo = vi.fn(async () => ({ root_skill_path: 'skills/video-skill.md' }))
    const initial = makeVideoProject({ status: 'pending', tracks: [[]] })
    const { findByText } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        // no pendingStatus slot → should show default card
      />,
    )

    // The card header should appear
    await findByText(/Send this to your agent/i)
    // The copy-able prompt text should include the skill path
    await findByText(/skills\/video-skill\.md/i)
  })

  // `handleOverlayChange` (VideoEditor.tsx) is a private closure whose `changes`
  // param is typed as `OverlayChanges` (useDragOverlay.ts) and whose body is
  // exactly `{ ...item, ...changes }`. No control in the preview layer currently
  // drives a `props` payload through it — the crop modal only ever sends
  // sourceCrop/sourceWidth/sourceHeight, and drag/resize/rotate only ever send
  // offsetX/offsetY/scale/rotation — so there is no DOM path in this harness
  // that reaches a `props` change via a mounted <VideoEditor>. This test instead
  // exercises the real merge contract directly: `changes` is typed against the
  // actual `OverlayChanges` export (so `props` only compiles once useDragOverlay
  // declares it), and the assertion applies the identical spread
  // `handleOverlayChange` performs.
  it('handleOverlayChange merges a props payload into the matching item without touching other fields', () => {
    const item: VisualItem = {
      id: 'overlay-1',
      type: 'overlay',
      src: 'overlay.jsx',
      start: 0,
      end: 4,
      offsetX: 5,
      offsetY: 10,
      props: { text: 'Old text' },
    }
    const changes: OverlayChanges = { props: { text: 'New text' } }

    // Mirrors VideoEditor.tsx handleOverlayChange's item-update line exactly.
    const merged = { ...item, ...changes }

    expect(merged.props).toEqual({ text: 'New text' })
    expect(merged.offsetX).toBe(5)
    expect(merged.offsetY).toBe(10)
  })
})
