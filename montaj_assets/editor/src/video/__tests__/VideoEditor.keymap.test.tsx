import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, act, fireEvent, screen } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderEvent, VersionEntry, WaveformChunk } from '../../types'
import VideoEditor from '../VideoEditor'
import { trackItems } from '../timeline/timeline-model'

// ── T9 integration tests — the ReviewSurface keymap, the command palette,
// and the scrubber's "go to time" affordance, driven through a mounted
// <VideoEditor>. A minimal fake adapter is duplicated from VideoEditor.test.tsx
// (that file isn't touched — "existing tests unmodified") rather than shared.

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
      [{ id: 'overlay-1', type: 'overlay', src: 'overlay.jsx', start: 0, end: 4, props: { text: 'Hello' } }],
    ],
    audio: { tracks: [] },
    assets: [],
    ...overrides,
  } as Project
}

// T2 clipboard fixture: identical to `makeVideoProject`'s default tracks
// except `overlay-1` carries a distinguishing `opacity`, so a paste-attributes
// test can prove the TARGET actually picked up the SOURCE's look field
// (rather than merely asserting no error was thrown). Built the same way
// `makeVideoProject` builds its own default tracks (a whole-object `as
// Project` cast) rather than routed through `makeVideoProject`'s `overrides:
// Partial<Project>` parameter — the legacy array-of-arrays tracks shape isn't
// structurally assignable to `Partial<Project>`'s `VisualTrack[]`, even
// though `trackItems`/`normalizeTracks` accept both shapes at runtime.
function makeClipboardProject(): Project {
  return {
    ...makeVideoProject(),
    tracks: [
      [{ id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4 }],
      [{ id: 'overlay-1', type: 'overlay', src: 'overlay.jsx', start: 0, end: 4, props: { text: 'Hello' }, opacity: 0.4 }],
    ],
    // `as unknown as Project` (TS's own suggestion here): the legacy
    // array-of-arrays tracks shape isn't structurally assignable to `Project`'s
    // `VisualTrack[]`, even though `trackItems`/`normalizeTracks` accept both
    // shapes at runtime — same reason `makeVideoProject`'s own default tracks
    // only compile because its `...overrides: Partial<Project>` spread widens
    // the inferred literal type enough for a plain `as Project` to pass.
  } as unknown as Project
}

function makeFakeAdapter(): EditorAdapter<Project> {
  return {
    loadProject: vi.fn(async () => makeVideoProject()),
    saveProject: vi.fn(async () => {}),
    subscribe: () => () => {},
    render: async function* (): AsyncIterable<RenderEvent> { yield { type: 'done', outputPath: '/out.mp4' } },
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
  ;(globalThis as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement.prototype.play = vi.fn(async () => {}) as never
  ;(globalThis as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement.prototype.pause = vi.fn(() => {}) as never
  ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
    state = 'running'
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createMediaElementSource() { return { connect() {}, disconnect() {} } }
    get destination() { return {} }
    close() {}
  }
  // T5 fullscreen — jsdom has no real Fullscreen API. Stubbed so
  // `requestFullscreen`/`exitFullscreen` do the one thing VideoEditor relies
  // on (real browsers do this natively): flip `document.fullscreenElement`
  // and fire `fullscreenchange`, synchronously, so the effect that reads it
  // settles inside the same `act()` as the call that triggered it.
  ;(HTMLElement.prototype as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen =
    vi.fn(function (this: HTMLElement) {
      Object.defineProperty(document, 'fullscreenElement', { value: this, configurable: true })
      document.dispatchEvent(new Event('fullscreenchange'))
      return Promise.resolve()
    })
  document.exitFullscreen = vi.fn(() => {
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
    document.dispatchEvent(new Event('fullscreenchange'))
    return Promise.resolve()
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
})

async function selectOverlay() {
  const overlayBlock = await screen.findByText('▪ overlay')
  fireEvent.click(overlayBlock, { metaKey: true })
}

// A PLAIN click (no meta/shift) replaces the selection outright — see
// `toggleSelection` (multiSelectOps.ts): additive-false always resolves to
// `[id]`. Used by the T2 tests below to move the selection off the clipboard
// source and onto a distinct paste-attributes TARGET.
async function selectVideoClip() {
  const clipBlock = await screen.findByText('▪ video')
  fireEvent.click(clipBlock)
}

/** Timeline's own Delete/Enter bindings are focus-scoped to its root (the
 *  `tabIndex={0}` container) — see Timeline.tsx. Selecting via the preview
 *  (as `selectOverlay` does above) never touches that container, so a plain
 *  Delete needs focus established explicitly here, mirroring how a real
 *  operator would have clicked a timeline row first. It's the only
 *  `tabIndex={0}` element this tree renders (TimelineCanvas's own container
 *  uses `tabIndex={-1}`, and isn't mounted in DOM mode anyway). */
function focusTimelineRoot() {
  const root = document.querySelector('[tabindex="0"]') as HTMLElement | null
  root?.focus()
}

describe('VideoEditor — T9 ripple-delete binding', () => {
  it('Shift+Delete ripple-deletes the selected item and commits (persists) exactly once', async () => {
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    render(
      <VideoEditor
        project={makeVideoProject()}
        adapter={adapter}
        onProjectChange={onProjectChange}
        slots={{ exportActions: <div /> }}
      />,
    )
    await selectOverlay()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', shiftKey: true }))
    })

    await waitFor(() => {
      const last = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
      expect(last.tracks?.flat().find((i) => i.id === 'overlay-1')).toBeUndefined()
    })
    // Exactly one commit for the gesture — one save call.
    await waitFor(() => expect((adapter.saveProject as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1))
  })

  it('Shift+Delete with no selection is a no-op', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', shiftKey: true }))
    })
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('plain Delete (no Shift) still runs the ORIGINAL two-step delete, not ripple-delete', async () => {
    // Regression guard for the Shift-exclusion added to Timeline's delete
    // matcher (see keymap.ts's matchesDelete) — without it, plain Delete
    // would ALSO match a binding meant only for Shift+Delete, or vice versa.
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={onProjectChange} slots={{ exportActions: <div /> }} />)
    await selectOverlay()
    focusTimelineRoot()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', shiftKey: false }))
    })
    await waitFor(() => {
      const last = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
      expect(last.tracks?.flat().find((i) => i.id === 'overlay-1')).toBeUndefined()
    })
  })
})

describe('VideoEditor — T9 command palette', () => {
  it('Cmd+K opens the palette listing commands', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    })
    expect(await screen.findByText('Split at playhead')).toBeTruthy()
  })

  it('typing a filter letter into the palette does not also split the timeline', async () => {
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={onProjectChange} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    })
    const input = await screen.findByPlaceholderText('Type a command…')
    onProjectChange.mockClear()
    fireEvent.keyDown(input, { key: 's' })
    fireEvent.change(input, { target: { value: 's' } })
    // 's' typed into the palette's OWN input must filter, not split — split
    // would show up as an onProjectChange carrying a new track split at 0.
    expect(onProjectChange).not.toHaveBeenCalled()
  })

  it('Escape closes the palette', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    })
    const input = await screen.findByPlaceholderText('Type a command…')
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByPlaceholderText('Type a command…')).toBeNull())
  })

  it('clicking the scrubber time readout opens the palette directly in "go to time" mode', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    const readout = await screen.findByLabelText('Go to time')
    fireEvent.click(readout)
    expect(await screen.findByPlaceholderText(/mm:ss/)).toBeTruthy()
    // The list view's search box must NOT also be present — it opened
    // straight into goto mode, not the filtered list.
    expect(screen.queryByPlaceholderText('Type a command…')).toBeNull()
  })
})

describe('VideoEditor — T9 keymap does not race Space', () => {
  it('Space is never observed by the keymap (no palette, no split, no undo/redo side effect)', async () => {
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={onProjectChange} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')
    onProjectChange.mockClear()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }))
    })
    // No palette opened, no split committed as a side effect of Space.
    expect(screen.queryByPlaceholderText('Type a command…')).toBeNull()
    expect(onProjectChange).not.toHaveBeenCalled()
  })
})

// ── The preview-axis toggle ──────────────────────────────────────────────
//
// The gesture RULES are covered as pure data in `pointer-machine.test.ts`.
// What's only observable at this level is the chrome: the toggle exists, it
// starts off, and the toolbar button / Cmd+S / the palette all drive the same
// piece of state.

describe('VideoEditor — preview axis toggle', () => {
  it('starts OFF, so clicking the timeline does not scrub by default', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    expect(screen.getByLabelText('Preview axis').getAttribute('aria-pressed')).toBe('false')
  })

  it('the toolbar button toggles it', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    const button = screen.getByLabelText('Preview axis')
    fireEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  it('Cmd+A and Ctrl+A both toggle it — A for Axis', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    const button = screen.getByLabelText('Preview axis')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true }))
    })
    expect(button.getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))
    })
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  it('leaves Cmd+A alone inside a typing surface, so Select All still works there', async () => {
    // The chord shadows the browser's Select All everywhere EXCEPT text entry.
    // `isTypingTarget` is what draws that line, and a caption row is a real
    // contentEditable in this surface — regressing the guard would make it
    // impossible to select the text of a caption you are editing.
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    const input = document.createElement('input')
    document.body.appendChild(input)
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    })
    expect(screen.getByLabelText('Preview axis').getAttribute('aria-pressed')).toBe('false')
    input.remove()
  })

  it('bare A does nothing — the toggle is the chord, not the letter', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    })
    expect(screen.getByLabelText('Preview axis').getAttribute('aria-pressed')).toBe('false')
  })

  it('offers the toggle in the command palette, labelled by what it will do', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    })
    fireEvent.click(await screen.findByText('Preview axis: turn on'))
    expect(screen.getByLabelText('Preview axis').getAttribute('aria-pressed')).toBe('true')
  })
})

// ── T2 — copy / paste / duplicate / paste-attributes ────────────────────
//
// Persistence assertions read `adapter.saveProject`'s SECOND argument (the
// project actually being saved), not `onProjectChange` — an optimistic
// `onProjectChange` fire can't tell a real commit apart from a client-side
// normalizer patch that never saves (see the load-time id-backfill/caption-
// repair effects elsewhere in VideoEditor.tsx).

describe('VideoEditor — T2 copy/paste/duplicate', () => {
  it('Cmd+C never persists on its own — copying is local clipboard state only', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await selectVideoClip()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true }))
    })
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('Cmd+V with an empty clipboard is a no-op', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await selectVideoClip()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true }))
    })
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('Cmd+C then Cmd+V pastes a copy at the playhead and commits it exactly once', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await selectVideoClip()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true }))
    })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true }))
    })

    await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(1))
    const saved = (adapter.saveProject as ReturnType<typeof vi.fn>).mock.calls[0][1] as Project
    const videoItems = trackItems(saved).flat().filter((i) => i.type === 'video')
    // The original plus one pasted copy — a fresh id, not a re-used one.
    expect(videoItems).toHaveLength(2)
    expect(videoItems.map((i) => i.id)).toContain('clip-0')
    expect(videoItems.filter((i) => i.id !== 'clip-0')).toHaveLength(1)
  })

  it('Cmd+D with no selection is a no-op', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true }))
    })
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('Cmd+D duplicates the selection in place and commits it exactly once', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await selectVideoClip()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true }))
    })

    await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(1))
    const saved = (adapter.saveProject as ReturnType<typeof vi.fn>).mock.calls[0][1] as Project
    const videoItems = trackItems(saved).flat().filter((i) => i.type === 'video')
    expect(videoItems).toHaveLength(2)
    expect(videoItems.filter((i) => i.id !== 'clip-0')).toHaveLength(1)
  })

  it('Cmd+Opt+V with neither a clipboard nor a selection is a no-op', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeClipboardProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true, altKey: true }))
    })
    expect(adapter.saveProject).not.toHaveBeenCalled()
  })

  it('Cmd+Opt+V pastes ATTRIBUTES onto the selected target and does NOT fall through to a plain paste', async () => {
    // Regression guard for the binding-ORDER requirement in keymap.ts's
    // `matchesModAltKey` doc comment: `matchesModKey('v')` (plain paste)
    // doesn't exclude `altKey`, so Cmd+Opt+V matches BOTH bindings — only
    // registering paste-attributes FIRST in the `useKeymap` array makes it
    // win. Proven two ways at once: the target's `opacity` picks up the
    // clipboard source's value, AND no third item is created (a plain paste
    // would have added one).
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeClipboardProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await selectOverlay() // selects overlay-1 (opacity 0.4) — the copy SOURCE
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true }))
    })
    await selectVideoClip() // plain click replaces the selection with clip-0 — the TARGET

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true, altKey: true }))
    })

    await waitFor(() => expect(adapter.saveProject).toHaveBeenCalledTimes(1))
    const saved = (adapter.saveProject as ReturnType<typeof vi.fn>).mock.calls[0][1] as Project
    const allItems = trackItems(saved).flat()
    expect(allItems).toHaveLength(2) // unchanged — proves this was NOT a paste
    expect(allItems.find((i) => i.id === 'clip-0')?.opacity).toBe(0.4)
  })
})

// ── T5 — fullscreen preview ──────────────────────────────────────────────

describe('VideoEditor — T5 fullscreen preview', () => {
  it('starts out of fullscreen', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    expect(screen.getByLabelText('Toggle fullscreen').getAttribute('aria-pressed')).toBe('false')
  })

  it('F requests fullscreen on the preview, and F again exits it via document.exitFullscreen', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }))
    })
    expect(screen.getByLabelText('Toggle fullscreen').getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }))
    })
    expect(document.exitFullscreen).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Toggle fullscreen').getAttribute('aria-pressed')).toBe('false')
  })

  it('Cmd+F is left alone — F only fires unmodified, so native browser find still works', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }))
    })
    expect(screen.getByLabelText('Toggle fullscreen').getAttribute('aria-pressed')).toBe('false')
  })

  it('the fullscreen button in the preview controls row also toggles it', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    const button = screen.getByLabelText('Toggle fullscreen')
    fireEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  it('a browser-driven fullscreenchange (Escape, tab switch) updates state truthfully — no Escape handling of our own', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }))
    })
    expect(screen.getByLabelText('Toggle fullscreen').getAttribute('aria-pressed')).toBe('true')

    // The browser exits fullscreen entirely on its own here — VideoEditor's
    // own `exitFullscreen` mock is never called, only the native event fires.
    await act(async () => {
      Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true })
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    expect(screen.getByLabelText('Toggle fullscreen').getAttribute('aria-pressed')).toBe('false')
  })

  it('offers the toggle in the command palette, labelled by what it will do', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    })
    fireEvent.click(await screen.findByText('Enter fullscreen'))
    expect(screen.getByLabelText('Toggle fullscreen').getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    })
    expect(await screen.findByText('Exit fullscreen')).toBeTruthy()
  })
})

// ── Preview controls row — timecode, zoom-to-fit, safe-zone toggle ────────

describe('VideoEditor — preview controls row', () => {
  it('renders a current / total timecode readout that updates as the playhead moves', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    // makeVideoProject's clips run 0-4, so content duration is 4s.
    expect(screen.getByTestId('preview-timecode').textContent).toBe('0:00.0 / 0:04.0')

    // Seek via the command palette's "go to time" entry (clock.set under the
    // hood) — the readout's `usePlaybackTime(clock)` subscription should
    // pick the new position up without any other interaction.
    fireEvent.click(await screen.findByLabelText('Go to time'))
    const input = await screen.findByPlaceholderText(/mm:ss/)
    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(screen.getByTestId('preview-timecode').textContent).toBe('0:02.0 / 0:04.0'))
  })

  it('clamps the DISPLAYED current time to the total, never showing more than it, while parked in the timeline canvas headroom', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    // makeVideoProject's clips run 0-4 (content duration 4s), but the go-to-time
    // clamp uses `getTotalDuration()` — content duration plus drag headroom for
    // the timeline canvas (max(5, contentDuration * 0.2), so 9s here) — not the
    // 4s shown as the readout's total. Seeking to 6 lands the playhead PAST the
    // readout's total, entirely inside that headroom.
    fireEvent.click(await screen.findByLabelText('Go to time'))
    const input = await screen.findByPlaceholderText(/mm:ss/)
    fireEvent.change(input, { target: { value: '6' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // The readout must never show a current time past its own total — clamped
    // display only; the clock and total are untouched (proven by the sibling
    // test above landing exactly on an UN-clamped in-range seek).
    await waitFor(() => expect(screen.getByTestId('preview-timecode').textContent).toBe('0:04.0 / 0:04.0'))
  })

  it('the safe-zone toggle shows and hides the TikTok chrome overlay over the video, off by default', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    expect(screen.queryByTestId('social-safe-zone-overlay')).toBeNull()
    const toggle = screen.getByLabelText('Safe zone guide')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('social-safe-zone-overlay')).toBeTruthy()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByTestId('social-safe-zone-overlay')).toBeNull()
  })

  it('the zoom-to-fit button resets the timeline zoom via timelineActionsRef, same as the palette entry', async () => {
    const adapter = makeFakeAdapter()
    render(<VideoEditor project={makeVideoProject()} adapter={adapter} onProjectChange={vi.fn()} slots={{ exportActions: <div /> }} />)
    await screen.findByText('▪ overlay')

    expect(screen.getByLabelText('Zoom in').closest('div')?.textContent).toContain('1×')
    fireEvent.click(screen.getByLabelText('Zoom in'))
    expect(screen.getByLabelText('Zoom in').closest('div')?.textContent).toContain('2×')

    fireEvent.click(screen.getByLabelText('Zoom to fit'))
    expect(screen.getByLabelText('Zoom in').closest('div')?.textContent).toContain('1×')
  })
})
