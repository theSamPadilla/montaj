import { useEffect, useRef } from 'react'

import type { EditorAdapter, EditorContext } from '../types'
import type { PlaybackClock } from './playback-clock'

/**
 * How often the playhead is reported during playback.
 *
 * The clock is written ~60Hz; reporting every tick would be 60 POSTs/sec for
 * information no agent can consume that fast. One per second is well inside
 * serve's CONTEXT_TTL_SEC while costing effectively nothing.
 *
 * Note this is an unconditional heartbeat, not change detection: a paused
 * editor keeps reporting the same playhead once a second, and must. The TTL
 * governs freshness, so going quiet while parked would make serve answer
 * "no editor open" about an editor that is plainly open.
 */
export const REPORT_INTERVAL_MS = 1000

interface Options {
  adapter: EditorAdapter
  projectId: string
  clock: PlaybackClock
  selectedIds: string[]
  selectedCaptionId: string | null
}

/**
 * Report playhead + selection to the host on a throttle.
 *
 * The throttle is deliberately asymmetric. The PLAYHEAD is sampled on an
 * interval — it moves continuously and an agent only needs roughly where it
 * is. SELECTION is reported the moment it changes — it is discrete, it is
 * usually the more meaningful half of "this section", and waiting up to a
 * second to report a click would make the agent answer about the previous
 * selection.
 */
export function useReportContext({
  adapter, projectId, clock, selectedIds, selectedCaptionId,
}: Options): void {
  // Kept in a ref so the interval effect never re-subscribes on a selection
  // change — it always reads the latest values without depending on them.
  const latest = useRef({ selectedIds, selectedCaptionId })
  latest.current = { selectedIds, selectedCaptionId }

  const send = useRef<(ctx: EditorContext) => void>(() => {})
  send.current = (ctx: EditorContext) => {
    // Fire and forget. A down serve, a 404, an offline host — none of it is
    // the editor's problem, and none of it reaches the user.
    void adapter.reportContext?.(projectId, ctx)?.catch(() => {})
  }

  // Playhead, on an interval. Reports on mount so an agent asked something the
  // instant the editor opens still gets an answer.
  useEffect(() => {
    if (!adapter.reportContext) return
    const emit = () => send.current({
      playheadSec:       clock.get(),
      selectedIds:       latest.current.selectedIds,
      selectedCaptionId: latest.current.selectedCaptionId,
    })
    emit()
    const id = setInterval(emit, REPORT_INTERVAL_MS)
    return () => clearInterval(id)
  }, [adapter, projectId, clock])

  // Selection, immediately on change. Skips the mount emit above by comparing
  // against what the interval effect already sent.
  const mounted = useRef(false)
  useEffect(() => {
    if (!adapter.reportContext) return
    if (!mounted.current) { mounted.current = true; return }
    send.current({ playheadSec: clock.get(), selectedIds, selectedCaptionId })
  }, [adapter, clock, selectedIds, selectedCaptionId])
}
