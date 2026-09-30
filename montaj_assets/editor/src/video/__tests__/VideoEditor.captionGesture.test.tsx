import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, act, fireEvent } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { EditorAdapter, OverlayFactory, Project, RenderEvent, VersionEntry, WaveformChunk } from '../../types'
import type { ImageElement } from '../../types'
import type { CaptionSegment } from '../../schema'
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

// ── "Apply to all" ───────────────────────────────────────────────────────────
// The captions panel's checkbox. VideoEditor owns the value (remembered on this
// computer, never on the project) and hands it to the panel and the preview;
// on, a preview drag, a corner resize or the selected caption's text color
// lands on EVERY caption as the same absolute value, in one undo step.
//
// Driven through the real panel and the real preview, so it needs the two
// stubs `captionPositioning.test.tsx` documents: a ResizeObserver that reports
// a size (or the caption layer never renders) and a Range rect (or measuring
// the caption throws).
const APPLY_TO_ALL_KEY = 'montaj.editor.captionApplyToAll'
const RENDER_W = 1080
const RENDER_H = 1920

function fixedRect(left: number, top: number, right: number, bottom: number): DOMRect {
  return { left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) } as DOMRect
}

/** A caption template that paints the active segment's text as a real text node. */
function compileCaptionTemplate() {
  return vi.fn(async (): Promise<OverlayFactory> => {
    return (frame: number, fps: number, _duration: number, props: Record<string, unknown>): ReactElement | null => {
      const segments = (props.segments ?? []) as CaptionSegment[]
      const t = frame / fps
      const active = segments.find((seg) => t >= seg.start && t < seg.end)
      return active ? <div><span>{active.text}</span></div> : null
    }
  })
}

// Different starting geometry and color on every caption, so "the same
// absolute value" and "a delta" give different answers. s0 is on screen at 0s.
const variedCaptions = {
  style: 'clean',
  segments: [
    { id: 's0', text: 'zero', start: 0, end: 1, offsetX: 5, words: [{ word: 'zero', start: 0, end: 1 }] },
    { id: 's1', text: 'one', start: 1, end: 2, offsetY: -8, scale: 1.5, color: '#00ff00', words: [{ word: 'one', start: 1, end: 2 }] },
    { id: 's2', text: 'two', start: 2, end: 3, words: [{ word: 'two', start: 2, end: 3 }] },
  ],
}

describe('VideoEditor — captions "Apply to all"', () => {
  beforeEach(() => {
    window.localStorage.clear()
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      cb: (entries: unknown[]) => void
      constructor(cb: (entries: unknown[]) => void) { this.cb = cb }
      observe() { this.cb([{ contentRect: { width: RENDER_W, height: RENDER_H } }]) }
      unobserve() {}
      disconnect() {}
    }
    Range.prototype.getBoundingClientRect = vi.fn(() => fixedRect(100, 1700, 300, 1750))
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => fixedRect(0, 0, RENDER_W, RENDER_H))
  })
  afterEach(() => {
    delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
    window.localStorage.clear()
  })

  function mount() {
    const adapter = { ...makeFakeAdapter(), compileOverlay: compileCaptionTemplate() } as EditorAdapter<Project>
    const onProjectChange = vi.fn()
    const initial = makeVideoProject({ captions: variedCaptions } as Partial<Project>)
    const view = render(<VideoEditor project={initial} adapter={adapter} onProjectChange={onProjectChange} />)
    const segments = () => {
      const last = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
      return last.captions!.segments
    }
    const checkbox = () => view.getByRole('checkbox', { name: 'Apply to all' }) as HTMLInputElement
    const undoButton = () => view.getByLabelText('Undo') as HTMLButtonElement
    /** The preview's selection box: the caption layer's only interactive element. */
    const selectionBox = async () => {
      await waitFor(() => expect(view.container.querySelector('[style*="z-index: 50"]')).not.toBeNull())
      return view.container.querySelector('[style*="z-index: 50"]')!.firstElementChild as HTMLElement
    }
    /** Drag the on-screen caption (s0) by +10% of the frame on both axes. */
    const dragCaption = async () => {
      const box = await selectionBox()
      fireEvent.mouseDown(box, { clientX: 500, clientY: 500 })
      fireEvent.mouseMove(document, { clientX: 500 + 108, clientY: 500 + 192 })
      fireEvent.mouseUp(document)
    }
    /** Select s0 with a click, then pull its south-east corner out: scale × 1.2. */
    const resizeCaption = async () => {
      const box = await selectionBox()
      fireEvent.mouseDown(box, { clientX: 500, clientY: 500 })
      fireEvent.mouseUp(document)
      await waitFor(() => expect(box.children).toHaveLength(4))
      fireEvent.mouseDown(box.children[3], { clientX: 500, clientY: 500 })
      fireEvent.mouseMove(document, { clientX: 500 + 108, clientY: 500 + 192 })
      fireEvent.mouseUp(document)
    }
    /** Select s0 with a click, then pick a text color on the Format tab. */
    const recolorCaption = async (color: string) => {
      const box = await selectionBox()
      fireEvent.mouseDown(box, { clientX: 500, clientY: 500 })
      fireEvent.mouseUp(document)
      fireEvent.click(view.getByRole('button', { name: 'Format' }))
      const input = await view.findByLabelText('Selected segment text color')
      fireEvent.change(input, { target: { value: color } })
      fireEvent.blur(input, { target: { value: color } })
    }
    const undo = async () => {
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))
      })
    }
    return { ...view, adapter, onProjectChange, segments, checkbox, undoButton, dragCaption, resizeCaption, recolorCaption, undo }
  }

  it('is off by default, and nothing is stored until it is used', async () => {
    const { checkbox } = mount()
    await waitFor(() => expect(checkbox().checked).toBe(false))
    expect(window.localStorage.getItem(APPLY_TO_ALL_KEY)).toBeNull()
  })

  it('is remembered on this computer: the value is stored, and a fresh editor restores it', async () => {
    const first = mount()
    await waitFor(() => expect(first.checkbox().checked).toBe(false))
    fireEvent.click(first.checkbox())
    expect(first.checkbox().checked).toBe(true)
    expect(window.localStorage.getItem(APPLY_TO_ALL_KEY)).toBe('true')
    first.unmount()

    const second = mount()
    await waitFor(() => expect(second.checkbox().checked).toBe(true))
    fireEvent.click(second.checkbox())
    expect(second.checkbox().checked).toBe(false)
    expect(window.localStorage.getItem(APPLY_TO_ALL_KEY)).toBe('false')
    second.unmount()

    const third = mount()
    await waitFor(() => expect(third.checkbox().checked).toBe(false))
  })

  it('is never written to the project', async () => {
    const { checkbox, onProjectChange } = mount()
    await waitFor(() => expect(checkbox().checked).toBe(false))
    const before = onProjectChange.mock.calls.length
    fireEvent.click(checkbox())
    expect(onProjectChange.mock.calls.length).toBe(before)
  })

  it('falls back to off when the stored value is not a boolean, and when storage throws', async () => {
    window.localStorage.setItem(APPLY_TO_ALL_KEY, '"yes"')
    const bad = mount()
    await waitFor(() => expect(bad.checkbox().checked).toBe(false))
    bad.unmount()

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage denied') })
    const denied = mount()
    await waitFor(() => expect(denied.checkbox().checked).toBe(false))
    // A write that throws still toggles the checkbox for this session.
    fireEvent.click(denied.checkbox())
    expect(denied.checkbox().checked).toBe(true)
  })

  it('off: a preview drag moves only the dragged caption', async () => {
    const { dragCaption, segments } = mount()
    await dragCaption()
    await waitFor(() => expect(segments()[0]).toMatchObject({ id: 's0', offsetX: 15, offsetY: 10 }))
    expect(segments()[1]).toEqual(variedCaptions.segments[1])
    expect(segments()[2]).toEqual(variedCaptions.segments[2])
  })

  it('off: a corner resize sizes only the dragged caption', async () => {
    const { resizeCaption, segments } = mount()
    await resizeCaption()
    await waitFor(() => expect(segments()[0].scale).toBeCloseTo(1.2))
    expect(segments()[1]).toEqual(variedCaptions.segments[1])
    expect(segments()[2]).toEqual(variedCaptions.segments[2])
  })

  it('off: a text color pick colors only the selected caption', async () => {
    const { recolorCaption, segments } = mount()
    await recolorCaption('#123456')
    await waitFor(() => expect(segments().map(seg => seg.color)).toEqual(['#123456', '#00ff00', undefined]))
  })

  it('on: a preview drag gives every caption the same absolute position, and one undo reverts all of them', async () => {
    const { checkbox, dragCaption, segments, undoButton, undo } = mount()
    await waitFor(() => expect(checkbox().checked).toBe(false))
    fireEvent.click(checkbox())
    expect(undoButton().disabled).toBe(true)

    await dragCaption()
    // s0 started at offsetX 5, offsetY 0 and moved +10% on both axes. Every
    // caption lands on that same absolute spot, not on its own start plus 10.
    await waitFor(() => expect(segments().map(seg => [seg.offsetX, seg.offsetY])).toEqual([[15, 10], [15, 10], [15, 10]]))
    // A move writes position only: each caption keeps its own size.
    expect(segments().map(seg => seg.scale)).toEqual([undefined, 1.5, undefined])

    await waitFor(() => expect(undoButton().disabled).toBe(false))
    await undo()
    await waitFor(() => expect(segments()).toEqual(variedCaptions.segments))
    // Exactly one undo entry covered all three captions.
    await waitFor(() => expect(undoButton().disabled).toBe(true))
  })

  it('on: a corner resize gives every caption the same size, and one undo reverts all of them', async () => {
    const { checkbox, resizeCaption, segments, undoButton, undo } = mount()
    await waitFor(() => expect(checkbox().checked).toBe(false))
    fireEvent.click(checkbox())

    await resizeCaption()
    // s0 started at scale 1 and grew × 1.2. s1 started at 1.5; it takes 1.2,
    // the same absolute size, not 1.5 × 1.2.
    await waitFor(() => {
      const scales = segments().map(seg => seg.scale)
      expect(scales).toHaveLength(3)
      scales.forEach(scale => expect(scale).toBeCloseTo(1.2))
    })
    // A resize writes size only: each caption keeps its own position.
    expect(segments().map(seg => [seg.offsetX, seg.offsetY])).toEqual([[5, undefined], [undefined, -8], [undefined, undefined]])

    await undo()
    await waitFor(() => expect(segments()).toEqual(variedCaptions.segments))
    await waitFor(() => expect(undoButton().disabled).toBe(true))
  })

  it('on: a text color pick colors every caption, and one undo reverts all of them', async () => {
    const { checkbox, recolorCaption, segments, undoButton, undo } = mount()
    await waitFor(() => expect(checkbox().checked).toBe(false))
    fireEvent.click(checkbox())

    await recolorCaption('#123456')
    await waitFor(() => expect(segments().map(seg => seg.color)).toEqual(['#123456', '#123456', '#123456']))

    await undo()
    await waitFor(() => expect(segments()).toEqual(variedCaptions.segments))
    await waitFor(() => expect(undoButton().disabled).toBe(true))
  })

  it('on: a drag does not wipe a color pick that is still waiting on its blur', async () => {
    const view = mount()
    await waitFor(() => expect(view.checkbox().checked).toBe(false))
    fireEvent.click(view.checkbox())

    // Pick a color and leave the swatch focused: previewed, not yet committed.
    const box = view.container.querySelector('[style*="z-index: 50"]')!.firstElementChild as HTMLElement
    fireEvent.mouseDown(box, { clientX: 500, clientY: 500 })
    fireEvent.mouseUp(document)
    fireEvent.click(view.getByRole('button', { name: 'Format' }))
    const input = await view.findByLabelText('Selected segment text color')
    fireEvent.change(input, { target: { value: '#123456' } })
    await waitFor(() => expect(view.segments().map(seg => seg.color)).toEqual(['#123456', '#123456', '#123456']))

    await view.dragCaption()
    await waitFor(() => expect(view.segments().map(seg => [seg.offsetX, seg.offsetY])).toEqual([[15, 10], [15, 10], [15, 10]]))
    expect(view.segments().map(seg => seg.color)).toEqual(['#123456', '#123456', '#123456'])
  })

  // ── Undo after a live-previewed change ─────────────────────────────────────
  // The Format tab's swatches, slider and number boxes write every
  // intermediate value into the project as a preview (no save, no undo entry)
  // and commit once when the gesture ends. One undo must then put back the
  // value from BEFORE the gesture. It used to put back the previewed value,
  // which is the value just committed, so undo spent its entry and changed
  // nothing. Each test also pins what must not change: the preview still lands
  // live and is not itself an undo step, and the gesture is exactly one step.
  describe('undo after a live-previewed change', () => {
    /** The host's latest captions object, track fields and segments together. */
    const captionsOf = (view: ReturnType<typeof mount>) => {
      const calls = view.onProjectChange.mock.calls
      return (calls[calls.length - 1][0] as Project).captions as unknown as Record<string, unknown>
    }

    it('off: one undo restores the selected caption\'s color', async () => {
      const view = mount()
      await waitFor(() => expect(view.checkbox().checked).toBe(false))

      // Select s0, then pick a color and leave the swatch focused.
      const box = view.container.querySelector('[style*="z-index: 50"]')!.firstElementChild as HTMLElement
      fireEvent.mouseDown(box, { clientX: 500, clientY: 500 })
      fireEvent.mouseUp(document)
      fireEvent.click(view.getByRole('button', { name: 'Format' }))
      const input = await view.findByLabelText('Selected segment text color')
      fireEvent.change(input, { target: { value: '#123456' } })
      // The preview is live, on that caption only, and is not an undo step.
      await waitFor(() => expect(view.segments().map(seg => seg.color)).toEqual(['#123456', '#00ff00', undefined]))
      expect(view.undoButton().disabled).toBe(true)

      fireEvent.blur(input, { target: { value: '#123456' } })
      await waitFor(() => expect(view.undoButton().disabled).toBe(false))
      expect(view.segments().map(seg => seg.color)).toEqual(['#123456', '#00ff00', undefined])

      await view.undo()
      await waitFor(() => expect(view.segments()).toEqual(variedCaptions.segments))
      // Exactly one undo entry for the whole gesture.
      await waitFor(() => expect(view.undoButton().disabled).toBe(true))

      // And redo brings the pick back.
      fireEvent.click(view.getByLabelText('Redo'))
      await waitFor(() => expect(view.segments().map(seg => seg.color)).toEqual(['#123456', '#00ff00', undefined]))
    })

    // Track-level controls, with nothing selected. `end` is the event that
    // closes each control's gesture: a blur for a swatch or a number box, a
    // pointer release for the slider.
    const blurWith = (value: string) => (input: HTMLElement) => fireEvent.blur(input, { target: { value } })
    const trackControls = [
      { name: 'text color', label: 'Caption text color', typed: '#123456', end: blurWith('#123456'), field: 'color', value: '#123456' },
      { name: 'font size (box)', label: 'Caption font size', typed: '72', end: (input: HTMLElement) => fireEvent.blur(input), field: 'fontsize', value: 72 },
      { name: 'font size (slider)', label: 'Caption font size slider', typed: '72', end: (input: HTMLElement) => fireEvent.pointerUp(input), field: 'fontsize', value: 72 },
      { name: 'letter spacing', label: 'Caption letter spacing', typed: '0.2', end: (input: HTMLElement) => fireEvent.blur(input), field: 'letterSpacing', value: '0.2em' },
      { name: 'line height', label: 'Caption line height', typed: '1.5', end: (input: HTMLElement) => fireEvent.blur(input), field: 'lineHeight', value: 1.5 },
    ]

    it.each(trackControls)('one undo restores the track $name', async ({ label, typed, end, field, value }) => {
      const view = mount()
      await waitFor(() => expect(view.checkbox().checked).toBe(false))
      fireEvent.click(view.getByRole('button', { name: 'Format' }))
      const input = await view.findByLabelText(label)

      fireEvent.change(input, { target: { value: typed } })
      // The preview is live and is not an undo step.
      await waitFor(() => expect(captionsOf(view)[field]).toBe(value))
      expect(view.undoButton().disabled).toBe(true)

      end(input)
      await waitFor(() => expect(view.undoButton().disabled).toBe(false))
      expect(captionsOf(view)[field]).toBe(value)

      await view.undo()
      // The fixture sets none of these fields, so "restored" is "absent again".
      await waitFor(() => expect(captionsOf(view)).toEqual(variedCaptions))
      expect(captionsOf(view)[field]).toBeUndefined()
      // Exactly one undo entry for the whole gesture.
      await waitFor(() => expect(view.undoButton().disabled).toBe(true))

      // And redo brings the change back.
      fireEvent.click(view.getByLabelText('Redo'))
      await waitFor(() => expect(captionsOf(view)[field]).toBe(value))
    })

    it('off: a drag does not wipe a color pick that is still waiting on its blur, and one undo reverts both', async () => {
      const view = mount()
      await waitFor(() => expect(view.checkbox().checked).toBe(false))

      // Pick a color and leave the swatch focused: previewed, not yet committed.
      const box = view.container.querySelector('[style*="z-index: 50"]')!.firstElementChild as HTMLElement
      fireEvent.mouseDown(box, { clientX: 500, clientY: 500 })
      fireEvent.mouseUp(document)
      fireEvent.click(view.getByRole('button', { name: 'Format' }))
      const input = await view.findByLabelText('Selected segment text color')
      fireEvent.change(input, { target: { value: '#123456' } })
      await waitFor(() => expect(view.segments()[0].color).toBe('#123456'))

      // The drag's commit drops the pick's preview, but only after building
      // its project from what was on screen, so the pick survives it.
      await view.dragCaption()
      await waitFor(() => expect(view.segments()[0]).toMatchObject({ id: 's0', offsetX: 15, offsetY: 10, color: '#123456' }))
      expect(view.segments()[1]).toEqual(variedCaptions.segments[1])
      expect(view.segments()[2]).toEqual(variedCaptions.segments[2])

      // The drag's undo entry is the project from before the pick.
      await view.undo()
      await waitFor(() => expect(view.segments()).toEqual(variedCaptions.segments))
    })

    it('a gesture that changes nothing commits nothing: no undo entry and no save', async () => {
      const view = mount()
      await waitFor(() => expect(view.checkbox().checked).toBe(false))
      fireEvent.click(view.getByRole('button', { name: 'Format' }))

      fireEvent.blur(await view.findByLabelText('Caption font size'))
      fireEvent.pointerUp(view.getByLabelText('Caption font size slider'))
      fireEvent.blur(view.getByLabelText('Caption letter spacing'))
      fireEvent.blur(view.getByLabelText('Caption line height'))

      expect(view.undoButton().disabled).toBe(true)
      expect(view.adapter.saveProject).not.toHaveBeenCalled()
      expect(captionsOf(view)).toEqual(variedCaptions)
    })
  })
})
