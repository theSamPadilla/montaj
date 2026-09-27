import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, act, fireEvent, screen } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent, VersionEntry, WaveformChunk } from '../../types'
import VideoEditor from '../VideoEditor'

// ── Save-error banner ────────────────────────────────────────────────────────
// `sync.lastError` (use-project-sync.ts) used to go unrendered in the video
// editor: a failed save rolled the edit back with no visible sign anything
// went wrong. CarouselEditor already surfaces it as a dismissible banner
// (CarouselEditor.tsx ~584-590); this mirrors that pattern in VideoEditor.
//
// "M drops a marker" (VideoEditor.keymap.test.tsx) is reused as the trigger —
// the simplest real `sync.mutate` call reachable without selecting a clip —
// so this test can focus on the banner itself rather than on how to cause a
// mutation.

function makeVideoProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'vid-1',
    name: 'Test Video',
    status: 'draft',
    editingPrompt: '',
    projectType: 'video',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [
      [{ id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4 }],
    ],
    audio: { tracks: [] },
    assets: [],
    ...overrides,
  } as Project
}

function makeFailingSaveAdapter(): EditorAdapter<Project> {
  return {
    loadProject: vi.fn(async () => makeVideoProject()),
    saveProject: vi.fn(async () => { throw new Error('save boom') }),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/out.mp4' } },
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

describe('VideoEditor — save-error banner', () => {
  it('shows sync.lastError when a save rejects, and dismiss clears it', async () => {
    const adapter = makeFailingSaveAdapter()
    render(
      <VideoEditor
        project={makeVideoProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ exportActions: <div /> }}
      />,
    )
    await screen.findByLabelText('Preview axis')

    // No error yet.
    expect(screen.queryByText('save boom')).toBeNull()

    // Drop a marker — the simplest sync.mutate a mounted editor can reach
    // without first selecting a clip. Its save rejects per the adapter above.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }))
    })

    const banner = await waitFor(() => screen.getByText('save boom'))
    expect(banner).toBeTruthy()
    expect(adapter.saveProject).toHaveBeenCalledTimes(1)

    const dismissBtn = screen.getByText('dismiss')
    await act(async () => { fireEvent.click(dismissBtn) })

    expect(screen.queryByText('save boom')).toBeNull()
  })
})
