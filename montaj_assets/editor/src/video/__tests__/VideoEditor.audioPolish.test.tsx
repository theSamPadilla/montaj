import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, act, fireEvent } from '@testing-library/react'
import type {
  AnalyzeAudioPolishArgs,
  AudioPolishAnalysis,
  EditorAdapter,
  ImageElement,
  Project,
  RenderEvent,
  VersionEntry,
  WaveformChunk,
} from '../../types'
import VideoEditor from '../VideoEditor'
import { trackItems } from '../timeline/timeline-model'

// ── Fake adapter ──────────────────────────────────────────────────────────────
// Trimmed down from VideoEditor.test.tsx's — this suite only needs the pieces
// VideoEditor threads unconditionally plus `analyzeAudioPolish`, which each
// test adds itself so "adapter omits it" is a real absence, not a stubbed-out
// no-op.

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
}

function makeFakeAdapter(): FakeAdapter {
  const saveCalls: Array<{ id: string; project: Project }> = []
  return {
    loadProject: vi.fn(async () => makeVideoProject()),
    saveProject: vi.fn(async (id: string, project: Project) => {
      saveCalls.push({ id, project })
    }),
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
    restoreVersion: vi.fn(async (_id: string, _hash: string) => makeVideoProject()),
    getWaveformChunks: vi.fn(async (): Promise<WaveformChunk[]> => []),
    resolveCaptionTemplate: (style: string) => `/caption/${style}`,
    getInfo: vi.fn(async () => ({ root_skill_path: undefined })),
    saveCalls,
  }
}

/** A loudness-only analyze mock: returns a fixed measurement that yields a
 *  nonzero, sub-ceiling gain (see audioPolish.ts's loudnessGainDb) so Apply
 *  produces a real, observable change without needing caption/removal
 *  fixtures the wiring under test does not care about. */
function loudnessOnlyAnalyze(): (args: AnalyzeAudioPolishArgs) => Promise<AudioPolishAnalysis> {
  return async (args) => {
    if (args.piece !== 'loudness') throw new Error(`unexpected piece requested: ${args.piece}`)
    return { piece: 'loudness', measuredI: -20, measuredTP: -20, measuredLRA: 5, targetI: -14, gainDb: 6 }
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

describe('VideoEditor — audio polish wiring', () => {
  it('shows neither the toolbar button nor the palette entry when the adapter omits analyzeAudioPolish', async () => {
    const adapter = makeFakeAdapter() // no analyzeAudioPolish
    const { queryByRole, findByPlaceholderText, queryByText } = render(
      <VideoEditor
        project={makeVideoProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ exportActions: <div /> }}
      />,
    )
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull())
    expect(queryByRole('button', { name: 'Polish audio' })).toBeNull()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    })
    // Palette open: the filtered command list is present (its search input's
    // placeholder, not text content — CommandPalette.tsx).
    await findByPlaceholderText('Type a command…')
    expect(queryByText('Polish audio…')).toBeNull()
  })

  it('shows the toolbar button and opens the modal when the adapter provides analyzeAudioPolish', async () => {
    const adapter = makeFakeAdapter()
    adapter.analyzeAudioPolish = vi.fn(loudnessOnlyAnalyze())
    const { findByRole } = render(
      <VideoEditor
        project={makeVideoProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ exportActions: <div /> }}
      />,
    )
    const button = await findByRole('button', { name: 'Polish audio' })
    fireEvent.click(button)
    await findByRole('dialog', { name: 'Polish audio' })
  })

  // Real useProjectSync — deliberately not mocked. A component test with a
  // mocked sync could only assert that VideoEditor CALLS mutateTransient/
  // commit/discardTransient, not that the real undo stack ends up with the
  // right number of entries; that requires the genuine implementation.
  it('Apply lands the whole polish as exactly one undo entry', async () => {
    const adapter = makeFakeAdapter()
    adapter.analyzeAudioPolish = vi.fn(loudnessOnlyAnalyze())
    const { findByRole, getByLabelText, getByText, queryByRole } = render(
      <VideoEditor
        project={makeVideoProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ exportActions: <div /> }}
      />,
    )

    fireEvent.click(await findByRole('button', { name: 'Polish audio' }))
    await findByRole('dialog', { name: 'Polish audio' })

    // Loudness only: unticking silence/fillers keeps this test to the wiring
    // under test rather than the planner's removal/guard logic, which
    // AudioPolishModal.test.tsx already covers on its own.
    fireEvent.click(getByLabelText('Remove silence'))
    fireEvent.click(getByLabelText('Remove filler words'))
    fireEvent.click(getByText('Analyse'))

    await waitFor(() => expect(getByText('Apply')).not.toBeDisabled())
    expect(adapter.analyzeAudioPolish).toHaveBeenCalledTimes(1)

    const savesBeforeApply = adapter.saveCalls.length
    fireEvent.click(getByText('Apply'))
    await waitFor(() => expect(queryByRole('dialog', { name: 'Polish audio' })).toBeNull())

    // One commit, one save, and the applied gain actually landed.
    await waitFor(() => expect(adapter.saveCalls.length).toBe(savesBeforeApply + 1))
    const applied = adapter.saveCalls[adapter.saveCalls.length - 1].project
    expect(trackItems(applied)[0][0].volume).toBeGreaterThan(1)

    // ONE undo reverts the whole polish, whatever the number of toggle/
    // checkbox changes the operator made while reviewing it...
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))
    })
    await waitFor(() => {
      const reverted = adapter.saveCalls[adapter.saveCalls.length - 1].project
      expect(trackItems(reverted)[0][0].volume).toBeUndefined()
    })
    const savesAfterUndo = adapter.saveCalls.length

    // ...and a second undo is a no-op: the stack had exactly one entry for
    // the whole gesture, not one per preview rebuild.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(adapter.saveCalls.length).toBe(savesAfterUndo)
  })

  it('Cancel produces no undo entry', async () => {
    const adapter = makeFakeAdapter()
    adapter.analyzeAudioPolish = vi.fn(loudnessOnlyAnalyze())
    const { findByRole, getByLabelText, getByText, queryByRole } = render(
      <VideoEditor
        project={makeVideoProject()}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ exportActions: <div /> }}
      />,
    )

    fireEvent.click(await findByRole('button', { name: 'Polish audio' }))
    await findByRole('dialog', { name: 'Polish audio' })
    fireEvent.click(getByLabelText('Remove silence'))
    fireEvent.click(getByLabelText('Remove filler words'))
    fireEvent.click(getByText('Analyse'))
    await waitFor(() => expect(getByText('Apply')).not.toBeDisabled())

    const savesBeforeCancel = adapter.saveCalls.length
    fireEvent.click(getByText('Cancel'))
    await waitFor(() => expect(queryByRole('dialog', { name: 'Polish audio' })).toBeNull())
    // No commit — nothing queued for save.
    expect(adapter.saveCalls.length).toBe(savesBeforeCancel)

    // No undo entry either: Cmd+Z is a no-op.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(adapter.saveCalls.length).toBe(savesBeforeCancel)
  })
})
