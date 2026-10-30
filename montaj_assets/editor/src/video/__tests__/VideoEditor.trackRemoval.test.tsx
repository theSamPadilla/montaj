import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, act, fireEvent, screen } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent, VersionEntry, WaveformChunk } from '../../types'
import VideoEditor from '../VideoEditor'
import { trackItems } from '../timeline/timeline-model'
import { installCanvasHarness } from '../timeline/__tests__/_canvasSelect'

// Right-click track removal through a mounted <VideoEditor>: the removal rides
// the normal timeline edit path, so one Undo brings the track and its clips back.

function makeProject(): Project {
  return {
    id: 'vid-1',
    name: 'Test Video',
    status: 'draft',
    editingPrompt: '',
    projectType: 'video',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [
      [{ id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4 }],
      [
        { id: 'ov-1', type: 'overlay', src: 'overlay.jsx', start: 0, end: 2, props: { text: 'A' } },
        { id: 'ov-2', type: 'overlay', src: 'overlay.jsx', start: 2, end: 4, props: { text: 'B' } },
      ],
    ],
    audio: { tracks: [] },
    assets: [],
  } as unknown as Project
}

function makeFakeAdapter(): EditorAdapter<Project> {
  return {
    loadProject: vi.fn(async () => makeProject()),
    saveProject: vi.fn(async () => {}),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/out.mp4' } },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (path: string) => path,
    listVersionHistory: vi.fn(async (): Promise<VersionEntry[]> => []),
    restoreVersion: vi.fn(async () => makeProject()),
    getWaveformChunks: vi.fn(async (): Promise<WaveformChunk[]> => []),
    resolveCaptionTemplate: (style: string) => `/caption/${style}`,
    getInfo: vi.fn(async () => ({ root_skill_path: undefined })),
  }
}

let uninstallCanvasHarness: () => void

beforeEach(() => {
  uninstallCanvasHarness = installCanvasHarness()
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
afterEach(() => {
  vi.restoreAllMocks()
  uninstallCanvasHarness()
})

const saved = (adapter: EditorAdapter<Project>) =>
  (adapter.saveProject as unknown as { mock: { calls: Array<[string, Project]> } }).mock.calls.map(c => c[1])

describe('VideoEditor track removal', () => {
  it('removes a track after confirm in one step, and one Undo restores it with its clips', async () => {
    const adapter = makeFakeAdapter()
    const { container } = render(<VideoEditor project={makeProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByLabelText('Preview axis')

    // Top row is the highest track (the two overlays).
    const cells = container.querySelectorAll('[data-rail-cell]')
    await act(async () => { fireEvent.contextMenu(cells[0]) })
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Remove track' })) })
    expect(screen.getByText('Remove track and 2 clips?')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove' })) })

    await waitFor(() => expect(saved(adapter).length).toBe(1))
    expect(trackItems(saved(adapter)[0]).map(t => t.map(i => i.id))).toEqual([['clip-0']])

    await act(async () => { fireEvent.click(screen.getByLabelText('Undo')) })
    await waitFor(() => expect(saved(adapter).length).toBe(2))
    expect(trackItems(saved(adapter)[1]).map(t => t.map(i => i.id))).toEqual([['clip-0'], ['ov-1', 'ov-2']])
  })
})
