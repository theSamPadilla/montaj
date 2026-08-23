import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react'
import type {
  AnalyzeAudioPolishArgs,
  AudioPolishAnalysis,
  EditorAdapter,
  ImageElement,
  Project,
} from '../../types'
import type { VisualItem, VisualTrack } from '../../schema'
import { trackItems } from '../timeline/timeline-model'
import AudioPolishModal from '../AudioPolishModal'

afterEach(() => cleanup())

// ── Fixtures ─────────────────────────────────────────────────────────────────

function clip(over: Partial<VisualItem> = {}): VisualItem {
  return { id: 'a', type: 'video', src: '/f/a.mov', start: 0, end: 20, inPoint: 0, outPoint: 20, ...over }
}

function vtracks(...items: VisualItem[][]): VisualTrack[] {
  return items.map((its, i) => ({ id: `trk-${i}`, items: its }))
}

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: vtracks([clip()]),
    ...over,
  } as Project
}

type Handler = (args: AnalyzeAudioPolishArgs) => Promise<AudioPolishAnalysis>

/** Piece results the happy path returns. `silence-check` keeps `[0, 1]`, which
 *  does not overlap the silence removal at `[2, 3]`, so nothing is flagged. */
const defaultHandler: Handler = async args => {
  switch (args.piece) {
    case 'silence':
      return { piece: 'silence', removals: [{ start: 2, end: 3 }] }
    case 'fillers':
      return { piece: 'fillers', removals: [{ start: 5, end: 5.4, text: 'um' }] }
    case 'silence-check':
      return { piece: 'silence-check', keeps: [[0, 1]] }
    case 'loudness':
      return { piece: 'loudness', measuredI: -20, measuredTP: -3, measuredLRA: 5, targetI: -14, gainDb: 6 }
    case 'voice':
      return { piece: 'voice', vocalsPath: '/f/a_vocals.wav', url: 'https://host/a_vocals.wav' }
  }
}

interface Spy {
  adapter: EditorAdapter<Project>
  calls: AnalyzeAudioPolishArgs[]
  maxInflight: number
}

function makeAdapter(handler: Handler = defaultHandler): Spy {
  const spy: Spy = { calls: [], maxInflight: 0, adapter: null as unknown as EditorAdapter<Project> }
  let inflight = 0
  spy.adapter = {
    loadProject: vi.fn(),
    saveProject: vi.fn(),
    subscribe: () => () => {},
    render: async function* () {},
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => ''),
    fileUrl: (p: string) => `url:${p}`,
    analyzeAudioPolish: async (args: AnalyzeAudioPolishArgs) => {
      spy.calls.push(args)
      inflight += 1
      spy.maxInflight = Math.max(spy.maxInflight, inflight)
      try {
        // A few microtask turns so overlapping jobs are actually observable.
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        return await handler(args)
      } finally {
        inflight -= 1
      }
    },
  } as unknown as EditorAdapter<Project>
  return spy
}

interface Harness {
  spy: Spy
  /** The project the modal snapshotted on open. `buildDraft` returns it BY
   *  REFERENCE for an empty plan, so `toBe(baseline)` is an exact no-op test. */
  baseline: Project
  drafts: Project[]
  last: () => Project
  commit: ReturnType<typeof vi.fn>
  discardTransient: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
  mutateTransient: ReturnType<typeof vi.fn>
  rerenderWithProject: (p: Project) => void
}

function renderModal(opts: {
  project?: Project
  handler?: Handler
  selectionIds?: string[]
} = {}): Harness {
  const baseline = opts.project ?? makeProject()
  const spy = makeAdapter(opts.handler)
  const drafts: Project[] = []
  // The modal always pushes `() => draft`, so the argument it is applied to is
  // irrelevant; passing the baseline mirrors what useProjectSync would do.
  const mutateTransient = vi.fn((fn: (p: Project) => Project) => { drafts.push(fn(baseline)) })
  const commit = vi.fn(async () => {})
  const discardTransient = vi.fn()
  const onClose = vi.fn()

  const props = {
    projectId: 'p1',
    adapter: spy.adapter,
    selectionIds: opts.selectionIds,
    mutateTransient,
    commit,
    discardTransient,
    onClose,
  }

  const { rerender } = render(<AudioPolishModal {...props} project={baseline} />)

  return {
    spy,
    baseline,
    drafts,
    last: () => drafts[drafts.length - 1],
    commit,
    discardTransient,
    onClose,
    mutateTransient,
    rerenderWithProject: (p: Project) => rerender(<AudioPolishModal {...props} project={p} />),
  }
}

function setPiece(label: string, on: boolean) {
  const box = screen.getByRole('checkbox', { name: label }) as HTMLInputElement
  if (box.checked !== on) fireEvent.click(box)
}

async function analyse() {
  fireEvent.click(screen.getByRole('button', { name: /^Analyse/ }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Analyse again' })).toBeTruthy())
}

function firstTrackItems(p: Project): VisualItem[] {
  return trackItems(p)[0] ?? []
}

/** Total picture time on `tracks[0]`. A cut SPLITS a clip into fragments, so
 *  `items[0].end` is a fragment boundary, not the clip's end. */
function totalDuration(p: Project): number {
  return firstTrackItems(p).reduce((n, i) => n + (i.end - i.start), 0)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AudioPolishModal — analysis', () => {
  it('calls each enabled piece with its own arg shape, and skips disabled pieces', async () => {
    const h = renderModal()
    await analyse()

    const byPiece = (p: string) => h.spy.calls.filter(c => c.piece === p)

    expect(byPiece('silence')[0]).toEqual({
      projectId: 'p1', piece: 'silence', src: '/f/a.mov', window: { in: 0, out: 20 }, options: { language: 'en' },
    })
    expect(byPiece('fillers')[0]).toEqual({
      projectId: 'p1', piece: 'fillers', src: '/f/a.mov', window: { in: 0, out: 20 }, options: { language: 'en' },
    })
    expect(byPiece('loudness')[0]).toEqual({
      projectId: 'p1', piece: 'loudness', src: '/f/a.mov', window: { in: 0, out: 20 }, options: { targetLufs: -14 },
    })
    // The cross check is whole source: no window, no exposed options.
    expect(byPiece('silence-check')[0]).toEqual({ projectId: 'p1', piece: 'silence-check', src: '/f/a.mov' })
    // Voice is off by default.
    expect(byPiece('voice')).toHaveLength(0)
  })

  it('sends the chosen language through to the speech pieces', async () => {
    const h = renderModal()
    fireEvent.change(screen.getByLabelText('Spoken language'), { target: { value: 'es' } })
    await analyse()
    for (const c of h.spy.calls.filter(x => x.piece === 'silence' || x.piece === 'fillers')) {
      expect(c.options?.language).toBe('es')
    }
  })

  it('prefers the proxy for speech detection and the original for loudness and voice', async () => {
    const h = renderModal({
      project: makeProject({ tracks: vtracks([clip({ proxySrc: '/f/a_proxy.mp4' })]) }),
    })
    setPiece('Isolate voice', true)
    await analyse()

    for (const c of h.spy.calls) {
      if (c.piece === 'silence' || c.piece === 'fillers') expect(c.src).toBe('/f/a_proxy.mp4')
      else expect(c.src).toBe('/f/a.mov')
    }
  })

  it('derives the analysis window through the planner when outPoint is absent, speed included', async () => {
    // The fallback path, which is the one a hand-rolled copy of the mapping
    // would have owned. Trimmed AND sped up, so the speed factor has to be
    // applied: source 30 to 30 + (15 - 5) * 2.
    const noOutPoint: VisualItem = {
      id: 'a', type: 'video', src: '/f/a.mov', start: 5, end: 15, inPoint: 30, speed: 2,
    }
    const h = renderModal({ project: makeProject({ tracks: vtracks([noOutPoint]) }) })
    await analyse()

    const windowed = h.spy.calls.filter(c => c.window)
    expect(windowed.length).toBeGreaterThan(0)
    for (const c of windowed) expect(c.window).toEqual({ in: 30, out: 50 })
  })

  it('ignores a stale outPoint that is not past the in-point, rather than inverting the window', async () => {
    // `outPoint: 0` is finite, so a bare `??` would hand the step {in: 30, out: 0}.
    // Same hazard timeline-model.ts guards with `outPt > inPt`.
    const h = renderModal({
      project: makeProject({
        tracks: vtracks([clip({ start: 5, end: 15, inPoint: 30, outPoint: 0, speed: 2 })]),
      }),
    })
    await analyse()

    const windowed = h.spy.calls.filter(c => c.window)
    expect(windowed.length).toBeGreaterThan(0)
    for (const c of windowed) expect(c.window).toEqual({ in: 30, out: 50 })
  })

  it('prefers a stored outPoint, which is the real source window on a looping clip', async () => {
    // A 10s source looped across 30s of timeline. Deriving from `clip.end` here
    // would ask the step for source [0, 30] of a 10s file.
    const h = renderModal({
      project: makeProject({
        tracks: vtracks([clip({ start: 0, end: 30, inPoint: 0, outPoint: 10, loop: true })]),
      }),
    })
    await analyse()

    const windowed = h.spy.calls.filter(c => c.window)
    expect(windowed.length).toBeGreaterThan(0)
    for (const c of windowed) expect(c.window).toEqual({ in: 0, out: 10 })
  })

  it('caps analysis at two step calls in flight', async () => {
    const h = renderModal({
      project: makeProject({
        tracks: vtracks([
          clip({ id: 'a', src: '/f/a.mov', start: 0, end: 20 }),
          clip({ id: 'b', src: '/f/b.mov', start: 20, end: 40, inPoint: 0, outPoint: 20 }),
          clip({ id: 'c', src: '/f/c.mov', start: 40, end: 60, inPoint: 0, outPoint: 20 }),
        ]),
      }),
    })
    setPiece('Isolate voice', true)
    await analyse()

    expect(h.spy.calls.length).toBeGreaterThan(4)
    expect(h.spy.maxInflight).toBe(2)
  })

  it('runs the whole-source pieces once per distinct source, not once per clip', async () => {
    const h = renderModal({
      project: makeProject({
        tracks: vtracks([
          clip({ id: 'a', start: 0, end: 10, inPoint: 0, outPoint: 10 }),
          clip({ id: 'b', start: 10, end: 20, inPoint: 10, outPoint: 20 }),
        ]),
      }),
    })
    setPiece('Isolate voice', true)
    await analyse()

    expect(h.spy.calls.filter(c => c.piece === 'silence-check')).toHaveLength(1)
    expect(h.spy.calls.filter(c => c.piece === 'voice')).toHaveLength(1)
    expect(h.spy.calls.filter(c => c.piece === 'silence')).toHaveLength(2)
  })
})

describe('AudioPolishModal — review defaults', () => {
  it('ticks unflagged removals and leaves flagged ones unticked', async () => {
    // The cross check hears sound across [2.5, 4], which overlaps the proposed
    // silence removal at [2, 3] well past the tolerance.
    renderModal({
      handler: async args =>
        args.piece === 'silence-check'
          ? { piece: 'silence-check', keeps: [[2.5, 4]] }
          : defaultHandler(args),
    })
    await analyse()

    const silence = screen.getByRole('checkbox', { name: /Remove silence at/ }) as HTMLInputElement
    const filler = screen.getByRole('checkbox', { name: /Remove filler "um" at/ }) as HTMLInputElement
    expect(silence.checked).toBe(false)
    expect(filler.checked).toBe(true)
  })

  it('shows the flag reason on the flagged removal', async () => {
    renderModal({
      handler: async args =>
        args.piece === 'silence-check'
          ? { piece: 'silence-check', keeps: [[2.5, 4]] }
          : defaultHandler(args),
    })
    await analyse()
    expect(screen.getByText(/The independent silence check heard sound here/)).toBeTruthy()
  })

  it('flags a removal that lands on a caption word and says which check fired', async () => {
    renderModal({
      project: makeProject({
        captions: {
          style: 'pop',
          segments: [{ text: 'hello', start: 2.2, end: 2.6, words: [{ word: 'hello', start: 2.2, end: 2.6 }] }],
        },
      }),
    })
    await analyse()

    const silence = screen.getByRole('checkbox', { name: /Remove silence at/ }) as HTMLInputElement
    expect(silence.checked).toBe(false)
    expect(screen.getByText(/Overlaps a caption word\./)).toBeTruthy()
  })

  it('says the caption check did not run when the project has no captions', async () => {
    renderModal()
    await analyse()
    expect(screen.getByText(/no captions, so the caption word check did not run/)).toBeTruthy()
  })

  it('says the cross check did not run when it fails, and still offers the removals', async () => {
    renderModal({
      handler: async args => {
        if (args.piece === 'silence-check') throw new Error('ffmpeg missing')
        return defaultHandler(args)
      },
    })
    await analyse()

    expect(screen.getByText(/independent silence check could not run/)).toBeTruthy()
    const silence = screen.getByRole('checkbox', { name: /Remove silence at/ }) as HTMLInputElement
    expect(silence.checked).toBe(true)
  })
})

describe('AudioPolishModal — the transient preview', () => {
  it('pushes a draft with the clip material removed, and puts it back when unticked', async () => {
    const h = renderModal()
    setPiece('Remove filler words', false)
    setPiece('Match loudness', false)
    await analyse()

    await waitFor(() => expect(h.drafts.length).toBeGreaterThan(0))
    // [2, 3] removed, then the gap closed: a 20s clip becomes 19s.
    expect(totalDuration(h.last())).toBeCloseTo(19, 5)

    fireEvent.click(screen.getByRole('checkbox', { name: /Remove silence at/ }))
    await waitFor(() => expect(totalDuration(h.last())).toBeCloseTo(20, 5))
  })

  it('rebuilds from the baseline rather than the previous draft, so a re-tick is exact', async () => {
    const h = renderModal()
    setPiece('Remove filler words', false)
    setPiece('Match loudness', false)
    await analyse()

    const box = () => screen.getByRole('checkbox', { name: /Remove silence at/ })
    fireEvent.click(box())
    await waitFor(() => expect(totalDuration(h.last())).toBeCloseTo(20, 5))
    fireEvent.click(box())
    await waitFor(() => expect(totalDuration(h.last())).toBeCloseTo(19, 5))
    fireEvent.click(box())
    await waitFor(() => expect(totalDuration(h.last())).toBeCloseTo(20, 5))
    // One whole clip again, not a pair of fragments: a rebuild from the previous
    // draft rather than from the baseline would leave the clip split.
    expect(firstTrackItems(h.last())).toHaveLength(1)
  })

  it('rebuilds the draft when a piece is toggled off after analysis, with no re-analysis', async () => {
    const h = renderModal()
    await analyse()
    await waitFor(() => expect(h.drafts.length).toBeGreaterThan(0))
    expect(firstTrackItems(h.last())[0].volume).toBeDefined()

    const before = h.spy.calls.length
    setPiece('Match loudness', false)
    await waitFor(() => expect(firstTrackItems(h.last())[0].volume).toBeUndefined())
    expect(h.spy.calls.length).toBe(before)
  })

  it('re-derives the gain from the measurement when the loudness target changes, without re-analysing', async () => {
    const h = renderModal()
    setPiece('Remove silence', false)
    setPiece('Remove filler words', false)
    await analyse()

    await waitFor(() => expect(h.drafts.length).toBeGreaterThan(0))
    // min(target - measuredI, -1.5 - measuredTP) = min(-14 + 20, -1.5 + 3) = 1.5 dB.
    const atYoutube = firstTrackItems(h.last())[0].volume!
    const before = h.spy.calls.length

    fireEvent.change(screen.getByLabelText('Loudness target'), { target: { value: 'broadcast' } })
    await waitFor(() => expect(firstTrackItems(h.last())[0].volume).not.toBe(atYoutube))
    expect(h.spy.calls.length).toBe(before)
  })

  it('re-pushes its draft when an external frame lands over the preview', async () => {
    const h = renderModal()
    await analyse()
    await waitFor(() => expect(h.drafts.length).toBeGreaterThan(0))

    const pushes = h.mutateTransient.mock.calls.length
    const draftBefore = h.last()
    h.rerenderWithProject(makeProject({ id: 'p1' }))
    await waitFor(() => expect(h.mutateTransient.mock.calls.length).toBe(pushes + 1))
    // The very same draft object goes back, not the incoming frame.
    expect(h.last()).toBe(draftBefore)
  })
})

describe('AudioPolishModal — voice isolation', () => {
  it('mutes the clip and adds one stem track when voice is on', async () => {
    const h = renderModal()
    setPiece('Remove silence', false)
    setPiece('Remove filler words', false)
    setPiece('Isolate voice', true)
    await analyse()

    await waitFor(() => expect(h.drafts.length).toBeGreaterThan(0))
    const d = h.last()
    expect(firstTrackItems(d)[0].muted).toBe(true)
    expect(d.audio?.tracks.map(t => t.src)).toEqual(['/f/a_vocals.wav'])
  })

  it('mints one stem per surviving fragment when cuts split the clip', async () => {
    const h = renderModal()
    setPiece('Isolate voice', true)
    await analyse()

    await waitFor(() => expect(h.drafts.length).toBeGreaterThan(0))
    const d = h.last()
    // Two cuts leave three fragments; one audio track cannot follow all three,
    // so the planner mints one stem each.
    expect(firstTrackItems(d)).toHaveLength(3)
    expect(d.audio?.tracks ?? []).toHaveLength(3)
    expect(firstTrackItems(d).every(i => i.muted)).toBe(true)
  })

  it('offers an A/B preview of the original and the isolated voice', async () => {
    renderModal()
    setPiece('Isolate voice', true)
    await analyse()

    expect(screen.getByLabelText('Original audio for a.mov').getAttribute('src')).toBe('url:/f/a.mov')
    expect(screen.getByLabelText('Isolated voice for a.mov').getAttribute('src')).toBe('https://host/a_vocals.wav')
  })

  it('shows the skip badge on a sped-up clip and still offers the other three pieces', async () => {
    const h = renderModal({
      project: makeProject({ tracks: vtracks([clip({ speed: 2, outPoint: 40 })]) }),
    })
    setPiece('Isolate voice', true)
    await analyse()

    expect(screen.getByText('Voice isolation unavailable: this clip does not play at normal speed')).toBeTruthy()
    // The other three are still on the table for this clip.
    expect(screen.getByRole('checkbox', { name: /Remove silence at/ })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /Remove filler "um" at/ })).toBeTruthy()
    expect(screen.getByText(/Loudness: measured -20.0 LUFS/)).toBeTruthy()

    // And nothing was muted or stemmed on it.
    await waitFor(() => expect(h.drafts.length).toBeGreaterThan(0))
    expect(firstTrackItems(h.last()).some(i => i.muted)).toBe(false)
    expect(h.last().audio?.tracks ?? []).toEqual([])
  })
})

describe('AudioPolishModal — loudness column', () => {
  it('reports the measurement and the resulting gain', async () => {
    renderModal()
    await analyse()
    expect(screen.getByText(/measured -20.0 LUFS, true peak -3.0 dBTP\. Gain \+1.5 dB to reach -14 LUFS/)).toBeTruthy()
  })

  it('says so when the +6 dB ceiling clamps the gain', async () => {
    renderModal({
      handler: async args =>
        args.piece === 'loudness'
          ? { piece: 'loudness', measuredI: -40, measuredTP: -30, measuredLRA: 5, targetI: -14, gainDb: 26 }
          : defaultHandler(args),
    })
    await analyse()
    expect(screen.getByText(/Held at the \+6 dB ceiling/)).toBeTruthy()
  })
})

describe('AudioPolishModal — warnings and failures', () => {
  it('warns when a clip would lose more than 60% of its length', async () => {
    renderModal({
      handler: async args =>
        args.piece === 'silence'
          ? { piece: 'silence', removals: [{ start: 1, end: 16 }] }
          : defaultHandler(args),
    })
    await analyse()
    expect(screen.getByText(/would lose 77% of its length/)).toBeTruthy()
  })

  it('drops the warning again once enough removals are unticked', async () => {
    renderModal({
      handler: async args =>
        args.piece === 'silence'
          ? { piece: 'silence', removals: [{ start: 1, end: 16 }] }
          : defaultHandler(args),
    })
    await analyse()
    fireEvent.click(screen.getByRole('checkbox', { name: /Remove silence at/ }))
    await waitFor(() => expect(screen.queryByText(/would lose/)).toBeNull())
  })

  it('reports one piece failing inline and leaves the others usable', async () => {
    const h = renderModal({
      handler: async args => {
        if (args.piece === 'fillers') throw new Error('whisper model missing')
        return defaultHandler(args)
      },
    })
    await analyse()

    expect(screen.getByText(/fillers could not be analysed: whisper model missing/)).toBeTruthy()
    // Silence and loudness both survived.
    const silence = screen.getByRole('checkbox', { name: /Remove silence at/ }) as HTMLInputElement
    expect(silence.checked).toBe(true)
    expect(screen.getByText(/Loudness: measured -20.0 LUFS/)).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /Remove filler "/ })).toBeNull()

    await waitFor(() => expect(h.drafts.length).toBeGreaterThan(0))
    expect(firstTrackItems(h.last())[0].volume).toBeDefined()
  })
})

describe('AudioPolishModal — close paths', () => {
  it('Cancel discards the transient draft and never commits', async () => {
    const h = renderModal()
    await analyse()
    await waitFor(() => expect(h.drafts.length).toBeGreaterThan(0))

    const pushes = h.mutateTransient.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(h.discardTransient).toHaveBeenCalledTimes(1)
    expect(h.commit).not.toHaveBeenCalled()
    expect(h.onClose).toHaveBeenCalledTimes(1)
    expect(h.mutateTransient.mock.calls.length).toBe(pushes)
  })

  it('Cancel before any analysis touches nothing but discardTransient', () => {
    const h = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(h.mutateTransient).not.toHaveBeenCalled()
    expect(h.commit).not.toHaveBeenCalled()
    expect(h.discardTransient).toHaveBeenCalledTimes(1)
  })

  it('Escape discards, exactly like Cancel', () => {
    const h = renderModal()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(h.discardTransient).toHaveBeenCalledTimes(1)
    expect(h.commit).not.toHaveBeenCalled()
    expect(h.onClose).toHaveBeenCalledTimes(1)
  })

  it('the header close button discards', () => {
    const h = renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(h.discardTransient).toHaveBeenCalledTimes(1)
    expect(h.commit).not.toHaveBeenCalled()
  })

  it('Apply commits exactly once, even on a double click', async () => {
    const h = renderModal()
    await analyse()
    await waitFor(() => expect(h.drafts.length).toBeGreaterThan(0))

    const apply = screen.getByRole('button', { name: 'Apply' })
    fireEvent.click(apply)
    fireEvent.click(apply)

    expect(h.commit).toHaveBeenCalledTimes(1)
    expect(h.discardTransient).not.toHaveBeenCalled()
    expect(h.onClose).toHaveBeenCalledTimes(1)
  })

  it('Apply on a polish that changes nothing discards instead of committing', async () => {
    // Nothing found, and the two field-writing pieces off: the plan is empty, so
    // `buildDraft` hands back the baseline itself. Committing that would push an
    // undo entry whose undo does nothing visible.
    const h = renderModal({
      handler: async args =>
        args.piece === 'silence' || args.piece === 'fillers'
          ? { piece: args.piece, removals: [] }
          : defaultHandler(args),
    })
    setPiece('Match loudness', false)
    setPiece('Isolate voice', false)
    await analyse()

    // The preview is the baseline, by reference.
    await waitFor(() => expect(h.drafts.length).toBeGreaterThan(0))
    expect(h.last()).toBe(h.baseline)

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    // `commit` is the ONLY path here that pushes an undo snapshot
    // (use-project-sync.ts), so not calling it is what leaves canUndo unmoved.
    expect(h.commit).not.toHaveBeenCalled()
    expect(h.discardTransient).toHaveBeenCalledTimes(1)
    expect(h.onClose).toHaveBeenCalledTimes(1)
  })

  it('Apply still commits when the polish does change something', async () => {
    const h = renderModal()
    await analyse()
    await waitFor(() => expect(h.drafts.length).toBeGreaterThan(0))
    expect(h.last()).not.toBe(h.baseline)

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(h.commit).toHaveBeenCalledTimes(1)
    expect(h.discardTransient).not.toHaveBeenCalled()
  })

  it('Apply after unticking every removal discards, not commits', async () => {
    const h = renderModal()
    setPiece('Match loudness', false)
    setPiece('Isolate voice', false)
    await analyse()

    fireEvent.click(screen.getByRole('checkbox', { name: /Remove silence at/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Remove filler "um" at/ }))
    await waitFor(() => expect(h.last()).toBe(h.baseline))

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(h.commit).not.toHaveBeenCalled()
    expect(h.discardTransient).toHaveBeenCalledTimes(1)
  })

  it('Apply is unavailable until something has been analysed', () => {
    renderModal()
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('AudioPolishModal — UI copy', () => {
  it('renders no em dash in the setup phase', () => {
    renderModal()
    expect(document.body.textContent).not.toContain('—')
  })

  it('renders no em dash in the review phase, flags and warnings included', async () => {
    renderModal({
      project: makeProject({
        tracks: vtracks([clip({ speed: 2, outPoint: 40 })]),
        captions: {
          style: 'pop',
          segments: [{ text: 'hello', start: 1, end: 1.4 }],
        },
      }),
      handler: async args => {
        if (args.piece === 'silence') return { piece: 'silence', removals: [{ start: 1, end: 16 }] }
        if (args.piece === 'loudness') throw new Error('measure failed')
        return defaultHandler(args)
      },
    })
    setPiece('Isolate voice', true)
    await analyse()

    expect(screen.getByText(/could not be analysed/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('—')
  })
})

describe('AudioPolishModal — scope', () => {
  it('narrows to the selection when one is given', async () => {
    const h = renderModal({
      project: makeProject({
        tracks: vtracks([
          clip({ id: 'a', src: '/f/a.mov' }),
          clip({ id: 'b', src: '/f/b.mov', start: 20, end: 40 }),
        ]),
      }),
      selectionIds: ['b'],
    })
    await analyse()
    expect(new Set(h.spy.calls.map(c => c.src))).toEqual(new Set(['/f/b.mov']))
  })

  it('groups the review list by clip', async () => {
    renderModal({
      project: makeProject({
        tracks: vtracks([
          clip({ id: 'a', src: '/f/a.mov' }),
          clip({ id: 'b', src: '/f/b.mov', start: 20, end: 40 }),
        ]),
      }),
    })
    await analyse()

    const dialog = screen.getByRole('dialog', { name: 'Polish audio' })
    expect(within(dialog).getByText('a.mov')).toBeTruthy()
    expect(within(dialog).getByText('b.mov')).toBeTruthy()
    expect(within(dialog).getAllByRole('checkbox', { name: /Remove silence at/ })).toHaveLength(2)
  })
})


// The four `pieceSupported` reasons, byte-exact. Asserting the literal here and
// not importing the constants is deliberate: these are user-visible strings, and
// a test that imports them would keep passing through a silent reword.
const VOICE_SPEED = 'Voice isolation unavailable: this clip does not play at normal speed'
const VOICE_LOOP = 'Voice isolation unavailable: this clip loops, so the isolated audio would drift out of sync'
const SILENCE_LOOP = 'Silence removal unavailable: this clip loops, so cuts would land in the wrong place'
const FILLERS_LOOP = 'Filler removal unavailable: this clip loops, so cuts would land in the wrong place'

describe('AudioPolishModal — looping clips', () => {
  const looping = () => makeProject({
    tracks: vtracks([clip({ start: 0, end: 30, inPoint: 0, outPoint: 10, loop: true })]),
  })

  it('badges all three excluded pieces and still offers loudness', async () => {
    renderModal({ project: looping() })
    setPiece('Isolate voice', true)
    await analyse()

    expect(screen.getByText(SILENCE_LOOP)).toBeTruthy()
    expect(screen.getByText(FILLERS_LOOP)).toBeTruthy()
    expect(screen.getByText(VOICE_LOOP)).toBeTruthy()
    // Loudness needs no mapping, so it is not denied.
    expect(screen.getByText(/Loudness: measured -20.0 LUFS/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('—')
  })

  it('issues no silence, filler, cross check or voice job for a looping clip', async () => {
    const h = renderModal({ project: looping() })
    setPiece('Isolate voice', true)
    await analyse()

    expect(h.spy.calls.map(c => c.piece)).toEqual(['loudness'])
  })

  it('still applies the loudness gain to a looping clip', async () => {
    const h = renderModal({ project: looping() })
    await analyse()

    await waitFor(() => expect(h.drafts.length).toBeGreaterThan(0))
    expect(firstTrackItems(h.last())[0].volume).toBeDefined()
    // No cuts, so the clip is untouched apart from its level.
    expect(firstTrackItems(h.last())).toHaveLength(1)
    expect(h.last().audio?.tracks ?? []).toEqual([])
  })

  it('proposes no removals, so nothing is ticked and Apply discards', async () => {
    const h = renderModal({ project: looping() })
    setPiece('Match loudness', false)
    setPiece('Isolate voice', false)
    await analyse()

    expect(screen.queryByRole('checkbox', { name: /Remove silence at/ })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /Remove filler "/ })).toBeNull()
    await waitFor(() => expect(h.last()).toBe(h.baseline))

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(h.commit).not.toHaveBeenCalled()
    expect(h.discardTransient).toHaveBeenCalledTimes(1)
  })

  it('reports the LOOP reason on a clip that both loops and is sped up, never the speed one', async () => {
    renderModal({
      project: makeProject({
        tracks: vtracks([clip({ start: 0, end: 30, inPoint: 0, outPoint: 10, loop: true, speed: 2 })]),
      }),
    })
    setPiece('Isolate voice', true)
    await analyse()

    expect(screen.getByText(VOICE_LOOP)).toBeTruthy()
    // The whole point of the precedence: the speed wording must not appear at
    // all. Asserting only that the loop string is present would pass with both
    // rendered, which is the failure mode being guarded.
    expect(screen.queryByText(VOICE_SPEED)).toBeNull()
    expect(document.body.textContent).not.toContain(VOICE_SPEED)
  })

  it('still runs the whole-source jobs when a non-looping clip shares the source', async () => {
    // Availability is per clip, but `voice` and `silence-check` are whole-source
    // and shared. One looping clip must not suppress the job the other needs.
    const h = renderModal({
      project: makeProject({
        tracks: vtracks([
          clip({ id: 'a', start: 0, end: 30, inPoint: 0, outPoint: 10, loop: true }),
          clip({ id: 'b', start: 30, end: 40, inPoint: 0, outPoint: 10 }),
        ]),
      }),
    })
    setPiece('Isolate voice', true)
    await analyse()

    expect(h.spy.calls.filter(c => c.piece === 'silence-check')).toHaveLength(1)
    expect(h.spy.calls.filter(c => c.piece === 'voice')).toHaveLength(1)
    // ...but only the non-looping clip gets the per-clip speech jobs.
    expect(h.spy.calls.filter(c => c.piece === 'silence')).toHaveLength(1)
    expect(h.spy.calls.filter(c => c.piece === 'fillers')).toHaveLength(1)
  })
})
