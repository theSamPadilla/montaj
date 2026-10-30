/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest'
import type { Project } from '../../../types'
import {
  canRemoveVisualTrack, removeVisualTrack, visualTrackItemCount,
  canRemoveAudioLane, removeAudioLane, audioLaneItemCount,
} from '../trackRemoval'
import { groupAudioLanes, trackItems } from '../timeline-model'

const v = (id: string) => ({ id, type: 'video', src: 'a.mp4', start: 0, end: 2 })
const o = (id: string) => ({ id, type: 'overlay', src: 'o.jsx', start: 0, end: 2 })
const a = (id: string, lane?: number) => ({ id, src: 'a.mp3', start: 0, end: 2, ...(lane != null ? { lane } : {}) })
const proj = (tracks: unknown, audio?: unknown[]): Project =>
  ({ id: 'p', tracks, audio: audio ? { tracks: audio } : undefined }) as unknown as Project

describe('visual tracks', () => {
  const p = proj([
    { id: 't0', items: [v('v0')] },
    { id: 't1', items: [o('o0'), o('o1')] },
    { id: 't2', items: [] },
  ])

  it('counts items', () => {
    expect(visualTrackItemCount(p, 1)).toBe(2)
    expect(visualTrackItemCount(p, 2)).toBe(0)
    expect(visualTrackItemCount(p, 9)).toBe(0)
  })

  it('overlay tracks are always removable', () => {
    expect(canRemoveVisualTrack(p, 1)).toBe(true)
    expect(trackItems(removeVisualTrack(p, 1)).map(t => t.length)).toEqual([1, 0])
  })

  it('an empty track counts as video, so two videos let either go', () => {
    expect(canRemoveVisualTrack(p, 0)).toBe(true)
    expect(canRemoveVisualTrack(p, 2)).toBe(true)
  })

  it('refuses the last video track, and out-of-range', () => {
    const only = proj([{ id: 't0', items: [v('v0')] }, { id: 't1', items: [o('o0')] }])
    expect(canRemoveVisualTrack(only, 0)).toBe(false)
    expect(removeVisualTrack(only, 0)).toBe(only)
    expect(canRemoveVisualTrack(only, 5)).toBe(false)
  })

  it('refuses the last empty track', () => {
    const lone = proj([{ id: 't0', items: [] }])
    expect(canRemoveVisualTrack(lone, 0)).toBe(false)
  })

  it('is immutable and keeps ids of survivors', () => {
    const before = JSON.stringify(p)
    const next = removeVisualTrack(p, 1)
    expect(JSON.stringify(p)).toBe(before)
    expect((next.tracks as Array<{ id: string }>).map(t => t.id)).toEqual(['t0', 't2'])
  })

  it('tolerates the legacy bare-array shape', () => {
    const legacy = proj([[v('v0')], [o('o0')]])
    expect(canRemoveVisualTrack(legacy, 1)).toBe(true)
    const next = removeVisualTrack(legacy, 1)
    expect(trackItems(next).map(t => t.map(i => i.id))).toEqual([['v0']])
    expect(canRemoveVisualTrack(legacy, 0)).toBe(false)
    expect(visualTrackItemCount(legacy, 1)).toBe(1)
  })

  it('re-asserts video-before-overlay order', () => {
    const mixed = proj([
      { id: 't0', items: [v('v0')] },
      { id: 't1', items: [o('o0')] },
      { id: 't2', items: [v('v1')] },
    ])
    const next = removeVisualTrack(mixed, 0)
    expect(trackItems(next).map(t => t[0].type)).toEqual(['video', 'overlay'])
  })
})

describe('audio lanes', () => {
  const p = proj([], [a('a0', 0), a('a1', 0), a('a2', 1), a('a3', 2)])

  it('counts clips in a lane', () => {
    expect(audioLaneItemCount(p, 0)).toBe(2)
    expect(audioLaneItemCount(p, 7)).toBe(0)
  })

  it('removes every clip in the lane without renumbering the rest', () => {
    const next = removeAudioLane(p, 1)
    expect(next.audio!.tracks.map(t => t.id)).toEqual(['a0', 'a1', 'a3'])
    expect(groupAudioLanes(next.audio!.tracks).map(l => l.laneIndex)).toEqual([0, 2])
    expect(p.audio!.tracks).toHaveLength(4)
  })

  it('handles lanes auto-assigned from tracks with no lane', () => {
    const auto = proj([], [a('a0'), a('a1')])
    expect(canRemoveAudioLane(auto, 0)).toBe(true)
    expect(removeAudioLane(auto, 0).audio!.tracks.map(t => t.id)).toEqual(['a1'])
  })

  it('refuses the last lane, an unknown lane, and no audio', () => {
    const one = proj([], [a('a0', 0), a('a1', 0)])
    expect(canRemoveAudioLane(one, 0)).toBe(false)
    expect(removeAudioLane(one, 0)).toBe(one)
    expect(canRemoveAudioLane(p, 9)).toBe(false)
    expect(canRemoveAudioLane(proj([]), 0)).toBe(false)
  })
})
