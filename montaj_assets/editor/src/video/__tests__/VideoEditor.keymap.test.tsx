import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, act, fireEvent, screen } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent, VersionEntry, WaveformChunk } from '../../types'
import VideoEditor from '../VideoEditor'

// ── T9 integration tests — the ReviewSurface keymap, the command palette,
// and the scrubber's "go to time" affordance, driven through a mounted
// <VideoEditor>. A minimal fake adapter is duplicated from VideoEditor.test.tsx
// (that file isn't touched — "existing tests unmodified") rather than shared.

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
      [{ id: 'overlay-1', type: 'overlay', src: 'overlay.jsx', start: 0, end: 4, props: { text: 'Hello' } }],
    ],
    audio: { tracks: [] },
    assets: [],
    ...overrides,
  } as Project
}

function makeFakeAdapter(): EditorAdapter<Project> {
  return {
    loadProject: vi.fn(async () => makeVideoProject()),
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

async function selectOverlay() {
  const overlayBlock = await screen.findByText('▪ overlay')
  fireEvent.click(overlayBlock, { metaKey: true })
}

/** Timeline's own Delete/Enter bindings are focus-scoped to its root (the
 *  `tabIndex={0}` container) — see Timeline.tsx. Selecting via the preview
 *  (as `selectOverlay` does above) never touches that container, so a plain
 *  Delete needs focus established explicitly here, mirroring how a real
 *  operator would have clicked a timeline row first. It's the only
 *  `tabIndex={0}` element this tree renders (TimelineCanvas's own container
 *  uses `tabIndex={-1}`, and isn't mounted in DOM mode anyway). */
function focusTimelineRoot() {
  const root = document.querySelector('[tabindex="0"]') as HTMLElement | null
  root?.focus()
}

describe('VideoEditor — T9 ripple-delete binding', () => {
  it('Shift+Delete ripple-deletes the selected item and commits (persists) exactly once', async () => {
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    render(
      <VideoEditor
        project={makeVideoProject()}
        adapter={adapter}
        onProjectChange={onProjectChange}
        slots={{ exportActions: <div /> }}
      />,
    )
    await selectOverlay()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', shiftKey: true }))
    })

    await waitFor(() => {
      const last = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
      expect(last.tracks?.flat().find((i) => i.id === 'overlay-1')).toBeUndefined()
    })
    // Exactly one commit for the gesture — one save call.
    await waitFor(() => expect((adapter.saveProject as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1))
  })

  it('Shift+Delete with no selection is a no-op', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', shiftKey: true }))
    })
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('plain Delete (no Shift) still runs the ORIGINAL two-step delete, not ripple-delete', async () => {
    // Regression guard for the Shift-exclusion added to Timeline's delete
    // matcher (see keymap.ts's matchesDelete) — without it, plain Delete
    // would ALSO match a binding meant only for Shift+Delete, or vice versa.
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={onProjectChange} slots={{ exportActions: <div /> }} />)
    await selectOverlay()
    focusTimelineRoot()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', shiftKey: false }))
    })
    await waitFor(() => {
      const last = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
      expect(last.tracks?.flat().find((i) => i.id === 'overlay-1')).toBeUndefined()
    })
  })
})

describe('VideoEditor — T9 command palette', () => {
  it('Cmd+K opens the palette listing commands', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    })
    expect(await screen.findByText('Split at playhead')).toBeTruthy()
  })

  it('typing a filter letter into the palette does not also split the timeline', async () => {
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={onProjectChange} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    })
    const input = await screen.findByPlaceholderText('Type a command…')
    onProjectChange.mockClear()
    fireEvent.keyDown(input, { key: 's' })
    fireEvent.change(input, { target: { value: 's' } })
    // 's' typed into the palette's OWN input must filter, not split — split
    // would show up as an onProjectChange carrying a new track split at 0.
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it('Escape closes the palette', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    })
    const input = await screen.findByPlaceholderText('Type a command…')
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByPlaceholderText('Type a command…')).toBeNull())
  })

  it('clicking the scrubber time readout opens the palette directly in "go to time" mode', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    const readout = await screen.findByTitle('Go to time')
    fireEvent.click(readout)
    expect(await screen.findByPlaceholderText(/mm:ss/)).toBeTruthy()
    // The list view's search box must NOT also be present — it opened
    // straight into goto mode, not the filtered list.
    expect(screen.queryByPlaceholderText('Type a command…')).toBeNull()
  })
})

describe('VideoEditor — T9 keymap does not race Space', () => {
  it('Space is never observed by the keymap (no palette, no split, no undo/redo side effect)', async () => {
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={onProjectChange} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')
    onProjectChange.mockClear()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }))
    })
    // No palette opened, no split committed as a side effect of Space.
    expect(screen.queryByPlaceholderText('Type a command…')).toBeNull()
    expect(onProjectChange).not.toHaveBeenCalled()
  })
})
