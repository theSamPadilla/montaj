// captionPositioning.test.tsx
//
// Integration coverage for per-segment caption positioning (offsetX/offsetY/
// scale) at the CaptionPreview / VideoEditor layer. The pure drag maths
// already have 17 tests in captionDragState.test.ts — this file does NOT
// repeat that coverage. It covers the four integration behaviours the plan
// calls out:
//   1. dragging segment N updates only segment N
//   2. offsets survive a save/reload round-trip
//   3. a project with no offsets renders unchanged
//   4. clicking empty preview space does not select a caption
//
// jsdom does no layout, so two things need explicit stubbing for
// CaptionPreview to become interactive at all:
//   - ResizeObserver never fires on its own → `scale` would stay null forever
//     and the caption would never render. Unlike VideoEditor.test.tsx's
//     no-op stub (fine there — it doesn't touch captions), this suite's
//     ResizeObserver calls back synchronously with a fixed size.
//   - Range.prototype.getBoundingClientRect does not exist in jsdom at all
//     (throws "is not a function"), and Element.prototype.getBoundingClientRect
//     always returns zeros. CaptionPreview's measureCaptionContentRect walks
//     real text nodes via Range on every commit, so without a stub any test
//     that renders actual caption content crashes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, fireEvent } from '@testing-library/react'
import type { ReactElement } from 'react'
import CaptionPreview, { clampVisible } from '../preview/CaptionPreview'
import VideoEditor from '../VideoEditor'
import type { CaptionSegment, Captions } from '../../schema'
import type {
  EditorAdapter,
  ImageElement,
  OverlayFactory,
  Project,
  RenderEvent,
  VersionEntry,
  WaveformChunk,
} from '../../types'

const RENDER_W = 1080
const RENDER_H = 1920

function fixedRect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    left, top, right, bottom,
    width: right - left, height: bottom - top,
    x: left, y: top,
    toJSON: () => ({}),
  } as DOMRect
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  // Fires synchronously with a fixed 1080×1920 size — CaptionPreview's own
  // `RENDER_W`/`RENDER_H` (hardcoded in CaptionPreview.tsx, independent of
  // project.settings.resolution), so `scale` resolves to exactly 1 and every
  // screen-px delta below maps 1:1 to design px.
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    cb: (entries: unknown[]) => void
    constructor(cb: (entries: unknown[]) => void) { this.cb = cb }
    observe() { this.cb([{ contentRect: { width: RENDER_W, height: RENDER_H } }]) }
    unobserve() {}
    disconnect() {}
  }

  // jsdom: Range.prototype.getBoundingClientRect doesn't exist — assign it
  // directly (vi.spyOn requires a pre-existing method).
  Range.prototype.getBoundingClientRect = vi.fn(() => fixedRect(100, 1700, 300, 1750))
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => fixedRect(0, 0, RENDER_W, RENDER_H))

  // jsdom doesn't implement media playback or Web Audio — VideoEditor mounts
  // real <video> elements even when the test only cares about captions.
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

afterEach(() => {
  vi.restoreAllMocks()
  delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
})

// ── Shared test fixtures ──────────────────────────────────────────────────

const seg = (over: Partial<CaptionSegment> = {}): CaptionSegment => ({
  id: 'cap-0', text: 'hello', start: 0, end: 2, ...over,
})

/**
 * A minimal but realistic caption template: picks the active segment the same
 * way the real templates do (`t = frame/fps`, `segments.find`) and renders its
 * text as a genuine text node, so measureCaptionContentRect has something to
 * find. `onProps`, if given, is called with every factory invocation's props —
 * used to inspect exactly what CaptionPreview threads through.
 */
function makeCompileOverlay(onProps?: (props: Record<string, unknown>) => void) {
  return vi.fn(async (): Promise<OverlayFactory> => {
    return (frame: number, fps: number, _duration: number, props: Record<string, unknown>): ReactElement | null => {
      onProps?.(props)
      const segments = (props.segments ?? []) as CaptionSegment[]
      const t = frame / fps
      const active = segments.find((s) => t >= s.start && t < s.end)
      if (!active) return null
      return <div><span>{active.text}</span></div>
    }
  })
}

/** The selection box — CaptionPreview's only interactive element (z-index 50, pointer-events: auto). */
function getSelectionBox(container: HTMLElement): HTMLElement {
  const layer = container.querySelector('[style*="z-index: 50"]')
  if (!layer) throw new Error('selection box layer not found in the DOM — is the caption interactive yet?')
  return layer.firstElementChild as HTMLElement
}

// ── 1. Dragging segment N updates only segment N ───────────────────────────

describe('CaptionPreview — dragging updates only the dragged segment', () => {
  const track: Captions = {
    style: 'clean',
    segments: [
      seg({ id: 'cap-0', text: 'first', start: 0, end: 2 }),
      seg({ id: 'cap-1', text: 'second', start: 2, end: 4 }),
    ],
  }

  it('drags the segment active at the playhead and patches only its id', async () => {
    const onCaptionSegmentChange = vi.fn()
    const { container } = render(
      <CaptionPreview
        track={track}
        currentTime={2.5} // active segment = cap-1
        fps={30}
        compileOverlay={makeCompileOverlay()}
        resolveCaptionTemplate={(style) => `/tpl/${style}.jsx`}
        onSelectCaption={vi.fn()}
        onCaptionSegmentChange={onCaptionSegmentChange}
      />,
    )

    await waitFor(() => expect(container.querySelector('[style*="z-index: 50"]')).not.toBeNull())
    const box = getSelectionBox(container)

    fireEvent.mouseDown(box, { clientX: 500, clientY: 500 })
    fireEvent.mouseMove(document, { clientX: 500 + 108, clientY: 500 + 192 }) // +10% x, +10% y at scale 1
    fireEvent.mouseUp(document)

    expect(onCaptionSegmentChange).toHaveBeenCalledTimes(1)
    const [id, patch] = onCaptionSegmentChange.mock.calls[0]
    expect(id).toBe('cap-1')
    expect(patch).toEqual({ offsetX: 10, offsetY: 10 })
    expect(onCaptionSegmentChange).not.toHaveBeenCalledWith('cap-0', expect.anything())
  })

  it('a different playhead position drags the OTHER segment — selection follows the active id, not a fixed index', async () => {
    const onCaptionSegmentChange = vi.fn()
    const { container } = render(
      <CaptionPreview
        track={track}
        currentTime={0.5} // active segment = cap-0
        fps={30}
        compileOverlay={makeCompileOverlay()}
        resolveCaptionTemplate={(style) => `/tpl/${style}.jsx`}
        onSelectCaption={vi.fn()}
        onCaptionSegmentChange={onCaptionSegmentChange}
      />,
    )

    await waitFor(() => expect(container.querySelector('[style*="z-index: 50"]')).not.toBeNull())
    const box = getSelectionBox(container)

    fireEvent.mouseDown(box, { clientX: 200, clientY: 200 })
    fireEvent.mouseMove(document, { clientX: 200 - 54, clientY: 200 - 96 }) // -5% x, -5% y
    fireEvent.mouseUp(document)

    expect(onCaptionSegmentChange).toHaveBeenCalledTimes(1)
    const [id, patch] = onCaptionSegmentChange.mock.calls[0]
    expect(id).toBe('cap-0')
    expect(patch).toEqual({ offsetX: -5, offsetY: -5 })
    expect(onCaptionSegmentChange).not.toHaveBeenCalledWith('cap-1', expect.anything())
  })
})

// ── 2. Offsets survive a save/reload round-trip ─────────────────────────────

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
    captions: { style: 'clean', segments: [seg({ start: 0, end: 4 })] },
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
    saveProject: vi.fn(async (id: string, project: Project) => { saveCalls.push({ id, project }) }),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/out.mp4' } },
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: makeCompileOverlay(),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => '/path'),
    fileUrl: (path: string) => path,
    listVersionHistory: vi.fn(async (): Promise<VersionEntry[]> => []),
    getWaveformChunks: vi.fn(async (): Promise<WaveformChunk[]> => []),
    resolveCaptionTemplate: (style: string) => `/caption/${style}`,
    getInfo: vi.fn(async () => ({ root_skill_path: undefined })),
    saveCalls,
  }
}

describe('VideoEditor — caption offsets survive a save/reload round trip', () => {
  // Exercises the actual persistence path the editor uses (preview drag →
  // handleCaptionSegmentChange → makeCaptionEdit → sync.mutate →
  // adapter.saveProject), not a hand-rolled JSON.stringify/parse round trip.
  // "Reload" is a fresh <VideoEditor> mount seeded with exactly what
  // saveProject received — the same `project` prop path a real page refresh
  // takes (useProjectSync only consults it once, on mount).
  it('a drag committed through the preview reaches adapter.saveProject, and a fresh mount from that saved project keeps the offsets', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeVideoProject()
    const { container, unmount } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ exportActions: <div /> }}
      />,
    )

    await waitFor(() => expect(container.querySelector('[style*="z-index: 50"]')).not.toBeNull())
    const box = getSelectionBox(container)
    fireEvent.mouseDown(box, { clientX: 500, clientY: 500 })
    fireEvent.mouseMove(document, { clientX: 500 + 108, clientY: 500 + 192 }) // +10% x, +10% y
    fireEvent.mouseUp(document)

    await waitFor(() => {
      const last = adapter.saveCalls[adapter.saveCalls.length - 1]
      expect(last?.project.captions?.segments[0]).toMatchObject({ id: 'cap-0', offsetX: 10, offsetY: 10 })
    })
    const saved = adapter.saveCalls[adapter.saveCalls.length - 1].project

    // Reload: unmount the live editor and mount a fresh one from exactly what
    // was persisted.
    unmount()
    const onProjectChangeAfterReload = vi.fn()
    render(
      <VideoEditor
        project={saved}
        adapter={adapter}
        onProjectChange={onProjectChangeAfterReload}
        slots={{ exportActions: <div /> }}
      />,
    )

    await waitFor(() => {
      expect(onProjectChangeAfterReload).toHaveBeenCalledWith(
        expect.objectContaining({
          captions: expect.objectContaining({
            segments: expect.arrayContaining([
              expect.objectContaining({ id: 'cap-0', offsetX: 10, offsetY: 10 }),
            ]),
          }),
        }),
      )
    })
  })
})

// ── 3. A project with no offsets renders unchanged ──────────────────────────

describe('CaptionPreview — a segment with no offsets passes through unchanged', () => {
  it('the template factory receives the exact, untouched segments array — no live-drag override, no injected defaults', async () => {
    const track: Captions = {
      style: 'clean',
      segments: [seg({ offsetX: undefined, offsetY: undefined, scale: undefined })],
    }
    const received: unknown[] = []
    const { container } = render(
      <CaptionPreview
        track={track}
        currentTime={1}
        fps={30}
        compileOverlay={makeCompileOverlay((props) => received.push(props.segments))}
        resolveCaptionTemplate={(style) => `/tpl/${style}.jsx`}
      />,
    )

    await waitFor(() => expect(container.querySelector('span')?.textContent).toBe('hello'))
    expect(received.length).toBeGreaterThan(0)
    const passed = received[received.length - 1] as CaptionSegment[]

    // No `live` drag is in progress, so CaptionPreview's
    // `segments = live ? track.segments.map(...) : track.segments` ternary must
    // hand the template the literal same array — not a copy, and with no
    // fields coerced (offsetX/offsetY/scale defaulting to 0/0/1 is
    // captionInnerStyle's/captionOuterStyle's job, not CaptionPreview's).
    expect(passed).toBe(track.segments)
    expect(passed[0].offsetX).toBeUndefined()
    expect(passed[0].offsetY).toBeUndefined()
    expect(passed[0].scale).toBeUndefined()
  })
})

// ── 3b. An off-frame caption stays recoverable ──────────────────────────────

describe('clampVisible — the selection box never leaves the frame entirely', () => {
  // offsetX/offsetY are unbounded and captions have no numeric reset control,
  // so a segment dragged fully past the frame edge would have both its text and
  // its selection box clipped away by the preview wrapper's `overflow-hidden` —
  // no way back short of hand-editing project.json. The box is clamped to keep
  // a grabbable sliver on screen; dragging is delta-based, so a clamped box
  // still moves the segment correctly.
  const FRAME = 400
  const BOX = 100

  it('leaves a box fully inside the frame untouched', () => {
    for (const pos of [0, 30, 150, FRAME - BOX]) {
      expect(clampVisible(pos, BOX, FRAME)).toBe(pos)
    }
  })

  it('pulls a box dragged off the leading edge back to a grabbable sliver', () => {
    const clamped = clampVisible(-5000, BOX, FRAME)
    expect(clamped + BOX).toBeGreaterThan(0)      // right edge is on screen
    expect(clamped).toBeLessThan(0)               // still visibly off to the left
  })

  it('pulls a box dragged off the trailing edge back to a grabbable sliver', () => {
    const clamped = clampVisible(5000, BOX, FRAME)
    expect(clamped).toBeLessThan(FRAME)           // left edge is on screen
    expect(clamped).toBeGreaterThan(FRAME - BOX)  // still visibly off to the right
  })

  it('is idempotent — clamping an already-clamped position changes nothing', () => {
    const once = clampVisible(5000, BOX, FRAME)
    expect(clampVisible(once, BOX, FRAME)).toBe(once)
  })

  // Degenerate frame: a collapsed/unmeasured player (extent 0) with a small box
  // inverts the clamp range, so the position is passed through rather than
  // snapped to a meaningless bound.
  it('leaves the position alone when the clamp range inverts', () => {
    expect(clampVisible(-999, 20, 0)).toBe(-999)
  })
})

// ── 4. Clicking empty preview space does not select a caption ──────────────

describe('CaptionPreview — pointer-events design: only the measured selection box is clickable', () => {
  const track: Captions = { style: 'clean', segments: [seg()] }

  it('clicking the rendered caption text (or its wrapper) does not select it', async () => {
    const onSelectCaption = vi.fn()
    const { container, getByText } = render(
      <CaptionPreview
        track={track}
        currentTime={1}
        fps={30}
        compileOverlay={makeCompileOverlay()}
        resolveCaptionTemplate={(style) => `/tpl/${style}.jsx`}
        onSelectCaption={onSelectCaption}
      />,
    )

    await waitFor(() => expect(getByText('hello')).toBeTruthy())
    fireEvent.click(getByText('hello'))
    fireEvent.click(getByText('hello').parentElement as HTMLElement)
    // The whole caption layer stays click-through by design.
    expect(container.firstElementChild).toHaveClass('pointer-events-none')
    expect(onSelectCaption).not.toHaveBeenCalled()
  })

  it('clicking empty space elsewhere in the preview (the outer wrap itself) does not select', async () => {
    const onSelectCaption = vi.fn()
    const { container } = render(
      <CaptionPreview
        track={track}
        currentTime={1}
        fps={30}
        compileOverlay={makeCompileOverlay()}
        resolveCaptionTemplate={(style) => `/tpl/${style}.jsx`}
        onSelectCaption={onSelectCaption}
      />,
    )

    await waitFor(() => expect(container.querySelector('[style*="z-index: 50"]')).not.toBeNull())
    fireEvent.click(container.firstElementChild as HTMLElement)
    expect(onSelectCaption).not.toHaveBeenCalled()
  })

  it('contrast case: pressing the actual selection box DOES select — proves the negative results above are load-bearing, not just "nothing works"', async () => {
    const onSelectCaption = vi.fn()
    const { container } = render(
      <CaptionPreview
        track={track}
        currentTime={1}
        fps={30}
        compileOverlay={makeCompileOverlay()}
        resolveCaptionTemplate={(style) => `/tpl/${style}.jsx`}
        onSelectCaption={onSelectCaption}
      />,
    )

    await waitFor(() => expect(container.querySelector('[style*="z-index: 50"]')).not.toBeNull())
    const box = getSelectionBox(container)
    fireEvent.mouseDown(box, { clientX: 10, clientY: 10 })
    expect(onSelectCaption).toHaveBeenCalledWith('cap-0')
  })
})
