import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { createPlaybackClock } from '../playback-clock'
import { useReportContext, REPORT_INTERVAL_MS } from '../use-report-context'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('useReportContext', () => {
  it('does nothing when the adapter omits reportContext', () => {
    const clock = createPlaybackClock()
    expect(() =>
      renderHook(() => useReportContext({
        adapter: {} as never, projectId: 'p1', clock,
        selectedIds: [], selectedCaptionId: null,
      })),
    ).not.toThrow()
  })

  it('reports once on mount', () => {
    const reportContext = vi.fn().mockResolvedValue(undefined)
    const clock = createPlaybackClock(4)
    renderHook(() => useReportContext({
      adapter: { reportContext } as never, projectId: 'p1', clock,
      selectedIds: [], selectedCaptionId: null,
    }))
    expect(reportContext).toHaveBeenCalledWith('p1', {
      playheadSec: 4, selectedIds: [], selectedCaptionId: null,
    })
  })

  it('throttles a 60Hz clock to one report per interval', () => {
    const reportContext = vi.fn().mockResolvedValue(undefined)
    const clock = createPlaybackClock()
    renderHook(() => useReportContext({
      adapter: { reportContext } as never, projectId: 'p1', clock,
      selectedIds: [], selectedCaptionId: null,
    }))
    reportContext.mockClear()

    act(() => {
      for (let i = 1; i <= 120; i++) clock.set(i / 60)
      vi.advanceTimersByTime(REPORT_INTERVAL_MS)
    })
    expect(reportContext).toHaveBeenCalledTimes(1)
    expect(reportContext.mock.calls[0][1].playheadSec).toBeCloseTo(2)
  })

  it('reports a selection change immediately, without waiting for the interval', () => {
    const reportContext = vi.fn().mockResolvedValue(undefined)
    const clock = createPlaybackClock()
    // Hoisted deliberately. The playhead effect depends on `adapter` by
    // reference, so an inline object literal would be a new adapter every
    // render and would re-fire that effect on rerender too — giving 2 calls
    // and testing object identity instead of the selection path. Real call
    // sites (EditorPage.tsx, MobileLiveView.tsx, MobileVideoPreview.tsx) all
    // wrap createMontajAdapter() in useMemo, so a stable adapter is what
    // production actually does.
    const adapter = { reportContext } as never
    const { rerender } = renderHook(
      (props: { ids: string[] }) => useReportContext({
        adapter, projectId: 'p1', clock,
        selectedIds: props.ids, selectedCaptionId: null,
      }),
      { initialProps: { ids: [] as string[] } },
    )
    reportContext.mockClear()
    rerender({ ids: ['c3'] })
    expect(reportContext).toHaveBeenCalledTimes(1)
    expect(reportContext.mock.calls[0][1].selectedIds).toEqual(['c3'])
  })

  it('swallows a rejected report — context sync never breaks the editor', async () => {
    const reportContext = vi.fn().mockRejectedValue(new Error('serve is down'))
    const clock = createPlaybackClock()
    expect(() =>
      renderHook(() => useReportContext({
        adapter: { reportContext } as never, projectId: 'p1', clock,
        selectedIds: [], selectedCaptionId: null,
      })),
    ).not.toThrow()
    await act(async () => { await Promise.resolve() })
  })

  it('stops reporting after unmount', () => {
    const reportContext = vi.fn().mockResolvedValue(undefined)
    const clock = createPlaybackClock()
    const { unmount } = renderHook(() => useReportContext({
      adapter: { reportContext } as never, projectId: 'p1', clock,
      selectedIds: [], selectedCaptionId: null,
    }))
    unmount()
    reportContext.mockClear()
    act(() => {
      clock.set(9)
      vi.advanceTimersByTime(REPORT_INTERVAL_MS * 3)
    })
    expect(reportContext).not.toHaveBeenCalled()
  })
})
