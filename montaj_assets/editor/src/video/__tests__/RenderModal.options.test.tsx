import { StrictMode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import type { EditorAdapter, ImageElement, Project } from '../../types'
import RenderModal, { pickSampleTime } from '../RenderModal'

afterEach(cleanup)

// ── The Export dialog ─────────────────────────────────────────────────────────
// The modal historically fired the render on mount with no inputs. Hosts that
// pass `preRenderOptions` (montaj always does — HDR and SDR alike) now open on
// the Export dialog first; hosts that omit it keep the old fire-on-mount
// behavior exactly, which is the regression these tests pin.

function baseAdapter(): EditorAdapter<Project> {
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
    fileUrl: (p: string) => `/files?path=${p}`,
  } as unknown as EditorAdapter<Project>
}

/** An adapter on the poll transport (renderAsync + getRenderStatus). */
function pollAdapter(): EditorAdapter<Project> {
  const a = baseAdapter()
  a.renderAsync = vi.fn(async () => ({ status: 'running' }))
  a.getRenderStatus = vi.fn(async () => ({ status: 'running' as const, phase: 'rendering' as const }))
  return a
}

const KEEPS = [{ start: 0, end: 12 }]

// Query helpers that disambiguate the dialog title (heading) from the primary
// action (button), which share the label "Export".
const exportButton = () => screen.getByRole('button', { name: 'Export' })
const exportHeading = () => screen.getByRole('heading', { name: 'Export' })

describe('pickSampleTime', () => {
  it('lands inside the chosen keep, away from its edges', () => {
    const at = pickSampleTime([{ start: 10, end: 20 }], () => 0.5)!
    expect(at).toBeGreaterThan(10)
    expect(at).toBeLessThan(20)
    // Middle 60% band: 0.2 + 0.5 * 0.6 = 0.5 of the span.
    expect(at).toBeCloseTo(15, 5)
  })

  it('picks from the keeps it is given', () => {
    // rand() = 0 → first keep, earliest point of the sampling band.
    expect(pickSampleTime([{ start: 0, end: 10 }, { start: 100, end: 110 }], () => 0)).toBeCloseTo(2, 5)
  })

  it('returns null when there is nothing worth sampling', () => {
    expect(pickSampleTime(undefined)).toBeNull()
    expect(pickSampleTime([])).toBeNull()
    // Slivers are skipped — a frame from a 0.1s keep is not a useful sample.
    expect(pickSampleTime([{ start: 4, end: 4.1 }])).toBeNull()
  })
})

describe('RenderModal — fire-on-mount (no preRenderOptions)', () => {
  it('fires the render on mount when preRenderOptions is absent', async () => {
    const adapter = pollAdapter()
    render(<RenderModal adapter={adapter} projectId="vid-1" onClose={vi.fn()} />)

    await waitFor(() => expect(adapter.renderAsync).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('heading', { name: 'Export' })).toBeNull()
    expect(screen.getByText('Rendering…')).toBeTruthy()
  })

  it('passes no render options through when there was nothing to choose', async () => {
    const adapter = pollAdapter()
    render(<RenderModal adapter={adapter} projectId="vid-1" onClose={vi.fn()} />)

    await waitFor(() => expect(adapter.renderAsync).toHaveBeenCalledTimes(1))
    expect(adapter.renderAsync).toHaveBeenCalledWith('vid-1', undefined)
  })
})

describe('RenderModal — Export dialog', () => {
  it('opens for an HDR project and does NOT start the render', async () => {
    const adapter = pollAdapter()
    render(
      <RenderModal
        adapter={adapter}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: true, keeps: KEEPS }}
      />,
    )

    expect(exportHeading()).toBeTruthy()
    expect(screen.getByText('Match footage (HDR)')).toBeTruthy()
    expect(exportButton()).toBeTruthy()

    // Give any effect a chance to misfire before asserting it did not.
    await waitFor(() => expect(screen.getByText('Advanced')).toBeTruthy())
    expect(adapter.renderAsync).not.toHaveBeenCalled()
    expect(adapter.render).not.toHaveBeenCalled()
  })

  it('opens for an SDR project and hides the HDR-only controls', async () => {
    const adapter = pollAdapter()
    render(
      <RenderModal
        adapter={adapter}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: false, keeps: KEEPS, name: 'clip' }}
      />,
    )

    // The dialog shows, with Name + Save-to, but none of the HDR controls.
    expect(exportHeading()).toBeTruthy()
    expect(screen.getByText('Name')).toBeTruthy()
    expect(screen.getByText('Save to')).toBeTruthy()
    expect(screen.queryByText('Format')).toBeNull()
    expect(screen.queryByText('Match footage (HDR)')).toBeNull()
    expect(screen.queryByText('Image color')).toBeNull()
    expect(screen.queryByText('Advanced')).toBeNull()

    // Nothing renders until the user hits Export.
    await waitFor(() => expect(screen.getByText('Save to')).toBeTruthy())
    expect(adapter.renderAsync).not.toHaveBeenCalled()

    fireEvent.click(exportButton())
    await waitFor(() => expect(adapter.renderAsync).toHaveBeenCalledTimes(1))
  })
})

describe('RenderModal — name + cover', () => {
  it('threads the edited name and chosen cover into the render opts (poll)', async () => {
    const adapter = pollAdapter()
    adapter.getSampleFrame = vi.fn(async () => ({ url: '/files?path=/cover.png' }))
    render(
      <RenderModal
        adapter={adapter}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: true, keeps: KEEPS, durationSec: 12, name: 'export' }}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('export'), { target: { value: 'my-clip' } })
    fireEvent.click(screen.getByText('Edit cover'))
    // Cover is now a frame-tile picker. durationSec 12 → 4 evenly-spaced tiles
    // at 1.5 / 4.5 / 7.5 / 10.5s; clicking the second sets cover to 4.5.
    const tiles = within(screen.getByRole('radiogroup', { name: 'Cover frame' })).getAllByRole('radio')
    fireEvent.click(tiles[1])
    fireEvent.click(exportButton())

    await waitFor(() => expect(adapter.renderAsync).toHaveBeenCalledTimes(1))
    expect(adapter.renderAsync).toHaveBeenCalledWith('vid-1', expect.objectContaining({
      export: 'auto',
      sdrCurve: 'vivid1',
      name: 'my-clip',
      cover: 4.5,
    }))
  })

  it('defaults the name to the host-suggested value', async () => {
    const adapter = pollAdapter()
    render(
      <RenderModal
        adapter={adapter}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: true, keeps: KEEPS, name: 'reel-2' }}
      />,
    )

    expect((screen.getByPlaceholderText('export') as HTMLInputElement).value).toBe('reel-2')
    fireEvent.click(exportButton())
    await waitFor(() => expect(adapter.renderAsync).toHaveBeenCalledTimes(1))
    expect(adapter.renderAsync).toHaveBeenCalledWith('vid-1', expect.objectContaining({ name: 'reel-2' }))
  })
})

describe('RenderModal — HDR format + curve', () => {
  it('starts the render with the chosen format and curve (poll transport)', async () => {
    const adapter = pollAdapter()
    render(
      <RenderModal
        adapter={adapter}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: true, keeps: KEEPS }}
      />,
    )

    fireEvent.click(screen.getByText('Both'))
    fireEvent.click(screen.getByText('Advanced'))
    fireEvent.click(screen.getByText('Neutral brights'))
    fireEvent.click(exportButton())

    await waitFor(() => expect(adapter.renderAsync).toHaveBeenCalledTimes(1))
    expect(adapter.renderAsync).toHaveBeenCalledWith('vid-1', expect.objectContaining({
      export: 'both',
      sdrCurve: 'vivid1-neutral',
    }))
    expect(screen.queryByRole('heading', { name: 'Export' })).toBeNull()
  })

  it('starts the render with the chosen format and curve (SSE transport)', async () => {
    const adapter = baseAdapter()
    render(
      <RenderModal
        adapter={adapter}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: true, keeps: KEEPS }}
      />,
    )

    fireEvent.click(screen.getByText('SDR'))
    fireEvent.click(exportButton())

    await waitFor(() => expect(adapter.render).toHaveBeenCalledTimes(1))
    expect(adapter.render).toHaveBeenCalledWith('vid-1', expect.objectContaining({
      export: 'sdr',
      sdrCurve: 'vivid1',
    }))
  })

  it('defaults to matching the footage on the default curve', async () => {
    const adapter = pollAdapter()
    render(
      <RenderModal
        adapter={adapter}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: true, keeps: KEEPS }}
      />,
    )

    fireEvent.click(exportButton())
    await waitFor(() => expect(adapter.renderAsync).toHaveBeenCalledTimes(1))
    expect(adapter.renderAsync).toHaveBeenCalledWith('vid-1', expect.objectContaining({
      export: 'auto',
      sdrCurve: 'vivid1',
    }))
  })

  it('shows the SDR derive step only when an SDR file is derived', async () => {
    const adapter = pollAdapter()
    const { unmount } = render(
      <RenderModal
        adapter={adapter}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: true, keeps: KEEPS }}
      />,
    )

    // Default (auto) → no derive step in the stepper.
    fireEvent.click(exportButton())
    await waitFor(() => expect(screen.getByText('Rendering graphics')).toBeTruthy())
    expect(screen.queryByText('Deriving SDR')).toBeNull()
    unmount()

    render(
      <RenderModal
        adapter={pollAdapter()}
        projectId="vid-2"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: true, keeps: KEEPS }}
      />,
    )
    fireEvent.click(screen.getByText('Both'))
    fireEvent.click(exportButton())
    await waitFor(() => expect(screen.getByText('Deriving SDR')).toBeTruthy())
  })
})

describe('RenderModal — curve picker honesty line', () => {
  const DEFAULT_LINE = 'SDR export matches this preview; HDR export adds highlight range on HDR displays.'

  function openAdvanced() {
    const adapter = pollAdapter()
    render(
      <RenderModal
        adapter={adapter}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: true, keeps: KEEPS }}
      />,
    )
    fireEvent.click(screen.getByText('Advanced'))
    return adapter
  }

  it('states how the export relates to the preview on the default curve', () => {
    openAdvanced()
    expect(screen.getByTestId('sdr-honesty-line').textContent).toBe(DEFAULT_LINE)
  })

  it('swaps to a differs-from-preview caveat on a non-default curve', () => {
    openAdvanced()
    fireEvent.click(screen.getByText('Neutral brights'))

    const line = screen.getByTestId('sdr-honesty-line').textContent ?? ''
    expect(line).not.toBe(DEFAULT_LINE)
    expect(line).toMatch(/will not match your preview/i)
    expect(line).toMatch(/Montaj Vivid/)

    // And back again.
    fireEvent.click(screen.getByText('Montaj Vivid'))
    expect(screen.getByTestId('sdr-honesty-line').textContent).toBe(DEFAULT_LINE)
  })

  it('keeps every option string free of em dashes (project copy rule)', () => {
    openAdvanced()
    expect(document.body.textContent ?? '').not.toContain('—')
  })
})

describe('RenderModal — curve thumbnails', () => {
  it('samples the same frame once per curve', async () => {
    const adapter = pollAdapter()
    adapter.getSampleFrame = vi.fn(async (_id: string, _at: number, opts?: { sdrCurve?: string }) => ({
      url: `/files?path=/sample-${opts?.sdrCurve}.png`,
    }))

    render(
      <RenderModal
        adapter={adapter}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: true, keeps: KEEPS }}
      />,
    )

    // Two curve samples fire synchronously on mount; the cover sample is
    // debounced, so it hasn't landed at the moment this resolves.
    await waitFor(() => expect(adapter.getSampleFrame).toHaveBeenCalledTimes(2))
    const calls = (adapter.getSampleFrame as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.map(c => c[2]?.sdrCurve).sort()).toEqual(['vivid1', 'vivid1-neutral'])
    // Both curves must be judged on the SAME frame, inside the given keep.
    expect(calls[0][1]).toBe(calls[1][1])
    expect(calls[0][1]).toBeGreaterThan(0)
    expect(calls[0][1]).toBeLessThan(12)

    fireEvent.click(screen.getByText('Advanced'))
    await waitFor(() => {
      const srcs = Array.from(document.querySelectorAll('img')).map(i => i.getAttribute('src'))
      expect(srcs).toContain('/files?path=/sample-vivid1.png')
      expect(srcs).toContain('/files?path=/sample-vivid1-neutral.png')
    })
  })

  it('still paints thumbnails under StrictMode double-mount (M3 regression)', async () => {
    // StrictMode fires mount→cleanup→mount in dev. The old effect flipped a
    // per-invocation `alive` flag false in mount #1's cleanup, while mount #2
    // hit the dedup ref-guard and returned without re-arming it — so the fetched
    // thumbnails resolved into a dead closure and never painted. Sampling still
    // ran once (the dedup), which is why it looked like it "worked" everywhere
    // but the screen. Production has no double-invoke, so this was dev-only.
    const adapter = pollAdapter()
    adapter.getSampleFrame = vi.fn(async (_id: string, _at: number, opts?: { sdrCurve?: string }) => ({
      url: `/files?path=/sample-${opts?.sdrCurve}.png`,
    }))

    render(
      <StrictMode>
        <RenderModal
          adapter={adapter}
          projectId="vid-1"
          onClose={vi.fn()}
          preRenderOptions={{ isHdr: true, keeps: KEEPS }}
        />
      </StrictMode>,
    )

    // Dedup still holds: exactly one sample per curve despite the double-mount.
    await waitFor(() => expect(adapter.getSampleFrame).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByText('Advanced'))
    await waitFor(() => {
      const srcs = Array.from(document.querySelectorAll('img')).map(i => i.getAttribute('src'))
      expect(srcs).toContain('/files?path=/sample-vivid1.png')
      expect(srcs).toContain('/files?path=/sample-vivid1-neutral.png')
    })
  })

  it('renders the picker with labels only when the adapter cannot sample', async () => {
    const adapter = pollAdapter()  // no getSampleFrame at all
    render(
      <RenderModal
        adapter={adapter}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: true, keeps: KEEPS }}
      />,
    )

    fireEvent.click(screen.getByText('Advanced'))
    expect(screen.getByText('Montaj Vivid')).toBeTruthy()
    expect(screen.getByText('Neutral brights')).toBeTruthy()
    expect(document.querySelectorAll('img').length).toBe(0)

    // Still perfectly renderable.
    fireEvent.click(exportButton())
    await waitFor(() => expect(adapter.renderAsync).toHaveBeenCalledTimes(1))
  })

  it('never blocks the render when sampling fails', async () => {
    const adapter = pollAdapter()
    adapter.getSampleFrame = vi.fn(async () => { throw new Error('ffmpeg exploded') })

    render(
      <RenderModal
        adapter={adapter}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: true, keeps: KEEPS }}
      />,
    )

    await waitFor(() => expect(adapter.getSampleFrame).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByText('Advanced'))
    expect(screen.getByText('Montaj Vivid')).toBeTruthy()

    fireEvent.click(exportButton())
    await waitFor(() => expect(adapter.renderAsync).toHaveBeenCalledTimes(1))
  })

  it('samples no curve thumbnails when there are no keeps to sample from', () => {
    const adapter = pollAdapter()
    adapter.getSampleFrame = vi.fn(async () => ({ url: '/x.png' }))

    render(
      <RenderModal
        adapter={adapter}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: true, keeps: [] }}
      />,
    )

    // The dialog still opens; opening Advanced shows curve labels but no
    // thumbnail sampling was scheduled (sampleAt is null with no keeps).
    expect(exportHeading()).toBeTruthy()
    fireEvent.click(screen.getByText('Advanced'))
    expect(screen.queryByText('Sampling a frame…')).toBeNull()
  })
})

describe('RenderModal — image color control', () => {
  it('persists a tone choice through the host callback', () => {
    const set = vi.fn()
    render(
      <RenderModal
        adapter={pollAdapter()}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: true, keeps: KEEPS, imageTone: { value: 'vivid', set } }}
      />,
    )

    // Image color is a first-class expandable section: click its header to open
    // the tone list, then pick another.
    fireEvent.click(screen.getByText('Image color'))
    fireEvent.click(screen.getByText('Broadcast'))
    expect(set).toHaveBeenCalledWith('broadcast')
  })

  it('omits the tone menu when the host supplies no callback', () => {
    render(
      <RenderModal
        adapter={pollAdapter()}
        projectId="vid-1"
        onClose={vi.fn()}
        preRenderOptions={{ isHdr: true, keeps: KEEPS }}
      />,
    )

    // With no imageTone callback the whole Image color control is omitted.
    expect(screen.queryByText('Image color:')).toBeNull()
  })
})

describe('RenderModal — leaving the dialog', () => {
  it('cancels without starting a render', () => {
    const onCancel = vi.fn()
    const onClose = vi.fn()
    const adapter = pollAdapter()
    render(
      <RenderModal
        adapter={adapter}
        projectId="vid-1"
        onClose={onClose}
        onCancel={onCancel}
        preRenderOptions={{ isHdr: true, keeps: KEEPS }}
      />,
    )

    fireEvent.click(screen.getByText('Cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(adapter.renderAsync).not.toHaveBeenCalled()
  })

  it('closes on Escape, since nothing is running yet', () => {
    const onCancel = vi.fn()
    render(
      <RenderModal
        adapter={pollAdapter()}
        projectId="vid-1"
        onClose={vi.fn()}
        onCancel={onCancel}
        preRenderOptions={{ isHdr: true, keeps: KEEPS }}
      />,
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('RenderModal — done state outputs', () => {
  function sseAdapter(doneEvent: { type: 'done'; outputPath: string; outputPaths?: string[] }) {
    const a = baseAdapter()
    a.render = vi.fn(async function* () { yield doneEvent })
    return a
  }

  it('a both export surfaces the derived SDR sibling as its own download', async () => {
    const adapter = sseAdapter({
      type: 'done',
      outputPath: '/ws/p/render/final.mp4',
      outputPaths: ['/ws/p/render/final.mp4', '/ws/p/render/final-sdr.mp4'],
    })
    render(<RenderModal adapter={adapter} projectId="vid-1" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Render complete')).toBeTruthy())
    const master = screen.getByText('Download HDR master') as HTMLAnchorElement
    const sdr = screen.getByText('Download SDR version') as HTMLAnchorElement
    expect(master.getAttribute('href')).toContain('final.mp4')
    expect(sdr.getAttribute('href')).toContain('final-sdr.mp4')
    expect(sdr.getAttribute('download')).toBe('final-sdr.mp4')
  })

  it('a single-file done event keeps the plain Download button', async () => {
    const adapter = sseAdapter({ type: 'done', outputPath: '/ws/p/render/final.mp4' })
    render(<RenderModal adapter={adapter} projectId="vid-1" onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Render complete')).toBeTruthy())
    expect(screen.getByText('Download')).toBeTruthy()
    expect(screen.queryByText('Download SDR version')).toBeNull()
    expect(screen.queryByText('Download HDR master')).toBeNull()
  })
})
