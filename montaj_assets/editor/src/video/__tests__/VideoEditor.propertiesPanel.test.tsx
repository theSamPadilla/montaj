import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent, VersionEntry, WaveformChunk } from '../../types'
import VideoEditor from '../VideoEditor'
import { installCanvasHarness, selectCanvasItem } from '../timeline/__tests__/_canvasSelect'

// ── The CapCut layout's right properties panel ───────────────────────────────
//
// The clip/audio inspector used to be a host-rendered MODAL, opened by a
// double-click on the timeline and wired through the `renderClipInspector`
// render-prop (now removed). It is a persistent column now: single-click
// selection populates it, and the column is ALWAYS mounted so the preview never
// resizes as the operator clicks from clip to clip.
//
// Two behaviours here can only be tested at THIS seam, not in
// ClipPropertiesPanel's own suite:
//
//   1. RIPPLE (Task G). A speed-up shrinks a clip and leaves a gap. The retired
//      modal closed it via `collapseGaps` when the magnet was on; the panel
//      cannot — it only ever sees the one item, and collapsing gaps moves that
//      item's SIBLINGS. So VideoEditor's commit handler owns it.
//   2. The DRAG FEEDBACK LOOP (Task H). `SpeedControl` reads the slider's own
//      DOM value at pointerup. If the previewed item is not fed back into the
//      panel's `selection` prop DURING the drag, React reverts the controlled
//      input and commit reads the pre-drag value.

const MEDIA_PANEL = <div data-testid="media-panel">Footage bin</div>

/** Two CONTIGUOUS video clips: clip-0 [0,10] holding a 10s source window at 1×,
 *  clip-1 [10,14] butted against it. No gap to start with — so turning the
 *  magnet on is a no-op (`handleRippleToggle` collapses on enable) and the only
 *  gap in the test is the one the speed change itself opens. */
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'vid-1',
    name: 'Test Video',
    status: 'draft',
    editingPrompt: '',
    projectType: 'video',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [
      [
        { id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 100, outPoint: 110 },
        { id: 'clip-1', type: 'video', src: 'b.mp4', start: 10, end: 14, inPoint: 0, outPoint: 4 },
      ],
    ],
    audio: { tracks: [] },
    assets: [],
    ...overrides,
  } as Project
}

function makeFakeAdapter(project: Project): EditorAdapter<Project> {
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
  } as unknown as EditorAdapter<Project>
}

/** The project body of the LAST `saveProject` call — what a commit persisted. */
function lastSaved(adapter: EditorAdapter<Project>): Project {
  const calls = (adapter.saveProject as unknown as { mock: { calls: unknown[][] } }).mock.calls
  return calls[calls.length - 1][1] as Project
}

function renderCapCut(
  project: Project,
  adapter: EditorAdapter<Project>,
  { slots, ...props }: { slots?: Record<string, unknown> } & Record<string, unknown> = {},
) {
  return render(
    <VideoEditor
      project={project}
      adapter={adapter}
      onProjectChange={vi.fn()}
      slots={{ mediaPanel: MEDIA_PANEL, ...slots }}
      {...props}
    />,
  )
}

beforeEach(() => {
  // The left panel persists its active tab; a leftover value from an earlier
  // test would decide which tab this one opens on.
  localStorage.clear()
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

describe('VideoEditor — CapCut right properties panel', () => {
  it('always renders the column, showing the generic empty state when nothing is selected', async () => {
    const project = makeProject()
    renderCapCut(project, makeFakeAdapter(project))

    // The column's divider is the structural tell that it mounted at all —
    // with NOTHING selected, which is the whole point of "always visible".
    await waitFor(() => screen.getByLabelText('Resize sidebar'))
    expect(screen.getByText('Select an element')).toBeTruthy()
  })

  it('renders the host-supplied propertiesEmptyState slot instead of the default when nothing is selected', async () => {
    const project = makeProject()
    renderCapCut(project, makeFakeAdapter(project), {
      slots: { propertiesEmptyState: <div data-testid="host-empty">host empty</div> },
    })
    await waitFor(() => screen.getByLabelText('Resize sidebar'))
    expect(screen.getByTestId('host-empty')).toBeTruthy()
    // The host node REPLACES the generic default, it is not stacked with it.
    expect(screen.queryByText('Select an element')).toBeNull()
  })

  it('swaps in the clip properties when a video clip is selected', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeProject()
    const { container } = renderCapCut(project, makeFakeAdapter(project))
    await waitFor(() => screen.getByLabelText('Resize sidebar'))

    selectCanvasItem(container, project, { type: 'video' })

    expect(await screen.findByRole('slider', { name: 'Speed' })).toBeTruthy()
    expect(screen.getByLabelText('Mute clip')).toBeTruthy()
    // Exactly one branch renders — the empty state is gone, not stacked.
    expect(screen.queryByText('Select an element')).toBeNull()
  })

  it('swaps in the audio-track properties when an audio track is selected', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeProject({
      audio: { tracks: [{ id: 'a0', src: 'vo.wav', start: 0, end: 4 }] },
    } as unknown as Partial<Project>)
    const { container } = renderCapCut(project, makeFakeAdapter(project))
    await waitFor(() => screen.getByLabelText('Resize sidebar'))

    selectCanvasItem(container, project, { id: 'a0' })

    expect(await screen.findByLabelText('Track label')).toBeTruthy()
    expect(screen.getByLabelText('Mute track')).toBeTruthy()
    // Speed is video-only, so an audio selection must not carry a Speed slider.
    expect(screen.queryByRole('slider', { name: 'Speed' })).toBeNull()
  })

  it('calls renderGenerationPanel with the SELECTED clip\'s id and mounts it beneath the clip properties', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeProject()
    const renderGenerationPanel = vi.fn(({ clipId }: { clipId: string }) => (
      <div data-testid="generation-panel">Regenerate {clipId}</div>
    ))
    const { container } = renderCapCut(project, makeFakeAdapter(project), { renderGenerationPanel })
    await waitFor(() => screen.getByLabelText('Resize sidebar'))

    // Not called with nothing selected — it hangs off the clip branch, and the
    // seam is per-clip, so there is no clip id to call it with yet.
    expect(screen.queryByTestId('generation-panel')).toBeNull()
    expect(renderGenerationPanel).not.toHaveBeenCalled()

    selectCanvasItem(container, project, { type: 'video' })

    expect(await screen.findByTestId('generation-panel')).toBeTruthy()
    // The whole point of the render-prop over a static node: the editor owns
    // selection, so it tells the host WHICH clip to draw for.
    expect(renderGenerationPanel).toHaveBeenCalledWith({ clipId: 'clip-0' })
  })

  it('does not call renderGenerationPanel for an audio track (generation is video-only)', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeProject({
      audio: { tracks: [{ id: 'a0', src: 'vo.wav', start: 0, end: 4 }] },
    } as unknown as Partial<Project>)
    const renderGenerationPanel = vi.fn(() => <div data-testid="generation-panel">Regenerate</div>)
    const { container } = renderCapCut(project, makeFakeAdapter(project), { renderGenerationPanel })
    await waitFor(() => screen.getByLabelText('Resize sidebar'))

    selectCanvasItem(container, project, { id: 'a0' })

    expect(await screen.findByLabelText('Track label')).toBeTruthy()
    expect(screen.queryByTestId('generation-panel')).toBeNull()
    expect(renderGenerationPanel).not.toHaveBeenCalled()
  })

  // ── Task H: the drag-preview feedback loop ─────────────────────────────────
  it('a speed drag round-trips: the previewed value survives to pointerup and lands in the saved project', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeProject()
    const adapter = makeFakeAdapter(project)
    const { container } = renderCapCut(project, adapter)
    await waitFor(() => screen.getByLabelText('Resize sidebar'))
    selectCanvasItem(container, project, { type: 'video' })

    const slider = await screen.findByRole('slider', { name: 'Speed' })
    fireEvent.change(slider, { target: { value: '2' } })

    // The load-bearing assertion. The panel is controlled off `selection`,
    // which is derived from the project — so the preview must have updated the
    // project state, or React would have reverted the input to 1 by now and the
    // commit below would read the pre-drag value off the DOM.
    expect(slider).toHaveValue('2')

    fireEvent.pointerUp(slider)

    await waitFor(() => {
      const items = lastSaved(adapter).tracks?.[0]?.items ?? []
      // `end` re-fit through setClipSpeed: the same 10s source window at 2×.
      expect(items[0]).toMatchObject({ id: 'clip-0', speed: 2, end: 5 })
    })
  })

  // ── Task G: ripple after a committed speed change ──────────────────────────
  it('with the magnet on, a committed speed change closes the gap it opened', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeProject()
    const adapter = makeFakeAdapter(project)
    const { container } = renderCapCut(project, adapter)
    await waitFor(() => screen.getByLabelText('Resize sidebar'))

    // Ripple on FIRST — the fixture has no gaps, so enabling it is a no-op and
    // the only gap in play is the one the speed change opens below.
    fireEvent.click(screen.getByLabelText('Ripple mode'))
    selectCanvasItem(container, project, { type: 'video' })

    const slider = await screen.findByRole('slider', { name: 'Speed' })
    fireEvent.change(slider, { target: { value: '2' } })
    fireEvent.pointerUp(slider)

    await waitFor(() => {
      const items = lastSaved(adapter).tracks?.[0]?.items ?? []
      expect(items[0]).toMatchObject({ id: 'clip-0', speed: 2, end: 5 })
      // The sibling followed the shrink — collapseGaps ran on the same commit.
      expect(items[1]).toMatchObject({ id: 'clip-1', start: 5, end: 9 })
    })
  })

  it('with the magnet off, the same speed change leaves the gap open', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeProject()
    const adapter = makeFakeAdapter(project)
    const { container } = renderCapCut(project, adapter)
    await waitFor(() => screen.getByLabelText('Resize sidebar'))
    selectCanvasItem(container, project, { type: 'video' })

    const slider = await screen.findByRole('slider', { name: 'Speed' })
    fireEvent.change(slider, { target: { value: '2' } })
    fireEvent.pointerUp(slider)

    await waitFor(() => {
      const items = lastSaved(adapter).tracks?.[0]?.items ?? []
      expect(items[0]).toMatchObject({ id: 'clip-0', speed: 2, end: 5 })
      expect(items[1]).toMatchObject({ id: 'clip-1', start: 10, end: 14 })
    })
  })

  // NOTE the name: this does NOT exercise the magnet, and cannot — see the
  // comment below. It pins the OTHER half of the gate: that the ripple keys on
  // a DURATION change and not on "any commit". The magnet-on/magnet-off pair
  // above is what proves `rippleMode` itself gates the collapse.
  it('a mute toggle does not ripple, because the ripple keys on a duration change', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeProject({
      // A REAL gap this time, so a stray collapseGaps would be unmissable.
      tracks: [[
        { id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 100, outPoint: 110 },
        { id: 'clip-1', type: 'video', src: 'b.mp4', start: 20, end: 24, inPoint: 0, outPoint: 4 },
      ]],
    } as unknown as Partial<Project>)
    const adapter = makeFakeAdapter(project)
    const { container } = renderCapCut(project, adapter)
    await waitFor(() => screen.getByLabelText('Resize sidebar'))
    selectCanvasItem(container, project, { type: 'video' })

    // Deliberately NOT touching the magnet: `handleRippleToggle` collapses on
    // enable, which would close this gap before the mute even happened.
    fireEvent.click(await screen.findByLabelText('Mute clip'))

    await waitFor(() => {
      const items = lastSaved(adapter).tracks?.[0]?.items ?? []
      expect(items[0]).toMatchObject({ id: 'clip-0', muted: true })
      expect(items[1]).toMatchObject({ id: 'clip-1', start: 20 })
    })
  })
})

// ── The CapCut left panel ────────────────────────────────────────────────────
// Media, Captions and Versions now live behind an icon rail on the LEFT, where
// captions and version history used to stack into the right rail. Tabs are lazy:
// only the active one is mounted, so "the media panel is on screen" is now
// "the Media tab is selected", not "the editor is in the CapCut layout".
describe('VideoEditor — CapCut left panel tabs', () => {
  function makeCaptionedProject(): Project {
    return makeProject({
      captions: { style: 'pop', segments: [{ id: 'cap-0', text: 'caption one', start: 0, end: 1 }] },
    } as unknown as Partial<Project>)
  }

  it('opens on Captions and keeps Media behind its own tab', async () => {
    const project = makeCaptionedProject()
    renderCapCut(project, makeFakeAdapter(project))

    const captionsTab = await screen.findByRole('tab', { name: 'Captions' })
    expect(captionsTab.getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByText('caption one')).toBeTruthy()
    // Lazy mount: the Media tab's content has never been rendered.
    expect(screen.queryByTestId('media-panel')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }))
    expect(await screen.findByTestId('media-panel')).toBeTruthy()
  })

  it('puts version history and the host runHistory slot together under Versions', async () => {
    const project = makeCaptionedProject()
    renderCapCut(project, makeFakeAdapter(project), {
      slots: { runHistory: <div data-testid="run-history">Previous runs</div> },
    })

    fireEvent.click(await screen.findByRole('tab', { name: 'Versions' }))
    expect(await screen.findByTestId('run-history')).toBeTruthy()
  })

  it('offers no Captions tab on a project with no captions and a host that cannot generate them', async () => {
    const project = makeProject() // no `captions`, adapter has no generateCaptions
    renderCapCut(project, makeFakeAdapter(project))

    await waitFor(() => screen.getByRole('tab', { name: 'Media' }))
    expect(screen.queryByRole('tab', { name: 'Captions' })).toBeNull()
    // `defaultTabId="captions"` names a tab that isn't there, so LeftPanelTabs
    // falls back to the first one — Media is open, not a blank pane.
    expect(screen.getByTestId('media-panel')).toBeTruthy()
  })
})
