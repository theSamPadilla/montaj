import { useState } from 'react'
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

/**
 * One of the CLIP panel's own tab buttons — Transform · Speed · Volume · Crop
 * · Generate — resolved INSIDE that tab strip's `role="group"`, the same
 * scoping `overlayTab` below uses for the overlay panel's Content/Transform
 * pair, and for the same defensive reason: a tab's own body can grow a
 * control whose accessible name would otherwise collide with a tab label.
 */
async function clipTab(name: 'Transform' | 'Speed' | 'Volume' | 'Crop' | 'Generate'): Promise<HTMLButtonElement> {
  const strip = await screen.findByRole('group', { name: 'Clip panel view' })
  const button = Array.from(strip.querySelectorAll('button')).find(b => b.textContent === name)
  if (!button) throw new Error(`no "${name}" tab in the clip panel strip`)
  return button
}

/** The tab labels the clip panel currently offers, in TabNav's own render
 *  order — for asserting a WHOLE tab set (e.g. "just Transform and Volume for
 *  an image clip") in one line instead of one assertion per missing tab. */
function clipTabNames(strip: HTMLElement): string[] {
  return Array.from(strip.querySelectorAll('button')).map(b => b.textContent ?? '')
}

/**
 * The Crop tab's OWN body button ("Open crop tool", a plain-text button with
 * no `aria-label`) — distinct from the crop TOOLBAR button in the controls
 * bar, which is an icon-only button carrying `aria-label="Crop source"`. The
 * two used to share the same visible/accessible text ("Crop source"); the
 * body button's label was changed to resolve that collision, so scoping to
 * the clip panel's own subtree (the tab strip's parent) is no longer needed
 * to disambiguate — kept anyway as good practice for a panel-specific query.
 */
async function cropTabBodyButton(): Promise<HTMLButtonElement> {
  const strip = await screen.findByRole('group', { name: 'Clip panel view' })
  const scope = strip.parentElement as HTMLElement
  return waitFor(() => {
    const found = Array.from(scope.querySelectorAll('button')).find(b => b.textContent === 'Open crop tool')
    if (!found) throw new Error('no "Open crop tool" button in the clip panel body')
    return found
  })
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
  // The caption panel now has Style / Captions sub-tabs defaulting to Style;
  // the CapCut-left-panel test wants the transcript ('caption one') visible.
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

  it('swaps in the clip properties when a video clip is selected, defaulting to Transform', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeProject()
    const { container } = renderCapCut(project, makeFakeAdapter(project))
    await waitFor(() => screen.getByLabelText('Resize sidebar'))

    selectCanvasItem(container, project, { type: 'video' })

    // Transform is the default tab, and its body is the shared OverlayInspector
    // — the same control the overlay branch's Transform tab uses.
    expect((await clipTab('Transform')).getAttribute('aria-pressed')).toBe('true')
    expect(await screen.findByLabelText('Scale')).toBeTruthy()
    // Exactly one branch renders — the empty state is gone, not stacked.
    expect(screen.queryByText('Select an element')).toBeNull()
  })

  it('switching to the Speed tab reveals the speed control (video only)', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeProject()
    const { container } = renderCapCut(project, makeFakeAdapter(project))
    await waitFor(() => screen.getByLabelText('Resize sidebar'))
    selectCanvasItem(container, project, { type: 'video' })
    await screen.findByLabelText('Scale')

    fireEvent.click(await clipTab('Speed'))

    // Not asserting the Transform body is gone: ClipTabs keeps every opened
    // tab MOUNTED (only hiding the inactive ones) once it has been shown, so
    // the Transform inputs are still in the DOM here — just hidden, and that
    // is by design (see ClipPropertiesPanel's "Lazy mount, then KEEP MOUNTED"
    // comment), not a leak this test should chase.
    expect(await screen.findByRole('slider', { name: 'Speed' })).toBeTruthy()
  })

  it('switching to the Volume tab reveals volume and mute controls', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeProject()
    const { container } = renderCapCut(project, makeFakeAdapter(project))
    await waitFor(() => screen.getByLabelText('Resize sidebar'))
    selectCanvasItem(container, project, { type: 'video' })
    await screen.findByLabelText('Scale')

    fireEvent.click(await clipTab('Volume'))

    expect(await screen.findByLabelText('Mute clip')).toBeTruthy()
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

  it('calls renderGenerationPanel with the SELECTED clip\'s id, and its node mounts in the Generate tab', async () => {
    onTestFinished(installCanvasHarness())
    // Both `regenEnabled` and the clip's own frozen `generation` provenance
    // have to be present — the Generate tab is gated on the clip actually
    // being a regenerable generation, not merely on being a video.
    const project = makeProject({
      tracks: [[
        { id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 100, outPoint: 110,
          generation: { sceneId: 'sc-1', prompt: 'a wide shot', provider: 'kling' } },
        { id: 'clip-1', type: 'video', src: 'b.mp4', start: 10, end: 14, inPoint: 0, outPoint: 4 },
      ]],
    } as unknown as Partial<Project>)
    const renderGenerationPanel = vi.fn(({ clipId }: { clipId: string }) => (
      <div data-testid="generation-panel">Regenerate {clipId}</div>
    ))
    const { container } = renderCapCut(project, makeFakeAdapter(project), { renderGenerationPanel, regenEnabled: true })
    await waitFor(() => screen.getByLabelText('Resize sidebar'))

    // Not called with nothing selected — it hangs off the clip branch, and the
    // seam is per-clip, so there is no clip id to call it with yet.
    expect(screen.queryByTestId('generation-panel')).toBeNull()
    expect(renderGenerationPanel).not.toHaveBeenCalled()

    selectCanvasItem(container, project, { type: 'video' })

    // The render-prop is called as soon as the clip is selected — it builds
    // the slot VideoEditor hands to the tab shell, independent of which tab is
    // showing. The whole point of the render-prop over a static node: the
    // editor owns selection, so it tells the host WHICH clip to draw for.
    await waitFor(() => expect(renderGenerationPanel).toHaveBeenCalledWith({ clipId: 'clip-0' }))
    // But the Generate tab's body is lazy-mounted — it does not reach the DOM
    // until the operator actually opens that tab.
    expect(screen.queryByTestId('generation-panel')).toBeNull()

    fireEvent.click(await clipTab('Generate'))

    expect(await screen.findByTestId('generation-panel')).toBeTruthy()
  })

  it('remounts the Generate tab body on a clip-to-clip switch, rather than reconciling it in place with the OLD clip\'s content', async () => {
    onTestFinished(installCanvasHarness())
    // Two DIFFERENT generated clips, both eligible for the Generate tab.
    const project = makeProject({
      tracks: [[
        { id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 100, outPoint: 110,
          generation: { sceneId: 'sc-1', prompt: 'a wide shot', provider: 'kling' } },
        { id: 'clip-1', type: 'video', src: 'b.mp4', start: 10, end: 20, inPoint: 0, outPoint: 10,
          generation: { sceneId: 'sc-2', prompt: 'a close-up', provider: 'kling' } },
      ]],
    } as unknown as Partial<Project>)

    // A stand-in for the host's real regen form. Like the real one, it seeds
    // state from `clipId` in a `useState` INITIALIZER — which React only
    // ever runs on a component instance's initial mount, never on a
    // re-render with new props. If `generationSlot` were reconciled IN PLACE
    // across the clip switch (missing or wrong `key`), this label would keep
    // reading the FIRST clip it ever mounted for even though
    // `renderGenerationPanel` had already been called with the new clip's
    // id — the exact stale-form bug (wrong clip's prompt queued for
    // regeneration, spending credits on the wrong content) the
    // `key={clipSelection.item.id}` guard exists to prevent. Calling the
    // render-prop with the right id is necessary but not sufficient to catch
    // that bug; only the rendered content proves the subtree actually
    // remounted.
    function FakeRegenForm({ clipId }: { clipId: string }) {
      const [seededFor] = useState(clipId)
      return <div data-testid="generation-panel">seeded for {seededFor}</div>
    }
    const renderGenerationPanel = vi.fn(({ clipId }: { clipId: string }) => <FakeRegenForm clipId={clipId} />)
    const { container } = renderCapCut(project, makeFakeAdapter(project), { renderGenerationPanel, regenEnabled: true })
    await waitFor(() => screen.getByLabelText('Resize sidebar'))

    selectCanvasItem(container, project, { id: 'clip-0' })
    await waitFor(() => expect(renderGenerationPanel).toHaveBeenCalledWith({ clipId: 'clip-0' }))
    fireEvent.click(await clipTab('Generate'))
    expect(await screen.findByTestId('generation-panel')).toHaveTextContent('seeded for clip-0')

    selectCanvasItem(container, project, { id: 'clip-1' })

    // The render-prop is called with the NEW clip's id — this much would
    // pass even with the key missing.
    await waitFor(() => expect(renderGenerationPanel).toHaveBeenCalledWith({ clipId: 'clip-1' }))
    // The OBSERVABLE remount: the seeded label must now read clip-1. Without
    // the key, React would reconcile `FakeRegenForm` in place, its `useState`
    // initializer would NOT re-run, and this would still read "seeded for
    // clip-0" forever — the credit-spending bug the key guards against.
    expect(await screen.findByTestId('generation-panel')).toHaveTextContent('seeded for clip-1')
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
    fireEvent.click(await clipTab('Speed'))

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
    fireEvent.click(await clipTab('Speed'))

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
    fireEvent.click(await clipTab('Speed'))

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
    fireEvent.click(await clipTab('Volume'))

    // Deliberately NOT touching the magnet: `handleRippleToggle` collapses on
    // enable, which would close this gap before the mute even happened.
    fireEvent.click(await screen.findByLabelText('Mute clip'))

    await waitFor(() => {
      const items = lastSaved(adapter).tracks?.[0]?.items ?? []
      expect(items[0]).toMatchObject({ id: 'clip-0', muted: true })
      expect(items[1]).toMatchObject({ id: 'clip-1', start: 20 })
    })
  })

  // ── Tab set varies with the selection ───────────────────────────────────
  it('offers only Transform and Volume for a selected image clip', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeProject({
      tracks: [[{ id: 'img-0', type: 'image', src: 'photo.jpg', start: 0, end: 4 }]],
    } as unknown as Partial<Project>)
    const { container } = renderCapCut(project, makeFakeAdapter(project))
    await waitFor(() => screen.getByLabelText('Resize sidebar'))

    selectCanvasItem(container, project, { type: 'image' })

    const strip = await screen.findByRole('group', { name: 'Clip panel view' })
    // No Speed (image, not video), no Crop (not a tracks[0] video), no
    // Generate (generation is video-only).
    expect(clipTabNames(strip)).toEqual(['Transform', 'Volume'])
  })

  it('offers no Generate tab for an ordinary video clip with no generation provenance', async () => {
    onTestFinished(installCanvasHarness())
    // The default fixture: a plain video clip, no `generation` field, and
    // `renderCapCut` here passes neither `regenEnabled` nor
    // `renderGenerationPanel`. This is the shipping shape of every
    // non-ai_video project — the Generate tab must not appear for it, or
    // every ordinary video clip in every ordinary project grows a dead,
    // empty tab.
    const project = makeProject()
    const { container } = renderCapCut(project, makeFakeAdapter(project))
    await waitFor(() => screen.getByLabelText('Resize sidebar'))

    // clip-0 is the tracks[0] video with a src — also the crop target, so
    // Crop is expected here alongside Transform/Speed/Volume.
    selectCanvasItem(container, project, { id: 'clip-0' })

    const strip = await screen.findByRole('group', { name: 'Clip panel view' })
    expect(clipTabNames(strip)).toEqual(['Transform', 'Speed', 'Volume', 'Crop'])
  })

  it('offers no Crop tab for a video clip that is not the crop target', async () => {
    onTestFinished(installCanvasHarness())
    // clip-1 is a VIDEO, but on the second track — `cropTarget` only ever
    // matches tracks[0], so it still gets Speed/Generate, just no Crop. It
    // also carries `generation` provenance and regen is enabled, so Generate
    // stays in the expected set here rather than being the thing under test.
    const project = makeProject({
      tracks: [
        [{ id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 100, outPoint: 110 }],
        [{ id: 'clip-1', type: 'video', src: 'b.mp4', start: 0, end: 6, inPoint: 0, outPoint: 6,
          generation: { sceneId: 'sc-1', prompt: 'a wide shot', provider: 'kling' } }],
      ],
    } as unknown as Partial<Project>)
    const renderGenerationPanel = vi.fn(() => <div data-testid="generation-panel">Regenerate</div>)
    const { container } = renderCapCut(project, makeFakeAdapter(project), { regenEnabled: true, renderGenerationPanel })
    await waitFor(() => screen.getByLabelText('Resize sidebar'))

    selectCanvasItem(container, project, { id: 'clip-1' })

    const strip = await screen.findByRole('group', { name: 'Clip panel view' })
    expect(clipTabNames(strip)).toEqual(['Transform', 'Speed', 'Volume', 'Generate'])
  })

  it("clicking the Crop tab's button enters crop mode and stays entered on a second click (unlike the toolbar's toggle)", async () => {
    onTestFinished(installCanvasHarness())
    const project = makeProject()
    const { container } = renderCapCut(project, makeFakeAdapter(project))
    await waitFor(() => screen.getByLabelText('Resize sidebar'))
    // clip-0 is the tracks[0] video with a src — the crop target.
    selectCanvasItem(container, project, { id: 'clip-0' })

    fireEvent.click(await clipTab('Crop'))
    fireEvent.click(await cropTabBodyButton())

    // Same underlying `cropMode` state the toolbar's own "Crop source" button
    // drives — its aria-pressed flips too, proving there is only one crop path.
    expect(screen.getByLabelText('Crop source').getAttribute('aria-pressed')).toBe('true')

    // A second click must NOT exit crop mode: the tab body button is a
    // one-way enter, not a toggle like the toolbar button it mirrors.
    fireEvent.click(await cropTabBodyButton())
    expect(screen.getByLabelText('Crop source').getAttribute('aria-pressed')).toBe('true')
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

// ── The overlay Content / Transform tabs ─────────────────────────────────────
//
// A selected overlay's own props (its text, colors, numbers, toggles, images)
// used to live in `OverlayPropsModal` — a floating, draggable dialog with a Save
// button, opened by a preview double-click or a Pencil in the controls bar. That
// dialog is retired. Those fields are the **Content** tab of this same right
// column now, and the keyframe inspector is the **Transform** tab beside it.
// Content is the default: what an overlay SAYS is what you reach for first.
//
// Two consequences worth pinning here rather than in OverlayContentPanel's own
// suite, because they only exist at THIS seam:
//
//   1. There is no dialog left to open, so the double-click has nothing to do
//      but leave the already-selected overlay where it is — and nothing may
//      portal itself over the preview.
//   2. Edits ride VideoEditor's sync core (transient preview → commit on blur),
//      so a typed change has to reach `saveProject` without a Save button
//      anywhere in the loop.
describe('VideoEditor — overlay properties tabs', () => {
  /** The clip fixture plus a JSX overlay on its own track. */
  function makeOverlayProject(): Project {
    return makeProject({
      tracks: [
        [{ id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 100, outPoint: 110 }],
        [{
          id: 'ov-0',
          type: 'overlay',
          src: 'scoreboard.jsx',
          start: 0,
          end: 10,
          props: { text: 'Full time', accent: '#FCD116' },
        }],
      ],
    } as unknown as Partial<Project>)
  }

  /**
   * One of the two tab buttons, resolved INSIDE the tab strip.
   *
   * Scoping is defensive, not load-bearing: `OverlayInspector`'s own
   * "Transform" section header is an inert `<span>`, not a button, so there
   * is currently only one "Transform" button in the tree and a bare
   * `getByRole('button', { name: 'Transform' })` would not throw today. But a
   * tab body can grow a control whose accessible name collides with a tab
   * label, so resolving inside the tab strip's `role="group"` keeps this
   * query safe against that regardless.
   */
  async function overlayTab(name: 'Content' | 'Transform'): Promise<HTMLButtonElement> {
    const strip = await screen.findByRole('group', { name: 'Overlay panel view' })
    const button = Array.from(strip.querySelectorAll('button')).find(b => b.textContent === name)
    if (!button) throw new Error(`no "${name}" tab in the overlay panel strip`)
    return button
  }

  it('opens on the Content tab, showing the overlay\'s own props', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeOverlayProject()
    const { container } = renderCapCut(project, makeFakeAdapter(project))
    await waitFor(() => screen.getByLabelText('Resize sidebar'))

    selectCanvasItem(container, project, { type: 'overlay' })

    // Content is the default with nothing persisted.
    expect((await overlayTab('Content')).getAttribute('aria-pressed')).toBe('true')
    expect((await overlayTab('Transform')).getAttribute('aria-pressed')).toBe('false')
    // The overlay's OWN props, inferred — a text field and a color swatch.
    expect(screen.getByLabelText('text')).toBeTruthy()
    expect((screen.getByLabelText('accent') as HTMLInputElement).type).toBe('color')
    // Exactly one tab body renders: the Transform inspector is not stacked under it.
    expect(screen.queryByLabelText('Scale')).toBeNull()
  })

  it('switching to Transform swaps in the keyframe inspector', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeOverlayProject()
    const { container } = renderCapCut(project, makeFakeAdapter(project))
    await waitFor(() => screen.getByLabelText('Resize sidebar'))
    selectCanvasItem(container, project, { type: 'overlay' })

    fireEvent.click(await overlayTab('Transform'))

    expect(screen.getByLabelText('Scale')).toBeTruthy()
    expect(screen.getByLabelText('Offset X')).toBeTruthy()
    // ...and the Content body is gone, not hidden behind it.
    expect(screen.queryByLabelText('text')).toBeNull()
    // The choice is written through to storage, not just held in React state.
    expect(localStorage.getItem('montaj.editor.overlayPanelTab')).toBe(JSON.stringify('transform'))
  })

  it('opens on the tab the operator last used', async () => {
    onTestFinished(installCanvasHarness())
    // The write half is asserted above; this is the READ half, and it needs a
    // fresh mount to mean anything — usePersistentState consults storage once,
    // in its lazy `useState` initializer, and never again.
    localStorage.setItem('montaj.editor.overlayPanelTab', JSON.stringify('transform'))
    const project = makeOverlayProject()
    const { container } = renderCapCut(project, makeFakeAdapter(project))
    await waitFor(() => screen.getByLabelText('Resize sidebar'))
    selectCanvasItem(container, project, { type: 'overlay' })

    expect((await overlayTab('Transform')).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('Scale')).toBeTruthy()
    expect(screen.queryByLabelText('text')).toBeNull()
  })

  it('falls back to Content when the stored tab name is one this build does not know', async () => {
    onTestFinished(installCanvasHarness())
    localStorage.setItem('montaj.editor.overlayPanelTab', JSON.stringify('effects'))
    const project = makeOverlayProject()
    const { container } = renderCapCut(project, makeFakeAdapter(project))
    await waitFor(() => screen.getByLabelText('Resize sidebar'))
    selectCanvasItem(container, project, { type: 'overlay' })

    // A stale key from an older build must not render a blank pane.
    expect((await overlayTab('Content')).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('text')).toBeTruthy()
  })

  it('a Content edit previews live and lands in the saved project on blur — no Save button in the loop', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeOverlayProject()
    const adapter = makeFakeAdapter(project)
    const { container } = renderCapCut(project, adapter)
    await waitFor(() => screen.getByLabelText('Resize sidebar'))
    selectCanvasItem(container, project, { type: 'overlay' })

    const field = await screen.findByLabelText('text')
    fireEvent.change(field, { target: { value: 'Half time' } })
    // The field is controlled off the project, so it only reads back what was
    // typed if the transient preview actually reached the sync core.
    expect(field).toHaveValue('Half time')
    // The dialog this replaces persisted on a Save click; a panel has no such
    // moment, so nothing is saved until the typing gesture closes.
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull()

    fireEvent.blur(field)

    await waitFor(() => {
      const overlay = lastSaved(adapter).tracks?.[1]?.items?.[0] as { props?: Record<string, unknown> }
      // The untouched sibling prop rides through the write untouched.
      expect(overlay.props).toEqual({ text: 'Half time', accent: '#FCD116' })
    })
  })

  it('a preview double-click keeps the overlay on the Content tab and opens no dialog', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeOverlayProject()
    const { container } = renderCapCut(project, makeFakeAdapter(project))
    await waitFor(() => screen.getByLabelText('Resize sidebar'))
    selectCanvasItem(container, project, { type: 'overlay' })
    await screen.findByLabelText('text')

    // The preview's move surface, inside the selected overlay's wrapper — the
    // wrapper is what carries `onDoubleClick` (OverlayItemsLayer), and the
    // handler is gated on the overlay ALREADY being selected, so this path can
    // only ever re-select. It used to portal a dialog over the preview.
    fireEvent.dblClick(container.querySelector('.cursor-grab') as HTMLElement)

    expect(screen.getByLabelText('text')).toBeTruthy()
    expect((await overlayTab('Content')).getAttribute('aria-pressed')).toBe('true')
    // Nothing portalled itself over the preview: no dialog header, no Save.
    expect(screen.queryByRole('heading', { name: 'Edit overlay' })).toBeNull()
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
  })

  it('no longer offers an "Edit overlay" button in the controls bar', async () => {
    onTestFinished(installCanvasHarness())
    const project = makeOverlayProject()
    const { container } = renderCapCut(project, makeFakeAdapter(project))
    await waitFor(() => screen.getByLabelText('Resize sidebar'))
    selectCanvasItem(container, project, { type: 'overlay' })

    // Selecting the overlay IS opening its properties now, so the button whose
    // only job was to open them has nothing left to do.
    await screen.findByLabelText('text')
    expect(screen.queryByLabelText('Edit overlay')).toBeNull()
  })
})
