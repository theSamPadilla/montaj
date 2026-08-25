import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { CaptionEvent, EditorAdapter, ImageElement, Project, RenderEvent, VersionEntry, WaveformChunk } from '../../types'
import VideoEditor from '../VideoEditor'

// ── T1 — host-driven caption trigger seam ────────────────────────────────────
//
// `onRegenerateCaptions` / `captionsGenerating` (VideoEditorProps) let a host
// run caption generation as its own background job instead of the package's
// built-in blocking `CaptionRegenModal`. Purely additive: mounts the REAL
// VideoEditor (classic layout — no `slots.mediaPanel`, so the caption panel
// renders directly in the right rail, no tab navigation needed) and drives
// the actual "Regenerate captions" footer button, mirroring
// VideoEditor.captionDelete.test.tsx's mounting pattern.

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
    // Non-empty caption track: the "Regenerate captions" footer button (the
    // one under test) only renders once there is at least one segment — an
    // empty track shows a different "Generate captions" empty-state button.
    captions: {
      style: 'clean',
      segments: [{ id: 'cap-0', text: 'hello', start: 0, end: 1, words: [{ word: 'hello', start: 0, end: 1 }] }],
    },
    ...overrides,
  } as Project
}

function makeFakeAdapter(): EditorAdapter<Project> {
  return {
    loadProject: vi.fn(async () => makeVideoProject()),
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
    restoreVersion: vi.fn(async () => makeVideoProject()),
    getWaveformChunks: vi.fn(async (): Promise<WaveformChunk[]> => []),
    resolveCaptionTemplate: (style: string) => `/caption/${style}`,
    getInfo: vi.fn(async () => ({ root_skill_path: undefined })),
    // Present in BOTH tests below, deliberately: the host-prop test proves
    // `onRegenerateCaptions` wins even though `adapter.generateCaptions` is
    // also available — a real host that passes the prop still implements
    // this to power the background job it owns (see types.ts's doc comment
    // on `onRegenerateCaptions`).
    generateCaptions: vi.fn(async function* (): AsyncIterable<CaptionEvent> {
      yield { type: 'log', message: 'transcribing…' }
    }),
  } as unknown as EditorAdapter<Project>
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

describe('VideoEditor — host-driven caption trigger seam', () => {
  it('clicking the trigger calls the host onRegenerateCaptions and never mounts the built-in modal', async () => {
    // Proves a host that owns the caption job (Mel's Hub running it as a
    // background task) gets its callback invoked instead of the package
    // racing its own blocking modal against it.
    const adapter = makeFakeAdapter()
    const onRegenerateCaptions = vi.fn()
    render(
      <VideoEditor
        project={makeVideoProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        onRegenerateCaptions={onRegenerateCaptions}
      />,
    )

    const trigger = await screen.findByText('Regenerate captions')
    fireEvent.click(trigger)

    expect(onRegenerateCaptions).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Regenerating captions…')).toBeNull()
  })

  it('clicking the trigger still opens the built-in modal when the host prop is absent', async () => {
    // Hub and Los Parceros never pass `onRegenerateCaptions` — this pins the
    // pre-existing blocking-modal path so it can never silently regress.
    const adapter = makeFakeAdapter()
    render(
      <VideoEditor
        project={makeVideoProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
      />,
    )

    const trigger = await screen.findByText('Regenerate captions')
    fireEvent.click(trigger)

    await waitFor(() => expect(screen.getByText('Regenerating captions…')).toBeTruthy())
  })
})
