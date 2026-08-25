import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import type { EditorAdapter, Project, RenderEvent, VersionEntry, WaveformChunk } from '../../types'
import type { ImageElement } from '../../types'
import VideoEditor from '../VideoEditor'

// ── Timeline stand-in ────────────────────────────────────────────────────────
// A cross-row caption drag is driven entirely by the canvas pointer machine
// (pointer-machine.ts — owned elsewhere and not exercised here) calling
// Timeline's `onProjectChange` prop once per mousemove and `onOverlayEdit` on
// release. The bug this regresses, and its fix, live entirely in
// VideoEditor.tsx's own wiring around those two callbacks (captionGestureRef +
// the lane-normalization effect just above it) — not in the pointer machine
// itself. So instead of reproducing real canvas hit-testing in jsdom, this
// test replaces Timeline with a stand-in that just captures those two props,
// and drives them directly with hand-built projects that represent exactly
// what a real drag's mid-gesture frame and end-of-gesture commit look like.
let latestOnProjectChange: ((p: Project) => void) | undefined
let latestOnOverlayEdit: ((p: Project) => void) | undefined
vi.mock('../timeline/Timeline', () => ({
  default: (props: { onProjectChange?: (p: Project) => void; onOverlayEdit?: (p: Project) => void }) => {
    latestOnProjectChange = props.onProjectChange
    latestOnOverlayEdit = props.onOverlayEdit
    return null
  },
}))

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
  latestOnProjectChange = undefined
  latestOnOverlayEdit = undefined
})
afterEach(() => vi.restoreAllMocks())

// Three dense rows, one caption each — the PRE-drag state undo must restore.
const preDragCaptions = {
  style: 'clean',
  segments: [
    { id: 's0', text: 'zero', start: 0, end: 1, lane: 0, words: [{ word: 'zero', start: 0, end: 1 }] },
    { id: 's1', text: 'one', start: 1, end: 2, lane: 1, words: [{ word: 'one', start: 1, end: 2 }] },
    { id: 's2', text: 'two', start: 2, end: 3, lane: 2, words: [{ word: 'two', start: 2, end: 3 }] },
  ],
}

describe('VideoEditor — cross-row caption drag preserves its undo entry (FIX 1)', () => {
  it('a mid-gesture frame that opens a hole lane does not corrupt the commit, and undo restores the pre-drag lanes', async () => {
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    const initial = makeVideoProject({ captions: preDragCaptions } as Partial<Project>)
    const { getByLabelText } = render(
      <VideoEditor project={initial} adapter={adapter} onProjectChange={onProjectChange} />,
    )

    await waitFor(() => expect(latestOnProjectChange).toBeTypeOf('function'))
    await waitFor(() => expect(latestOnOverlayEdit).toBeTypeOf('function'))

    // Nothing to undo before the gesture starts.
    expect((getByLabelText('Undo') as HTMLButtonElement).disabled).toBe(true)

    // Mid-drag frame: s1 dragged from row 1 up onto row 0. Row 1 is now a
    // HOLE (no segments) while row 2 (s2) is left untouched — exactly what
    // pointer-machine.ts deliberately leaves un-normalized for the length of
    // the gesture, so the vacated row stays open as a drop target and the
    // timeline doesn't jump under the pointer.
    const midDragProject = {
      ...initial,
      captions: {
        ...preDragCaptions,
        segments: [
          { ...preDragCaptions.segments[0] },
          { ...preDragCaptions.segments[1], lane: 0 },
          { ...preDragCaptions.segments[2] },
        ],
      },
    } as Project
    await act(async () => { latestOnProjectChange!(midDragProject) })

    // Gesture ends: the canvas pointer machine's own commit already closed
    // the hole (row 2 renumbers to row 1). VideoEditor folds in
    // auto-crossfade (a no-op here) and commits.
    const committedProject = {
      ...initial,
      captions: {
        ...preDragCaptions,
        segments: [
          { ...preDragCaptions.segments[0] },
          { ...preDragCaptions.segments[1], lane: 0 },
          { ...preDragCaptions.segments[2], lane: 1 },
        ],
      },
    } as Project
    await act(async () => { latestOnOverlayEdit!(committedProject) })

    // The gesture produced exactly one undo entry.
    await waitFor(() => expect((getByLabelText('Undo') as HTMLButtonElement).disabled).toBe(false))

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))
    })

    // Undo must land on the PRE-drag arrangement (s0:0, s1:1, s2:2) — not the
    // mid-drag state, and not the committed state.
    await waitFor(() => {
      const last = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
      expect(last.captions?.segments.map((s) => [s.id, s.lane])).toEqual([
        ['s0', 0],
        ['s1', 1],
        ['s2', 2],
      ])
    })
  })
})
