import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { CaptionEvent, EditorAdapter, ImageElement, Project, RenderEvent, VersionEntry, WaveformChunk } from '../../types'
import VideoEditor from '../VideoEditor'
import { installCanvasHarness, selectCanvasItem } from '../timeline/__tests__/_canvasSelect'

// ── A blank project (PV45 B3) ────────────────────────────────────────────────
//
// A project with nothing on it yet has one job: get footage in. Three seams
// serve that, and each is pinned here in both directions (blank vs. not):
//
//   1. `slots.previewEmptyState` replaces the preview's "No clips" label, so a
//      host can make the whole empty preview a drop target.
//   2. The media-panel layout's left rail opens on Media, even over a persisted tab.
//   3. "Generate captions" waits until the timeline has audio to transcribe.

const MEDIA_PANEL = <div data-testid="media-panel">Footage bin</div>
const TAB_KEY = 'montaj.editor.leftPanelTab'

/** The shape `montaj init` writes for a project with no footage yet: one
 *  object-shaped track with no items, no audio, no captions. */
function makeBlankProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'vid-blank',
    name: 'Blank',
    status: 'draft',
    editingPrompt: '',
    projectType: 'video',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [{ id: 'trk-0', items: [] }],
    audio: { tracks: [] },
    assets: [],
    ...overrides,
  } as unknown as Project
}

function makeClipProject(overrides: Partial<Project> = {}): Project {
  return makeBlankProject({
    id: 'vid-1',
    tracks: [[{ id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4 }]],
    ...overrides,
  } as unknown as Partial<Project>)
}

/** Music on the timeline and nothing else: content, and audio to transcribe. */
function makeAudioOnlyProject(): Project {
  return makeBlankProject({
    audio: { tracks: [{ id: 'aud-0', src: 'song.mp3', start: 0, end: 8, inPoint: 0, outPoint: 8 }] },
  } as unknown as Partial<Project>)
}

function makeFakeAdapter(project: Project, { canGenerateCaptions = false } = {}): EditorAdapter<Project> {
  return {
    loadProject: vi.fn(async () => project),
    saveProject: vi.fn(async () => {}),
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
    restoreVersion: vi.fn(async () => project),
    getWaveformChunks: vi.fn(async (): Promise<WaveformChunk[]> => []),
    resolveCaptionTemplate: (style: string) => `/caption/${style}`,
    getInfo: vi.fn(async () => ({ root_skill_path: undefined })),
    ...(canGenerateCaptions
      ? {
          generateCaptions: async function* (): AsyncIterable<CaptionEvent> {
            yield { type: 'log', message: 'transcribing audio…' }
          },
        }
      : {}),
  } as unknown as EditorAdapter<Project>
}

function renderEditor(
  project: Project,
  { slots, canGenerateCaptions }: { slots?: Record<string, unknown>; canGenerateCaptions?: boolean } = {},
) {
  return render(
    <VideoEditor
      project={project}
      adapter={makeFakeAdapter(project, { canGenerateCaptions })}
      onProjectChange={vi.fn()}
      slots={{ mediaPanel: MEDIA_PANEL, ...slots }}
    />,
  )
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('montaj.editor.captionPanelTab', JSON.stringify('captions'))
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

const HOST_EMPTY = <div data-testid="host-preview-empty">Drop your clips</div>

describe('VideoEditor — slots.previewEmptyState', () => {
  it('renders the host node in place of "No clips" on a blank project', async () => {
    renderEditor(makeBlankProject(), { slots: { previewEmptyState: HOST_EMPTY } })
    expect(await screen.findByTestId('host-preview-empty')).toBeTruthy()
    // Replaces the default, not stacked with it.
    expect(screen.queryByText('No clips')).toBeNull()
  })

  it('keeps "No clips" when the host supplies no slot', async () => {
    renderEditor(makeBlankProject())
    expect(await screen.findByText('No clips')).toBeTruthy()
  })

  it('does not render once the project has content', async () => {
    renderEditor(makeClipProject(), { slots: { previewEmptyState: HOST_EMPTY } })
    await waitFor(() => screen.getByTestId('preview-timecode'))
    expect(screen.queryByTestId('host-preview-empty')).toBeNull()
  })
})

describe('VideoEditor — the left rail on a blank project', () => {
  it('opens on Media even when Captions is the persisted tab', async () => {
    localStorage.setItem(TAB_KEY, JSON.stringify('captions'))
    renderEditor(makeBlankProject(), { canGenerateCaptions: true })

    const media = await screen.findByRole('tab', { name: 'Media' })
    await waitFor(() => expect(media.getAttribute('aria-selected')).toBe('true'))
    expect(screen.getByRole('tab', { name: 'Captions' }).getAttribute('aria-selected')).toBe('false')
    expect(screen.getByTestId('media-panel')).toBeTruthy()
  })

  it('opens on Media when nothing is persisted', async () => {
    renderEditor(makeBlankProject(), { canGenerateCaptions: true })
    const media = await screen.findByRole('tab', { name: 'Media' })
    await waitFor(() => expect(media.getAttribute('aria-selected')).toBe('true'))
  })

  it('opens on Media without saving it as the default for later projects', async () => {
    localStorage.setItem(TAB_KEY, JSON.stringify('captions'))
    renderEditor(makeBlankProject(), { canGenerateCaptions: true })
    const media = await screen.findByRole('tab', { name: 'Media' })
    await waitFor(() => expect(media.getAttribute('aria-selected')).toBe('true'))
    expect(localStorage.getItem(TAB_KEY)).toBe(JSON.stringify('captions'))
  })

  it('leaves a project with content on its persisted tab', async () => {
    localStorage.setItem(TAB_KEY, JSON.stringify('versions'))
    renderEditor(makeClipProject(), { canGenerateCaptions: true })

    const versions = await screen.findByRole('tab', { name: 'Versions' })
    // Give a stray activation effect its chance to fire before asserting.
    await waitFor(() => screen.getByLabelText('Resize sidebar'))
    expect(versions.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Media' }).getAttribute('aria-selected')).toBe('false')
  })

  it('still jumps to Captions when a caption is selected', async () => {
    onTestFinished(installCanvasHarness())
    localStorage.setItem(TAB_KEY, JSON.stringify('media'))
    const project = makeClipProject({
      captions: { style: 'pop', segments: [{ id: 'cap-0', text: 'caption one', start: 0, end: 1 }] },
    } as unknown as Partial<Project>)
    const { container } = renderEditor(project)

    const captions = await screen.findByRole('tab', { name: 'Captions' })
    expect(captions.getAttribute('aria-selected')).toBe('false')

    selectCanvasItem(container, project, { id: 'cap-0' })
    await waitFor(() => expect(captions.getAttribute('aria-selected')).toBe('true'))
  })
})

describe('VideoEditor — Generate captions waits for audio', () => {
  async function openCaptionsTab() {
    fireEvent.click(await screen.findByRole('tab', { name: 'Captions' }))
    return screen.findByRole('button', { name: 'Generate captions' })
  }

  it('is disabled with a reason on a blank timeline', async () => {
    renderEditor(makeBlankProject(), { canGenerateCaptions: true })
    const button = await openCaptionsTab()
    expect(button).toBeDisabled()
    expect(screen.getByText('Add a clip with sound first.')).toBeTruthy()
  })

  it('is enabled once the timeline has an audio track', async () => {
    renderEditor(makeAudioOnlyProject(), { canGenerateCaptions: true })
    const button = await openCaptionsTab()
    expect(button).toBeEnabled()
    expect(screen.queryByText('Add a clip with sound first.')).toBeNull()
  })

  const videoOnly = (item: Record<string, unknown>, track: Record<string, unknown> = {}) =>
    makeBlankProject({
      tracks: [{ id: 'trk-0', ...track, items: [{ id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4, ...item }] }],
    } as unknown as Partial<Project>)

  it.each([
    ['a muted clip', videoOnly({ muted: true })],
    ['a muted track', videoOnly({}, { muted: true })],
    ['a disabled track', videoOnly({}, { enabled: false })],
  ])('stays disabled with the reason when the only video is %s', async (_name, project) => {
    renderEditor(project, { canGenerateCaptions: true })
    const button = await openCaptionsTab()
    expect(button).toBeDisabled()
    expect(screen.getByText('Add a clip with sound first.')).toBeTruthy()
  })

  it('is enabled for an audible video on an object-shaped track', async () => {
    renderEditor(videoOnly({}), { canGenerateCaptions: true })
    expect(await openCaptionsTab()).toBeEnabled()
  })

  it('is enabled once the timeline has a video clip', async () => {
    renderEditor(makeClipProject(), { canGenerateCaptions: true })
    const button = await openCaptionsTab()
    expect(button).toBeEnabled()
  })
})
