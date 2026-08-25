import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import type { EditorAdapter, Project, RenderEvent, VersionEntry, WaveformChunk } from '../../types'
import type { ImageElement } from '../../types'
import VideoEditor from '../VideoEditor'
import { createSourcePreviewStore } from '../source-preview'

// ── Source-preview overlay (opt-in footage-bin → main-preview scrub) ─────────
// When a host wires the `sourcePreview` store and sets a value, VideoEditor
// mounts a paused <video> overlay (its src = the value's url) above PreviewPlayer
// in the preview stage; clearing the store unmounts it. Absent store → no
// overlay, and the classic preview is unchanged. Setup mirrors
// VideoEditor.layout.test.tsx.

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

const SCRUB_URL = 'proxy-scrub.mp4'

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

describe('VideoEditor — source-preview overlay', () => {
  it('mounts a <video> overlay with the store value url, and unmounts on clear', async () => {
    const adapter = makeFakeAdapter()
    const store = createSourcePreviewStore()
    const { container, getByLabelText } = render(
      <VideoEditor
        project={makeVideoProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        sourcePreview={store}
      />,
    )

    await waitFor(() => getByLabelText('Editor controls & shortcuts'))
    // No value yet → no scrub overlay.
    expect(container.querySelector(`video[src="${SCRUB_URL}"]`)).toBeNull()

    // Host hovers a bin card → the overlay appears with that src.
    act(() => { store.set({ url: SCRUB_URL, fraction: 0.5 }) })
    await waitFor(() => expect(container.querySelector(`video[src="${SCRUB_URL}"]`)).toBeTruthy())

    // Clearing (pointer leaves the card) unmounts the overlay.
    act(() => { store.set(null) })
    await waitFor(() => expect(container.querySelector(`video[src="${SCRUB_URL}"]`)).toBeNull())
  })

  it('is inert when no sourcePreview store is supplied (classic path)', async () => {
    const adapter = makeFakeAdapter()
    const { container, getByLabelText } = render(
      <VideoEditor
        project={makeVideoProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
      />,
    )

    await waitFor(() => getByLabelText('Editor controls & shortcuts'))
    // Only PreviewPlayer's own slots exist; none carry the scrub url.
    expect(container.querySelector(`video[src="${SCRUB_URL}"]`)).toBeNull()
  })
})
