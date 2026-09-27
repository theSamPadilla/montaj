import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import type {
  EditorAdapter,
  ImageElement,
  Project,
  RenderEvent,
  VersionEntry,
  WaveformChunk,
} from '../../types'
import VideoEditor from '../VideoEditor'

// `pendingSurface` and `onUserEdit`: a host that owns the pending gate
// (`'host'`) gets the full review editor while `status === 'pending'`, and a
// signal that tells its own user's edits apart from an agent's SSE writes.
// Adapter helpers copied from VideoEditor.test.tsx.

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
  /** Push a server-authored SSE frame to every active subscriber. */
  emit: (project: Project) => void
  /** When true, saveProject() blocks until flushSaves() so a save stays pending. */
  setHoldSaves: (hold: boolean) => void
  /** Resolve every held saveProject() promise. */
  flushSaves: () => void
}

function makeFakeAdapter(): FakeAdapter {
  const saveCalls: Array<{ id: string; project: Project }> = []
  let subscribers: Array<(project: Project) => void> = []
  let holdSaves = false
  let saveResolvers: Array<() => void> = []
  return {
    loadProject: vi.fn(async () => makeVideoProject()),
    saveProject: vi.fn(async (id: string, project: Project) => {
      saveCalls.push({ id, project })
      if (holdSaves) await new Promise<void>((resolve) => saveResolvers.push(resolve))
    }),
    // Capture the sync core's frame callback so a test can drive SSE frames.
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
    restoreVersion: vi.fn(async (_id: string, _hash: string) => makeVideoProject()),
    getWaveformChunks: vi.fn(async (): Promise<WaveformChunk[]> => []),
    resolveCaptionTemplate: (style: string) => `/caption/${style}`,
    getInfo: vi.fn(async () => ({ root_skill_path: undefined })),
    saveCalls,
    emit: (project: Project) => { for (const s of [...subscribers]) s(project) },
    setHoldSaves: (hold: boolean) => { holdSaves = hold },
    flushSaves: () => { const r = saveResolvers; saveResolvers = []; r.forEach((res) => res()) },
  }
}

beforeEach(() => {
  // The caption panel now splits into Style / Captions sub-tabs and defaults
  // to Style; these tests want the transcript + Regenerate trigger visible, so
  // pin the sub-tab to 'captions' (usePersistentState reads this at mount).
  window.localStorage.setItem('montaj.editor.captionPanelTab', JSON.stringify('captions'))
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


function pendingProject(overrides: Partial<Project> = {}): Project {
  return makeVideoProject({ status: 'pending', tracks: [{ id: 'trk-0', items: [] }], ...overrides } as Partial<Project>)
}

describe('VideoEditor — pendingSurface', () => {
  it('default: a pending project shows the built-in pending surface, not the review chrome', async () => {
    const adapter = makeFakeAdapter()
    const { findByTestId, queryByText, container } = render(
      <VideoEditor
        project={pendingProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ pendingStatus: <div data-testid="pending" /> }}
      />,
    )
    await findByTestId('pending')
    expect(container.textContent).toContain('project id:')
    expect(queryByText('Render →')).toBeNull()
  })

  it("'host': a pending project renders the review editor and none of the pending surface", async () => {
    const adapter = makeFakeAdapter()
    const { findByText, queryByTestId, container } = render(
      <VideoEditor
        project={makeVideoProject({ status: 'pending' })}
        adapter={adapter}
        onProjectChange={vi.fn()}
        pendingSurface="host"
        onBackToSetup={vi.fn()}
        slots={{ pendingStatus: <div data-testid="pending" /> }}
      />,
    )
    await findByText('Render →')
    expect(queryByTestId('pending')).toBeNull()
    expect(container.textContent).not.toContain('project id:')
    expect(container.textContent).not.toMatch(/Back to setup/i)
    // The skill-path fetch lives in the pending surface only.
    expect(adapter.getInfo).not.toHaveBeenCalled()
  })

  it("'host': a pending project with zero-duration placeholders renders without throwing", async () => {
    const adapter = makeFakeAdapter()
    const project = makeVideoProject({
      status: 'pending',
      tracks: [
        [
          { id: 'ph-0', type: 'video', src: 'a.mp4', start: 0, end: 0 },
          { id: 'ph-1', type: 'video', src: 'b.mp4' },
        ],
      ],
    } as unknown as Partial<Project>)
    const { findByText } = render(
      <VideoEditor project={project} adapter={adapter} onProjectChange={vi.fn()} pendingSurface="host" />,
    )
    await findByText('Render →')
  })

  it("'host': an SSE frame flipping pending to draft keeps the same surface mounted", async () => {
    const adapter = makeFakeAdapter()
    const initial = makeVideoProject({ status: 'pending' })
    const onProjectChange = vi.fn()
    const { findByText } = render(
      <VideoEditor project={initial} adapter={adapter} onProjectChange={onProjectChange} pendingSurface="host" />,
    )
    const before = await findByText('Render →')
    await act(async () => { adapter.emit({ ...initial, status: 'draft' }) })
    await waitFor(() => {
      expect(onProjectChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'draft' }))
    })
    const after = await findByText('Render →')
    expect(after).toBe(before)
    expect(before.isConnected).toBe(true)
  })
})

describe('VideoEditor — onUserEdit', () => {
  it('fires once for a user edit and once for undo, never for an SSE frame', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeVideoProject({ status: 'draft' })
    const onUserEdit = vi.fn()
    const { findByText } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        onUserEdit={onUserEdit}
        slots={{ exportActions: <div /> }}
      />,
    )
    const renderBtn = await findByText('Render →')
    // Let mount-time normalization settle: it goes through applyExternal.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(onUserEdit).not.toHaveBeenCalled()

    // Render flips status to 'final' through sync.mutate: a user edit.
    await act(async () => { renderBtn.click() })
    expect(onUserEdit).toHaveBeenCalledTimes(1)

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))
    })
    expect(onUserEdit).toHaveBeenCalledTimes(2)

    await waitFor(() => expect(adapter.saveCalls.length).toBe(2))
    await act(async () => { adapter.emit({ ...initial, name: 'Agent rename' }) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(onUserEdit).toHaveBeenCalledTimes(2)
  })
})
