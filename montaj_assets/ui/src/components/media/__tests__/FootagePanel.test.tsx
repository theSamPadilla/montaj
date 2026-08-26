import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FOOTAGE_DND_MIME, type FootageDropPayload } from '@bycrux/editor'
import type { VisualItem } from '@/lib/types/schema'

const { pickFiles, getSourceJobStatus, probeSourceDuration } = vi.hoisted(() => ({
  pickFiles: vi.fn(),
  getSourceJobStatus: vi.fn(),
  probeSourceDuration: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: { pickFiles, getSourceJobStatus, probeSourceDuration },
}))

vi.mock('@bycrux/editor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bycrux/editor')>()
  return {
    ...actual,
    FilmstripScrubber: () => <div data-testid="filmstrip-scrubber" />,
  }
})

import FootagePanel from '../FootagePanel'

function source(overrides: Partial<VisualItem> = {}): VisualItem {
  return {
    id: 'src-1',
    type: 'video',
    src: '/videos/clip-one.mp4',
    start: 0,
    end: 0,
    sourceDuration: 10,
    proxySrc: '/videos/clip-one_proxy.mp4',
    ...overrides,
  }
}

const noop = () => {}
const getFilmstrip = vi.fn(async () => ({ sheets: [], interval: 1, tileWidth: 160 }))
const fileUrl = (p: string) => `/files?path=${p}`

function baseProps(overrides: Partial<React.ComponentProps<typeof FootagePanel>> = {}) {
  return {
    sources: [] as VisualItem[],
    usedSrcs: new Set<string>(),
    projectId: 'proj-1',
    getFilmstrip,
    fileUrl,
    ingestSource: vi.fn(async () => ({ jobId: 'job-1' })),
    onRemove: noop,
    sourcePreview: { get: () => null, set: vi.fn(), subscribe: () => () => {} },
    ...overrides,
  }
}

let realGetRect: typeof Element.prototype.getBoundingClientRect

beforeEach(() => {
  pickFiles.mockReset()
  getSourceJobStatus.mockReset()
  probeSourceDuration.mockReset()
  getFilmstrip.mockClear()
  realGetRect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 120, width: 200, height: 120, toJSON: () => ({}) } as DOMRect
  }
})

afterEach(() => {
  vi.useRealTimers()
  Element.prototype.getBoundingClientRect = realGetRect
})

describe('FootagePanel', () => {
  it('renders one card per source with its basename filename and formatted duration', () => {
    render(<FootagePanel {...baseProps({ sources: [source()] })} />)
    expect(screen.getByText('clip-one.mp4')).toBeInTheDocument()
    expect(screen.getByText('0:10')).toBeInTheDocument()
  })

  it('shows the Added pill only for a source whose src is in usedSrcs', () => {
    render(
      <FootagePanel
        {...baseProps({
          sources: [
            source({ id: 'src-1', src: '/videos/clip-one.mp4' }),
            source({ id: 'src-2', src: '/videos/clip-two.mp4' }),
          ],
          usedSrcs: new Set(['/videos/clip-one.mp4']),
        })}
      />,
    )
    expect(screen.getAllByText('Added')).toHaveLength(1)
  })

  it('does not show the Added pill when no source is used', () => {
    render(<FootagePanel {...baseProps({ sources: [source()] })} />)
    expect(screen.queryByText('Added')).not.toBeInTheDocument()
  })

  it('sets a correctly-shaped FootageDropPayload on dragStart', () => {
    render(<FootagePanel {...baseProps({ sources: [source()] })} />)
    const card = screen.getByText('clip-one.mp4').closest('[draggable="true"]') as HTMLElement
    expect(card).toBeTruthy()

    const setData = vi.fn()
    fireEvent.dragStart(card, { dataTransfer: { setData, effectAllowed: '' } })

    expect(setData).toHaveBeenCalledWith(FOOTAGE_DND_MIME, expect.any(String))
    const [, json] = setData.mock.calls[0]
    const payload: FootageDropPayload = JSON.parse(json)
    expect(payload).toEqual({
      src: '/videos/clip-one.mp4',
      proxySrc: '/videos/clip-one_proxy.mp4',
      sourceDuration: 10,
      sourceWidth: undefined,
      sourceHeight: undefined,
      name: 'clip-one.mp4',
    })
  })

  it('imports via pickFiles and clears the in-flight placeholder once the job is done', async () => {
    vi.useFakeTimers()
    pickFiles.mockResolvedValue({ paths: ['/videos/new-clip.mp4'] })
    getSourceJobStatus.mockResolvedValue({ status: 'done' })
    const ingestSource = vi.fn(async () => ({ jobId: 'job-1' }))

    render(<FootagePanel {...baseProps({ ingestSource })} />)

    await act(async () => {
      fireEvent.click(screen.getByTitle('Import footage'))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(ingestSource).toHaveBeenCalledWith({ path: '/videos/new-clip.mp4' })
    expect(screen.getByText('new-clip.mp4')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(getSourceJobStatus).toHaveBeenCalledWith('proj-1', 'job-1')
    expect(screen.queryByText('new-clip.mp4')).not.toBeInTheDocument()
  })

  it('shows the empty-state hint when there is no footage and nothing in flight', () => {
    render(<FootagePanel {...baseProps({ emptyHint: 'No footage yet. Import video to get started.' })} />)
    expect(screen.getByText('No footage yet. Import video to get started.')).toBeInTheDocument()
  })

  it('lists Name, Date added, Date created, and Type in the sort menu', () => {
    render(<FootagePanel {...baseProps({ sources: [source()] })} />)
    fireEvent.click(screen.getByTitle('Sort footage'))
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByText('Date added')).toBeInTheDocument()
    expect(screen.getByText('Date created')).toBeInTheDocument()
    expect(screen.getByText('Type')).toBeInTheDocument()
  })

  it('leaves the default (insertion) order unchanged on mount', () => {
    render(
      <FootagePanel
        {...baseProps({
          sources: [
            source({ id: 'src-1', src: '/videos/banana.mp4' }),
            source({ id: 'src-2', src: '/videos/apple.mov' }),
            source({ id: 'src-3', src: '/videos/cherry.mp4' }),
          ],
        })}
      />,
    )
    const names = screen.getAllByTitle(/\.(mp4|mov)$/).map(el => el.textContent)
    expect(names).toEqual(['banana.mp4', 'apple.mov', 'cherry.mp4'])
  })

  it('sorts cards alphabetically by filename when Name is picked', () => {
    render(
      <FootagePanel
        {...baseProps({
          sources: [
            source({ id: 'src-1', src: '/videos/banana.mp4' }),
            source({ id: 'src-2', src: '/videos/apple.mov' }),
            source({ id: 'src-3', src: '/videos/cherry.mp4' }),
          ],
        })}
      />,
    )
    fireEvent.click(screen.getByTitle('Sort footage'))
    fireEvent.click(screen.getByText('Name'))

    const names = screen.getAllByTitle(/\.(mp4|mov)$/).map(el => el.textContent)
    expect(names).toEqual(['apple.mov', 'banana.mp4', 'cherry.mp4'])
    expect(screen.getByTitle('Sort footage')).toHaveTextContent('Name')
  })

  it('groups cards by file extension when Type is picked', () => {
    render(
      <FootagePanel
        {...baseProps({
          sources: [
            source({ id: 'src-1', src: '/videos/one.mp4' }),
            source({ id: 'src-2', src: '/videos/two.mov' }),
            source({ id: 'src-3', src: '/videos/three.mp4' }),
          ],
        })}
      />,
    )
    fireEvent.click(screen.getByTitle('Sort footage'))
    fireEvent.click(screen.getByText('Type'))

    const names = screen.getAllByTitle(/\.(mp4|mov)$/).map(el => el.textContent)
    // "mov" < "mp4" lexicographically; ties (one.mp4, three.mp4) keep their original order.
    expect(names).toEqual(['two.mov', 'one.mp4', 'three.mp4'])
  })

  it('sorts by recording time (newest first) when Date created is picked; undated cards last in insertion order', () => {
    render(
      <FootagePanel
        {...baseProps({
          sources: [
            source({ id: 'src-1', src: '/videos/older.mp4', sourceCreatedAt: '2023-01-01T00:00:00.000000Z' }),
            source({ id: 'src-2', src: '/videos/undated-a.mp4' }),
            source({ id: 'src-3', src: '/videos/newer.mp4', sourceCreatedAt: '2024-06-15T12:00:00.000000Z' }),
            source({ id: 'src-4', src: '/videos/undated-b.mp4' }),
          ],
        })}
      />,
    )
    fireEvent.click(screen.getByTitle('Sort footage'))
    fireEvent.click(screen.getByText('Date created'))

    const names = screen.getAllByTitle(/\.(mp4|mov)$/).map(el => el.textContent)
    // Dated newest-first (newer before older); the two undated cards sort after
    // both dated ones, keeping their original relative order (a before b).
    expect(names).toEqual(['newer.mp4', 'older.mp4', 'undated-a.mp4', 'undated-b.mp4'])
  })

  it('drives sourcePreview.set with the proxy url and hover fraction on pointer move, and clears it on pointer leave', () => {
    const set = vi.fn()
    const sourcePreview = { get: () => null, set, subscribe: () => () => {} }
    render(<FootagePanel {...baseProps({ sources: [source()], sourcePreview })} />)

    const mediaCell = screen.getByTestId('filmstrip-scrubber').parentElement as HTMLElement
    // jsdom has no native PointerEvent constructor, so `fireEvent.pointerMove`
    // (which falls back to a bare `Event` and drops `clientX`) can't carry
    // coordinates through. Dispatch a MouseEvent typed as the native pointer
    // event instead — React registers onPointerMove directly against the
    // native "pointermove" event regardless of which Event subclass fired it,
    // and MouseEvent actually implements clientX.
    act(() => {
      mediaCell.dispatchEvent(new MouseEvent('pointermove', { clientX: 100, bubbles: true, cancelable: true }))
    })

    expect(set).toHaveBeenCalledWith({ url: '/files?path=/videos/clip-one_proxy.mp4', fraction: 0.5 })

    // onPointerLeave is synthesized by React from the bubbling "pointerout"
    // event (with no relatedTarget inside the tree, i.e. left to nowhere) —
    // a real "pointerleave" (non-bubbling) never reaches the delegated root
    // listener, so it must be "pointerout" here, not "pointerleave".
    act(() => {
      mediaCell.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, cancelable: true }))
    })
    expect(set).toHaveBeenLastCalledWith(null)
  })

  it('renders a probe-less source (no sourceDuration) as non-draggable with a Duration unknown affordance', () => {
    render(<FootagePanel {...baseProps({ sources: [source({ sourceDuration: undefined })] })} />)
    const card = screen.getByText('clip-one.mp4').closest('.group') as HTMLElement
    expect(card.getAttribute('draggable')).toBe('false')
    expect(screen.getByText('Duration unknown')).toBeInTheDocument()
    expect(screen.getByTitle('Get duration')).toBeInTheDocument()
  })

  it('leaves a source that has a duration draggable with no unknown-duration affordance (agent-path parity)', () => {
    render(<FootagePanel {...baseProps({ sources: [source()] })} />)
    const card = screen.getByText('clip-one.mp4').closest('.group') as HTMLElement
    expect(card.getAttribute('draggable')).toBe('true')
    expect(screen.queryByText(/duration unknown/i)).not.toBeInTheDocument()
    expect(screen.queryByTitle('Get duration')).not.toBeInTheDocument()
  })

  it('treats sourceDuration: 0 as probe-less: no bogus 0:00 badge and not draggable', () => {
    render(<FootagePanel {...baseProps({ sources: [source({ sourceDuration: 0 })] })} />)
    expect(screen.queryByText('0:00')).not.toBeInTheDocument()
    const card = screen.getByText('clip-one.mp4').closest('.group') as HTMLElement
    expect(card.getAttribute('draggable')).toBe('false')
  })

  it('probes the duration on click and flips the card to draggable on success, without a reload', async () => {
    probeSourceDuration.mockResolvedValue({ id: 'src-1', src: '/videos/clip-one.mp4', sourceDuration: 12 })
    render(<FootagePanel {...baseProps({ sources: [source({ sourceDuration: undefined })] })} />)

    fireEvent.click(screen.getByTitle('Get duration'))

    await waitFor(() => expect(screen.queryByText(/duration unknown/i)).not.toBeInTheDocument())

    expect(probeSourceDuration).toHaveBeenCalledWith('proj-1', 'src-1')
    const card = screen.getByText('clip-one.mp4').closest('.group') as HTMLElement
    expect(card.getAttribute('draggable')).toBe('true')
    expect(screen.getByText('0:12')).toBeInTheDocument()

    // Pin the drag payload itself, not just the gate: the failure mode this
    // feature exists to eliminate is the gate flipping while the payload
    // still sends 0 (handleDragStart falls back to `?? 0`).
    const setData = vi.fn()
    fireEvent.dragStart(card, { dataTransfer: { setData, effectAllowed: '' } })
    const [, json] = setData.mock.calls[0]
    expect((JSON.parse(json) as FootageDropPayload).sourceDuration).toBe(12)
  })

  it('shows the error message on a failed probe and leaves the button retryable', async () => {
    probeSourceDuration.mockRejectedValue(new Error('Source file is missing: /x.mov'))
    render(<FootagePanel {...baseProps({ sources: [source({ sourceDuration: undefined })] })} />)

    fireEvent.click(screen.getByTitle('Get duration'))

    await waitFor(() => expect(screen.getByText('Source file is missing: /x.mov')).toBeInTheDocument())

    const retryButton = screen.getByTitle('Get duration')
    expect(retryButton).not.toBeDisabled()
    // Duration is still unknown after a failed probe — the card stays gated.
    const card = screen.getByText('clip-one.mp4').closest('.group') as HTMLElement
    expect(card.getAttribute('draggable')).toBe('false')
  })
})
