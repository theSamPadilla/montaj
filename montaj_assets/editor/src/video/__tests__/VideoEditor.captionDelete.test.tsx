import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, act, fireEvent } from '@testing-library/react'
import type { EditorAdapter, Project, RenderEvent, VersionEntry, WaveformChunk } from '../../types'
import type { ImageElement } from '../../types'
import VideoEditor from '../VideoEditor'

// ── FIX 2 regression ──────────────────────────────────────────────────────────
// `handleCaptionSegmentDelete` (VideoEditor.tsx) is the sidebar trash button's
// commit path. Timeline.tsx's own Delete keymap normalizes caption lanes after
// an explicit delete (see Timeline.keymap.test.tsx's "Delete collapses and
// renumbers a caption row it empties"); this handler used to filter the
// segment out and stop, so deleting the last caption in a row from the
// SIDEBAR (as opposed to the canvas timeline) persisted a sparse/hole lane to
// disk — two affordances for the same delete, two different outcomes. This
// mounts the real editor (not a mocked Timeline: the sidebar delete button
// doesn't route through Timeline at all) and drives the actual trash button.
//
// IMPORTANT: VideoEditor's own general-purpose lane-normalization effect
// (mount/SSE/regen/etc, keyed on `sync.project.captions`) ALSO catches and
// closes a hole lane shortly after ANY caption change that isn't a caption
// drag gesture — via `sync.applyExternal`. So asserting on the LAST
// `onProjectChange` call (client-side state) passes with or without this fix
// and proves nothing: `applyExternal` never calls `adapter.saveProject`, only
// `sync.mutate`/`commit`/`undo`/`redo` do. The actual bug is what gets
// PERSISTED — what a reload or another client would see — which is exactly
// what `handleCaptionSegmentDelete`'s own `syncMutate` call hands to the
// adapter. So this test asserts on the adapter's `saveProject` payload.
// (Verified against a scratchpad revert: without the fix, asserting on
// `onProjectChange` alone passes regardless of the fix — asserting on the
// saved payload correctly fails without it, with cap-2 stuck at lane 2.)

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

describe('VideoEditor — sidebar caption delete densifies lanes (FIX 2)', () => {
  it('removing the only caption in a row from the sidebar trash button PERSISTS a collapsed, dense row', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeVideoProject({
      captions: {
        style: 'clean',
        segments: [
          { id: 'cap-0', text: 'ground', start: 0, end: 1, words: [{ word: 'ground', start: 0, end: 1 }] },
          { id: 'cap-1', text: 'middle', start: 1, end: 2, lane: 1, words: [{ word: 'middle', start: 1, end: 2 }] },
          { id: 'cap-2', text: 'top', start: 2, end: 3, lane: 2, words: [{ word: 'top', start: 2, end: 3 }] },
        ],
      },
    } as Partial<Project>)
    const { getByText } = render(
      <VideoEditor project={initial} adapter={adapter} onProjectChange={vi.fn()} />,
    )

    // Locate the sole row-1 segment's own delete button — not by array index
    // (row order in the sidebar isn't the point under test here), by scoping
    // to its listitem.
    const middleRow = (await waitFor(() => getByText('middle'))).closest('[role="listitem"]') as HTMLElement
    const deleteBtn = middleRow.querySelector('button[aria-label="Delete caption"]') as HTMLButtonElement
    expect(deleteBtn).toBeTruthy()

    await act(async () => { fireEvent.click(deleteBtn) })

    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(0))
    // Give any redundant client-side patch-up effect a chance to also fire a
    // second save — there shouldn't be one; applyExternal never saves.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    const saved = adapter.saveCalls[0].project
    const segs = saved.captions?.segments ?? []
    expect(segs.map((s) => s.id)).toEqual(['cap-0', 'cap-2'])
    // cap-2 was on row 2 with the hole below it (row 1, just emptied) — it
    // drops into the vacated row instead of leaving row 1 sparse. This is the
    // assertion that fails without the fix (cap-2 stuck at lane 2).
    expect(segs.map((s) => s.lane ?? 0)).toEqual([0, 1])
    // Exactly one save for the whole delete — densifying didn't cost a
    // second commit.
    expect(adapter.saveCalls.length).toBe(1)
  })
})
