import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type { Project } from '@/lib/types/schema'

// ── Mocks ─────────────────────────────────────────────────────────────────────
// Mounts the REAL EditorPage with a REAL package VideoEditor (not a stub) —
// see the harness note above `describe` below for why. Follows
// EditorPage.carousel.test.tsx's mock shape: stub the api surface the
// assembled package VideoEditor touches on mount (getInfo / overlay lists),
// no-op useProjectStream, and force the desktop path via useIsMobile so the
// package VideoEditor (not MobileLiveView) renders.

// A pending, non-ai_video project whose tracks[0] mixes both item kinds the
// manual-start filter must tell apart: a zero-duration placeholder
// (`project/init.py` seeds every source onto tracks[0] with start/end both
// 0.0 for the agent to fill in) alongside a clip that already has a real
// span. Proves the filter drops the placeholder and keeps the real one,
// rather than "clears everything" or "changes nothing" both accidentally
// passing.
const pendingProject = {
  version: '0.2',
  id: 'proj-manual-1',
  name: 'Manual Test',
  workflow: 'clean_cut',
  status: 'pending',
  projectType: 'editing',
  editingPrompt: 'do the thing',
  settings: { resolution: [1080, 1920], fps: 30 },
  sources: [
    { id: 'clip-0', type: 'video', src: '/w/clip_0.mp4', start: 0, end: 0, sourceDuration: 12 },
    { id: 'clip-1', type: 'video', src: '/w/clip_1.mp4', start: 0, end: 0, sourceDuration: 9 },
  ],
  tracks: [{ id: 'trk-0', items: [
    { id: 'clip-0', type: 'video', src: '/w/clip_0.mp4', start: 0, end: 0 },   // placeholder
    { id: 'clip-1', type: 'video', src: '/w/clip_1.mp4', start: 0, end: 5 },   // real span
  ] }],
  assets: [],
  audio: {},
} as unknown as Project

vi.mock('@/lib/api', () => ({
  api: {
    getProject: vi.fn(async () => pendingProject),
    saveProject: vi.fn(async () => {}),
    getInfo: vi.fn(async () => ({ skill_path: '', root_skill_path: 'skills/native', style_profile_skill_path: '' })),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    listProfileOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    reservePath: vi.fn(async () => ({ path: '/p.png' })),
    runStep: vi.fn(async () => ({ path: '/p.png' })),
    runStepAsync: vi.fn(async () => ({ path: '/p.png' })),
    renderProject: vi.fn(async () => () => {}),
  },
  fileUrl: (p: string) => `/api/files?path=${encodeURIComponent(p)}`,
}))

// Captures the `onLog` callback EditorPage hands to useProjectStream so the
// second test can drive the SSE log path directly (see that test below) —
// the mock stays a no-op otherwise, mirroring the carousel harness.
let capturedOnLog: ((msg: string) => void) | undefined
vi.mock('@/lib/sse', () => ({
  useProjectStream: vi.fn((_id: unknown, _onUpdate: unknown, onLog: (msg: string) => void) => {
    capturedOnLog = onLog
  }),
  // The montaj adapter's `subscribe` (used by the package editor) multiplexes
  // over this shared pool; stub it to a no-op unsubscribe.
  subscribeProjectStream: vi.fn(() => () => {}),
}))

vi.mock('@/lib/useIsMobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/lib/overlay-eval', () => ({
  compileOverlay: vi.fn(async () => () => null),
}))

import EditorPage from '../EditorPage'
import { CaptionJobProvider } from '../captionJob'
import { api } from '@/lib/api'

// Saved originals so afterEach can restore the prototypes exactly —
// vi.restoreAllMocks() only undoes vi.spyOn/vi.fn mocks, not a direct
// prototype assignment. Mirrors FootagePanel.test.tsx's pattern.
let realGetContext: typeof HTMLCanvasElement.prototype.getContext
let realGetRect: typeof Element.prototype.getBoundingClientRect

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  capturedOnLog = undefined
  // ResizeObserver / EventSource aren't in jsdom.
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { EventSource: unknown }).EventSource = class {
    close() {}
  }
  // jsdom has no 2D canvas. VideoEditor's pending surface mounts the package's
  // canvas Timeline unconditionally (even while showing the pendingStatus
  // slot instead of the preview player), so a generic no-op 2D context is
  // enough to let it paint without throwing — the rasterizer isn't what this
  // test is about. Same shape the editor package's own TimelineCanvas tests
  // use (`montaj_assets/editor/src/video/timeline/canvas/__tests__/*.tsx`).
  realGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function () {
    return new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'createLinearGradient') return () => ({ addColorStop: () => {} })
        return () => {}
      },
      set() { return true },
    })
  } as unknown as typeof HTMLCanvasElement.prototype.getContext
  // jsdom lays everything out at 0x0; the canvas timeline needs a size to paint into.
  realGetRect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON: () => ({}) } as DOMRect
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  HTMLCanvasElement.prototype.getContext = realGetContext
  Element.prototype.getBoundingClientRect = realGetRect
})

// ── Harness note ─────────────────────────────────────────────────────────────
// Mounting strategy: the REAL package VideoEditor, not a stub. Tried first per
// the task's "highest-fidelity approach first" — and it works: with
// project.status === 'pending' and no trimmed clips in the fixture,
// VideoEditor renders its PendingSurface, which shows the pendingStatus slot
// (never the preview player) and mounts the canvas Timeline underneath purely
// as static (unselected, unfocused) chrome. A generic Proxy-based 2D context
// stub (above) is enough for that chrome to paint without error under jsdom,
// with no per-test canvas assertions required. So this test exercises the
// real thing end to end: EditorPage supplies `pendingStatus` unconditionally,
// the package's own PendingSurface renders it, PendingIntro renders the
// button, and clicking it produces the correct saved payload — the whole host
// + package wiring, not just the host's half of it.

describe('EditorPage — manual-start bypass', () => {
  it('flips a pending project to draft, drops the zero-duration placeholder, and keeps sources', async () => {
    const { getByText } = render(
      <CaptionJobProvider>
        <MemoryRouter
          initialEntries={[{ pathname: '/editor/proj-manual-1', state: { project: pendingProject } }]}
        >
          <Routes>
            <Route path="/editor/:id" element={<EditorPage />} />
          </Routes>
        </MemoryRouter>
      </CaptionJobProvider>,
    )

    const button = await waitFor(() => getByText('Start editing manually'))
    fireEvent.click(button)

    await waitFor(() => expect(api.saveProject).toHaveBeenCalledTimes(1))
    const [id, payload] = (api.saveProject as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Project]

    expect(id).toBe('proj-manual-1')
    expect(payload.status).toBe('draft')

    // The zero-duration placeholder (clip-0) is dropped; the real span
    // (clip-1) survives untouched. Asserting only length or only status would
    // let a broken filter (e.g. one that clears everything, or one that
    // never filters at all) pass.
    const items = payload.tracks![0].items
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('clip-1')

    // The footage bin's data (project.sources) is untouched — both clips are
    // still there for the media bin to show, even though only one is placed.
    expect(payload.sources).toHaveLength(2)
    expect(payload.sources!.map(s => s.id)).toEqual(['clip-0', 'clip-1'])
  })

  it('still offers the button while the agent is working', async () => {
    const { getByText } = render(
      <CaptionJobProvider>
        <MemoryRouter
          initialEntries={[{ pathname: '/editor/proj-manual-1', state: { project: pendingProject } }]}
        >
          <Routes>
            <Route path="/editor/:id" element={<EditorPage />} />
          </Routes>
        </MemoryRouter>
      </CaptionJobProvider>,
    )

    // Wait for the idle-state card first so the SSE handler has definitely
    // been captured, then drive it directly — EditorPage passes its `handleLog`
    // straight through to useProjectStream's onLog callback, which this file's
    // mock captures into `capturedOnLog`.
    await waitFor(() => getByText('Start editing manually'))
    act(() => { capturedOnLog?.('trimming clip 2 of 3') })

    await waitFor(() => getByText(/trimming clip 2 of 3/))
    expect(getByText('Start editing manually')).toBeInTheDocument()
  })
})
