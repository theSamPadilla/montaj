import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── montajAdapter: render options + sample frames ────────────────────────────
// The RenderModal's HDR options (export choice + SDR tone curve) reach the
// backend through `render`, since this host implements only the streaming
// transport. `getSampleFrame` powers the modal's curve thumbnails.

const SAMPLE_PATH = '/ws/proj-1/sdr_sample_20260817_a1b2c3.png'

// Hoisted so the vi.mock factory (which runs before module-level consts are
// initialized) can close over the same spies these tests assert on.
const { reservePath, runStepAsync, renderProject, renderStatus } = vi.hoisted(() => {
  const SAMPLE = '/ws/proj-1/sdr_sample_20260817_a1b2c3.png'
  return {
    reservePath: vi.fn(async (_projectId: string, _body: { prefix: string; extension: string }) => ({
      path: SAMPLE,
    })),
    runStepAsync: vi.fn(async (_name: string, _params: Record<string, unknown>) => ({
      path: SAMPLE,
      type: 'image',
    })),
    renderProject: vi.fn(async (
      _id: string,
      _onLog: (line: string) => void,
      onDone: (outputPath: string) => void,
      _onError: (msg: string) => void,
      _opts?: { export?: string; sdrCurve?: string },
    ) => {
      onDone('/ws/proj-1/render/final.mp4')
      return () => {}
    }),
    renderStatus: vi.fn(async (_id: string) => ({
      status: 'done',
      outputPath: '/ws/proj-1/render/final.mp4',
      outputPaths: ['/ws/proj-1/render/final.mp4', '/ws/proj-1/render/final-sdr.mp4'],
    })),
  }
})

vi.mock('@/lib/api', () => ({
  api: { reservePath, runStepAsync, renderProject, renderStatus },
  fileUrl: (p: string) => `/api/files?path=${encodeURIComponent(p)}`,
}))

vi.mock('@/lib/overlay-eval', () => ({
  compileOverlay: vi.fn(async () => () => null),
  clearOverlayCache: vi.fn(),
}))

vi.mock('@/lib/file-watch', () => ({ watchWorkspaceFile: vi.fn(() => () => {}) }))
vi.mock('@/lib/sse', () => ({ subscribeProjectStream: vi.fn(() => () => {}) }))

import { createMontajAdapter } from '../montajAdapter'

beforeEach(() => {
  reservePath.mockClear()
  runStepAsync.mockClear()
  renderProject.mockClear()
  renderStatus.mockClear()
})

async function drain(iterable: AsyncIterable<unknown>) {
  const events: unknown[] = []
  for await (const ev of iterable) events.push(ev)
  return events
}

describe('montajAdapter.render', () => {
  it('forwards the export choice and SDR curve to the render request', async () => {
    const adapter = createMontajAdapter()
    await drain(adapter.render('proj-1', { export: 'both', sdrCurve: 'vivid1-neutral' }))

    expect(renderProject).toHaveBeenCalledTimes(1)
    expect(renderProject.mock.calls[0][0]).toBe('proj-1')
    expect(renderProject.mock.calls[0][4]).toEqual({ export: 'both', sdrCurve: 'vivid1-neutral' })
  })

  it('sends no export options when the caller passed none', async () => {
    const adapter = createMontajAdapter()
    await drain(adapter.render('proj-1'))

    expect(renderProject.mock.calls[0][4]).toEqual({ export: undefined, sdrCurve: undefined })
  })

  it('still streams the render events', async () => {
    const adapter = createMontajAdapter()
    const events = await drain(adapter.render('proj-1', { export: 'sdr' }))
    expect(events).toEqual([{ type: 'done', outputPath: '/ws/proj-1/render/final.mp4' }])
    // Non-both exports emit one file; no status round-trip needed.
    expect(renderStatus).not.toHaveBeenCalled()
  })

  it('a both export enriches the done event with the full outputPaths list', async () => {
    const adapter = createMontajAdapter()
    const events = await drain(adapter.render('proj-1', { export: 'both' }))
    expect(renderStatus).toHaveBeenCalledWith('proj-1')
    expect(events).toEqual([{
      type: 'done',
      outputPath: '/ws/proj-1/render/final.mp4',
      outputPaths: ['/ws/proj-1/render/final.mp4', '/ws/proj-1/render/final-sdr.mp4'],
    }])
  })

  it('a failed status fetch degrades a both export to the single-path done event', async () => {
    renderStatus.mockRejectedValueOnce(new Error('status route down'))
    const adapter = createMontajAdapter()
    const events = await drain(adapter.render('proj-1', { export: 'both' }))
    expect(events).toEqual([{ type: 'done', outputPath: '/ws/proj-1/render/final.mp4' }])
  })

  it('a single-path status snapshot degrades a both export to the plain done event', async () => {
    renderStatus.mockResolvedValueOnce({
      status: 'done', outputPath: '/ws/proj-1/render/final.mp4',
      outputPaths: ['/ws/proj-1/render/final.mp4'],
    })
    const adapter = createMontajAdapter()
    const events = await drain(adapter.render('proj-1', { export: 'both' }))
    expect(events).toEqual([{ type: 'done', outputPath: '/ws/proj-1/render/final.mp4' }])
  })
})

describe('montajAdapter.getSampleFrame', () => {
  it('reserves a path, runs sample_frame against the project, and returns a displayable URL', async () => {
    const adapter = createMontajAdapter()
    const { url } = await adapter.getSampleFrame!('proj-1', 4.5, { sdrCurve: 'vivid1-neutral' })

    expect(reservePath).toHaveBeenCalledWith('proj-1', { prefix: 'sdr_sample', extension: 'png' })
    expect(runStepAsync).toHaveBeenCalledWith('sample_frame', {
      // Derived from the reserved path, which always sits in the project dir.
      project: '/ws/proj-1/project.json',
      at: 4.5,
      out: SAMPLE_PATH,
      // Kebab-case: the step server matches body keys to declared param names.
      'sdr-curve': 'vivid1-neutral',
    })
    expect(url).toBe(`/api/files?path=${encodeURIComponent(SAMPLE_PATH)}`)
  })

  it('omits the curve param when the caller did not pick one', async () => {
    const adapter = createMontajAdapter()
    await adapter.getSampleFrame!('proj-1', 1)

    expect(Object.keys(runStepAsync.mock.calls[0][1] as object)).toEqual(['project', 'at', 'out'])
  })

  it('propagates a step failure so the caller can degrade', async () => {
    runStepAsync.mockRejectedValueOnce(new Error('sample_failed'))
    const adapter = createMontajAdapter()
    await expect(adapter.getSampleFrame!('proj-1', 1, { sdrCurve: 'vivid1' })).rejects.toThrow('sample_failed')
  })
})
