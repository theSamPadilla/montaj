import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, act, fireEvent } from '@testing-library/react'
import type { EditorAdapter, Project, RenderEvent, VersionEntry, WaveformChunk } from '../../types'
import type { ImageElement } from '../../types'
import VideoEditor from '../VideoEditor'

// ── FIX 3 regression ──────────────────────────────────────────────────────────
// Shift+Delete (VideoEditor.tsx's `handleRippleDelete`) reaches cuts.ts's
// `rippleDelete`, which reaches `applyCutToCaptions` — the function that DROPS
// a caption segment outright when it falls entirely inside the removed span,
// rather than shifting it like `collapseGaps` does. Dropping the only caption
// in a row leaves a hole lane.
//
// IMPORTANT: VideoEditor's own general-purpose lane-normalization effect
// (mount/SSE/regen/etc, keyed on `sync.project.captions`) ALSO catches and
// closes that hole shortly afterward — via `sync.applyExternal`, since a
// ripple-delete isn't a caption drag gesture. So asserting on the LAST
// `onProjectChange` call (client-side state) passes with or without this fix
// and proves nothing — `applyExternal` never calls `adapter.saveProject`, only
// `sync.mutate`/`commit`/`undo`/`redo` do. The actual bug is that the SAVED
// project — what a reload or another client would see — is whatever
// `handleRippleDelete`'s own `sync.mutate` call handed to the adapter, which
// without this fix is the sparse, hole-lane version. So this test asserts on
// the adapter's `saveProject` payload, not on local `onProjectChange` state.
// (Verified against a scratchpad revert: without the fix this fails with
// cap-2 stuck at lane 2 instead of renumbering to lane 1.)

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

interface FakeAdapter extends EditorAdapter<Project> {
  saveCalls: Array<{ id: string; project: Project }>
}

function makeFakeAdapter(): FakeAdapter {
  let subscribers: Array<(project: Project) => void> = []
  const saveCalls: Array<{ id: string; project: Project }> = []
  return {
    loadProject: vi.fn(async () => makeVideoProject()),
    saveProject: vi.fn(async (id: string, project: Project) => { saveCalls.push({ id, project }) }),
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
    saveCalls,
  } as unknown as FakeAdapter
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

describe('VideoEditor — ripple-delete densifies caption lanes (FIX 3)', () => {
  it('Shift+Delete on a clip whose span contains the only caption in its row PERSISTS a collapsed, dense row in the same commit', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeVideoProject({
      tracks: [{
        id: 'trk-0',
        items: [
          { id: 'clip-A', type: 'video', src: 'a.mp4', start: 0, end: 2, inPoint: 0, outPoint: 2 },
          { id: 'clip-B', type: 'video', src: 'a.mp4', start: 2, end: 4, inPoint: 2, outPoint: 4 },
        ],
      }],
      captions: {
        style: 'clean',
        segments: [
          // Outside clip-A's [0,2) span — survives, shifts left with clip-B.
          { id: 'cap-0', text: 'ground', start: 2.5, end: 3, words: [{ word: 'ground', start: 2.5, end: 3 }] },
          // Entirely inside clip-A's [0,2) span, alone in row 1 — dropped by
          // applyCutToCaptions when clip-A is ripple-deleted.
          { id: 'cap-1', text: 'middle', start: 0.5, end: 1, lane: 1, words: [{ word: 'middle', start: 0.5, end: 1 }] },
          // Outside clip-A's span, row 2 — survives, shifts left, and should
          // renumber into the row-1 hole cap-1 left behind.
          { id: 'cap-2', text: 'top', start: 3, end: 3.5, lane: 2, words: [{ word: 'top', start: 3, end: 3.5 }] },
        ],
      },
    } as Partial<Project>)

    const { getAllByText } = render(
      <VideoEditor project={initial} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />,
    )

    // Additive (metaKey) click sidesteps the plain-click playhead-seek branch,
    // which needs real layout metrics jsdom doesn't provide — same trick
    // VideoEditor.test.tsx's overlay-selection tests use.
    const clipA = (await waitFor(() => getAllByText('▪ video')))[0]
    fireEvent.click(clipA, { metaKey: true })

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', shiftKey: true }))
    })

    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(0))
    // Give any redundant client-side patch-up effect a chance to also fire a
    // second save — there shouldn't be one; applyExternal never saves.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    const saved = adapter.saveCalls[0].project
    const segs = saved.captions?.segments ?? []
    expect(segs.map((s) => s.id)).toEqual(['cap-0', 'cap-2'])
    // Row 1 (cap-1) is gone; row 2 (cap-2) drops into the vacated row — this
    // is the assertion that fails without the fix (cap-2 stays at lane 2).
    expect(segs.map((s) => s.lane ?? 0)).toEqual([0, 1])
    expect(segs.map((s) => s.start)).toEqual([0.5, 1])
    // Exactly one save for the whole gesture — densifying didn't cost a
    // second commit.
    expect(adapter.saveCalls.length).toBe(1)
  })
})
