/// <reference types="vitest/globals" />
/**
 * Audio rows: lane-less tracks are packed into rows by kind (`packAudioLanes`),
 * and `stampAudioLanes` writes those rows down as explicit lanes without moving
 * any of them.
 */
import { describe, it, expect } from 'vitest'
import type { Project } from '../../../types'
import type { AudioTrack } from '../../../schema'
import { AUDIO_PACK_TOLERANCE_S, computeAutoCrossfade, computeDerivedTiming, groupAudioLanes, packAudioLanes, stampAudioLanes } from '../timeline-model'
import { reflowMagneticLanes } from '../../audioMagnet'
import { duplicateSelection, pasteAt } from '../../clipboard-ops'

function track(over: Partial<AudioTrack> & { id: string }): AudioTrack {
  return { src: `${over.id}.mp3`, start: 0, end: 2, ...over }
}

function project(tracks: AudioTrack[]): Project {
  return { id: 'p', tracks: [], audio: { tracks } } as unknown as Project
}

/** Track ids per drawn row, top row first. */
function rows(p: Project): string[][] {
  const tracks = p.audio?.tracks ?? []
  return groupAudioLanes(tracks, computeDerivedTiming(p).contentDuration).map(l => l.tracks.map(t => t.id))
}

/** The AI-made shape: a voiceover cut into 14 back-to-back segments, then a music bed and one sfx, none with a lane. */
function aiProject(): Project {
  const vo = Array.from({ length: 14 }, (_, i) =>
    track({ id: `vo-take1-seg-${i}`, type: 'voiceover', start: i * 2.5, end: (i + 1) * 2.5 }))
  return project([
    ...vo,
    track({ id: 'music', type: 'music', start: 0, end: 35 }),
    track({ id: 'sfx', type: 'sfx', start: 4, end: 5 }),
  ])
}

describe('packAudioLanes', () => {
  it('packs 14 back-to-back voiceover segments, a music bed and an sfx into 3 rows: voice, music, sfx', () => {
    const r = rows(aiProject())
    expect(r).toHaveLength(3)
    expect(r[0]).toHaveLength(14)
    expect(r[0].every(id => id.startsWith('vo-'))).toBe(true)
    expect(r[1]).toEqual(['music'])
    expect(r[2]).toEqual(['sfx'])
  })

  it('splits overlapping clips of one kind into 2 rows', () => {
    const p = project([
      track({ id: 'a', type: 'voiceover', start: 0, end: 3 }),
      track({ id: 'b', type: 'voiceover', start: 2, end: 5 }),
      track({ id: 'c', type: 'voiceover', start: 5, end: 6 }),
    ])
    // c starts where a's row is free again (a ends at 3), so it goes back in the first row.
    expect(rows(p)).toEqual([['a', 'c'], ['b']])
  })

  it('ignores an overlap under 50 ms: a 30 ms overlap shares a row', () => {
    expect(AUDIO_PACK_TOLERANCE_S).toBe(0.05)
    const p = project([
      track({ id: 'a', start: 0, end: 1.03 }),
      track({ id: 'b', start: 1, end: 2 }),
    ])
    expect(rows(p)).toEqual([['a', 'b']])
  })

  it('a 60 ms overlap splits', () => {
    const p = project([
      track({ id: 'a', start: 0, end: 1.06 }),
      track({ id: 'b', start: 1, end: 2 }),
    ])
    expect(rows(p)).toEqual([['a'], ['b']])
  })

  it('a 30 ms overlap stamped into one row gets no fade, and keeps any fade it had', () => {
    // Rounded to 0.1 s the overlap is 0: not a crossfade, so nothing is written.
    const p = project([
      track({ id: 'a', start: 0, end: 1.03, fadeOut: 0.5 }),
      track({ id: 'b', start: 1, end: 2 }),
    ])
    const stamped = stampAudioLanes(p)
    expect(stamped.audio!.tracks.map(t => t.lane)).toEqual([0, 0])
    expect(computeAutoCrossfade(stamped)).toBeNull()
  })

  it('never puts music or sfx in a row with voice, even with no overlap', () => {
    const p = project([
      track({ id: 'vo', type: 'voiceover', start: 0, end: 1 }),
      track({ id: 'm', type: 'music', start: 2, end: 3 }),
      track({ id: 's', type: 'sfx', start: 4, end: 5 }),
      track({ id: 'plain', start: 6, end: 7 }),
    ])
    expect(rows(p)).toEqual([['vo'], ['m'], ['s'], ['plain']])
  })

  it('orders kinds by first appearance and packs each kind by start, not array order', () => {
    const p = project([
      track({ id: 'm', type: 'music', start: 0, end: 10 }),
      track({ id: 'vo2', type: 'voiceover', start: 3, end: 4 }),
      track({ id: 'vo1', type: 'voiceover', start: 0, end: 3 }),
    ])
    const lanes = packAudioLanes(p.audio!.tracks)
    expect(lanes).toEqual([0, 1, 1])
    // Within a lane, tracks keep array order.
    expect(rows(p)).toEqual([['m'], ['vo2', 'vo1']])
  })

  it('keeps explicit lanes as they are and packs lane-less tracks into rows above them', () => {
    const p = project([
      track({ id: 'x', lane: 0, start: 0, end: 10 }),
      track({ id: 'y', lane: 5, start: 0, end: 10 }),
      track({ id: 'vo1', type: 'voiceover', start: 0, end: 2 }),
      track({ id: 'vo2', type: 'voiceover', start: 2, end: 4 }),
      track({ id: 'm', type: 'music', start: 0, end: 4 }),
    ])
    expect(packAudioLanes(p.audio!.tracks)).toEqual([0, 5, 6, 6, 7])
    expect(rows(p)).toEqual([['x'], ['y'], ['vo1', 'vo2'], ['m']])
  })

  it('packs a track without start/end where it is drawn (its resolved window)', () => {
    const bare = { id: 'bed', src: 'bed.mp3', type: 'music' } as unknown as AudioTrack
    const p = project([bare, track({ id: 'm2', type: 'music', start: 1, end: 2 })])
    // The bed's fallback window covers 0..5, so the second music clip overlaps it.
    expect(rows(p)).toEqual([['bed'], ['m2']])
  })
})

describe('a lane-less clip added after the rows were stamped joins its kind\'s row', () => {
  const stampedRows = () => [
    track({ id: 'vo1', type: 'voiceover', lane: 0, start: 0, end: 4 }),
    track({ id: 'vo2', type: 'voiceover', lane: 0, start: 4, end: 8 }),
    track({ id: 'music', type: 'music', lane: 1, start: 0, end: 10 }),
    track({ id: 'hit', type: 'sfx', lane: 2, start: 2, end: 3 }),
  ]

  it('a new sfx joins the stamped sfx row when it fits there', () => {
    const p = project([...stampedRows(), track({ id: 'whoosh', type: 'sfx', start: 6, end: 7 })])
    expect(packAudioLanes(p.audio!.tracks)[4]).toBe(2)
    expect(rows(p)).toEqual([['vo1', 'vo2'], ['music'], ['hit', 'whoosh']])
  })

  it('and gets a new row when it overlaps there', () => {
    const p = project([...stampedRows(), track({ id: 'whoosh', type: 'sfx', start: 2.5, end: 3.5 })])
    expect(rows(p)).toEqual([['vo1', 'vo2'], ['music'], ['hit'], ['whoosh']])
  })

  it('a new voice clip joins the stamped voice row', () => {
    const p = project([...stampedRows(), track({ id: 'vo3', type: 'voiceover', start: 8, end: 9 })])
    expect(rows(p)).toEqual([['vo1', 'vo2', 'vo3'], ['music'], ['hit']])
  })

  it('tries the kind\'s rows in drawn order', () => {
    const p = project([
      track({ id: 'm1', type: 'music', lane: 4, start: 0, end: 5 }),
      track({ id: 'm2', type: 'music', lane: 1, start: 0, end: 2 }),
      track({ id: 'm3', type: 'music', start: 3, end: 4 }),
    ])
    expect(packAudioLanes(p.audio!.tracks)).toEqual([4, 1, 1])
  })

  it('never joins a lane holding more than one kind', () => {
    const p = project([
      track({ id: 'vo1', type: 'voiceover', lane: 0, start: 0, end: 2 }),
      track({ id: 'sfx1', type: 'sfx', lane: 0, start: 5, end: 6 }),
      track({ id: 'vo2', type: 'voiceover', start: 3, end: 4 }),
    ])
    expect(packAudioLanes(p.audio!.tracks)).toEqual([0, 0, 1])
  })

  it('never moves an explicit clip, and stamping writes the same rows it draws', () => {
    const p = project([...stampedRows(), track({ id: 'whoosh', type: 'sfx', start: 6, end: 7 })])
    const stamped = stampAudioLanes(p)
    expect(stamped.audio!.tracks.slice(0, 4)).toEqual(p.audio!.tracks.slice(0, 4))
    expect(rows(stamped)).toEqual(rows(p))
    expect(stamped.audio!.tracks[4].lane).toBe(2)
  })
})

describe('stampAudioLanes', () => {
  it('writes each packed row as an explicit lane, and the rows are identical before and after', () => {
    const p = aiProject()
    const stamped = stampAudioLanes(p)
    expect(stamped.audio!.tracks.every(t => typeof t.lane === 'number')).toBe(true)
    expect(rows(stamped)).toEqual(rows(p))
    const lanesOf = (q: Project) => groupAudioLanes(q.audio!.tracks, computeDerivedTiming(q).contentDuration).map(l => l.laneIndex)
    expect(lanesOf(stamped)).toEqual(lanesOf(p))
  })

  it('adds `lane` and nothing else', () => {
    const p = aiProject()
    const stamped = stampAudioLanes(p)
    stamped.audio!.tracks.forEach((t, i) => {
      const { lane, ...rest } = t
      expect(typeof lane).toBe('number')
      expect(rest).toEqual(p.audio!.tracks[i])
    })
  })

  it('is idempotent and returns the same object when nothing is lane-less', () => {
    const once = stampAudioLanes(aiProject())
    expect(stampAudioLanes(once)).toBe(once)
    const noAudio = { id: 'p', tracks: [] } as unknown as Project
    expect(stampAudioLanes(noAudio)).toBe(noAudio)
  })

  it('leaves explicit lanes alone and stamps only the lane-less tracks', () => {
    const p = project([track({ id: 'x', lane: 4, start: 0, end: 1 }), track({ id: 'y', start: 0, end: 1 })])
    const stamped = stampAudioLanes(p)
    expect(stamped.audio!.tracks[0]).toBe(p.audio!.tracks[0])
    expect(stamped.audio!.tracks[1].lane).toBe(5)
  })
})

describe('other audio edits keep every row where it is drawn', () => {
  it('a magnet reflow stamps the lanes it reflows with', () => {
    const p = project([
      track({ id: 'a', start: 0, end: 2, magnetic: true }),
      track({ id: 'b', start: 4, end: 6, magnetic: true }),
      track({ id: 'm', type: 'music', start: 0, end: 6 }),
    ])
    const before = rows(p)
    const next = reflowMagneticLanes(p)
    expect(next.audio!.tracks.find(t => t.id === 'b')!.start).toBe(2)
    expect(next.audio!.tracks.every(t => typeof t.lane === 'number')).toBe(true)
    expect(rows(next)).toEqual(before)
  })

  it('a magnet reflow with nothing to move writes nothing (same object)', () => {
    const p = project([track({ id: 'a', start: 0, end: 2, magnetic: true }), track({ id: 'b', start: 2, end: 4, magnetic: true })])
    expect(reflowMagneticLanes(p)).toBe(p)
  })

  it('a pasted copy of a lane-less clip lands back on its source row', () => {
    const p = aiProject()
    const seg = p.audio!.tracks[3]
    const pasted = pasteAt(p, { items: [], audioTracks: [seg] }, 100)
    const r = rows(pasted)
    expect(r).toHaveLength(3)
    expect(r[0]).toHaveLength(15)
    expect(r[1]).toEqual(['music'])
  })

  it('a duplicate of a lane-less clip lands in its original row', () => {
    const p = aiProject()
    const dup = duplicateSelection(p, ['sfx'])
    const r = rows(dup)
    expect(r).toHaveLength(3)
    expect(r[2]).toHaveLength(2)
    expect(r[2][0]).toBe('sfx')
  })
})
