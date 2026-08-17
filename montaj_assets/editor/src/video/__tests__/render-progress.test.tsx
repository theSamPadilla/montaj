import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, act, cleanup } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project, RenderStatus } from '../../types'
import RenderModal, { phaseLabel, phaseIndex, RENDER_PHASES, stepperPhases } from '../RenderModal'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('phaseLabel', () => {
  it('returns the exact user-facing label for each phase', () => {
    expect(phaseLabel('preparing')).toBe('Preparing')
    expect(phaseLabel('rendering')).toBe('Rendering graphics')
    expect(phaseLabel('captions')).toBe('Adding captions')
    expect(phaseLabel('encoding')).toBe('Encoding video')
    expect(phaseLabel('sdr_derive')).toBe('Deriving SDR')
    expect(phaseLabel('saving')).toBe('Saving to your library')
    expect(phaseLabel('done')).toBe('Done')
  })
})

describe('phaseIndex / RENDER_PHASES', () => {
  it('orders the phases preparing → done, with sdr_derive after encoding', () => {
    expect(RENDER_PHASES).toEqual([
      'preparing',
      'rendering',
      'captions',
      'encoding',
      'sdr_derive',
      'saving',
      'done',
    ])
  })

  it('returns the ordinal of each phase', () => {
    expect(phaseIndex('preparing')).toBe(0)
    expect(phaseIndex('rendering')).toBe(1)
    expect(phaseIndex('captions')).toBe(2)
    expect(phaseIndex('encoding')).toBe(3)
    expect(phaseIndex('sdr_derive')).toBe(4)
    expect(phaseIndex('saving')).toBe(5)
    expect(phaseIndex('done')).toBe(6)
  })
})

describe('stepperPhases', () => {
  it('hides sdr_derive unless the render actually derives an SDR file', () => {
    expect(stepperPhases()).not.toContain('sdr_derive')
    expect(stepperPhases({ export: 'auto' })).not.toContain('sdr_derive')
    expect(stepperPhases({ export: 'sdr' })).toContain('sdr_derive')
    expect(stepperPhases({ export: 'both' })).toContain('sdr_derive')
  })

  it('never lists the terminal done phase', () => {
    expect(stepperPhases({ export: 'both' })).not.toContain('done')
  })
})

// ── Component (poll-driven) ───────────────────────────────────────────────────

function baseAdapter(): EditorAdapter<Project> {
  return {
    loadProject: vi.fn(),
    saveProject: vi.fn(),
    subscribe: () => () => {},
    render: async function* () {},
    resolveImageSrc: (el: ImageElement) => el.src,
    compileOverlay: vi.fn(async () => () => null),
    listGlobalOverlays: vi.fn(async () => []),
    listSystemOverlays: vi.fn(async () => []),
    uploadFile: vi.fn(async () => ''),
    fileUrl: (p: string) => `/files?path=${p}`,
  } as unknown as EditorAdapter<Project>
}

const DONE_MEDIA = {
  id: 'm1',
  filename: 'x.mp4',
  contentType: 'video/mp4',
  url: 'https://r2/x.mp4',
}

describe('RenderModal (poll-driven)', () => {
  it('advances the active phase label and shows the R2 video on done', async () => {
    vi.useFakeTimers()

    const sequence: RenderStatus[] = [
      { status: 'running', phase: 'rendering' },
      { status: 'running', phase: 'captions' },
      { status: 'done', phase: 'done', media: [DONE_MEDIA] },
    ]
    let call = 0

    const adapter = baseAdapter()
    adapter.renderAsync = vi.fn(async () => ({ status: 'running' }))
    adapter.getRenderStatus = vi.fn(async () => sequence[Math.min(call++, sequence.length - 1)])

    render(
      <RenderModal adapter={adapter} projectId="vid-1" onClose={vi.fn()} />,
    )

    // Kick (renderAsync) + the immediate first poll resolve via microtasks → rendering.
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
    expect(screen.getByText('Rendering graphics')).toBeTruthy()

    // Next interval poll → captions.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    expect(screen.getByText('Adding captions')).toBeTruthy()

    // Next interval poll → done, video appears.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })

    vi.useRealTimers()
    await waitFor(() => {
      const video = document.querySelector('video')
      expect(video).toBeTruthy()
      expect(video?.getAttribute('src')).toBe('https://r2/x.mp4')
    })

    const download = screen.getByText('Download').closest('a')
    expect(download?.getAttribute('href')).toBe('https://r2/x.mp4')
    expect(download?.getAttribute('download')).toBe('x.mp4')
  })

  it('never renders raw-log or Copy UI', async () => {
    vi.useFakeTimers()
    const adapter = baseAdapter()
    adapter.renderAsync = vi.fn(async () => ({ status: 'running' }))
    adapter.getRenderStatus = vi.fn(async () => ({
      status: 'running',
      phase: 'rendering',
    } as RenderStatus))

    render(<RenderModal adapter={adapter} projectId="vid-1" onClose={vi.fn()} />)

    await act(async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2500)
    })

    expect(screen.queryByText('Copy')).toBeNull()
    expect(screen.queryByTitle('Copy logs')).toBeNull()
  })

  it('shows the error string and a Close button on error', async () => {
    vi.useFakeTimers()
    const adapter = baseAdapter()
    adapter.renderAsync = vi.fn(async () => ({ status: 'running' }))
    adapter.getRenderStatus = vi.fn(async () => ({
      status: 'error',
      error: 'sidecar exploded',
    } as RenderStatus))

    render(<RenderModal adapter={adapter} projectId="vid-1" onClose={vi.fn()} />)

    await act(async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2500)
    })

    expect(screen.getByText('sidecar exploded')).toBeTruthy()
    expect(screen.getByText('Close')).toBeTruthy()
  })

  it('surfaces an interrupted render when the server reports idle after kicking', async () => {
    vi.useFakeTimers()
    const adapter = baseAdapter()
    adapter.renderAsync = vi.fn(async () => ({ status: 'running' }))
    // Job lost server-side (e.g. sidecar restart mid-render) → status flips to idle.
    adapter.getRenderStatus = vi.fn(async () => ({ status: 'idle' } as RenderStatus))

    render(<RenderModal adapter={adapter} projectId="vid-1" onClose={vi.fn()} />)

    await act(async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2500)
    })

    expect(screen.getByText(/interrupted on the server/i)).toBeTruthy()
    expect(screen.getByText('Close')).toBeTruthy()
  })

  it('tolerates a transient poll failure and still completes', async () => {
    vi.useFakeTimers()
    // poll #1 throws (network blip), then it recovers and finishes. The modal
    // must NOT flip to "Render failed" on the transient throw — the render is
    // still running server-side.
    const steps: Array<() => RenderStatus> = [
      () => { throw new Error('Failed to fetch') },
      () => ({ status: 'running', phase: 'rendering' } as RenderStatus),
      () => ({ status: 'done', phase: 'done', media: [DONE_MEDIA] } as RenderStatus),
    ]
    let call = 0
    const adapter = baseAdapter()
    adapter.renderAsync = vi.fn(async () => ({ status: 'running' }))
    adapter.getRenderStatus = vi.fn(async () => steps[Math.min(call++, steps.length - 1)]())

    render(<RenderModal adapter={adapter} projectId="vid-1" onClose={vi.fn()} />)

    // Kick + the first poll (which throws) — still "Rendering…", not failed.
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
    expect(screen.queryByText('Render failed')).toBeNull()
    expect(screen.getByText('Rendering…')).toBeTruthy()

    // Subsequent polls recover → running → done.
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })

    vi.useRealTimers()
    await waitFor(() => {
      expect(document.querySelector('video')?.getAttribute('src')).toBe('https://r2/x.mp4')
    })
  })

  it('gives up only after sustained consecutive poll failures', async () => {
    vi.useFakeTimers()
    const adapter = baseAdapter()
    adapter.renderAsync = vi.fn(async () => ({ status: 'running' }))
    adapter.getRenderStatus = vi.fn(async () => { throw new Error('Failed to fetch') })

    render(<RenderModal adapter={adapter} projectId="vid-1" onClose={vi.fn()} />)

    // First poll throws — still running, NOT failed (one blip is tolerated).
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
    expect(screen.queryByText('Render failed')).toBeNull()

    // Keep failing past MAX_POLL_FAILURES (~12 × 2.5s) → terminal error.
    await act(async () => { await vi.advanceTimersByTimeAsync(2500 * 15) })
    expect(screen.getByText('Render failed')).toBeTruthy()
    expect(screen.getByText('Failed to fetch')).toBeTruthy()
  })
})

// ── Component (SSE fallback when poll methods absent) ──────────────────────────

describe('RenderModal (SSE fallback)', () => {
  it('falls back to render() when poll methods are absent', async () => {
    const adapter = baseAdapter()
    adapter.render = async function* () {
      yield { type: 'done' as const, outputPath: '/out/final.mp4' }
    }

    render(<RenderModal adapter={adapter} projectId="vid-1" onClose={vi.fn()} />)

    await waitFor(() => {
      const video = document.querySelector('video')
      expect(video).toBeTruthy()
      expect(video?.getAttribute('src')).toBe('/files?path=/out/final.mp4')
    })
  })
})
