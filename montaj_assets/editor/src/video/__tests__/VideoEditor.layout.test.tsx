import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { CaptionEvent, EditorAdapter, Project, RenderEvent, VersionEntry, WaveformChunk } from '../../types'
import type { ImageElement } from '../../types'
import VideoEditor from '../VideoEditor'
import { installCanvasHarness, selectCanvasItem, type CanvasItemSelector } from '../timeline/__tests__/_canvasSelect'

// ── Layout gating: classic vs. CapCut media-panel branch ─────────────────────
// ReviewSurface renders the classic layout (preview above a timeline pane, plus
// the version rail) UNLESS the host supplies `slots.mediaPanel`, which switches
// it to the CapCut layout: [media | preview | rail] across the top with a
// full-width timeline strip below. These tests assert the gate both directions —
// the media panel appears/disappears, and (in CapCut) the timeline strip is a
// sibling below the top row rather than nested inside the preview column.

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

beforeEach(() => {
  // The caption panel now splits into Style / Captions sub-tabs and defaults
  // to Style; these tests select captions from the transcript list, so pin the
  // sub-tab to 'captions' (usePersistentState reads this at mount).
  window.localStorage.setItem('montaj.editor.captionPanelTab', JSON.stringify('captions'))
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

describe('VideoEditor — layout gating (classic vs. CapCut media panel)', () => {
  it('renders the CapCut layout when slots.mediaPanel is provided', async () => {
    const adapter = makeFakeAdapter()
    const { getByTestId, getByLabelText, getByRole } = render(
      <VideoEditor
        project={makeVideoProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ mediaPanel: <div data-testid="media-panel">Footage bin</div> }}
      />,
    )

    // The host's media panel is rendered (its content is present). It sits in a
    // Media TAB of the left panel now, and the tabs mount LAZILY, so this test
    // clicks that tab before asserting rather than relying on it happening to
    // be open. It would otherwise pass only incidentally: this fixture has no
    // captions and no `generateCaptions`, so there is no Captions tab for
    // `defaultTabId="captions"` to open and Media is tabs[0] by fallback — and
    // giving this adapter caption support later would break the assertion for
    // reasons that have nothing to do with layout. See
    // VideoEditor.propertiesPanel.test.tsx for the tab behaviour itself.
    fireEvent.click(await waitFor(() => getByRole('tab', { name: 'Media' })))
    const media = await waitFor(() => getByTestId('media-panel'))
    // The CapCut-only media-column resize divider exists.
    expect(getByLabelText('Resize media panel')).toBeTruthy()

    // Structural: the timeline strip (its Controls button lives in the timeline
    // pane) is a SIBLING below the top row, not nested inside it or the preview.
    const controls = getByLabelText('Editor controls & shortcuts')
    expect(media.contains(controls)).toBe(false)
    expect(controls.contains(media)).toBe(false)
    // Top row (media | preview | rail) comes before the timeline strip in the DOM.
    expect(
      media.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('renders the classic layout (no media panel) when slots.mediaPanel is absent', async () => {
    const adapter = makeFakeAdapter()
    const { queryByTestId, queryByLabelText, getByLabelText } = render(
      <VideoEditor
        project={makeVideoProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
      />,
    )

    // The classic timeline pane still renders (its Controls button is present)…
    await waitFor(() => getByLabelText('Editor controls & shortcuts'))
    // …and the CapCut media panel is entirely inert: no media-panel content and
    // no media-column resize divider.
    expect(queryByTestId('media-panel')).toBeNull()
    expect(queryByLabelText('Resize media panel')).toBeNull()
  })
})

// ── Right-rail visibility gate (SP5-captions Phase 5) ─────────────────────────
// The rail (version history / run history / sidebar assets / CaptionListPanel)
// only mounts when it has something to show. A project with NO captions and NO
// other rail content, on a host that DOES support `generateCaptions`, must
// still get a rail — otherwise "Generate captions" (CaptionListPanel's only way to
// create captions from scratch) is unreachable. The retired bottom
// TranscriptPanel offered Regenerate unconditionally whenever the host
// supported it; the rail gate must preserve that reachability now that the
// control lives in the sidebar instead.
describe('VideoEditor — right-rail gate includes the regenerate capability', () => {
  it('renders the rail (and a working Regenerate) with no captions and no version/run/assets content, purely because the adapter supports generateCaptions', async () => {
    const project = makeVideoProject() // no `captions` field at all
    const adapter = {
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
      // Deliberately NO listVersionHistory, and no slots below — the rail has
      // nothing else to justify its presence except the regenerate capability.
      resolveCaptionTemplate: (style: string) => `/caption/${style}`,
      getInfo: vi.fn(async () => ({ root_skill_path: undefined })),
      generateCaptions: async function* (): AsyncIterable<CaptionEvent> {
        yield { type: 'log', message: 'transcribing audio…' }
      },
    } as unknown as EditorAdapter<Project>

    render(
      <VideoEditor
        project={project}
        adapter={adapter}
        onProjectChange={vi.fn()}
      />,
    )

    // The rail mounted at all — its divider is the structural tell.
    const divider = await waitFor(() => screen.getByLabelText('Resize sidebar'))
    expect(divider).toBeTruthy()

    // And the trigger is not just present but actually reachable: clicking it
    // opens CaptionRegenModal (asserted via its immediate "Starting
    // transcription…" line, present before any stream event arrives).
    fireEvent.click(screen.getByText('Generate captions'))
    expect(await screen.findByText(/starting transcription/i)).toBeTruthy()
  })
})

// ── primarySelectedId must skip caption ids (FIX 1) ─────────────────────────
//
// Under D1, a caption id shares `selectedIds` with clips and audio — selected
// on the canvas timeline exactly like either, or (as exercised here, since
// captions have no DOM-mode timeline row of their own any more — see the
// retired CaptionTrackRow) via a plain click on its row in the sidebar
// CaptionListPanel. `primarySelectedId` used to be `selectedIds[0]` verbatim,
// so a caption id at index 0 blanked the selected clip's crop/overlay-edit
// affordances and scoped Split to an id no track item matches. These are full
// <VideoEditor> DOM-mode renders, not source-level assertions: selecting a
// caption via its sidebar row, then additively (metaKey) selecting a clip or
// overlay block via the ordinary DOM-mode timeline click, is a real user
// gesture and needs no canvas/engine internals to drive.
describe('VideoEditor — a caption id ahead of a clip id in selectedIds (D1)', () => {
  function makeMixedProject(): Project {
    return makeVideoProject({
      tracks: [
        [{ id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4 }],
        [{ id: 'overlay-1', type: 'overlay', src: 'overlay.jsx', start: 0, end: 4, props: { text: 'Hello' } }],
      ],
      captions: { style: 'pop', segments: [{ id: 'cap-0', text: 'caption one', start: 0, end: 1 }] },
    } as unknown as Partial<Project>)
  }

  /** Click the caption's sidebar row (plain, single-select — replaces
   *  `selectedIds`), then additively (metaKey) select the given canvas
   *  item — `toggleSelection` appends, so the caption id lands FIRST. */
  async function selectCaptionThenAdditively(container: HTMLElement, project: Project, selector: CanvasItemSelector) {
    fireEvent.click(await screen.findByText('caption one'))
    selectCanvasItem(container, project, selector, { metaKey: true })
  }

  async function seekTo(seconds: string) {
    fireEvent.click(await screen.findByLabelText('Go to time'))
    const input = await screen.findByPlaceholderText(/mm:ss/)
    fireEvent.change(input, { target: { value: seconds } })
    fireEvent.keyDown(input, { key: 'Enter' })
  }

  it('resolves cropTarget to the clip, not null, and S still splits it', async () => {
    onTestFinished(installCanvasHarness())
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    const project = makeMixedProject()
    const { container } = render(
      <VideoEditor
        project={project}
        adapter={adapter}
        onProjectChange={onProjectChange}
      />,
    )
    await selectCaptionThenAdditively(container, project, { type: 'video' })

    // cropTarget resolved past the caption to the clip: the button is
    // enabled, not stuck on "Select a clip to crop".
    expect(screen.getByLabelText('Crop source').hasAttribute('disabled')).toBe(false)
    // selectedOverlayItem correctly stayed null — the resolved item is the
    // video clip, not the overlay, so the right panel's Content/Transform tab
    // strip (`role="group" aria-label="Overlay panel view"`, only drawn when
    // `overlayPropertiesPanel` has a truthy `selectedOverlayItem`) is absent.
    expect(screen.queryByRole('group', { name: 'Overlay panel view' })).toBeNull()

    // Seek inside the clip (splitting exactly at a clip's start/end is a
    // no-op — see splitAtTime), then Split. Pre-fix, primarySelectedId was
    // 'cap-0': no track item has that id, splitAtTime returned the same
    // project reference, and handleSplit's `if (updated === base) return`
    // swallowed the keypress with no onProjectChange call at all.
    await seekTo('2')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }))
    })

    await waitFor(() => {
      const last = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
      // `mapTrackItems` normalizes to `VisualTrack[]` ({ id, items }) on the
      // way out, whatever shape the fixture went in with.
      expect(last.tracks?.[0]?.items).toHaveLength(2) // clip-0 split into two
      expect(last.tracks?.[1]?.items).toHaveLength(1) // overlay untouched — Split scoped to the clip only
    })
  })

  it('resolves selectedOverlayItem to the overlay, not null, when it (not a clip) is the non-caption member', async () => {
    onTestFinished(installCanvasHarness())
    const adapter = makeFakeAdapter()
    const project = makeMixedProject()
    const { container } = render(
      <VideoEditor
        project={project}
        adapter={adapter}
        onProjectChange={vi.fn()}
      />,
    )
    await selectCaptionThenAdditively(container, project, { type: 'overlay' })

    // selectedOverlayItem resolved to the overlay (not null): `overlayPropertiesPanel`
    // (VideoEditor.tsx, shared by both layouts' right rail) only draws its
    // Content/Transform tab strip — `role="group" aria-label="Overlay panel
    // view"` — when `selectedOverlayItem` is truthy; with nothing (or a
    // non-overlay) selected it falls through to OverlayInspector's bare empty
    // state instead. The floating "Edit overlay" Pencil button this test used
    // to probe with is gone (folded into this same panel), but the tab strip
    // proves the same resolution this test is actually about.
    expect(screen.getByRole('group', { name: 'Overlay panel view' })).toBeTruthy()
    // The overlay is not croppable — cropTarget correctly stayed null.
    expect(screen.getByLabelText('Crop source').hasAttribute('disabled')).toBe(true)
  })

  it('a caption-only selection leaves primarySelectedId null — Split then scopes to the MAIN video track only, not every clip under the playhead', async () => {
    onTestFinished(installCanvasHarness())
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    render(
      <VideoEditor
        project={makeMixedProject()}
        adapter={adapter}
        onProjectChange={onProjectChange}
      />,
    )
    fireEvent.click(await screen.findByText('caption one'))

    expect(screen.getByLabelText('Crop source').hasAttribute('disabled')).toBe(true)
    // primarySelectedId is null for a caption-only selection, so
    // selectedOverlayItem is null too — the Content/Transform tab strip
    // (`role="group" aria-label="Overlay panel view"`) doesn't render.
    expect(screen.queryByRole('group', { name: 'Overlay panel view' })).toBeNull()

    // primarySelectedId is null (caption-only selection). Split with nothing
    // selected resolves the MAIN video track's clip under the playhead
    // (`trackItems(base)[0]`) and scopes the split to its id — it does NOT
    // razor every track. Passing null straight to `splitAtTime` used to cut
    // the overlay under the playhead too, which was wrong (Sam): nothing
    // selected means the main track only.
    await seekTo('2')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }))
    })

    await waitFor(() => {
      const last = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
      expect(last.tracks?.[0]?.items).toHaveLength(2) // main video clip split
      expect(last.tracks?.[1]?.items).toHaveLength(1) // overlay untouched — split scoped to the main track
    })
  })
})
