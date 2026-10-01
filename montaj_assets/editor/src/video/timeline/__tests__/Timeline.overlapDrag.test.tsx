/// <reference types="vitest/globals" />
/**
 * Dragging an item sideways INTO a neighbour keeps it on its own track.
 *
 * The report: drag an overlay into another to make them overlap, and "after a
 * certain period" the dragged one jumps to the track above. Measured, there
 * was no timer in it — `resolveTargetTrackIdx` rejected the item's own track
 * once the overlap passed 30% of its duration and minted a new top track for
 * it, on whichever mousemove crossed that line. The "period" was the pointer's
 * own travel, or edge auto-scroll carrying the item further with the pointer
 * held still. Now only vertical intent (the pointer leaving its own band,
 * `Math.round(dy / VISUAL_ROW_HEIGHT_PX) !== 0`) can change the track, and a
 * sideways move is clamped short of the overlaps `engine/validate.py` rejects
 * instead (`_overlapRules.ts`).
 *
 * Driven through a CONTROLLED host that echoes every `onProjectChange` back
 * into the `project` prop and folds the derived crossfades into its commit, as
 * `VideoEditor` does, so the mid-drag frames reach Timeline's own effects
 * exactly as they do in the app. Fake timers stand in for "holding still": the
 * debounced crossfade pass and the edge auto-scroll loop are the only timers
 * in play.
 *
 * Timeline owns its viewport store, so `useViewportStore` is swapped for one
 * this file can reach: the auto-scroll test needs a zoom where the neighbour is
 * still off-screen to the right, which a freshly fitted surface never has.
 */
import { useState } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, cleanup, fireEvent } from '@testing-library/react'
import type { Project } from '../../../types'
import type { VisualTrack } from '../../../schema'
import { createPlaybackClock } from '../../playback-clock'
import Timeline, { CROSSFADE_COMMIT_DELAY_MS } from '../Timeline'
import { computeAutoCrossfade, computeVisualCrossfade, normalizeTracks, VISUAL_ROW_HEIGHT_PX } from '../timeline-model'
import type { ViewportStore } from '../canvas/viewport'
import { canvasItemPoint, canvasSurface, installCanvasHarness, SURFACE_LEFT, timeToClientX } from './_canvasSelect'
import { overlapViolations } from './_overlapRules'

const viewport = vi.hoisted(() => ({ store: null as ViewportStore | null }))
vi.mock('../canvas/viewport', async (orig) => {
  const actual = await orig<typeof import('../canvas/viewport')>()
  return {
    ...actual,
    useViewportStore: () => (viewport.store ??= actual.createViewportStore()),
  }
})

let uninstall: () => void

beforeEach(() => {
  viewport.store = null
  vi.useFakeTimers()
  uninstall = installCanvasHarness()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  uninstall()
})

/** The orchestrator's measured case: overlay `a` (0-10) slid into `b`
 *  (14-24) on the same overlay track, above a 30s video base track. */
function overlayProject(): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [
      { id: 'trk-0', items: [{ id: 'v', type: 'video', src: 'v.mp4', start: 0, end: 30, inPoint: 0, outPoint: 30, sourceDuration: 30 }] },
      { id: 'trk-1', items: [
        { id: 'a', type: 'overlay', src: 'A.jsx', start: 0, end: 10 },
        { id: 'b', type: 'overlay', src: 'B.jsx', start: 14, end: 24 },
      ] },
    ],
    audio: { tracks: [] },
  } as unknown as Project
}

interface Recorder {
  /** Every live frame the gesture sent, newest last. */
  frames: Project[]
  /** Every commit, newest last. */
  commits: Project[]
}

function mount(initial: Project): Recorder {
  const rec: Recorder = { frames: [], commits: [] }
  function Host() {
    const [project, setProject] = useState(initial)
    return (
      <Timeline
        project={project}
        clock={createPlaybackClock(0)}
        selectedIds={[]}
        onSelectIds={() => {}}
        onProjectChange={p => { rec.frames.push(p); setProject(p) }}
        onOverlayEdit={p => {
          // VideoEditor's `commitTimelineEdit`: the derived fades ride in the
          // gesture's own commit.
          const withAudio = computeAutoCrossfade(p) ?? p
          const committed = computeVisualCrossfade(withAudio) ?? withAudio
          rec.commits.push(committed)
          setProject(committed)
        }}
      />
    )
  }
  render(<Host />)
  return rec
}

/** The gesture's current position: its most recent live frame. */
function latest(rec: Recorder): Project {
  expect(rec.frames.length).toBeGreaterThan(0)
  return rec.frames[rec.frames.length - 1]
}

function tracksOf(p: Project): VisualTrack[] {
  return normalizeTracks(p).tracks ?? []
}

/** Index of the track holding `id`, and the ids that share it. */
function placement(p: Project, id: string): { idx: number; ids: string[] } {
  const tracks = tracksOf(p)
  const idx = tracks.findIndex(t => t.items.some(i => i.id === id))
  return { idx, ids: tracks[idx].items.map(i => i.id).sort() }
}

function overlapSeconds(p: Project, x: string, y: string): number {
  const items = tracksOf(p).flatMap(t => t.items)
  const a = items.find(i => i.id === x)!
  const b = items.find(i => i.id === y)!
  return Math.min(a.end, b.end) - Math.max(a.start, b.start)
}

describe('Timeline — a horizontal drag into an overlap keeps the item on its track', () => {
  it('stays on its track past 30% overlap while held still, and on drop', () => {
    const initial = overlayProject()
    const rec = mount(initial)
    const surface = canvasSurface(document.body)
    const press = canvasItemPoint(initial, { id: 'a' }, { at: 5 })
    const at = (t: number) => ({ clientX: timeToClientX(initial, t), clientY: press.clientY, button: 0, bubbles: true })

    fireEvent.mouseDown(surface, { ...press, button: 0 })
    // a -> [8, 18]: 4s into b, 40% of a. Then hold still for seconds.
    act(() => { document.dispatchEvent(new MouseEvent('mousemove', at(13))) })
    expect(overlapSeconds(latest(rec), 'a', 'b')).toBeGreaterThan(3)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(placement(latest(rec), 'a')).toEqual({ idx: 1, ids: ['a', 'b'] })

    // a -> [10, 20]: 60%. Hold again.
    act(() => { document.dispatchEvent(new MouseEvent('mousemove', at(15))) })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(placement(latest(rec), 'a')).toEqual({ idx: 1, ids: ['a', 'b'] })
    expect(rec.commits).toHaveLength(0)

    act(() => { document.dispatchEvent(new MouseEvent('mouseup', at(15))) })
    act(() => { vi.advanceTimersByTime(CROSSFADE_COMMIT_DELAY_MS * 4) })

    expect(rec.commits).toHaveLength(1)
    expect(placement(rec.commits[0], 'a')).toEqual({ idx: 1, ids: ['a', 'b'] })
    expect(tracksOf(rec.commits[0])).toHaveLength(2)
  })

  it('sub-threshold vertical jitter while overlapping stays on the track', () => {
    const initial = overlayProject()
    const rec = mount(initial)
    const surface = canvasSurface(document.body)
    const press = canvasItemPoint(initial, { id: 'a' }, { at: 5 })
    const jitter = VISUAL_ROW_HEIGHT_PX / 2 - 1
    const at = (t: number, dy: number) => ({ clientX: timeToClientX(initial, t), clientY: press.clientY + dy, button: 0, bubbles: true })

    fireEvent.mouseDown(surface, { ...press, button: 0 })
    for (const [t, dy] of [[12, jitter], [13, -jitter], [14, jitter], [15, -jitter], [15, jitter]] as const) {
      act(() => { document.dispatchEvent(new MouseEvent('mousemove', at(t, dy))) })
      act(() => { vi.advanceTimersByTime(500) })
      expect(placement(latest(rec), 'a').idx).toBe(1)
    }
    expect(overlapSeconds(latest(rec), 'a', 'b')).toBeGreaterThan(3)

    act(() => { document.dispatchEvent(new MouseEvent('mouseup', at(15, jitter))) })
    expect(rec.commits).toHaveLength(1)
    expect(placement(rec.commits[0], 'a')).toEqual({ idx: 1, ids: ['a', 'b'] })
  })

  it('a vertical move past the band boundary still changes track', () => {
    const initial = overlayProject()
    const rec = mount(initial)
    const surface = canvasSurface(document.body)
    const press = canvasItemPoint(initial, { id: 'a' }, { at: 5 })
    const at = (t: number, dy: number) => ({ clientX: timeToClientX(initial, t), clientY: press.clientY + dy, button: 0, bubbles: true })

    fireEvent.mouseDown(surface, { ...press, button: 0 })
    act(() => { document.dispatchEvent(new MouseEvent('mousemove', at(15, 0))) })
    expect(placement(latest(rec), 'a').idx).toBe(1)
    // Upward, a full row step: the pointed-at band is past the top of the
    // stack, so the move mints a new top track exactly as before.
    act(() => { document.dispatchEvent(new MouseEvent('mousemove', at(15, -VISUAL_ROW_HEIGHT_PX))) })
    expect(placement(latest(rec), 'a')).toEqual({ idx: 2, ids: ['a'] })

    act(() => { document.dispatchEvent(new MouseEvent('mouseup', at(15, -VISUAL_ROW_HEIGHT_PX))) })
    expect(rec.commits).toHaveLength(1)
    expect(placement(rec.commits[0], 'a')).toEqual({ idx: 2, ids: ['a'] })
  })

  it('held at the edge while auto-scroll carries it toward containment: stays on its track, clamped, and on drop', () => {
    // 100px/s with the view at 0 shows 0-10s; b (12-20) starts off-screen.
    // Holding the pointer in the right edge zone pans the view, and the pan
    // alone carries a (4s) into b: past 30% overlap, then to the point where
    // b would contain it.
    const initial: Project = {
      ...overlayProject(),
      tracks: [
        { id: 'trk-0', items: [{ id: 'v', type: 'video', src: 'v.mp4', start: 0, end: 40, inPoint: 0, outPoint: 40, sourceDuration: 40 }] },
        { id: 'trk-1', items: [
          { id: 'a', type: 'overlay', src: 'A.jsx', start: 0, end: 4 },
          { id: 'b', type: 'overlay', src: 'B.jsx', start: 12, end: 20 },
        ] },
      ],
    } as unknown as Project
    const rec = mount(initial)
    act(() => { vi.advanceTimersByTime(32) })
    act(() => { viewport.store!.set({ pxPerSecond: 100, scrollSeconds: 0, widthPx: 1000 }) })
    act(() => { vi.advanceTimersByTime(32) })

    let now = 0
    const perf = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const surface = canvasSurface(document.body)
      const y = canvasItemPoint(initial, { id: 'a' }).clientY
      const at = (x: number) => ({ clientX: SURFACE_LEFT + x, clientY: y, button: 0, bubbles: true })

      fireEvent.mouseDown(surface, at(200))                   // a's body, 2s in
      act(() => { document.dispatchEvent(new MouseEvent('mousemove', at(990))) })
      expect(placement(latest(rec), 'a').idx).toBe(1)

      // Hold: the loop's first tick seeds its clock, then every tick pans.
      act(() => { vi.advanceTimersByTime(20) })
      let sawPastThreshold = false
      for (let i = 0; i < 40; i++) {
        now += 1000
        act(() => { vi.advanceTimersByTime(20) })
        const frame = latest(rec)
        if (overlapSeconds(frame, 'a', 'b') > 1.2) sawPastThreshold = true
        expect(placement(frame, 'a')).toEqual({ idx: 1, ids: ['a', 'b'] })
        expect(overlapViolations(frame)).toEqual([])
      }
      expect(sawPastThreshold).toBe(true)
      expect(viewport.store!.get().scrollSeconds).toBeGreaterThan(8)
      // And still: seconds of fake time with nothing moving.
      act(() => { vi.advanceTimersByTime(3000) })
      expect(rec.commits).toHaveLength(0)

      // The pan carried it as far as it may go: just short of b containing it.
      const held = tracksOf(latest(rec)).flatMap(t => t.items).find(i => i.id === 'a')!
      expect(held.start).toBeLessThan(12)
      expect(held.start).toBeGreaterThan(11.999)

      act(() => { document.dispatchEvent(new MouseEvent('mouseup', at(990))) })
      act(() => { vi.advanceTimersByTime(CROSSFADE_COMMIT_DELAY_MS * 4) })
      expect(rec.commits).toHaveLength(1)
      expect(placement(rec.commits[0], 'a')).toEqual({ idx: 1, ids: ['a', 'b'] })
      expect(overlapViolations(rec.commits[0])).toEqual([])
    } finally {
      perf.mockRestore()
    }
  })

  it('a video clip dragged into overlap on tracks[0] stays there and yields a valid project', () => {
    // tracks[0] allows any overlap and containment; only a third clip live at
    // once is invalid there. c1 and c2 already cross-fade over [9, 10).
    const initial: Project = {
      ...overlayProject(),
      tracks: [{ id: 'trk-0', items: [
        { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, outPoint: 4, sourceDuration: 40 },
        { id: 'c1', type: 'video', src: 'b.mp4', start: 6, end: 10, inPoint: 0, outPoint: 4, sourceDuration: 40 },
        { id: 'c2', type: 'video', src: 'c.mp4', start: 9, end: 14, inPoint: 0, outPoint: 5, sourceDuration: 40 },
      ] }],
    } as unknown as Project
    const rec = mount(initial)
    const surface = canvasSurface(document.body)
    const press = canvasItemPoint(initial, { id: 'c0' }, { at: 2 })
    const at = (t: number) => ({ clientX: timeToClientX(initial, t), clientY: press.clientY, button: 0, bubbles: true })

    fireEvent.mouseDown(surface, { ...press, button: 0 })
    // c0 -> [4.5, 8.5]: 2.5s into c1, 62% of c0. Then hold.
    act(() => { document.dispatchEvent(new MouseEvent('mousemove', at(6.5))) })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(overlapSeconds(latest(rec), 'c0', 'c1')).toBeGreaterThan(1.2)
    expect(placement(latest(rec), 'c0')).toEqual({ idx: 0, ids: ['c0', 'c1', 'c2'] })
    expect(overlapViolations(latest(rec))).toEqual([])

    // Further right would put c0 live inside c1/c2's cross-fade: clamped
    // short of it, still on tracks[0].
    act(() => { document.dispatchEvent(new MouseEvent('mousemove', at(12))) })
    const clamped = tracksOf(latest(rec)).flatMap(t => t.items).find(i => i.id === 'c0')!
    expect(clamped.end).toBeLessThan(9)
    expect(clamped.end).toBeGreaterThan(8.999)
    expect(placement(latest(rec), 'c0').idx).toBe(0)

    act(() => { document.dispatchEvent(new MouseEvent('mouseup', at(12))) })
    expect(rec.commits).toHaveLength(1)
    expect(tracksOf(rec.commits[0])).toHaveLength(1)
    expect(overlapViolations(rec.commits[0])).toEqual([])
  })
})
