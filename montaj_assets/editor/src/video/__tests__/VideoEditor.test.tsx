import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest'
import { render, waitFor, act, fireEvent } from '@testing-library/react'
import type {
  CaptionEvent,
  EditorAdapter,
  ImageElement,
  Project,
  RenderEvent,
  VersionEntry,
  WaveformChunk,
} from '../../types'
import type { Captions, VisualItem } from '../../schema'
import type { OverlayChanges } from '../preview/useDragOverlay'
import VideoEditor from '../VideoEditor'
import { CROSSFADE_COMMIT_DELAY_MS } from '../timeline/Timeline'
import { trackItems } from '../timeline/timeline-model'
import { dragCanvasItem, installCanvasHarness, selectCanvasItem } from '../timeline/__tests__/_canvasSelect'

// ── Fake adapter ──────────────────────────────────────────────────────────────
// Full EditorAdapter with the video-editor capabilities VideoEditor threads:
// listVersionHistory / restoreVersion / getWaveformChunks / compileOverlay /
// fileUrl / resolveCaptionTemplate. No host (`@/`) modules are mocked — the
// package owns the assembled editor.

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
  /** Push a server-authored SSE frame to every active subscriber. */
  emit: (project: Project) => void
  /** When true, saveProject() blocks until flushSaves() so a save stays pending. */
  setHoldSaves: (hold: boolean) => void
  /** Resolve every held saveProject() promise. */
  flushSaves: () => void
}

function makeFakeAdapter(): FakeAdapter {
  const saveCalls: Array<{ id: string; project: Project }> = []
  let subscribers: Array<(project: Project) => void> = []
  let holdSaves = false
  let saveResolvers: Array<() => void> = []
  return {
    loadProject: vi.fn(async () => makeVideoProject()),
    saveProject: vi.fn(async (id: string, project: Project) => {
      saveCalls.push({ id, project })
      if (holdSaves) await new Promise<void>((resolve) => saveResolvers.push(resolve))
    }),
    // Capture the sync core's frame callback so a test can drive SSE frames.
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
    restoreVersion: vi.fn(async (_id: string, _hash: string) => makeVideoProject()),
    getWaveformChunks: vi.fn(async (): Promise<WaveformChunk[]> => []),
    resolveCaptionTemplate: (style: string) => `/caption/${style}`,
    getInfo: vi.fn(async () => ({ root_skill_path: undefined })),
    saveCalls,
    emit: (project: Project) => { for (const s of [...subscribers]) s(project) },
    setHoldSaves: (hold: boolean) => { holdSaves = hold },
    flushSaves: () => { const r = saveResolvers; saveResolvers = []; r.forEach((res) => res()) },
  }
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

describe('VideoEditor — editor-package integration', () => {
  it('renders the timeline and preview for a draft project', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeVideoProject()
    const { container } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ pendingStatus: <div data-testid="pending" />, exportActions: <div data-testid="export" /> }}
      />,
    )

    // Timeline: the zoom control reads "1×" once totalDuration > 0.
    await waitFor(() => {
      expect(container.textContent).toContain('×')
    })
    // Preview: the video player mounts <video> elements for the clips.
    await waitFor(() => {
      expect(container.querySelector('video')).not.toBeNull()
    })
  })

  it('shows the host pendingStatus slot for a pending project', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeVideoProject({ status: 'pending', tracks: [{ id: 'trk-0', items: [] }] })
    const { getByTestId } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ pendingStatus: <div data-testid="pending" />, exportActions: <div data-testid="export" /> }}
      />,
    )
    await waitFor(() => getByTestId('pending'))
  })

  it('queries version history via adapter.listVersionHistory', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeVideoProject()
    render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ pendingStatus: <div data-testid="pending" />, exportActions: <div data-testid="export" /> }}
      />,
    )
    await waitFor(() => {
      expect(adapter.listVersionHistory).toHaveBeenCalledWith('vid-1')
    })
  })

  it('invokes onBackToSetup affordance only when the host supplies it', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeVideoProject({ status: 'pending', tracks: [{ id: 'trk-0', items: [] }] })
    const onBackToSetup = vi.fn()
    const { findByText } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        onBackToSetup={onBackToSetup}
      />,
    )
    const back = await findByText(/Back to setup/i)
    back.click()
    expect(onBackToSetup).toHaveBeenCalledTimes(1)
  })

  it('Render button flips project status to final and persists before opening modal', async () => {
    const adapter = makeFakeAdapter()
    const initial = makeVideoProject({ status: 'draft' })
    const onProjectChange = vi.fn()
    const { findByText } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={onProjectChange}
        slots={{ exportActions: <div /> }}
      />,
    )

    const renderBtn = await findByText('Render →')
    renderBtn.click()

    // onProjectChange should have been called with status: 'final'
    expect(onProjectChange).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'final' }),
    )
    // saveProject should have been called with status: 'final'
    await waitFor(() => {
      expect(adapter.saveProject).toHaveBeenCalledWith(
        'vid-1',
        expect.objectContaining({ status: 'final' }),
      )
    })
  })

  it('shows the skill-path card on the pending surface when getInfo returns a path', async () => {
    const adapter = makeFakeAdapter()
    adapter.getInfo = vi.fn(async () => ({ root_skill_path: 'skills/video-skill.md' }))
    const initial = makeVideoProject({ status: 'pending', tracks: [{ id: 'trk-0', items: [] }] })
    const { findByText } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        // no pendingStatus slot → should show default card
      />,
    )

    // The card header should appear
    await findByText(/Send this to your agent/i)
    // The copy-able prompt text should include the skill path
    await findByText(/skills\/video-skill\.md/i)
  })

  // `handleOverlayChange` (VideoEditor.tsx) is a private closure whose `changes`
  // param is typed as `OverlayChanges` (useDragOverlay.ts) and whose body is
  // exactly `{ ...item, ...changes }`. No control in the preview layer currently
  // drives a `props` payload through it — the crop modal only ever sends
  // sourceCrop/sourceWidth/sourceHeight, and drag/resize/rotate only ever send
  // offsetX/offsetY/scale/rotation — so there is no DOM path in this harness
  // that reaches a `props` change via a mounted <VideoEditor>. This test instead
  // exercises the real merge contract directly: `changes` is typed against the
  // actual `OverlayChanges` export (so `props` only compiles once useDragOverlay
  // declares it), and the assertion applies the identical spread
  // `handleOverlayChange` performs.
  it('handleOverlayChange merges a props payload into the matching item without touching other fields', () => {
    const item: VisualItem = {
      id: 'overlay-1',
      type: 'overlay',
      src: 'overlay.jsx',
      start: 0,
      end: 4,
      offsetX: 5,
      offsetY: 10,
      props: { text: 'Old text' },
    }
    const changes: OverlayChanges = { props: { text: 'New text' } }

    // Mirrors VideoEditor.tsx handleOverlayChange's item-update line exactly.
    const merged = { ...item, ...changes }

    expect(merged.props).toEqual({ text: 'New text' })
    expect(merged.offsetX).toBe(5)
    expect(merged.offsetY).toBe(10)
  })

  // ── Sync core adoption: undo/redo + SSE echo protection ──────────────────────
  // These drive the one reliable DOM-triggerable mutation (the Render button,
  // which flips status draft→final through sync.mutate) and then exercise the
  // shared save/undo core the editor now routes through.

  it('undo restores the pre-mutation project and re-persists it', async () => {
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    const { findByText } = render(
      <VideoEditor
        project={makeVideoProject({ status: 'draft' })}
        adapter={adapter}
        onProjectChange={onProjectChange}
        slots={{ exportActions: <div /> }}
      />,
    )

    // Mutation: Render flips status draft → final and persists via the queue.
    const renderBtn = await findByText('Render →')
    await act(async () => { renderBtn.click() })
    await waitFor(() => expect(adapter.saveCalls[adapter.saveCalls.length - 1]?.project.status).toBe('final'))

    // Undo (Cmd+Z): restores 'draft' AND enqueues a save of the restored state.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))
    })
    await waitFor(() => expect(adapter.saveCalls[adapter.saveCalls.length - 1]?.project.status).toBe('draft'))
    // Host is notified of the restored (draft) authoritative state.
    expect(onProjectChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'draft' }))
  })

  it('redo re-applies an undone mutation and re-persists it', async () => {
    const adapter = makeFakeAdapter()
    const { findByText } = render(
      <VideoEditor
        project={makeVideoProject({ status: 'draft' })}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ exportActions: <div /> }}
      />,
    )

    const renderBtn = await findByText('Render →')
    await act(async () => { renderBtn.click() })
    await waitFor(() => expect(adapter.saveCalls[adapter.saveCalls.length - 1]?.project.status).toBe('final'))

    // Undo back to draft…
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))
    })
    await waitFor(() => expect(adapter.saveCalls[adapter.saveCalls.length - 1]?.project.status).toBe('draft'))

    // …then Redo (Cmd+Shift+Z) re-applies 'final'.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true }))
    })
    await waitFor(() => expect(adapter.saveCalls[adapter.saveCalls.length - 1]?.project.status).toBe('final'))
  })

  it('does not clobber an optimistic edit with an SSE frame that arrives mid-save', async () => {
    const adapter = makeFakeAdapter()
    adapter.setHoldSaves(true) // saves hang so the mutation queue stays pending
    const onProjectChange = vi.fn()
    const { findByText } = render(
      <VideoEditor
        project={makeVideoProject({ status: 'draft', name: 'Original' })}
        adapter={adapter}
        onProjectChange={onProjectChange}
        slots={{ exportActions: <div /> }}
      />,
    )

    // Optimistic mutation: status → final. Its save is now in-flight (held).
    const renderBtn = await findByText('Render →')
    await act(async () => { renderBtn.click() })
    await waitFor(() =>
      expect(onProjectChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'final' })),
    )

    // A stale server frame arrives WHILE the save is pending. It must be deferred,
    // not applied — otherwise it would regress the optimistic 'final' edit.
    await act(async () => {
      adapter.emit(makeVideoProject({ status: 'draft', name: 'StaleServerFrame' }))
    })
    // Optimistic edit intact: still 'final', and the stale frame never reached the host.
    expect(onProjectChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'final' }))
    expect(onProjectChange).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'StaleServerFrame' }))

    // Once the save drains, the deferred frame is applied (last-write-wins).
    await act(async () => { adapter.flushSaves() })
    await waitFor(() =>
      expect(onProjectChange).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'StaleServerFrame' })),
    )
  })

  // Regression: a timeline gesture is ONE undo step, not one per mousemove.
  // `onProjectChange` (the per-move channel) used to be a full `sync.mutate`,
  // so dragging a clip across the timeline pushed dozens of undo entries and
  // Undo walked it back a few pixels at a time instead of returning it to where
  // the drag started. Drives the real DOM drag so the wiring is what's under
  // test, not the sync core (which already had transient/commit).
  it('undoes a whole drag in one step, not one step per mousemove', async () => {
    onTestFinished(installCanvasHarness())
    const adapter = makeFakeAdapter()
    const initial = makeVideoProject({
      tracks: [{
        id: 'trk-0',
        items: [
          { id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4, sourceDuration: 40 },
        ],
      }],
    })
    const { container } = render(
      <VideoEditor project={initial} adapter={adapter} slots={{ exportActions: <div /> }} />,
    )

    // Press, then travel in several steps — each one used to be its own undo
    // entry. `steps` defaults to 5, matching the DOM version's five mousemoves.
    dragCanvasItem(container, initial, { type: 'video' }, { dxPx: 300 })

    // The gesture moved the clip and persisted exactly one save for it.
    await waitFor(() => expect(adapter.saveCalls.length).toBeGreaterThan(0))
    const moved = adapter.saveCalls[adapter.saveCalls.length - 1].project.tracks![0].items[0]
    expect(moved.start).toBeGreaterThan(0)

    // ONE undo returns it all the way to the start — not to an intermediate
    // position partway through the drag.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))
    })
    await waitFor(() => {
      const after = adapter.saveCalls[adapter.saveCalls.length - 1].project.tracks![0].items[0]
      expect(after.start).toBe(0)
      expect(after.end).toBe(4)
    })
  })

  // Regression (now against the Content-tab commit model): the right panel's
  // Content tab previews an edit transiently through sync.mutateTransient — no
  // undo entry, no save — and commits it on the field's blur through
  // sync.commit() — exactly one undo entry + one queued save. This replaced
  // the floating OverlayPropsModal's Save/Cancel model (see VideoEditor.tsx's
  // `selectOverlayForEditing` comment): there is no Cancel any more, and no
  // pre-open snapshot for one to restore — Undo is the only revert path now,
  // and `editOriginalRef` (the stale pre-edit baseline the old version of this
  // test guarded surviving a Cancel) is deleted along with the modal, so that
  // exact bug is structurally impossible.
  //
  // The underlying risk it stood in for — a transient-gesture baseline
  // surviving stale across an external frame that lands between two gestures —
  // is a SYNC-CORE concern, not a VideoEditor-wiring one, and it is already
  // covered directly at that layer: see
  // src/state/__tests__/use-project-sync.test.tsx, describe('useProjectSync —
  // stale baseline regression'), `it('undo after a gesture that follows an
  // external frame restores the external state, not the stale pre-gesture
  // baseline', ...)`. That test drives mutateTransient → applyExternal
  // (mid-gesture) → mutateTransient → commit → undo directly against the hook,
  // which is a strictly better place to guard it (no modal, no DOM, no
  // dependency on VideoEditor's plumbing existing at all). This test's job is
  // narrower and DOM-specific: prove VideoEditor's Content-tab wiring
  // (previewOverlayProps → mutateTransient, commitOverlayEdit → sync.commit(),
  // fired on the field's change/blur) is correct.
  it('an overlay-props edit previews transiently, then commits on blur as one undo step', async () => {
    onTestFinished(installCanvasHarness())
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    const initial = makeVideoProject({
      name: 'Original',
      tracks: [
        { id: 'trk-0', items: [{ id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4 }] },
        { id: 'trk-1', items: [{ id: 'overlay-1', type: 'overlay', src: 'overlay.jsx', start: 0, end: 4, props: { text: 'Old text' } }] },
      ],
    })
    const { container, findByLabelText } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={onProjectChange}
        slots={{ exportActions: <div /> }}
      />,
    )

    // Select the overlay item — additive (metaKey) click, matching the DOM
    // version's modifier. Selecting IS opening it now (no Pencil/dialog step):
    // the right panel's Content tab shows the overlay's fields immediately —
    // see VideoEditor.tsx's `overlayPropertiesPanel` / `selectOverlayForEditing`.
    selectCanvasItem(container, initial, { type: 'overlay' }, { metaKey: true })
    const textField = await findByLabelText('text')

    // Preview an edit — mutateTransient baselines against the pre-gesture state.
    fireEvent.change(textField, { target: { value: 'Live preview' } })
    await waitFor(() => expect(onProjectChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tracks: expect.arrayContaining([
          expect.objectContaining({
            items: expect.arrayContaining([expect.objectContaining({ id: 'overlay-1', props: { text: 'Live preview' } })]),
          }),
        ]),
      }),
    ))

    // Still transient: nothing has been pushed to the undo stack yet, so Undo
    // here is a no-op — sync core's undo() pops an empty stack and returns
    // before touching project state, so onProjectChange doesn't fire again.
    const callsBeforeUndo = onProjectChange.mock.calls.length
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))
    })
    expect(onProjectChange.mock.calls.length).toBe(callsBeforeUndo)

    // Blur commits the gesture as ONE undo step. commit() doesn't itself
    // change project content (it only pushes the pre-gesture baseline and
    // queues a save), so the Undo right after is what proves the whole typing
    // gesture collapsed to exactly one entry — it lands all the way back on
    // the pre-edit text, not some intermediate preview.
    fireEvent.blur(textField)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))
    })
    await waitFor(() => expect(onProjectChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: 'Original',
        tracks: expect.arrayContaining([
          expect.objectContaining({
            items: expect.arrayContaining([expect.objectContaining({ id: 'overlay-1', props: { text: 'Old text' } })]),
          }),
        ]),
      }),
    ))
  })

  // Caption LANES are dense from 0 by contract — the bands the painter emits,
  // the row the hit-test addresses and the fan-out a cross-row drag searches
  // all assume it. A project.json written by hand or by an agent need not
  // honour that, so the same defensive pass that backfills ids normalizes
  // lanes on load.
  it('normalizes sparse caption lanes on load, and settles instead of looping', async () => {
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    render(
      <VideoEditor
        project={makeVideoProject({
          status: 'draft',
          captions: {
            style: 'clean',
            segments: [
              // `lane: 7` with nothing on lanes 1–6: eight rows of mostly
              // nothing unless this is collapsed to row 1.
              { id: 's0', text: 'one', start: 0, end: 1, lane: 7, words: [{ word: 'one', start: 0, end: 1 }] },
              { id: 's1', text: 'two', start: 1, end: 2, words: [{ word: 'two', start: 1, end: 2 }] },
            ],
          },
        } as Partial<Project>)}
        adapter={adapter}
        onProjectChange={onProjectChange}
        slots={{ exportActions: <div /> }}
      />,
    )

    await waitFor(() => {
      const last = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
      // s0 drops from 7 to 1; s1's absent lane already means 0 and is left
      // absent rather than rewritten.
      expect(last.captions?.segments.map((s) => s.lane)).toEqual([1, undefined])
    })

    // Settles: `normalizeCaptionLanes` hands back the same reference once the
    // lanes are dense, so the pass that follows its own applyExternal is a true
    // no-op rather than another write.
    const settledCallCount = onProjectChange.mock.calls.length
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(onProjectChange.mock.calls.length).toBe(settledCallCount)
  })

  it('never publishes a half-normalized project — ids and lanes land in one write', async () => {
    // Both defensive passes share ONE effect on purpose. Run as two effects
    // with the same deps they both close over the pre-effect project, so the
    // second applyExternal lands a project derived from before the first and
    // drops the ids the backfill just minted — recovered on the next pass, but
    // only after the host has already been handed that half-normalized frame.
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    render(
      <VideoEditor
        project={makeVideoProject({
          status: 'draft',
          captions: {
            style: 'clean',
            segments: [
              { text: 'one', start: 0, end: 1, lane: 4, words: [{ word: 'one', start: 0, end: 1 }] },
              { text: 'two', start: 1, end: 2, words: [{ word: 'two', start: 1, end: 2 }] },
            ],
          },
        } as Partial<Project>)}
        adapter={adapter}
        onProjectChange={onProjectChange}
        slots={{ exportActions: <div /> }}
      />,
    )

    await waitFor(() => {
      const last = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
      expect(last.captions?.segments.map((s) => s.id)).toEqual(['cap-0', 'cap-1'])
      expect(last.captions?.segments.map((s) => s.lane)).toEqual([1, undefined])
    })

    // Every frame the host saw is either the raw input or the finished result:
    // no frame has the lanes collapsed while the ids are still missing.
    for (const call of onProjectChange.mock.calls) {
      const segments = (call[0] as Project).captions?.segments ?? []
      if (segments.some((s) => s.lane === 1)) {
        expect(segments.every((s) => !!s.id)).toBe(true)
      }
    }
  })

  // Regression: the caption-repair effect (VideoEditor.tsx, near backfillCaptionIds)
  // used to be keyed on project.id ONLY, so it ran once per project load and never
  // again. CaptionRegenModal's onDone replaces project.captions via applyExternal
  // WITHOUT changing project.id, so a mid-session regeneration used to skip word
  // repair entirely until a remount. The effect is now also keyed on
  // project.captions.
  it('regenerating captions mid-session (no project.id change) re-runs word repair, and the effect settles instead of looping', async () => {
    const adapter = makeFakeAdapter()
    // Text has a double space between words and no words[] at all — this
    // exercises both "needs a repair pass" AND (via captionRepair.ts's
    // whitespace-normalized comparison) "the repair reaches a fixed point on
    // the very next pass", which is what stops the widened effect from
    // applyExternal-ing forever.
    adapter.generateCaptions = async function* (): AsyncIterable<CaptionEvent> {
      yield {
        type: 'done',
        captions: { style: 'clean', segments: [{ id: 's1', text: 'brand  new text', start: 0, end: 3 }] },
      }
    }
    const onProjectChange = vi.fn()
    const { findByText } = render(
      <VideoEditor
        project={makeVideoProject({ status: 'draft' })}
        adapter={adapter}
        onProjectChange={onProjectChange}
        slots={{ exportActions: <div /> }}
      />,
    )

    // This project starts with no captions, so the panel's trigger is the
    // empty state's "Generate captions" button; the two tests below seed a
    // caption track and therefore get "Regenerate captions" instead.
    const regenBtn = await findByText('Generate captions')
    await act(async () => { regenBtn.click() })

    // Repair fired for a captions-only replacement — words[] derived from the
    // (whitespace-collapsed) text, not left stale/absent.
    await waitFor(() => {
      const last = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
      expect(last.captions?.segments[0]?.words?.map((w) => w.word)).toEqual(['brand', 'new', 'text'])
    })

    // Settles: once repaired, flushing further ticks must produce no additional
    // onProjectChange calls — proves the effect reached its fixed point instead
    // of looping.
    const settledCallCount = onProjectChange.mock.calls.length
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(onProjectChange.mock.calls.length).toBe(settledCallCount)
  })

  // Round-trip regression: the caption pipeline (serve/routes/projects.py,
  // _run_caption_pipeline) writes the SAME freshly-regenerated track to two
  // places — the `done` frame on this fetch's own SSE response (read by
  // CaptionRegenModal → onDone → applyExternal), and project.json, broadcast
  // over the AMBIENT per-project stream (read by adapter.subscribe →
  // applyExternal). Those are two independent connections with no ordering
  // guarantee between them. Neither arrival order may leave project.captions
  // stale or half-merged — each segment already carries a fixed-point `words[]`
  // so the caption-repair effect is a no-op and doesn't obscure the assertion.
  const regeneratedTrack: Captions = {
    style: 'pop',
    segments: [{
      id: 's1',
      text: 'fresh take',
      start: 0,
      end: 1,
      words: [{ word: 'fresh', start: 0, end: 0.5 }, { word: 'take', start: 0.5, end: 1 }],
    }],
  }

  it('captions land as the new track when the ambient SSE broadcast arrives AFTER the done event', async () => {
    const adapter = makeFakeAdapter()
    adapter.generateCaptions = async function* (): AsyncIterable<CaptionEvent> {
      yield { type: 'done', captions: regeneratedTrack }
    }
    const onProjectChange = vi.fn()
    const { findByText } = render(
      <VideoEditor
        project={makeVideoProject({
          captions: { style: 'clean', segments: [{ id: 'old', text: 'stale', start: 0, end: 1 }] },
        } as Partial<Project>)}
        adapter={adapter}
        onProjectChange={onProjectChange}
        slots={{ exportActions: <div /> }}
      />,
    )

    const regenBtn = await findByText('Regenerate captions')
    await act(async () => { regenBtn.click() })

    await waitFor(() => {
      const last = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
      expect(last.captions).toEqual(regeneratedTrack)
    })

    // The server's whole-project broadcast for this SAME write lands next, on
    // the ambient stream — carrying the identical track. Must be a no-op.
    const afterDone = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
    await act(async () => {
      adapter.emit({ ...afterDone, captions: regeneratedTrack })
    })

    const final = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
    expect(final.captions).toEqual(regeneratedTrack)
  })

  it('captions land as the new track when the ambient SSE broadcast arrives BEFORE the done event resolves', async () => {
    const adapter = makeFakeAdapter()
    const baseProject = makeVideoProject({
      captions: { style: 'clean', segments: [{ id: 'old', text: 'stale', start: 0, end: 1 }] },
    } as Partial<Project>)
    adapter.generateCaptions = async function* (): AsyncIterable<CaptionEvent> {
      // Simulate the server writing + broadcasting project.json BEFORE this
      // request's own `done` frame is read — the two are separate connections
      // (POST response body vs. GET .../stream), and the route publishes the
      // broadcast strictly before it yields `done` (serve/routes/projects.py,
      // _run_caption_pipeline: broadcaster.publish(...) then `return track`,
      // ahead of the route's `yield f"event: done..."`).
      adapter.emit({ ...baseProject, captions: regeneratedTrack })
      yield { type: 'done', captions: regeneratedTrack }
    }
    const onProjectChange = vi.fn()
    const { findByText } = render(
      <VideoEditor
        project={baseProject}
        adapter={adapter}
        onProjectChange={onProjectChange}
        slots={{ exportActions: <div /> }}
      />,
    )

    const regenBtn = await findByText('Regenerate captions')
    await act(async () => { regenBtn.click() })

    await waitFor(() => {
      const last = onProjectChange.mock.calls[onProjectChange.mock.calls.length - 1][0] as Project
      expect(last.captions).toEqual(regeneratedTrack)
    })
  })

  // ── Version history: save / restore / compare (SP8b T8) ──────────────────────

  it('a completed render triggers listVersionHistory to be called again', async () => {
    const adapter = makeFakeAdapter()
    // Starting status is already 'final' — openRender always re-sets status to
    // 'final' (`{ ...project, status: 'final' }`), which for an
    // already-final project is the SAME primitive value. useVersionHistory's
    // auto-refetch effect is keyed on `project.status` by reference-equal
    // primitive, so it will NOT re-fire from that assignment here — isolating
    // this test to the refetch RenderModal's onRenderComplete triggers once
    // the fake adapter's render stream reaches its `done` event.
    const initial = makeVideoProject({ status: 'final' })
    const { findByText, findByRole } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ exportActions: <div /> }}
      />,
    )

    await waitFor(() => expect(adapter.listVersionHistory).toHaveBeenCalledTimes(1))

    const renderBtn = await findByText('Render →')
    await act(async () => { renderBtn.click() })

    // ReviewSurface always supplies `preRenderOptions`, so RenderModal opens on
    // its pre-render options dialog first — the render itself only starts once
    // the "Export" action inside that dialog is clicked.
    const startBtn = await findByRole('button', { name: 'Export' })
    await act(async () => { fireEvent.click(startBtn) })

    await waitFor(() => {
      expect(adapter.listVersionHistory).toHaveBeenCalledTimes(2)
    })
  })

  it('handleSaveVersion calls adapter.saveVersion and refetches history', async () => {
    const adapter = makeFakeAdapter()
    adapter.saveVersion = vi.fn(async () => [])
    const initial = makeVideoProject({ status: 'draft' })
    const { findByPlaceholderText, findByText } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ exportActions: <div /> }}
      />,
    )

    await waitFor(() => expect(adapter.listVersionHistory).toHaveBeenCalledTimes(1))

    const input = await findByPlaceholderText('Name (optional)')
    fireEvent.change(input, { target: { value: 'my checkpoint' } })
    const saveBtn = await findByText('Save version')
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(adapter.saveVersion).toHaveBeenCalledWith('vid-1', 'my checkpoint')
    })
    await waitFor(() => {
      expect(adapter.listVersionHistory).toHaveBeenCalledTimes(2)
    })
  })

  it('handleRestoreVersion refetches history after restore', async () => {
    const adapter = makeFakeAdapter()
    const versionEntry = { hash: 'abc123', message: 'version: run 1 — draft', timestamp: '2026-01-01T00:00:00Z' }
    adapter.listVersionHistory = vi.fn(async () => [versionEntry])
    const initial = makeVideoProject({ status: 'draft' })
    const { findByText } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ exportActions: <div /> }}
      />,
    )

    await waitFor(() => expect(adapter.listVersionHistory).toHaveBeenCalledTimes(1))

    const restoreBtn = await findByText('Restore →')
    fireEvent.click(restoreBtn)

    await waitFor(() => {
      expect(adapter.restoreVersion).toHaveBeenCalledWith('vid-1', 'abc123')
    })
    // Post-Phase-3 behavior: a restore refetches version history rather than
    // relying on the restored project's status to have changed.
    await waitFor(() => {
      expect(adapter.listVersionHistory).toHaveBeenCalledTimes(2)
    })
  })

  it('does not render the Compare button when adapter.versionFrameUrl is undefined', async () => {
    const adapter = makeFakeAdapter()
    const versionEntry = { hash: 'abc123', message: 'version: run 1 — draft', timestamp: '2026-01-01T00:00:00Z' }
    adapter.listVersionHistory = vi.fn(async () => [versionEntry])
    // adapter.versionFrameUrl is intentionally left undefined — makeFakeAdapter's default.
    const initial = makeVideoProject({ status: 'draft' })
    const { queryByText } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={vi.fn()}
        slots={{ exportActions: <div /> }}
      />,
    )

    await waitFor(() => expect(adapter.listVersionHistory).toHaveBeenCalled())

    expect(queryByText('Compare')).toBeNull()
  })

  // ── Derived OVERLAY crossfades: the wiring, not the function ─────────────
  //
  // `computeVisualCrossfade` (timeline-model.ts, unit-tested in
  // timeline/__tests__/timeline-model.test.ts) ships INERT without two call
  // sites, exactly as `computeAutoCrossfade` needs two: the gesture commit
  // (`commitTimelineEdit` here in VideoEditor) and Timeline.tsx's debounced
  // catch-all for overlay timing that changes without a gesture. One test each.
  //
  // Both assert on the ADAPTER's saveProject payload rather than on local
  // `onProjectChange` state, for the reason
  // VideoEditor.rippleDeleteCaptions.test.tsx records in full: only a real
  // commit reaches `saveProject`, so an assertion on client state can pass on
  // a transient preview that was never persisted.

  /** The `opacity` keyframe track on `itemId` in a saved project, wherever the
   *  item lives. `undefined` when the item carries no opacity curve at all. */
  function opacityTrackOf(project: Project, itemId: string) {
    for (const items of trackItems(project)) {
      const item = items.find((i) => i.id === itemId)
      if (item) return item.keyframes?.find((k) => k.prop === 'opacity')
    }
    return undefined
  }

  /** The item itself, for the span assertions. */
  function itemOf(project: Project, itemId: string): VisualItem | undefined {
    for (const items of trackItems(project)) {
      const item = items.find((i) => i.id === itemId)
      if (item) return item
    }
    return undefined
  }

  it('a trim that creates an overlay overlap commits the fade in ONE undo step', async () => {
    onTestFinished(installCanvasHarness())
    // Fake timers, never advanced: Timeline.tsx's debounced catch-all cannot
    // fire, so a fade in the saved project can ONLY have come from the gesture
    // commit. Without this the two call sites are indistinguishable.
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })

    const adapter = makeFakeAdapter()
    // The overlays start APART — the gesture is what creates the overlap.
    const initial = makeVideoProject({
      tracks: [
        {
          id: 'trk-0',
          items: [
            { id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10, sourceDuration: 40 },
          ],
        },
        {
          id: 'trk-1',
          items: [
            { id: 'ov-a', type: 'overlay', src: 'A.jsx', start: 0, end: 4 },
            { id: 'ov-b', type: 'overlay', src: 'B.jsx', start: 5, end: 9 },
          ],
        },
      ],
    })
    const { container } = render(
      <VideoEditor project={initial} adapter={adapter} slots={{ exportActions: <div /> }} />,
    )
    await act(async () => { await Promise.resolve() })

    // Drag ov-a's OUT edge from t=4 to t=6, so it runs 1s into ov-b. A trim on
    // a non-zero track is allowed past a neighbour's near boundary (a partial
    // overlap is a transition) but not past its far one.
    dragCanvasItem(container, initial, { id: 'ov-a' }, { fromTime: 4, toTime: 6 })
    await act(async () => { await Promise.resolve() })

    expect(adapter.saveCalls.length).toBe(1)
    const trimmed = adapter.saveCalls[0].project
    expect(itemOf(trimmed, 'ov-a')!.end).toBeCloseTo(6, 5)

    // ov-a fades 1 -> 0 across the overlap, in ITS OWN item-relative seconds.
    const fadeOut = opacityTrackOf(trimmed, 'ov-a')!
    expect(fadeOut.origin).toBe('crossfade')
    expect(fadeOut.points.length).toBe(2)
    expect(fadeOut.points[0]).toEqual({ t: 5, value: 1 })
    expect(fadeOut.points[1].value).toBe(0)
    expect(fadeOut.points[1].t).toBeCloseTo(6, 5)

    // ov-b fades 0 -> 1 across the same span, measured from ITS start (t=5).
    const fadeIn = opacityTrackOf(trimmed, 'ov-b')!
    expect(fadeIn.origin).toBe('crossfade')
    expect(fadeIn.points[0]).toEqual({ t: 0, value: 0 })
    expect(fadeIn.points[1].value).toBe(1)
    expect(fadeIn.points[1].t).toBeCloseTo(1, 5)

    // ONE undo takes back the trim AND its derived fade together. The audio
    // version of this bug recorded dozens of entries for a single drag; a
    // second undo being needed here, or either curve surviving the first, is
    // the regression.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))
    })
    expect(adapter.saveCalls.length).toBe(2)
    const undone = adapter.saveCalls[1].project
    expect(itemOf(undone, 'ov-a')!.end).toBe(4)
    expect(opacityTrackOf(undone, 'ov-a')).toBeUndefined()
    expect(opacityTrackOf(undone, 'ov-b')).toBeUndefined()
  })

  it('a ripple-delete that creates an overlay overlap commits a fade without a gesture', async () => {
    onTestFinished(installCanvasHarness())
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })

    const adapter = makeFakeAdapter()
    // Shift+Delete on clip-A (0-2s) shifts everything starting at or after 2s
    // left by 2s — across EVERY track. ov-b travels 4->2 while ov-a stays at
    // 0-4, so the two overlap by 2s without any pointer ever touching them.
    const initial = makeVideoProject({
      tracks: [
        {
          id: 'trk-0',
          items: [
            { id: 'clip-A', type: 'video', src: 'a.mp4', start: 0, end: 2, inPoint: 0, outPoint: 2 },
            { id: 'clip-B', type: 'video', src: 'a.mp4', start: 2, end: 6, inPoint: 2, outPoint: 6 },
          ],
        },
        {
          id: 'trk-1',
          items: [
            { id: 'ov-a', type: 'overlay', src: 'A.jsx', start: 0, end: 4 },
            { id: 'ov-b', type: 'overlay', src: 'B.jsx', start: 4, end: 8 },
          ],
        },
      ],
    })
    const { container } = render(
      <VideoEditor project={initial} adapter={adapter} slots={{ exportActions: <div /> }} />,
    )
    await act(async () => { await Promise.resolve() })

    selectCanvasItem(container, initial, { id: 'clip-A' })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', shiftKey: true }))
    })

    // `handleRippleDelete` goes straight to `sync.mutate` — it never passes
    // through `commitTimelineEdit`, so its own commit carries no fade. That is
    // precisely the hole the debounced pass fills.
    expect(adapter.saveCalls.length).toBe(1)
    const rippled = adapter.saveCalls[0].project
    expect(itemOf(rippled, 'ov-b')!.start).toBe(2)
    expect(opacityTrackOf(rippled, 'ov-a')).toBeUndefined()
    expect(opacityTrackOf(rippled, 'ov-b')).toBeUndefined()

    await act(async () => { vi.advanceTimersByTime(CROSSFADE_COMMIT_DELAY_MS) })

    expect(adapter.saveCalls.length).toBe(2)
    const faded = adapter.saveCalls[1].project
    expect(opacityTrackOf(faded, 'ov-a')!.points).toEqual([
      { t: 2, value: 1 }, { t: 4, value: 0 },
    ])
    expect(opacityTrackOf(faded, 'ov-b')!.points).toEqual([
      { t: 0, value: 0 }, { t: 2, value: 1 },
    ])

    // Idempotent: the pass re-runs off its own commit and must find nothing,
    // or it would commit forever.
    await act(async () => { vi.advanceTimersByTime(CROSSFADE_COMMIT_DELAY_MS * 4) })
    expect(adapter.saveCalls.length).toBe(2)
  })
})
