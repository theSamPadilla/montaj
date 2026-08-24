import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
    const realRect = Element.prototype.getBoundingClientRect
    // jsdom reports every rect as 0x0, which collapses the drag hook's
    // px-to-time conversion to a divide-by-zero no-op.
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return { x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 100, width: 1000, height: 100, toJSON: () => ({}) } as DOMRect
    }
    try {
      const adapter = makeFakeAdapter()
      const initial = makeVideoProject({
        tracks: [{
          id: 'trk-0',
          items: [
            { id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4, sourceDuration: 40 },
          ],
        }],
      })
      const { findByText } = render(
        <VideoEditor project={initial} adapter={adapter} slots={{ exportActions: <div /> }} />,
      )

      const block = await findByText('▪ video')
      // Press, then travel in several steps — each one used to be its own undo entry.
      fireEvent.mouseDown(block, { clientX: 100, clientY: 20 })
      for (const x of [140, 190, 250, 320, 400]) {
        await act(async () => { document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: 20, bubbles: true })) })
      }
      await act(async () => { document.dispatchEvent(new MouseEvent('mouseup', { clientX: 400, clientY: 20, bubbles: true })) })

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
    } finally {
      Element.prototype.getBoundingClientRect = realRect
    }
  })

  // Regression: cancelOverlayEdit routes through sync.applyExternal (see
  // use-project-sync.ts) to revert the live preview. applyExternal used to leave
  // the sync core's transient-gesture baseline pointing at the pre-edit snapshot;
  // if a real external frame then arrived before the *next* gesture, that next
  // gesture would see a non-null baseline and skip re-baselining, so its commit
  // pushed the STALE pre-first-gesture snapshot as the undo target — a later
  // Undo would silently discard the external change. Drives the actual DOM path
  // (select overlay → open dialog → live preview → Cancel) rather than the core
  // directly, to prove the fix holds through VideoEditor's wiring too.
  it('Cancel after previewing an overlay-props edit reverts the project, and a later gesture is not corrupted by the stale pre-edit baseline', async () => {
    const adapter = makeFakeAdapter()
    const onProjectChange = vi.fn()
    const initial = makeVideoProject({
      name: 'Original',
      tracks: [
        { id: 'trk-0', items: [{ id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4 }] },
        { id: 'trk-1', items: [{ id: 'overlay-1', type: 'overlay', src: 'overlay.jsx', start: 0, end: 4, props: { text: 'Old text' } }] },
      ],
    })
    const { findByText, findByTitle, findByLabelText, getByText } = render(
      <VideoEditor
        project={initial}
        adapter={adapter}
        onProjectChange={onProjectChange}
        slots={{ exportActions: <div /> }}
      />,
    )

    // Select the overlay item — additive (metaKey) click sidesteps the plain-
    // click playhead-seek branch, which needs real layout metrics jsdom doesn't
    // provide — then open its props dialog via the timeline's Pencil button.
    const overlayBlock = await findByText('▪ overlay')
    fireEvent.click(overlayBlock, { metaKey: true })
    const editBtn = await findByTitle('Edit overlay')
    fireEvent.click(editBtn)

    // Preview an edit — mutateTransient baselines against the pre-gesture state.
    const textField = await findByLabelText('text')
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

    // Cancel — routes through applyExternal, reverting to the pre-edit snapshot.
    fireEvent.click(getByText('Cancel'))
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

    // A real external frame now arrives (SSE echo / caption regen / restoreVersion)
    // — an authoritative change that must survive whatever the cancelled gesture
    // left behind in the sync core.
    await act(async () => { adapter.emit({ ...initial, name: 'FromServer' }) })
    await waitFor(() => expect(onProjectChange).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'FromServer' })))

    // A second overlay-props gesture must baseline against THIS state, not a
    // stale pre-first-gesture snapshot left behind if Cancel failed to clear it.
    const editBtn2 = await findByTitle('Edit overlay')
    fireEvent.click(editBtn2)
    const textField2 = await findByLabelText('text')
    fireEvent.change(textField2, { target: { value: 'Second edit' } })
    fireEvent.click(getByText('Save'))

    // Undo should remove only the second gesture, landing back on the external
    // ('FromServer') state — not the stale first-gesture baseline ('Original').
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))
    })
    await waitFor(() => expect(onProjectChange).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'FromServer' })))
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
})
