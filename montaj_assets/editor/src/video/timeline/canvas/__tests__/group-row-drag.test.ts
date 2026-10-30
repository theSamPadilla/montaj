/// <reference types="vitest/globals" />
/**
 * A multi-selection dragged as one lands on the ROW UNDER THE POINTER: every
 * selected clip of that row's kind goes into that one row at its dragged time,
 * offsets kept, and an overlap there is kept as dropped (the same-row crossfade
 * makes the fade). What the row does not take moves in time only.
 */
import { describe, it, expect } from 'vitest'
import type { Project } from '../../../../types'
import type { AudioTrack } from '../../../../schema'
import { ROW_GAP_PX, computeAutoCrossfade, computeDerivedTiming, computeVisualCrossfade, normalizeTracks, stampAudioLanes } from '../../timeline-model'
import { computeTimelineLayout } from '../draw'
import { NO_MODIFIERS, createPointerMachine, type PointerContext, type PointerEffect } from '../pointer-machine'

const VIEWPORT = { pxPerSecond: 100, scrollSeconds: 0, widthPx: 2000 }
const NO_SNAP = { attractPx: 0, releasePx: 0, weakAttractPx: 0, weakReleasePx: 0 }

type Point = { x: number; y: number }

/** Press at `from` with `selectedIds` selected, move there in four steps, release. */
function groupDrag(project: Project, selectedIds: string[], from: Point, to: Point) {
  const { snapBoundaries, totalDuration } = computeDerivedTiming(project)
  const ctx: PointerContext = {
    project, layout: computeTimelineLayout(project), viewport: VIEWPORT, selectedIds,
    snapBoundaries, totalDuration, rippleMode: false, playheadTime: -100, fps: 30, snapConfig: NO_SNAP,
  }
  const m = createPointerMachine()
  const effects: PointerEffect[] = [...m.dispatch({ type: 'pointerDown', point: from, modifiers: NO_MODIFIERS, ctx })]
  for (let i = 1; i <= 4; i++) {
    const point = { x: from.x + (to.x - from.x) * i / 4, y: from.y + (to.y - from.y) * i / 4 }
    effects.push(...m.dispatch({ type: 'pointerMove', point, modifiers: NO_MODIFIERS, ctx }))
  }
  const up = m.dispatch({ type: 'pointerUp', point: to, modifiers: NO_MODIFIERS, ctx })
  effects.push(...up)
  const commits = up.filter((e): e is Extract<PointerEffect, { type: 'commit' }> => e.type === 'commit')
  expect(commits).toHaveLength(1)   // one undo step
  return { committed: commits[0].project, effects }
}

const rowMid = (p: Project, trackIdx: number) => {
  const row = computeTimelineLayout(p).rows.find(r => r.trackIdx === trackIdx)!
  return Math.round(row.y + row.height / 2)
}
const laneMid = (p: Project, laneIndex: number) => {
  const lane = computeTimelineLayout(p).lanes.find(l => l.laneIndex === laneIndex)!
  return Math.round(lane.y + lane.height / 2)
}
const audioOf = (p: Project, id: string) => p.audio!.tracks.find(t => t.id === id)!
const visualOf = (p: Project, id: string) => normalizeTracks(p).tracks!.flatMap(t => t.items).find(i => i.id === id)!
const trackIdOf = (p: Project, id: string) => normalizeTracks(p).tracks!.find(t => t.items.some(i => i.id === id))!.id
const audioRows = (p: Project) => computeTimelineLayout(p).lanes.map(l => l.tracks.map(t => t.id))

function project(tracks: unknown[], audio: AudioTrack[] = []): Project {
  return { id: 'p', tracks, audio: { tracks: audio } } as unknown as Project
}
const BASE = { id: 'trk-0', items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 20, inPoint: 0, outPoint: 20, sourceDuration: 20 }] }

// ── Audio ────────────────────────────────────────────────────────────────

describe('audio: a group dragged onto one row', () => {
  const threeRows = () => project([BASE], [
    { id: 'a', src: 'a.wav', start: 0, end: 1, lane: 0 },
    { id: 'b', src: 'b.wav', start: 2, end: 3, lane: 1 },
    { id: 'c', src: 'c.wav', start: 4, end: 5, lane: 2 },
  ] as AudioTrack[])

  it('3 clips on 3 rows all land on the row under the pointer, offsets kept', () => {
    const p = threeRows()
    // Pressed on a (row 0), dropped on row 1, half a second to the right.
    const { committed, effects } = groupDrag(p, ['a', 'b', 'c'], { x: 50, y: laneMid(p, 0) }, { x: 100, y: laneMid(p, 1) })
    expect(audioOf(committed, 'a')).toMatchObject({ lane: 1, start: 0.5, end: 1.5 })
    expect(audioOf(committed, 'b')).toMatchObject({ lane: 1, start: 2.5, end: 3.5 })
    expect(audioOf(committed, 'c')).toMatchObject({ lane: 1, start: 4.5, end: 5.5 })
    expect(audioRows(committed)).toEqual([['a', 'b', 'c']])
    // The destination row is highlighted while over it, and cleared on release.
    const drops = effects.filter((e): e is Extract<PointerEffect, { type: 'dropLane' }> => e.type === 'dropLane')
    expect(drops.map(d => d.laneIndex)).toEqual([1, null])
  })

  it('lanes are stamped first: an unselected lane-less row never moves', () => {
    const p = project([BASE], [
      { id: 'music', type: 'music', src: 'm.mp3', start: 0, end: 10 },
      { id: 'v1', type: 'voiceover', src: '1.wav', start: 0, end: 2 },
      { id: 'v2', type: 'voiceover', src: '2.wav', start: 1, end: 3 },
    ] as AudioTrack[])
    expect(audioRows(p)).toEqual([['music'], ['v1'], ['v2']])
    const { committed } = groupDrag(p, ['v1', 'v2'], { x: 150, y: laneMid(p, 2) }, { x: 150, y: laneMid(p, 1) })
    expect(audioRows(committed)).toEqual([['music'], ['v1', 'v2']])
    expect(audioOf(committed, 'music').lane).toBe(0)
  })

  it('an overlapping pair after the drop stays as dropped and crossfades on save', () => {
    const p = project([BASE], [
      { id: 'a', src: 'a.wav', start: 0, end: 2, lane: 0 },
      { id: 'b', src: 'b.wav', start: 1.5, end: 3, lane: 1 },
    ] as AudioTrack[])
    const { committed } = groupDrag(p, ['a', 'b'], { x: 250, y: laneMid(p, 1) }, { x: 250, y: laneMid(p, 0) })
    expect(audioOf(committed, 'a')).toMatchObject({ lane: 0, start: 0, end: 2 })
    expect(audioOf(committed, 'b')).toMatchObject({ lane: 0, start: 1.5, end: 3 })
    // The commit path: stamp, then the audio crossfade pass.
    const saved = computeAutoCrossfade(stampAudioLanes(committed))!
    expect(audioOf(saved, 'a').fadeOut).toBe(0.5)
    expect(audioOf(saved, 'b').fadeIn).toBe(0.5)
    expect(audioOf(saved, 'b')).toMatchObject({ lane: 0, start: 1.5, end: 3 })
  })

  it('below the last row opens ONE new row for all of them', () => {
    const p = threeRows()
    const lanes = computeTimelineLayout(p).lanes
    const last = lanes[lanes.length - 1]
    const { committed } = groupDrag(p, ['a', 'b'], { x: 50, y: laneMid(p, 0) }, { x: 50, y: last.y + last.height + ROW_GAP_PX + 10 })
    expect(audioOf(committed, 'a').lane).toBe(3)
    expect(audioOf(committed, 'b').lane).toBe(3)
    expect(audioOf(committed, 'c').lane).toBe(2)
  })

  it('over a visual row, the audio moves in time only', () => {
    const p = threeRows()
    const { committed } = groupDrag(p, ['a', 'b'], { x: 50, y: laneMid(p, 0) }, { x: 150, y: rowMid(p, 0) })
    expect(audioOf(committed, 'a')).toMatchObject({ lane: 0, start: 1, end: 2 })
    expect(audioOf(committed, 'b')).toMatchObject({ lane: 1, start: 3, end: 4 })
  })
})

// ── Visual ───────────────────────────────────────────────────────────────

describe('overlays: a group dragged onto one overlay track', () => {
  const twoTracks = () => project([
    BASE,
    { id: 'trk-1', items: [{ id: 'o1', type: 'overlay', start: 0, end: 2 }] },
    { id: 'trk-2', items: [{ id: 'o2', type: 'overlay', start: 1.5, end: 3.5 }] },
    { id: 'trk-3', items: [{ id: 'o3', type: 'overlay', start: 8, end: 9 }] },
  ])

  it('2 overlays from 2 tracks land on the track under the pointer, offsets kept', () => {
    const p = twoTracks()
    const { committed } = groupDrag(p, ['o1', 'o2'], { x: 100, y: rowMid(p, 1) }, { x: 150, y: rowMid(p, 3) })
    expect(trackIdOf(committed, 'o1')).toBe('trk-3')
    expect(trackIdOf(committed, 'o2')).toBe('trk-3')
    expect(visualOf(committed, 'o1')).toMatchObject({ start: 0.5, end: 2.5 })
    expect(visualOf(committed, 'o2')).toMatchObject({ start: 2, end: 4 })
    expect(normalizeTracks(committed).tracks!.map(t => t.id)).toEqual(['trk-0', 'trk-3'])
  })

  it('their overlap stays as dropped and gets the same-track crossfade on save', () => {
    const p = twoTracks()
    const { committed } = groupDrag(p, ['o1', 'o2'], { x: 100, y: rowMid(p, 1) }, { x: 100, y: rowMid(p, 3) })
    expect(visualOf(committed, 'o1')).toMatchObject({ start: 0, end: 2 })
    expect(visualOf(committed, 'o2')).toMatchObject({ start: 1.5, end: 3.5 })
    const saved = computeVisualCrossfade(committed)!
    expect(saved).not.toBeNull()
    expect(visualOf(saved, 'o1').keyframes?.some(k => k.prop === 'opacity')).toBe(true)
    expect(visualOf(saved, 'o2').keyframes?.some(k => k.prop === 'opacity')).toBe(true)
  })

  it('never onto the video track: the kind gate keeps them in place, moved in time only', () => {
    const p = twoTracks()
    const { committed } = groupDrag(p, ['o1', 'o2'], { x: 100, y: rowMid(p, 1) }, { x: 200, y: rowMid(p, 0) })
    expect(trackIdOf(committed, 'o1')).toBe('trk-1')
    expect(trackIdOf(committed, 'o2')).toBe('trk-2')
    expect(visualOf(committed, 'o1')).toMatchObject({ start: 1, end: 3 })
  })
})

describe('video: a group dragged onto one video track', () => {
  const clip = (id: string, start: number, end: number) =>
    ({ id, type: 'video', src: `${id}.mp4`, start, end, inPoint: 0, outPoint: end - start, sourceDuration: 20 })
  const p0 = () => project([
    { id: 'trk-0', items: [clip('c0', 0, 3)] },
    { id: 'trk-1', items: [clip('v1', 2.5, 5)] },
    { id: 'trk-2', items: [clip('v2', 8, 10)] },
  ])

  it('2 clips from 2 video tracks land on the track under the pointer, the overlap kept as dropped', () => {
    const p = p0()
    const { committed } = groupDrag(p, ['v1', 'v2'], { x: 300, y: rowMid(p, 1) }, { x: 300, y: rowMid(p, 0) })
    expect(trackIdOf(committed, 'v1')).toBe('trk-0')
    expect(trackIdOf(committed, 'v2')).toBe('trk-0')
    expect(visualOf(committed, 'v1')).toMatchObject({ start: 2.5, end: 5 })   // overlaps c0 by 0.5 s: a transition
    expect(visualOf(committed, 'v2')).toMatchObject({ start: 8, end: 10 })
    expect(normalizeTracks(committed).tracks).toHaveLength(1)
  })
})

describe('a mixed audio + overlay selection', () => {
  const mixed = () => project([
    BASE,
    { id: 'trk-1', items: [{ id: 'o1', type: 'overlay', start: 0, end: 2 }] },
  ], [
    { id: 'a', src: 'a.wav', start: 3, end: 4, lane: 0 },
    { id: 'b', src: 'b.wav', start: 5, end: 6, lane: 1 },
  ] as AudioTrack[])

  it('dropped on an audio row: the audio lands in it, the overlay moves in time only', () => {
    const p = mixed()
    const { committed } = groupDrag(p, ['a', 'o1'], { x: 350, y: laneMid(p, 0) }, { x: 400, y: laneMid(p, 1) })
    expect(audioOf(committed, 'a')).toMatchObject({ lane: 1, start: 3.5, end: 4.5 })
    expect(trackIdOf(committed, 'o1')).toBe('trk-1')
    expect(visualOf(committed, 'o1')).toMatchObject({ start: 0.5, end: 2.5 })
  })

  it('still over the pressed row, everything moves in time only', () => {
    const p = mixed()
    const { committed } = groupDrag(p, ['a', 'b'], { x: 350, y: laneMid(p, 0) }, { x: 400, y: laneMid(p, 0) })
    expect(audioOf(committed, 'a')).toMatchObject({ lane: 0, start: 3.5 })
    expect(audioOf(committed, 'b')).toMatchObject({ lane: 1, start: 5.5 })
  })
})
