/**
 * `VideoEditorProps.missingClips`: clips whose footage is absent. Covers the
 * timeline draw path, refused play, refused export, edits that need no pixels,
 * and no change at all without the prop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import type { EditorAdapter, Project, ImageElement } from '../../types'
import type { EditorProject, VisualItem } from '../../schema'
import PreviewPlayer, { type TransportHandle } from '../preview/PreviewPlayer'
import RenderModal from '../RenderModal'
import { MissingClipsProvider, enabledMissingClips, missingClipAt, missingClipsAhead, missingDetail } from '../missingClips'
import { createPlaybackClock } from '../playback-clock'
import { computeTimelineLayout, drawTimelineContent, type DrawContext, type TimelineScene } from '../timeline/canvas/draw'

afterEach(cleanup)

function vclip(id: string, start: number, end: number, src: string): VisualItem {
  return { id, type: 'video', src, start, end } as VisualItem
}

function makeProject(extra: { enabled?: boolean } = {}): EditorProject {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [
      { id: 't0', items: [vclip('a', 0, 2, '/m/ok.mp4'), vclip('b', 2, 4, '/m/gone.mp4')], ...extra },
    ],
  } as unknown as EditorProject
}

const MISSING = new Set(['b'])

// ── Timeline draw path ────────────────────────────────────────────────────────

function recordingContext() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const props: Record<string, unknown> = {}
  const ctx = new Proxy({}, {
    get(_t, prop: string) {
      if (prop in props) return props[prop]
      return (...args: unknown[]) => { calls.push({ method: prop, args }) }
    },
    set(_t, prop: string, value: unknown) { props[prop] = value; return true },
  }) as unknown as DrawContext
  return { ctx, count: (m: string) => calls.filter(c => c.method === m).length }
}

function drawScene(missingClips?: ReadonlySet<string>) {
  const p = makeProject()
  const tiles = vi.fn(() => null)
  const cols = vi.fn(() => null)
  const r = recordingContext()
  const scene = {
    project: p,
    viewport: { pxPerSecond: 100, scrollSeconds: 0, widthPx: 1000 },
    layout: computeTimelineLayout(p as unknown as Project),
    selectedIds: [],
    surfaceWidth: 1000,
    surfaceHeight: 200,
    filmstrips: { clipTiles: tiles },
    waveforms: { clipColumns: cols, audioColumns: () => null },
    missingClips,
  } as unknown as TimelineScene
  drawTimelineContent(r.ctx, scene)
  return { tiles, cols, strokes: r.count('stroke') }
}

describe('missingClips: timeline draw', () => {
  it('asks for no filmstrip and no waveform for a missing clip, and still does for the others', () => {
    const { tiles, cols } = drawScene(MISSING)
    const itemIds = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map(c => (c[0] as { id: string }).id)
    expect(itemIds(tiles)).toEqual(['a'])
    expect(itemIds(cols)).toEqual(['a'])
  })

  it('hatches a missing clip (extra stroke) and nothing else changes without the prop', () => {
    const withMissing = drawScene(MISSING)
    const without = drawScene(undefined)
    const empty = drawScene(new Set())
    expect(without.tiles).toHaveBeenCalledTimes(2)
    expect(without.cols).toHaveBeenCalledTimes(2)
    expect(empty.strokes).toBe(without.strokes)
    expect(withMissing.strokes).toBeGreaterThan(without.strokes)
  })
})

// ── Helpers ───────────────────────────────────────────────────────────────────

describe('missingClips: helpers', () => {
  it('names clips by file name and skips skipped tracks', () => {
    const p = makeProject()
    expect(enabledMissingClips(p, MISSING).map(c => c.name)).toEqual(['gone.mp4'])
    expect(enabledMissingClips(makeProject({ enabled: false }), MISSING)).toEqual([])
    expect(missingClipAt(p, MISSING, 3)?.id).toBe('b')
    expect(missingClipAt(p, MISSING, 1)).toBeNull()
    expect(missingClipsAhead(p, MISSING, 1).length).toBe(1)
    expect(missingClipsAhead(p, MISSING, 4)).toEqual([])
    expect(missingDetail(enabledMissingClips(p, MISSING))).toBe('gone.mp4')
  })
})

// ── Preview: play refused ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
    state = 'running'
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createMediaElementSource() { return { connect() {}, disconnect() {} } }
    get destination() { return {} }
    resume() { return Promise.resolve() }
    close() {}
  }
})
afterEach(() => { vi.restoreAllMocks() })

function mountPreview(project: EditorProject, ids: ReadonlySet<string> | undefined, t: number) {
  const transportRef: MutableRefObject<TransportHandle | null> = { current: null }
  const onPlayingChange = vi.fn()
  const onError = vi.fn()
  render(
    <MissingClipsProvider ids={ids} notify={onError}>
      <PreviewPlayer
        project={project}
        clock={createPlaybackClock(t)}
        compileOverlay={async () => (() => null) as never}
        fileUrl={(p) => p}
        transportRef={transportRef}
        onPlayingChange={onPlayingChange}
      />
    </MissingClipsProvider>,
  )
  return { transportRef, onPlayingChange, onError }
}

describe('missingClips: preview', () => {
  it('refuses play with the list, never starts, and shows the card over a missing clip', () => {
    const { transportRef, onPlayingChange, onError } = mountPreview(makeProject(), MISSING, 3)
    expect(screen.getByTestId('footage-missing-card').textContent).toContain('Footage missing')
    act(() => { transportRef.current!.togglePlay() })
    expect(onError).toHaveBeenCalledWith({ title: 'Footage missing', detail: 'gone.mp4' })
    expect(onPlayingChange.mock.calls.every(c => c[0] === false)).toBe(true)
  })

  it('shows no card when the playhead is on present footage, but still refuses play that would reach the gap', () => {
    const { transportRef, onError } = mountPreview(makeProject(), MISSING, 1)
    expect(screen.queryByTestId('footage-missing-card')).toBeNull()
    act(() => { transportRef.current!.togglePlay() })
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('sets no src on any video slot for a missing clip', () => {
    mountPreview(makeProject(), MISSING, 3)
    for (const v of Array.from(document.querySelectorAll('video'))) {
      expect(v.getAttribute('src') ?? '').not.toContain('gone.mp4')
    }
  })

  it('does nothing different without the prop: no card, no refusal', () => {
    const p = { id: 'pc', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [[{ id: 'o1', type: 'overlay', src: 'a.jsx', start: 0, end: 4, props: {} }]] } as unknown as EditorProject
    for (const ids of [undefined, new Set<string>()]) {
      const { transportRef, onError, onPlayingChange } = mountPreview(p, ids, 1)
      expect(screen.queryByTestId('footage-missing-card')).toBeNull()
      act(() => { transportRef.current!.togglePlay() })
      expect(onError).not.toHaveBeenCalled()
      expect(onPlayingChange.mock.lastCall).toEqual([true])
      cleanup()
    }
  })
})

// ── Export refused ────────────────────────────────────────────────────────────

function adapter(): EditorAdapter<Project> {
  return {
    loadProject: vi.fn(),
    saveProject: vi.fn(),
    subscribe: () => () => {},
    render: vi.fn(async function* () {}),
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => ''),
    fileUrl: (p: string) => p,
    renderAsync: vi.fn(async () => ({ status: 'running' })),
    getRenderStatus: vi.fn(async () => ({ status: 'running' as const })),
  } as unknown as EditorAdapter<Project>
}

describe('missingClips: export', () => {
  it('refuses with the list and never calls the adapter', () => {
    const a = adapter()
    render(<RenderModal projectId="p1" adapter={a} onClose={() => {}} missingClipNames={['gone.mp4', 'x.mov']} />)
    expect(screen.getByText('Render failed')).toBeTruthy()
    expect(screen.getAllByText(/Footage missing: gone\.mp4, x\.mov/).length).toBeGreaterThan(0)
    expect(a.renderAsync).not.toHaveBeenCalled()
    expect(a.render).not.toHaveBeenCalled()
  })

  it('starts as before with no missing names', () => {
    const a = adapter()
    render(<RenderModal projectId="p1" adapter={a} onClose={() => {}} missingClipNames={[]} />)
    expect(screen.queryByText('Render failed')).toBeNull()
    expect(a.renderAsync).toHaveBeenCalled()
  })
})
