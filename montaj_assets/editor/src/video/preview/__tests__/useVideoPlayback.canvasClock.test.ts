/**
 * The canvas rAF clock's CEILING, driven through the real effect.
 *
 * `canvasMaxEndRef` is the only thing standing between "space plays" and "space
 * does nothing" on a project with no track-0 video. It used to read
 * `overlayTracks` (`tracks.slice(1)`), which silently skips track 0 — and track
 * 0 in canvas mode is not the primary footage track, it is content: the
 * background images, and on an agent-authored project frequently the overlays
 * themselves. A project that is ONE track of nothing but overlays (what the
 * animations workflow emits) therefore got a ceiling of 0, and the first tick
 * clamped the playhead to 0 and called `setIsPlaying(false)` in the same frame.
 *
 * These drive the hook's own rAF effect rather than asserting on a helper: the
 * ceiling lives in a ref that nothing exports, so the only honest way to pin it
 * is to run the clock and watch where time goes. Each case fails on the
 * pre-fix `overlayTracks` read.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useVideoPlayback } from '../useVideoPlayback'
import type { EditorProject, VisualItem } from '../../../schema'

const overlay = (id: string, start: number, end: number): VisualItem =>
  ({ id, type: 'overlay', src: `/overlays/${id}.jsx`, start, end }) as VisualItem

const image = (id: string, start: number, end: number): VisualItem =>
  ({ id, type: 'image', src: `/img/${id}.png`, start, end }) as VisualItem

/** The last emission. Not `.at(-1)` — this package targets ES2020. */
const last = (xs: number[]): number | undefined => xs[xs.length - 1]

function projectOf(...tracks: VisualItem[][]): EditorProject {
  return {
    id: 'canvas-clock',
    status: 'draft',
    settings: { resolution: [1920, 1080] },
    tracks: tracks.map((items, i) => ({ id: `trk-${i}`, items })),
  } as EditorProject
}

/**
 * Mount the hook on a canvas project and run the clock for one second of wall
 * time, returning every playhead value it emitted.
 *
 * Two ticks, because the first only anchors `rafLastMs` — it has no `dt` yet
 * and emits nothing. The second is the first that can move the playhead, and
 * the one the collapsed ceiling used to kill.
 */
function runClock(project: EditorProject) {
  const times: number[] = []
  const scheduled: FrameRequestCallback[] = []
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    scheduled.push(cb)
    return scheduled.length
  })

  const view = renderHook(() => useVideoPlayback(project, 0, (t) => times.push(t), (p) => p))
  expect(view.result.current.isCanvasProject).toBe(true)

  scheduled.length = 0
  act(() => { view.result.current.setIsPlaying(true) })
  expect(scheduled.length).toBeGreaterThan(0)

  act(() => { scheduled[0](0) })          // anchor only
  act(() => { scheduled[scheduled.length - 1](1000) })  // +1s of wall clock

  return { times, isPlaying: view.result.current.isPlaying }
}

describe('useVideoPlayback — the canvas clock counts track 0', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('advances on a single track holding nothing but overlays', () => {
    // The Daubert-demo shape: one track, 14 overlays, no captions, no video.
    const { times, isPlaying } = runClock(projectOf([overlay('o1', 0, 5), overlay('o2', 5, 12)]))
    expect(last(times)).toBeCloseTo(1, 6)
    expect(isPlaying).toBe(true)
  })

  it('advances on a track-0 image that outlasts every overlay track', () => {
    // Same defect, other content kind — the background image was invisible to
    // the ceiling, so a slideshow stopped at its last overlay.
    //
    // The overlay track has to end INSIDE the second this clock runs (0.4 < 1),
    // or `overlayTracks` alone already carries the playhead to 1 and the case
    // passes on the broken code without ever reading track 0.
    const { times } = runClock(projectOf([image('bg', 0, 20)], [overlay('o', 0, 0.4)]))
    expect(last(times)).toBeCloseTo(1, 6)
  })

  it('still stops at the ceiling rather than running past the content', () => {
    // The clamp itself is not what was wrong, and must survive: one second of
    // wall clock against a half-second project lands on the end, not past it,
    // and playback stops there.
    const { times, isPlaying } = runClock(projectOf([overlay('o', 0, 0.5)]))
    expect(last(times)).toBeCloseTo(0.5, 6)
    expect(isPlaying).toBe(false)
  })
})
