/**
 * A sped-up clip on the main track (tracks[0], the legacy <video> path) must
 * seek, play and report time at its speed, the same way timeline-core's
 * `seekTime` and the overlay layer's `OverlayVideo` do:
 *   source = inPoint + S · (projectT − start),  projectT = start + (source − inPoint) / S
 * Before the fix the main track scrubbed to `inPoint + (projectT − start)` and
 * played at 1×, so a 2× clip showed the wrong frame on every scrub.
 */
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useVideoPlayback } from '../useVideoPlayback'
import type { EditorProject, VisualItem } from '../../../schema'

function fakeVideo(): HTMLVideoElement {
  const el = document.createElement('video')
  let t = 0
  Object.defineProperty(el, 'currentTime', { get: () => t, set: (v: number) => { t = v }, configurable: true })
  ;(el as unknown as { __montajGain: unknown }).__montajGain = { gain: { value: 1 } }
  return el
}

const clip = (speed?: number, extra: Partial<VisualItem> = {}): VisualItem =>
  ({ id: 'c1', type: 'video', src: '/w/a.mp4', start: 2, end: 6, inPoint: 1, outPoint: speed ? 1 + 4 * speed : 5, ...(speed ? { speed } : {}), ...extra }) as VisualItem

function project(items: VisualItem[]): EditorProject {
  return { id: 'p', status: 'draft', settings: { resolution: [1080, 1920] }, tracks: [{ id: 'trk-0', items }] } as unknown as EditorProject
}

function mountAt(items: VisualItem[], t: number) {
  const p = project(items)
  const h = renderHook(
    ({ p, t }: { p: EditorProject; t: number }) => useVideoPlayback(p, t, () => {}, (path) => path),
    { initialProps: { p, t: 0 } },
  )
  const v0 = fakeVideo(), v1 = fakeVideo()
  h.result.current.video0Ref.current = v0
  h.result.current.video1Ref.current = v1
  h.rerender({ p: { ...p }, t })
  const active = () => (h.result.current.activeSlotRef.current === 0 ? v0 : v1)
  return { ...h, active }
}

describe('main-track speed in the legacy <video> preview', () => {
  it('a scrub into a 2x clip seeks to inPoint + 2 x elapsed', () => {
    const h = mountAt([clip(2)], 3.5) // 1.5 s into the clip
    expect(h.active().currentTime).toBeCloseTo(1 + 2 * 1.5, 6)
  })

  it('a scrub into a 0.5x clip seeks to inPoint + 0.5 x elapsed', () => {
    const h = mountAt([clip(0.5)], 4) // 2 s into the clip
    expect(h.active().currentTime).toBeCloseTo(1 + 0.5 * 2, 6)
  })

  it('a clip with no speed is unchanged (1x)', () => {
    const h = mountAt([clip()], 3.5)
    expect(h.active().currentTime).toBeCloseTo(1 + 1.5, 6)
  })

  it('the active element plays at the clip speed', () => {
    const h = mountAt([clip(2)], 3.5)
    expect(h.active().playbackRate).toBe(2)
  })

  it('reported project time divides the source offset by the speed', async () => {
    const times: number[] = []
    const p = project([clip(2)])
    const h = renderHook(
      ({ p, t }: { p: EditorProject; t: number }) => useVideoPlayback(p, t, (x: number) => times.push(x), (path) => path),
      { initialProps: { p, t: 0 } },
    )
    const v0 = fakeVideo(), v1 = fakeVideo()
    h.result.current.video0Ref.current = v0
    h.result.current.video1Ref.current = v1
    h.rerender({ p: { ...p }, t: 3.5 })
    const active = h.result.current.activeSlotRef.current === 0 ? v0 : v1
    await new Promise((r) => setTimeout(r, 150)) // the post-seek guard clears after 100 ms
    active.currentTime = 1 + 2 * 2.5 // source 2.5 project-seconds into the clip at 2x
    h.result.current.handleTimeUpdate()
    expect(times.length).toBeGreaterThan(0)
    expect(times[times.length - 1]).toBeCloseTo(2 + 2.5, 6)
  })
})
