import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import type { Project } from '@/lib/types/schema'

// vi.hoisted so these mock fns exist before the vi.mock factories below run
// (both factories close over them) — same shape FootagePanel.test.tsx uses
// for the identical getSourceJobStatus mock. Each stub is typed against its
// REAL counterpart's signature (api.ts's getSourceJobStatus/saveProject,
// videoDuration.ts's probeVideoDuration) rather than a bare `vi.fn()` — a
// mock whose arity has drifted from the thing it stands in for is how a test
// stays green against an interface that no longer exists.
const { getSourceJobStatus, saveProject, probeVideoDuration } = vi.hoisted(() => ({
  getSourceJobStatus: vi.fn(async (_projectId: string, _jobId: string): Promise<{
    status: string
    phase?: string
    result?: unknown
    error?: string
  }> => ({ status: 'running' })),
  saveProject: vi.fn(async (_id: string, project: unknown) => project),
  probeVideoDuration: vi.fn(async (_file: File): Promise<number> => 0),
}))

vi.mock('@/lib/api', () => ({
  api: { getSourceJobStatus, saveProject },
}))

vi.mock('@/lib/videoDuration', () => ({
  probeVideoDuration,
}))

import { useTimelineImport } from '../timelineImport'

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    version: '0.2',
    id: 'proj-1',
    name: 'Test',
    workflow: 'clean_cut',
    status: 'draft',
    projectType: 'editing',
    editingPrompt: '',
    settings: { resolution: [1080, 1920], fps: 30 },
    sources: [],
    tracks: [{ id: 'trk-0', items: [] }],
    assets: [],
    ...overrides,
  } as unknown as Project
}

function videoFile(name = 'a.mp4'): File {
  return new File(['x'], name, { type: 'video/mp4' })
}

/** Wires up the hook with a ref/onProjectChange pair that behaves exactly
 *  like EditorPage's real ones: `onProjectChange` updates `projectRef.current`
 *  SYNCHRONOUSLY (see EditorPage.tsx's own `handleProjectChange`), which is
 *  what every callback in timelineImport.ts relies on reading fresh.
 *  `projectId` defaults to the initial project's own id (the common case,
 *  where the route matches whatever is open) — pass one explicitly, together
 *  with the returned `rerender`, to simulate a route navigation independent
 *  of `projectRef`. */
function setup(initialProject: Project, projectId: string | undefined = initialProject.id) {
  const projectRef = { current: initialProject } as MutableRefObject<Project | null>
  const onProjectChange = vi.fn((p: Project) => { projectRef.current = p })
  const ingestSource = vi.fn(async (_projectId: string, _input: { path: string } | File) => ({ jobId: 'job-1' }))
  const { result, rerender, unmount } = renderHook(
    ({ projectId }: { projectId: string | undefined }) =>
      useTimelineImport({ adapter: { ingestSource }, projectRef, onProjectChange, projectId }),
    { initialProps: { projectId } },
  )
  return { result, rerender, unmount, projectRef, onProjectChange, ingestSource }
}

beforeEach(() => {
  getSourceJobStatus.mockReset()
  saveProject.mockReset().mockResolvedValue(undefined)
  probeVideoDuration.mockReset()
  vi.spyOn(window, 'alert').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useTimelineImport', () => {
  it('imports a dropped file and places the real clip at the drop point using the job result\'s post-normalize src', async () => {
    vi.useFakeTimers()
    const project = makeProject()
    const { result, projectRef, ingestSource } = setup(project)
    probeVideoDuration.mockResolvedValue(8)
    getSourceJobStatus.mockResolvedValue({
      status: 'done',
      // Deliberately NOT the upload path — proves placement reads the job
      // result's src, not anything guessed from the dropped File.
      result: { id: 'clip-0', type: 'video', src: '/workspace/proj-1/normalized_a.mp4', start: 0, end: 8, sourceDuration: 8 },
    })

    await act(async () => {
      result.current.handleImportFilesToTimeline([videoFile('a.mp4')], { atTime: 5, preferredTrackIndex: -1, ripple: false })
      await vi.advanceTimersByTimeAsync(0)
    })
    // Ghost appears immediately, at the drop point, before the job resolves —
    // resolved onto the VIDEO row the clip will land on (the empty base row,
    // index 0, is a video candidate), NOT the raw "no preference" -1 the drop
    // carried. This is what keeps a ghost off an overlay/image row.
    expect(result.current.pendingDrops).toEqual([
      { id: expect.any(String), atTime: 5, durationSec: 8, trackIndex: 0, label: 'a.mp4' },
    ])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(ingestSource).toHaveBeenCalledWith('proj-1', expect.any(File))
    expect(getSourceJobStatus).toHaveBeenCalledWith('proj-1', 'job-1')

    const saved = projectRef.current!
    const items = saved.tracks![0].items
    expect(items).toHaveLength(1)
    expect(items[0].src).toBe('/workspace/proj-1/normalized_a.mp4')
    expect(items[0].start).toBe(5)
    expect(saveProject).toHaveBeenCalledWith('proj-1', saved)
    expect(result.current.pendingDrops).toHaveLength(0)
  })

  it('reconciles a source the SSE frame has NOT yet delivered, exactly once', async () => {
    vi.useFakeTimers()
    const project = makeProject({ sources: [] })
    const { result, projectRef } = setup(project)
    probeVideoDuration.mockResolvedValue(4)
    getSourceJobStatus.mockResolvedValue({
      status: 'done',
      result: { id: 'clip-0', type: 'video', src: '/w/n.mp4', start: 0, end: 4, sourceDuration: 4 },
    })

    await act(async () => {
      result.current.handleImportFilesToTimeline([videoFile()], { atTime: 0, preferredTrackIndex: -1, ripple: false })
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    const sources = projectRef.current!.sources ?? []
    expect(sources.filter(s => s.id === 'clip-0')).toHaveLength(1)
  })

  it('does not duplicate a source the SSE frame already delivered before the poll observed done', async () => {
    vi.useFakeTimers()
    const already = { id: 'clip-0', type: 'video' as const, src: '/w/n.mp4', start: 0, end: 4, sourceDuration: 4 }
    const project = makeProject({ sources: [already] })
    const { result, projectRef } = setup(project)
    probeVideoDuration.mockResolvedValue(4)
    getSourceJobStatus.mockResolvedValue({ status: 'done', result: already })

    await act(async () => {
      result.current.handleImportFilesToTimeline([videoFile()], { atTime: 0, preferredTrackIndex: -1, ripple: false })
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    const sources = projectRef.current!.sources ?? []
    expect(sources.filter(s => s.id === 'clip-0')).toHaveLength(1)
    // Reference-identical to the ORIGINAL sources array: proves no new entry
    // was appended at all (not just that de-duplication trimmed one back).
    expect(sources).toBe(project.sources)
  })

  it('shows a ghost on drop and removes it once the job errors, surfacing the failure', async () => {
    vi.useFakeTimers()
    const project = makeProject()
    const { result } = setup(project)
    probeVideoDuration.mockResolvedValue(6)
    getSourceJobStatus.mockResolvedValue({ status: 'error', error: 'ffmpeg exploded' })

    await act(async () => {
      result.current.handleImportFilesToTimeline([videoFile()], { atTime: 0, preferredTrackIndex: -1, ripple: false })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.pendingDrops).toHaveLength(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    expect(result.current.pendingDrops).toHaveLength(0)
    expect(window.alert).toHaveBeenCalledTimes(1)
    expect((window.alert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('ffmpeg exploded')
  })

  it('still runs the import when the local probe fails, but places no ghost and no clip', async () => {
    vi.useFakeTimers()
    const project = makeProject()
    const { result, projectRef, ingestSource } = setup(project)
    probeVideoDuration.mockRejectedValue(new Error('no moov atom'))
    getSourceJobStatus.mockResolvedValue({
      status: 'done',
      result: { id: 'clip-0', type: 'video', src: '/w/n.mp4', start: 0, end: 9, sourceDuration: 9 },
    })

    await act(async () => {
      result.current.handleImportFilesToTimeline([videoFile()], { atTime: 3, preferredTrackIndex: -1, ripple: false })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.pendingDrops).toHaveLength(0)
    expect(ingestSource).toHaveBeenCalledWith('proj-1', expect.any(File))

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    const saved = projectRef.current!
    expect(saved.tracks![0].items).toHaveLength(0) // nothing placed
    expect(saved.sources?.some(s => s.id === 'clip-0')).toBe(true) // but it IS in the bin
  })

  it('ignores a non-video file entirely', () => {
    const project = makeProject()
    const { result, ingestSource } = setup(project)

    act(() => {
      result.current.handleImportFilesToTimeline(
        [new File(['x'], 'notes.txt', { type: 'text/plain' })],
        { atTime: 0, preferredTrackIndex: -1, ripple: false },
      )
    })

    expect(ingestSource).not.toHaveBeenCalled()
    expect(result.current.pendingDrops).toHaveLength(0)
  })

  it('places two dropped files end-to-end from the drop point', async () => {
    vi.useFakeTimers()
    const project = makeProject()
    const { result, projectRef, ingestSource } = setup(project)
    probeVideoDuration.mockImplementation(async (file: File) => (file.name === 'a.mp4' ? 4 : 6))
    ingestSource.mockImplementation(async (_pid: string, input: { path: string } | File) => ({
      jobId: (input as File).name === 'a.mp4' ? 'job-a' : 'job-b',
    }))
    getSourceJobStatus.mockImplementation(async (_pid: string, jobId: string) =>
      jobId === 'job-a'
        ? { status: 'done', result: { id: 'clip-a', type: 'video', src: '/w/a.mp4', start: 0, end: 4, sourceDuration: 4 } }
        : { status: 'done', result: { id: 'clip-b', type: 'video', src: '/w/b.mp4', start: 0, end: 6, sourceDuration: 6 } },
    )

    await act(async () => {
      result.current.handleImportFilesToTimeline(
        [videoFile('a.mp4'), videoFile('b.mp4')],
        { atTime: 10, preferredTrackIndex: -1, ripple: false },
      )
      await vi.advanceTimersByTimeAsync(0)
    })
    // Second ghost butts against the end of the first: 10 + 4 = 14.
    expect(result.current.pendingDrops.map(d => ({ atTime: d.atTime, durationSec: d.durationSec }))).toEqual([
      { atTime: 10, durationSec: 4 },
      { atTime: 14, durationSec: 6 },
    ])

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    const items = projectRef.current!.tracks![0].items
    expect(items).toHaveLength(2)
    const bySrc = Object.fromEntries(items.map(i => [i.src, i.start]))
    expect(bySrc['/w/a.mp4']).toBe(10)
    expect(bySrc['/w/b.mp4']).toBe(14)
    expect(result.current.pendingDrops).toHaveLength(0)
  })

  it('drops a stale import when the project id changes before the job resolves', async () => {
    vi.useFakeTimers()
    const projectA = makeProject({ id: 'proj-a' })
    const { result, rerender, projectRef, onProjectChange } = setup(projectA, 'proj-a')
    probeVideoDuration.mockResolvedValue(5)

    // Hangs until resolved manually, so the test controls exactly when the
    // "done" tick lands relative to the project switch below.
    let resolveStatus: (v: { status: string; result?: unknown }) => void = () => {}
    getSourceJobStatus.mockImplementation(
      () => new Promise(resolve => { resolveStatus = resolve }),
    )

    await act(async () => {
      result.current.handleImportFilesToTimeline([videoFile('a.mp4')], { atTime: 0, preferredTrackIndex: -1, ripple: false })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.pendingDrops).toHaveLength(1)

    // First poll tick fires and is now AWAITING getSourceJobStatus — in
    // flight, exactly like the real race the fix guards against.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(getSourceJobStatus).toHaveBeenCalledTimes(1)

    // The operator navigates to a DIFFERENT project. `projectRef` moves on
    // too — simulating an edit having already landed on the new project,
    // the "worse half" of the race the module doc describes — before the
    // in-flight tick above resolves.
    const projectB = makeProject({ id: 'proj-b' })
    projectRef.current = projectB
    rerender({ projectId: 'proj-b' })

    // The projectId-keyed effect clears every ghost immediately, well
    // before the in-flight tick even has a chance to resolve.
    expect(result.current.pendingDrops).toHaveLength(0)

    // NOW the stale tick's status resolves 'done'. It was already in flight
    // when the switch happened, so nothing could stop it from running.
    await act(async () => {
      resolveStatus({
        status: 'done',
        result: { id: 'clip-0', type: 'video', src: '/w/a.mp4', start: 0, end: 5, sourceDuration: 5 },
      })
      await vi.advanceTimersByTimeAsync(0)
    })

    // `commitIngestedClip` bails: the project it would write into ('proj-b')
    // isn't the one this import was dropped on ('proj-a').
    expect(onProjectChange).not.toHaveBeenCalled()
    expect(saveProject).not.toHaveBeenCalled()
    expect(result.current.pendingDrops).toHaveLength(0)
  })

  it('never lets two overlapping poll ticks both commit — exactly one placed clip and one save', async () => {
    vi.useFakeTimers()
    const project = makeProject()
    const { result, projectRef } = setup(project)
    probeVideoDuration.mockResolvedValue(4)

    // Resolves 2.5s after being CALLED — longer than the 1s poll cadence, so
    // a naive `setInterval` would already have fired a SECOND tick (at
    // 2000ms) before this first call even resolves.
    getSourceJobStatus.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve({
        status: 'done',
        result: { id: 'clip-0', type: 'video', src: '/w/a.mp4', start: 0, end: 4, sourceDuration: 4 },
      }), 2500)
    }))

    await act(async () => {
      result.current.handleImportFilesToTimeline([videoFile('a.mp4')], { atTime: 0, preferredTrackIndex: -1, ripple: false })
      await vi.advanceTimersByTimeAsync(0)
    })

    // Well past enough 1s cadences for a second (and third) overlapping tick
    // to have fired under the old `setInterval` behaviour, and past the
    // point every such tick's own 2.5s status call would have resolved.
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })

    expect(getSourceJobStatus).toHaveBeenCalledTimes(1)
    expect(saveProject).toHaveBeenCalledTimes(1)
    expect(projectRef.current!.tracks![0].items).toHaveLength(1)
  })

  it('does not start polling, or touch state, when the hook unmounts during the ingestSource upload', async () => {
    vi.useFakeTimers()
    const project = makeProject()
    const projectRef = { current: project } as MutableRefObject<Project | null>
    const onProjectChange = vi.fn((p: Project) => { projectRef.current = p })
    let resolveIngest: (v: { jobId: string }) => void = () => {}
    const ingestSource = vi.fn(() => new Promise<{ jobId: string }>(resolve => { resolveIngest = resolve }))
    probeVideoDuration.mockResolvedValue(4)

    const { result, unmount } = renderHook(
      ({ projectId }: { projectId: string | undefined }) =>
        useTimelineImport({ adapter: { ingestSource }, projectRef, onProjectChange, projectId }),
      { initialProps: { projectId: project.id } },
    )

    await act(async () => {
      result.current.handleImportFilesToTimeline([videoFile()], { atTime: 0, preferredTrackIndex: -1, ripple: false })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(ingestSource).toHaveBeenCalledTimes(1)

    // Unmount WHILE the upload is still in flight — before any poll timer
    // has been registered.
    unmount()

    // The upload finally resolves after the unmount.
    await act(async () => {
      resolveIngest({ jobId: 'job-1' })
      await vi.advanceTimersByTimeAsync(0)
    })

    // Advance well past several poll cadences: a timer that HAD been
    // registered would have fired by now and called getSourceJobStatus.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(getSourceJobStatus).not.toHaveBeenCalled()
  })

  it("starts every file's upload immediately without waiting on a slower probe ahead of it, while keeping ghosts and placement in strict drop order", async () => {
    vi.useFakeTimers()
    const project = makeProject()
    const { result, ingestSource } = setup(project)

    let resolveA: (v: number) => void = () => {}
    probeVideoDuration.mockImplementation((file: File) =>
      file.name === 'a.mp4'
        ? new Promise<number>(resolve => { resolveA = resolve }) // hangs until resolved below
        : Promise.resolve(6),
    )
    getSourceJobStatus.mockResolvedValue({ status: 'running' })

    await act(async () => {
      result.current.handleImportFilesToTimeline(
        [videoFile('a.mp4'), videoFile('b.mp4')],
        { atTime: 10, preferredTrackIndex: -1, ripple: false },
      )
      await vi.advanceTimersByTimeAsync(0)
    })

    // Both uploads started already — including a.mp4's, despite its OWN
    // probe still being unresolved. Uploads never wait on drop-order
    // position at all, so this holds regardless of which file's probe is
    // slow. This is the real guarantee this test protects.
    expect(ingestSource).toHaveBeenCalledWith('proj-1', expect.objectContaining({ name: 'a.mp4' }))
    expect(ingestSource).toHaveBeenCalledWith('proj-1', expect.objectContaining({ name: 'b.mp4' }))

    // But NEITHER ghost is up yet: b's own probe already resolved, but b is
    // SECOND in drop order, so its position depends on a's still-unknown
    // duration — drop order is preserved even though b "answered" first.
    expect(result.current.pendingDrops).toHaveLength(0)

    // Now let a's probe resolve.
    await act(async () => {
      resolveA(4)
      await vi.advanceTimersByTimeAsync(0)
    })

    // Both ghosts land in DROP order (a before b, a at the original drop
    // point, b butted against its end) — not resolution order, even though
    // b's probe settled first.
    expect(result.current.pendingDrops).toEqual([
      { id: expect.any(String), atTime: 10, durationSec: 4, trackIndex: 0, label: 'a.mp4' },
      { id: expect.any(String), atTime: 14, durationSec: 6, trackIndex: 0, label: 'b.mp4' },
    ])
  })

  it("does not strand a later file behind a middle file whose probe fails — it lands at the first file's end", async () => {
    vi.useFakeTimers()
    const project = makeProject()
    const { result, projectRef, ingestSource } = setup(project)
    probeVideoDuration.mockImplementation(async (file: File) => {
      if (file.name === 'a.mp4') return 4
      if (file.name === 'b.mp4') throw new Error('no moov atom') // b's local probe fails
      return 3 // c.mp4
    })
    ingestSource.mockImplementation(async (_pid: string, input: { path: string } | File) => ({
      jobId: `job-${(input as File).name}`,
    }))
    const jobResults: Record<string, { id: string; src: string; duration: number }> = {
      'job-a.mp4': { id: 'clip-a', src: '/w/a.mp4', duration: 4 },
      'job-b.mp4': { id: 'clip-b', src: '/w/b.mp4', duration: 9 }, // server probes it fine even though the LOCAL probe failed
      'job-c.mp4': { id: 'clip-c', src: '/w/c.mp4', duration: 3 },
    }
    getSourceJobStatus.mockImplementation(async (_pid: string, jobId: string) => {
      const r = jobResults[jobId]
      return { status: 'done', result: { id: r.id, type: 'video', src: r.src, start: 0, end: r.duration, sourceDuration: r.duration } }
    })

    await act(async () => {
      result.current.handleImportFilesToTimeline(
        [videoFile('a.mp4'), videoFile('b.mp4'), videoFile('c.mp4')],
        { atTime: 10, preferredTrackIndex: -1, ripple: false },
      )
      await vi.advanceTimersByTimeAsync(0)
    })

    // b's failed local probe contributes NO ghost and advances the running
    // cursor by ZERO — c (third in drop order) still lands right after a,
    // at 10 + 4 = 14, rather than deadlocking behind b's failure or being
    // pushed out to make room for it.
    expect(result.current.pendingDrops.map(d => ({ atTime: d.atTime, durationSec: d.durationSec, label: d.label }))).toEqual([
      { atTime: 10, durationSec: 4, label: 'a.mp4' },
      { atTime: 14, durationSec: 3, label: 'c.mp4' },
    ])
    // b's upload still ran despite its local probe failing (unchanged from
    // every other probe-failure path in this hook).
    expect(ingestSource).toHaveBeenCalledWith('proj-1', expect.objectContaining({ name: 'b.mp4' }))

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    const items = projectRef.current!.tracks![0].items
    const bySrc = Object.fromEntries(items.map(i => [i.src, i.start]))
    expect(bySrc['/w/a.mp4']).toBe(10)
    expect(bySrc['/w/c.mp4']).toBe(14)
    expect(items).toHaveLength(2) // b has no placement target
    // b still reaches the bin via `sources`, same as any other probe-less
    // import.
    expect(projectRef.current!.sources?.some(s => s.id === 'clip-b')).toBe(true)
  })
})
