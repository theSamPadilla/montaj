/// <reference types="vitest/globals" />
/**
 * Dropping a sound from the Media bin: where it lands in `audio.tracks`. Pure data, like placement.test.ts.
 * A drop on an existing audio lane lands there; anywhere else (or on a lane the sound would overlap) it gets a new lane.
 */
import { describe, it, expect } from 'vitest'
import type { Project } from '../../../types'
import { placeDroppedAudio } from '../placement'
import { groupAudioLanes } from '../timeline-model'

const base = (tracks: unknown[]): Project =>
  ({ id: 'p', tracks: [{ id: 'trk-0', items: [] }], audio: { tracks } }) as unknown as Project

const SOUND = { src: '/p/assets/bed.mp3', sourceDuration: 10, name: 'bed.mp3', type: 'music' as const }

describe('placeDroppedAudio', () => {
  it('puts the sound on a new lane at the drop time when the project has no audio', () => {
    const out = placeDroppedAudio(base([]), { atTime: 3, preferredLane: -1, audio: SOUND })
    expect(out.audio?.tracks).toEqual([
      expect.objectContaining({ src: '/p/assets/bed.mp3', type: 'music', start: 3, end: 13, sourceDuration: 10, lane: 0, label: 'bed.mp3' }),
    ])
    expect(out.audio!.tracks![0].id).toBeTruthy()
  })

  it('a drop on an existing lane lands on that lane', () => {
    const p = base([{ id: 'a', src: '/x.mp3', start: 0, end: 4, lane: 0 }, { id: 'b', src: '/y.mp3', start: 0, end: 4, lane: 1 }])
    const out = placeDroppedAudio(p, { atTime: 6, preferredLane: 1, audio: SOUND })
    const added = out.audio!.tracks!.find(t => t.src === SOUND.src)!
    expect(added).toMatchObject({ lane: 1, start: 6, end: 16 })
  })

  it('a drop anywhere else (no lane under the pointer) gets a new lane under the last', () => {
    const p = base([{ id: 'a', src: '/x.mp3', start: 0, end: 4, lane: 0 }, { id: 'b', src: '/y.mp3', start: 0, end: 4, lane: 3 }])
    const out = placeDroppedAudio(p, { atTime: 6, preferredLane: -1, audio: SOUND })
    expect(out.audio!.tracks!.find(t => t.src === SOUND.src)!.lane).toBe(4)
  })

  it('a lane the sound would overlap is not used: the sound gets a new lane', () => {
    const p = base([{ id: 'a', src: '/x.mp3', start: 0, end: 8, lane: 0 }])
    const out = placeDroppedAudio(p, { atTime: 5, preferredLane: 0, audio: SOUND })
    expect(out.audio!.tracks!.find(t => t.src === SOUND.src)!.lane).toBe(1)
  })

  it('lane-less tracks keep their rows: they are given the lane they are drawn on', () => {
    const p = base([{ id: 'a', src: '/x.mp3', start: 0, end: 4 }, { id: 'b', src: '/y.mp3', start: 0, end: 4 }])
    const lanesBefore = groupAudioLanes(p.audio!.tracks!).map(l => l.tracks.map(t => t.id))
    const out = placeDroppedAudio(p, { atTime: 6, preferredLane: 1, audio: SOUND })
    const lanes = groupAudioLanes(out.audio!.tracks!)
    expect(lanes.map(l => l.tracks.map(t => t.id).filter(id => lanesBefore.flat().includes(id)))).toEqual(lanesBefore)
    expect(lanes[1].tracks.map(t => t.src)).toContain(SOUND.src)
  })

  it('snaps to a nearby boundary like a video drop', () => {
    const out = placeDroppedAudio(base([]), { atTime: 4.95, preferredLane: -1, audio: SOUND, snapTimes: [5], snapToleranceSec: 0.2 })
    expect(out.audio!.tracks![0].start).toBe(5)
  })

  it('places nothing, by reference, when the sound has no length', () => {
    const p = base([])
    expect(placeDroppedAudio(p, { atTime: 1, preferredLane: -1, audio: { ...SOUND, sourceDuration: 0 } })).toBe(p)
  })

  it('every id stays unique', () => {
    let p = base([])
    for (let i = 0; i < 3; i++) p = placeDroppedAudio(p, { atTime: 0, preferredLane: -1, audio: SOUND })
    const ids = p.audio!.tracks!.map(t => t.id)
    expect(new Set(ids).size).toBe(3)
  })
})
