/// <reference types="vitest/globals" />
/**
 * A marquee released OFF the canvas surface keeps what it caught.
 *
 * The bug (Sam, 2026-10-01): a big marquee over many items selected nothing,
 * while a small one worked, so it read as a cap on multi-selection. There is
 * no cap. `itemsInRect` caught every item and the release applied them through
 * `onSelectItems`; then the browser's own `click` undid it.
 *
 * The browser dispatches the `click` that follows a press/release pair to the
 * nearest COMMON ANCESTOR of the mousedown and mouseup targets (measured in
 * Chromium 154). A marquee released inside the surface clicks the surface,
 * whose `onClick` swallows it. A marquee dragged past t=0 into the track rail,
 * or past the last lane, is released on something else, so the click lands on
 * the gutter/canvas row or on Timeline's root. It bubbles to Timeline's
 * `handleContainerClick`, which reads it as a background click and clears the
 * selection the marquee had just made. Covering half a busy timeline from its
 * start means overshooting the edge, which is why "many" failed and "few" did
 * not.
 *
 * jsdom does not synthesize that click, so `releaseOff` dispatches it where
 * Chromium does: on the common ancestor of the two targets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import type { Project } from '../../../types'
import { createPlaybackClock } from '../../playback-clock'
import Timeline from '../Timeline'
import { computeTimelineLayout } from '../canvas/draw'
import { canvasSurface, installCanvasHarness, SURFACE_LEFT, timeToClientX } from './_canvasSelect'

let uninstall: () => void

beforeEach(() => { uninstall = installCanvasHarness() })
afterEach(() => { cleanup(); uninstall() })

const CLIP_LEN = 0.5
const VIDEO_A = 26   // clips on the first video track, 0..13s
const VIDEO_B = 22   // clips on the second, 0..11s
const OVERLAY_TRACKS = 4
const OVERLAYS_PER_TRACK = 3

/** Sam's shape: 4 overlay tracks, 2 video tracks of short clips (48 in all), one
 *  audio lane. Content runs past 20s; every overlay sits before 10s, so t=12 on
 *  the top overlay row is empty track area, which is where a marquee starts. */
function makeProject(): Project {
  const video = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`, type: 'video', src: `${prefix}.mp4`,
    start: i * CLIP_LEN, end: (i + 1) * CLIP_LEN, inPoint: 0, outPoint: CLIP_LEN, sourceDuration: 60,
  }))
  const overlays = (track: number) => Array.from({ length: OVERLAYS_PER_TRACK }, (_, i) => ({
    id: `ov${track}-${i}`, type: 'overlay', src: `overlays/o${track}.jsx`,
    start: i * 3, end: i * 3 + 2, props: {},
  }))
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [
      [...video('va', VIDEO_A), { id: 'va-tail', type: 'video', src: 'tail.mp4', start: 13, end: 24, inPoint: 0, outPoint: 11, sourceDuration: 60 }],
      video('vb', VIDEO_B),
      ...Array.from({ length: OVERLAY_TRACKS }, (_, t) => overlays(t)),
    ],
    audio: { tracks: [{ id: 'music', src: 'music.mp3', start: 0, end: 24, lane: 0 }] },
  } as unknown as Project
}

/** Every item a box from t=0 to t=12 over every row and lane touches. */
function expectedCatch(project: Project): string[] {
  const layout = computeTimelineLayout(project)
  const ids: string[] = []
  for (const row of layout.rows) for (const item of row.items) if (item.start < 12) ids.push(item.id)
  for (const lane of layout.lanes) for (const track of lane.tracks) if (track.start < 12) ids.push(track.id)
  return ids
}

function mount(selectedIds: string[] = []) {
  const project = makeProject()
  const clock = createPlaybackClock(0)
  const onSelectIds = vi.fn()
  const utils = render(
    <Timeline project={project} clock={clock} selectedIds={selectedIds} onSelectIds={onSelectIds} />,
  )
  const surface = canvasSurface(utils.container)
  const layout = computeTimelineLayout(project)
  const top = layout.rows.reduce((a, b) => (b.y < a.y ? b : a))
  if (!top.items.every(i => i.type === 'overlay' && i.end < 12)) throw new Error('top row is not the empty-at-12s overlay row')
  const lastLane = layout.lanes[layout.lanes.length - 1]
  // Top-right corner: empty overlay-row area at t=12. Bottom-left: past the
  // last lane and past t=0, over the track rail, the way you catch a run of
  // clips from its very start.
  const from = { clientX: timeToClientX(project, 12), clientY: top.y + top.height / 2 }
  const to = { clientX: SURFACE_LEFT - 30, clientY: lastLane.y + lastLane.height + 20 }
  return { project, onSelectIds, surface, from, to, ...utils }
}

function mouse(type: string, p: { clientX: number; clientY: number }, shiftKey = false): MouseEvent {
  return new MouseEvent(type, { ...p, button: 0, bubbles: true, cancelable: true, shiftKey })
}

function commonAncestor(a: Element, b: Element): Element {
  let n: Element | null = a
  while (n && !n.contains(b)) n = n.parentElement
  if (!n) throw new Error('no common ancestor')
  return n
}

/** Press on the surface, drag in steps, release on `releaseTarget`, then fire
 *  the click on the common ancestor of the two targets, as Chromium does. */
function marquee(
  surface: HTMLElement,
  from: { clientX: number; clientY: number },
  to: { clientX: number; clientY: number },
  releaseTarget: Element,
  shiftKey = false,
) {
  act(() => { surface.dispatchEvent(mouse('mousedown', from, shiftKey)) })
  for (let i = 1; i <= 6; i++) {
    const at = { clientX: from.clientX + ((to.clientX - from.clientX) * i) / 6, clientY: from.clientY + ((to.clientY - from.clientY) * i) / 6 }
    act(() => { document.dispatchEvent(mouse('mousemove', at, shiftKey)) })
  }
  act(() => {
    releaseTarget.dispatchEvent(mouse('mouseup', to, shiftKey))
    commonAncestor(surface, releaseTarget).dispatchEvent(mouse('click', to, shiftKey))
  })
}

/** The selection the host ends up holding: the last thing Timeline asked for. */
function finalSelection(onSelectIds: ReturnType<typeof vi.fn>): string[] {
  const calls = onSelectIds.mock.calls
  return calls.length ? (calls[calls.length - 1][0] as string[]) : []
}

describe('Timeline: a marquee released off the canvas', () => {
  it('released over the track rail, keeps every item it caught across overlay, video and audio', () => {
    const { project, onSelectIds, surface, from, to } = mount()
    const gutter = surface.parentElement?.previousElementSibling
    expect(gutter, 'the track rail sits beside the canvas column').toBeTruthy()

    marquee(surface, from, to, gutter!)

    const expected = expectedCatch(project)
    expect(expected.length).toBeGreaterThan(55)
    // One selection change, the marquee's. Before the fix this was
    // [catch, 0]: the catch, then the stray click's clear.
    expect(onSelectIds.mock.calls.map(c => (c[0] as string[]).length)).toEqual([expected.length])
    expect(new Set(finalSelection(onSelectIds))).toEqual(new Set(expected))
    expect(finalSelection(onSelectIds)).toEqual(expect.arrayContaining(['ov3-2', 'va0', 'vb21', 'music']))
  })

  it('released below the last lane (on Timeline\'s root), keeps what it caught', () => {
    const { project, onSelectIds, surface, from, container } = mount()
    const root = container.firstElementChild as HTMLElement
    const to = { clientX: timeToClientX(project, 0) + 1, clientY: 2000 }

    marquee(surface, from, to, root)

    expect(new Set(finalSelection(onSelectIds))).toEqual(new Set(expectedCatch(project)))
  })

  it('released inside the surface, keeps what it caught (the case that always worked)', () => {
    const { project, onSelectIds, surface, from } = mount()
    const layout = computeTimelineLayout(project)
    const lastLane = layout.lanes[layout.lanes.length - 1]
    const to = { clientX: timeToClientX(project, 0) + 1, clientY: lastLane.y + lastLane.height / 2 }

    marquee(surface, from, to, surface)

    expect(new Set(finalSelection(onSelectIds))).toEqual(new Set(expectedCatch(project)))
  })

  it('shift still adds the catch to the existing selection when released off the canvas', () => {
    const { project, onSelectIds, surface, from, to } = mount(['va-tail'])
    const gutter = surface.parentElement!.previousElementSibling!

    marquee(surface, from, to, gutter, true)

    expect(new Set(finalSelection(onSelectIds))).toEqual(new Set(['va-tail', ...expectedCatch(project)]))
  })

  it('a later background click with no canvas press still clears the selection', () => {
    const { onSelectIds, surface, from, to, container } = mount(['va0'])
    marquee(surface, from, to, surface.parentElement!.previousElementSibling!)
    onSelectIds.mockClear()
    // The one-shot swallow is gone once the gesture's own click has passed.
    const root = container.firstElementChild as HTMLElement
    act(() => { root.dispatchEvent(mouse('click', { clientX: 600, clientY: 10 })) })
    expect(onSelectIds).toHaveBeenCalledWith([])
  })
})
