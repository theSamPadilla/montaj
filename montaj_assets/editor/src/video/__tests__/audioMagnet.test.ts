import { describe, it, expect } from 'vitest'
import { reflowMagneticLanes } from '../audioMagnet'
import type { AudioTrack, EditorProject as Project, VisualItem } from '../../schema'

// Minimal project factory — only the fields reflowMagneticLanes touches.
function makeProject(tracks: AudioTrack[]): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    audio: { tracks },
  }
}

function clip(id: string, start: number, end: number, over: Partial<AudioTrack> = {}): AudioTrack {
  return { id, src: `${id}.mp3`, start, end, ...over }
}

describe('reflowMagneticLanes', () => {
  it('is a no-op on a project with no audio', () => {
    const p: Project = { id: 'p1', status: 'draft', settings: { resolution: [1080, 1920] } }
    expect(reflowMagneticLanes(p)).toBe(p)
  })

  it('is a no-op on a project with an empty audio.tracks array', () => {
    const p = makeProject([])
    expect(reflowMagneticLanes(p)).toBe(p)
  })

  it('leaves a non-magnetic lane completely untouched', () => {
    const p = makeProject([
      clip('a', 0, 2, { lane: 0 }),
      clip('b', 5, 7, { lane: 0 }),
    ])
    const out = reflowMagneticLanes(p)
    expect(out).toBe(p)
  })

  it('closes an internal gap between two magnetic clips', () => {
    const p = makeProject([
      clip('a', 0, 2, { lane: 0, magnetic: true }),
      clip('b', 5, 8, { lane: 0, magnetic: true }),
    ])
    const out = reflowMagneticLanes(p)
    const [a, b] = out.audio!.tracks
    expect(a).toMatchObject({ id: 'a', start: 0, end: 2 })
    expect(b).toMatchObject({ id: 'b', start: 2, end: 5 }) // duration (3) preserved, butted to a's end
  })

  it('resolves an overlap between two magnetic clips', () => {
    const p = makeProject([
      clip('a', 0, 3, { lane: 0, magnetic: true }),
      clip('b', 2, 6, { lane: 0, magnetic: true }), // overlaps a by 1s
    ])
    const out = reflowMagneticLanes(p)
    const [a, b] = out.audio!.tracks
    expect(a).toMatchObject({ start: 0, end: 3 })
    expect(b).toMatchObject({ start: 3, end: 7 }) // duration (4) preserved, butted after a
  })

  it('reorders when a clip is dragged past its neighbour (sorts by start before reflowing)', () => {
    const p = makeProject([
      // Array order is [a, b], but 'a' now starts LATER than 'b' — e.g. 'a'
      // was dragged past 'b'. Reflow must follow timeline position, not
      // array order.
      clip('a', 5, 7, { lane: 0, magnetic: true }),
      clip('b', 0, 2, { lane: 0, magnetic: true }),
    ])
    const out = reflowMagneticLanes(p)
    const a = out.audio!.tracks.find(t => t.id === 'a')!
    const b = out.audio!.tracks.find(t => t.id === 'b')!
    // b (start 0) sorts before a (start 5), so b anchors the lane and a follows it.
    expect(b).toMatchObject({ start: 0, end: 2 })
    expect(a).toMatchObject({ start: 2, end: 4 })
  })

  it('preserves a leading gap by anchoring at the earliest clip\'s own start', () => {
    const p = makeProject([
      clip('a', 3, 5, { lane: 0, magnetic: true }),
      clip('b', 5, 7, { lane: 0, magnetic: true }),
    ])
    const out = reflowMagneticLanes(p)
    const [a, b] = out.audio!.tracks
    expect(a).toMatchObject({ start: 3, end: 5 }) // untouched — already anchor + gapless
    expect(b).toMatchObject({ start: 5, end: 7 })
  })

  it('reflows only the magnetic lane when a project has one magnetic and one non-magnetic lane', () => {
    const p = makeProject([
      clip('a', 0, 2, { lane: 0, magnetic: true }),
      clip('b', 5, 8, { lane: 0, magnetic: true }),
      clip('c', 0, 2, { lane: 1 }),
      clip('d', 9, 11, { lane: 1 }),
    ])
    const out = reflowMagneticLanes(p)
    const byId = Object.fromEntries(out.audio!.tracks.map(t => [t.id, t]))
    expect(byId.b).toMatchObject({ start: 2, end: 5 }) // magnetic lane 0 collapsed
    expect(byId.c).toMatchObject({ start: 0, end: 2 }) // non-magnetic lane 1 untouched
    expect(byId.d).toMatchObject({ start: 9, end: 11 })
  })

  it('does not touch project.tracks or project.captions', () => {
    const p: Project = {
      id: 'p1',
      status: 'draft',
      settings: { resolution: [1080, 1920] },
      tracks: [{ id: 'trk-0', items: [{ id: 'v0', type: 'video', src: 'a.mp4', start: 0, end: 10 } satisfies VisualItem] }],
      captions: { style: 'clean', segments: [{ text: 'hi', start: 0, end: 1 }] },
      audio: { tracks: [
        clip('a', 0, 2, { lane: 0, magnetic: true }),
        clip('b', 5, 8, { lane: 0, magnetic: true }),
      ] },
    }
    const out = reflowMagneticLanes(p)
    expect(out.tracks).toBe(p.tracks)
    expect(out.captions).toBe(p.captions)
  })

  it('is idempotent: reflowing twice equals reflowing once, and the second call returns the SAME reference', () => {
    const p = makeProject([
      clip('a', 0, 2, { lane: 0, magnetic: true }),
      clip('b', 5, 8, { lane: 0, magnetic: true }),
    ])
    const once = reflowMagneticLanes(p)
    const twice = reflowMagneticLanes(once)
    expect(twice).toBe(once)
  })

  it('returns the SAME project reference when a magnetic lane is already gapless', () => {
    const p = makeProject([
      clip('a', 0, 2, { lane: 0, magnetic: true }),
      clip('b', 2, 5, { lane: 0, magnetic: true }),
    ])
    expect(reflowMagneticLanes(p)).toBe(p)
  })

  it('preserves inPoint/outPoint through a timeline shift — this reflows position, not the source window', () => {
    const p = makeProject([
      clip('a', 0, 2, { lane: 0, magnetic: true, inPoint: 1, outPoint: 3 }),
      clip('b', 5, 8, { lane: 0, magnetic: true, inPoint: 10, outPoint: 13 }),
    ])
    const out = reflowMagneticLanes(p)
    const b = out.audio!.tracks.find(t => t.id === 'b')!
    expect(b.inPoint).toBe(10)
    expect(b.outPoint).toBe(13)
    expect(b.start).toBe(2)
    expect(b.end).toBe(5) // duration (3) preserved
  })

  it('requires EVERY track in a lane to be magnetic — a mixed lane is left alone', () => {
    const p = makeProject([
      clip('a', 0, 2, { lane: 0, magnetic: true }),
      clip('b', 5, 8, { lane: 0 }), // not magnetic
    ])
    const out = reflowMagneticLanes(p)
    expect(out).toBe(p)
  })
})
