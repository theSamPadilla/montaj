import { describe, it, expect } from 'vitest'
import type { Project } from '../../../types'
import type { AudioTrack } from '../../../schema'
import { computeAutoCrossfade, computeDerivedTiming, groupAudioLanes } from '../timeline-model'

function track(overrides: Partial<AudioTrack> = {}): AudioTrack {
  return { id: 't0', src: 'a.mp3', start: 0, end: 2, ...overrides }
}

function project(overrides: Partial<Project> = {}): Project {
  return { id: 'p1', ...overrides } as unknown as Project
}

describe('computeDerivedTiming', () => {
  it('derives snap boundaries, content duration, and padded total duration from tracks + audio', () => {
    const p = project({
      tracks: [[
        { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 4 },
        { id: 'c1', type: 'video', src: 'b.mp4', start: 4, end: 10 },
      ]],
      audio: { tracks: [track({ start: 2, end: 6 })] },
    } as unknown as Partial<Project>)

    const { snapBoundaries, contentDuration, totalDuration } = computeDerivedTiming(p)
    expect(snapBoundaries.sort((a, b) => a - b)).toEqual([0, 2, 4, 6, 10])
    expect(contentDuration).toBe(10)
    // max(5, 10 * 0.2) = 5s padding beyond content
    expect(totalDuration).toBe(15)
  })

  it('uses the 5s minimum headroom when 20% of content duration is smaller', () => {
    const p = project({
      tracks: [[{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 2 }]],
    } as unknown as Partial<Project>)

    const { contentDuration, totalDuration } = computeDerivedTiming(p)
    expect(contentDuration).toBe(2)
    expect(totalDuration).toBe(7) // 2 + max(5, 0.4) = 7
  })

  it('returns zeroed timing for a project with no tracks or audio', () => {
    const { snapBoundaries, contentDuration, totalDuration } = computeDerivedTiming(project())
    expect(snapBoundaries).toEqual([])
    expect(contentDuration).toBe(0)
    expect(totalDuration).toBe(5)
  })
})

describe('computeAutoCrossfade', () => {
  it('returns null (no-change signal) when there are no audio tracks', () => {
    expect(computeAutoCrossfade(project())).toBeNull()
    expect(computeAutoCrossfade(project({ audio: { tracks: [] } }))).toBeNull()
  })

  it('returns null when tracks do not overlap, leaving any stale fade values untouched', () => {
    // The overlap check is a strict `a.end > b.start` — touching (not
    // overlapping) tracks never enter the fade-assignment branch at all, so
    // pre-existing fade values (e.g. left over from before the tracks were
    // moved apart) are not cleared. This mirrors the original inline effect
    // exactly: there is no "un-fade" branch, only "set fade while overlapping".
    const p = project({
      audio: {
        tracks: [
          track({ id: 'a', start: 0, end: 2, fadeOut: 1 }),
          track({ id: 'b', start: 2, end: 4, fadeIn: 1 }),
        ],
      },
    })
    expect(computeAutoCrossfade(p)).toBeNull()
  })

  it('adds fade-out/fade-in on overlapping tracks, sized to the overlap', () => {
    const p = project({
      audio: { tracks: [track({ id: 'a', start: 0, end: 3 }), track({ id: 'b', start: 2, end: 5 })] },
    })
    const next = computeAutoCrossfade(p)
    expect(next).not.toBeNull()
    const tracks = next!.audio!.tracks
    expect(tracks.find(t => t.id === 'a')!.fadeOut).toBe(1)
    expect(tracks.find(t => t.id === 'b')!.fadeIn).toBe(1)
  })

  it('shrinks an existing fade as two still-overlapping tracks are moved further apart', () => {
    const p = project({
      audio: {
        tracks: [
          track({ id: 'a', start: 0, end: 3, fadeOut: 2 }),
          track({ id: 'b', start: 2.5, end: 5, fadeIn: 2 }),
        ],
      },
    })
    const next = computeAutoCrossfade(p)
    expect(next).not.toBeNull()
    const tracks = next!.audio!.tracks
    expect(tracks.find(t => t.id === 'a')!.fadeOut).toBe(0.5)
    expect(tracks.find(t => t.id === 'b')!.fadeIn).toBe(0.5)
  })

  it('returns null when existing fades already match the overlap (no-change signal, loop-safe)', () => {
    const p = project({
      audio: {
        tracks: [
          track({ id: 'a', start: 0, end: 3, fadeOut: 1 }),
          track({ id: 'b', start: 2, end: 5, fadeIn: 1 }),
        ],
      },
    })
    expect(computeAutoCrossfade(p)).toBeNull()
  })

  it('ignores overlap when either track is muted', () => {
    const p = project({
      audio: {
        tracks: [
          track({ id: 'a', start: 0, end: 3, muted: true }),
          track({ id: 'b', start: 2, end: 5 }),
        ],
      },
    })
    expect(computeAutoCrossfade(p)).toBeNull()
  })

  it('preserves original track order and untouched tracks in the returned project', () => {
    const p = project({
      audio: {
        tracks: [
          track({ id: 'solo', start: 20, end: 22 }),
          track({ id: 'a', start: 0, end: 3 }),
          track({ id: 'b', start: 2, end: 5 }),
        ],
      },
    })
    const next = computeAutoCrossfade(p)
    expect(next).not.toBeNull()
    expect(next!.audio!.tracks.map(t => t.id)).toEqual(['solo', 'a', 'b'])
    expect(next!.audio!.tracks.find(t => t.id === 'solo')!.fadeOut).toBeUndefined()
  })
})

describe('groupAudioLanes', () => {
  it('keeps explicit lanes and sorts ascending', () => {
    const lanes = groupAudioLanes([
      track({ id: 'b', lane: 2 }),
      track({ id: 'a', lane: 0 }),
      track({ id: 'c', lane: 2 }),
    ])
    expect(lanes.map(l => l.laneIndex)).toEqual([0, 2])
    expect(lanes[1].tracks.map(t => t.id)).toEqual(['b', 'c'])
  })

  it('auto-assigns lane-less tracks above the highest explicit lane, in array order', () => {
    const lanes = groupAudioLanes([
      track({ id: 'auto1' }),
      track({ id: 'pinned', lane: 3 }),
      track({ id: 'auto2' }),
    ])
    expect(lanes.map(l => l.laneIndex)).toEqual([3, 4, 5])
    expect(lanes.map(l => l.tracks[0].id)).toEqual(['pinned', 'auto1', 'auto2'])
  })

  it('returns nothing for no tracks', () => {
    expect(groupAudioLanes([])).toEqual([])
  })
})
