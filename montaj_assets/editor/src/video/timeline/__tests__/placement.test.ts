/**
 * `placeDroppedClip` — the one placement rule shared by every "new footage
 * lands on the timeline" drop entry point (see placement.ts's own doc
 * comment for who calls it). Tracks are built through `vtracks()`, the same
 * `trk-<i>` id convention `normalizeTracks` hands out, so fixtures already
 * sit in canonical order and reordering surprises stay out of the tests that
 * aren't specifically about ordering.
 */
import { describe, it, expect } from 'vitest'
import type { EditorProject as Project, VisualItem, VisualTrack } from '../../../schema'
import { placeDroppedClip, resolveDropTrackIndex } from '../placement'

function vtracks(...items: VisualItem[][]): VisualTrack[] {
  return items.map((its, i) => ({ id: `trk-${i}`, items: its }))
}

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: vtracks([]),
    ...over,
  }
}

const videoItem = (id: string, start: number, end: number): VisualItem =>
  ({ id, type: 'video', src: `${id}.mp4`, start, end }) as VisualItem

const imageItem = (id: string, start: number, end: number): VisualItem =>
  ({ id, type: 'image', src: `${id}.png`, start, end }) as VisualItem

describe('placeDroppedClip — guard', () => {
  it.each([0, NaN, -1])('places nothing for a sourceDuration of %s, returning the input project by reference', dur => {
    const p = makeProject({ tracks: vtracks([videoItem('a', 0, 5)]) })
    const result = placeDroppedClip(p, {
      atTime: 0,
      preferredTrackIndex: 0,
      clip: { src: 'n.mp4', sourceDuration: dur },
    })
    expect(result).toEqual({ project: p, trackIndex: -1, start: 0, createdTrack: false })
    expect(result.project).toBe(p)
  })
})

describe('placeDroppedClip — free preferred track', () => {
  it('lands on the preferred track at exactly atTime when its region is free', () => {
    const p = makeProject({ tracks: vtracks([videoItem('a', 20, 25)]) })
    const result = placeDroppedClip(p, {
      atTime: 3,
      preferredTrackIndex: 0,
      clip: { src: 'n.mp4', sourceDuration: 4 },
    })
    expect(result.trackIndex).toBe(0)
    expect(result.start).toBe(3)
    expect(result.createdTrack).toBe(false)
    expect(result.itemId).toBeDefined()
    const placed = result.project.tracks![0].items.find(it => it.id === result.itemId)!
    expect(placed).toMatchObject({ start: 3, end: 7, type: 'video' })
  })
})

describe('placeDroppedClip — occupied preferred track falls back', () => {
  it('lands at the same time on the CLOSEST free video track, not just any free one', () => {
    const p = makeProject({
      tracks: vtracks(
        [videoItem('a', 0, 5)],   // trk-0: preferred, but OCCUPIED at the drop window
        [videoItem('b', 20, 25)], // trk-1: video-kind (item elsewhere), free at the drop window — distance 1
        [videoItem('c', 20, 25)], // trk-2: video-kind (item elsewhere), free at the drop window — distance 2
      ),
    })
    const result = placeDroppedClip(p, {
      atTime: 0,
      preferredTrackIndex: 0,
      clip: { src: 'n.mp4', sourceDuration: 3 },
    })
    expect(result.trackIndex).toBe(1)
    expect(result.start).toBe(0)
    expect(result.createdTrack).toBe(false)
    // trk-0's occupant and trk-2 are both untouched.
    expect(result.project.tracks![0].items).toEqual([videoItem('a', 0, 5)])
    expect(result.project.tracks![2].items).toEqual([videoItem('c', 20, 25)])
  })

  it('breaks a distance tie in favor of the LOWER index', () => {
    const p = makeProject({
      tracks: vtracks(
        [videoItem('a', 20, 25)], // trk-0: free at the drop window — distance 1 from ref
        [videoItem('b', 0, 5)],   // trk-1: preferred, OCCUPIED — this is `ref`
        [videoItem('c', 20, 25)], // trk-2: free at the drop window — distance 1 from ref
      ),
    })
    const result = placeDroppedClip(p, {
      atTime: 0,
      preferredTrackIndex: 1,
      clip: { src: 'n.mp4', sourceDuration: 3 },
    })
    expect(result.trackIndex).toBe(0)
  })
})

describe('placeDroppedClip — new track creation', () => {
  it('creates a new video track when every existing video track is occupied at the drop region, without moving anything', () => {
    const p = makeProject({
      tracks: vtracks(
        [videoItem('a', 0, 10)],
        [videoItem('b', 0, 10)],
        [imageItem('ov', 0, 100)], // overlay/image track — sorts after the video block
      ),
    })
    const result = placeDroppedClip(p, {
      atTime: 2,
      preferredTrackIndex: 0,
      clip: { src: 'n.mp4', sourceDuration: 3 },
    })
    expect(result.createdTrack).toBe(true)
    expect(result.trackIndex).toBe(2) // top of the video block, below the overlay track
    const tracks = result.project.tracks!
    expect(tracks).toHaveLength(4)
    expect(tracks[0].items).toEqual([videoItem('a', 0, 10)])   // untouched
    expect(tracks[1].items).toEqual([videoItem('b', 0, 10)])   // untouched
    expect(tracks[2].items).toHaveLength(1)
    expect(tracks[2].items[0]).toMatchObject({ start: 2, end: 5, type: 'video' })
    expect(tracks[3].items).toEqual([imageItem('ov', 0, 100)]) // the overlay track, still last
  })
})

describe('placeDroppedClip — kind lock', () => {
  it('never chooses an overlay/image track, even when it is the preferred index and free', () => {
    const p = makeProject({
      tracks: vtracks(
        [videoItem('a', 20, 25)],  // trk-0: video-kind, free at the drop window
        [imageItem('img', 0, 100)], // trk-1: image-kind, free everywhere, but not a candidate
      ),
    })
    const result = placeDroppedClip(p, {
      atTime: 0,
      preferredTrackIndex: 1, // points at the image track
      clip: { src: 'n.mp4', sourceDuration: 3 },
    })
    expect(result.trackIndex).toBe(0)
    expect(result.project.tracks![1].items).toEqual([imageItem('img', 0, 100)]) // untouched
  })
})

describe('resolveDropTrackIndex — where the ghost band goes', () => {
  it('resolves a drop released over an overlay/image row to the VIDEO row (the ghost bug)', () => {
    // The exact filesystem-drop ghost defect: the pointer released over the
    // image row (index 1), so the ghost used to draw there — but the clip
    // always lands on the video row. The ghost must resolve the same way.
    const p = makeProject({
      tracks: vtracks(
        [videoItem('a', 20, 25)],   // trk-0: video-kind, free at the drop window
        [imageItem('img', 0, 100)], // trk-1: image-kind — never a ghost home
      ),
    })
    const idx = resolveDropTrackIndex(p, {
      atTime: 0,
      preferredTrackIndex: 1, // released over the image row
      clip: { sourceDuration: 3 },
    })
    expect(idx).toBe(0)
  })

  it('returns a past-the-end index (a fresh video row) when no video row is free', () => {
    const p = makeProject({
      tracks: vtracks(
        [videoItem('a', 0, 100)],   // the only video row, occupied across the drop
        [imageItem('img', 0, 100)],
      ),
    })
    const idx = resolveDropTrackIndex(p, {
      atTime: 0,
      preferredTrackIndex: 0,
      ripple: false,
      clip: { sourceDuration: 5 }, // overlaps the occupied video row
    })
    expect(idx).toBe(2) // == tracks.length ⇒ placeDroppedClip would make a new track
  })
})

describe('placeDroppedClip — no preference', () => {
  it('defaults ref to 0, not some other plausible default — proven by a fixture where they disagree', () => {
    // A single-track fixture can't tell "ref correctly defaults to 0" apart
    // from a broken implementation that skips the `>= 0` clamp entirely: with
    // exactly one candidate, EVERY possible ref lands on it, so the assertion
    // would pass for the wrong reason. This fixture forces a real choice:
    //   trk-0 — free at the drop window, distance 0 from a correct ref=0
    //   trk-1 — OCCUPIED at the drop window (never a candidate either way;
    //           exists only to sit between trk-0 and trk-2 on the timeline)
    //   trk-2 — free at the drop window, distance 2 from ref=0, but distance
    //           0 from a plausible WRONG default such as "ref = last track
    //           index" (tracks.length - 1)
    // A correct ref=0 must land on trk-0; a wrong "last track" default would
    // land on trk-2 instead — so this test can actually fail if the `>= 0`
    // fallback regresses.
    const p = makeProject({
      tracks: vtracks(
        [videoItem('a', 20, 25)],
        [videoItem('b', 0, 5)],
        [videoItem('c', 20, 25)],
      ),
    })
    const result = placeDroppedClip(p, {
      atTime: 0,
      preferredTrackIndex: -1,
      clip: { src: 'n.mp4', sourceDuration: 3 },
    })
    expect(result.trackIndex).toBe(0)
    expect(result.start).toBe(0)
    // trk-1's occupant and trk-2 are both untouched — trk-2 in particular is
    // the wrong-default's pick, so leaving it alone confirms it was never
    // even chosen, not just chosen-then-unaffected.
    expect(result.project.tracks![1].items).toEqual([videoItem('b', 0, 5)])
    expect(result.project.tracks![2].items).toEqual([videoItem('c', 20, 25)])
  })
})

describe('placeDroppedClip — snapping', () => {
  it('snaps atTime to a nearby snap target within tolerance, and leaves it alone outside tolerance', () => {
    const p = makeProject({ tracks: vtracks([]) })

    const snapped = placeDroppedClip(p, {
      atTime: 5.3,
      preferredTrackIndex: 0,
      clip: { src: 'n.mp4', sourceDuration: 2 },
      snapTimes: [5],
      snapToleranceSec: 0.5,
    })
    expect(snapped.start).toBe(5)

    const notSnapped = placeDroppedClip(p, {
      atTime: 5.8,
      preferredTrackIndex: 0,
      clip: { src: 'n.mp4', sourceDuration: 2 },
      snapTimes: [5],
      snapToleranceSec: 0.5,
    })
    expect(notSnapped.start).toBe(5.8)
  })
})

describe('placeDroppedClip — ripple', () => {
  it('ignores collision on the preferred track (pushes the occupant right) instead of falling back', () => {
    const p = makeProject({ tracks: vtracks([videoItem('a', 0, 20)]) })
    const result = placeDroppedClip(p, {
      atTime: 10, // dead center of 'a' — a straddle, and the exact 50% tie
      preferredTrackIndex: 0,
      clip: { src: 'n.mp4', sourceDuration: 3 },
      ripple: true,
    })
    expect(result.createdTrack).toBe(false)
    expect(result.trackIndex).toBe(0)
    const tracks = result.project.tracks!
    expect(tracks).toHaveLength(1) // no new track — the collision never disqualified trk-0
    // Tie at exactly 50% resolves to the straddler's START (Sam's rule, cuts.ts).
    expect(result.start).toBe(0)
    const a = tracks[0].items.find(it => it.id === 'a')!
    expect(a).toMatchObject({ start: 3, end: 23 }) // pushed right by the new clip's length
  })
})

describe('placeDroppedClip — purity', () => {
  it('never mutates the input project or its item objects', () => {
    const p = makeProject({ tracks: vtracks([videoItem('a', 0, 5)]) })
    const itemRef = p.tracks![0].items[0]
    const before = JSON.stringify(p)

    placeDroppedClip(p, {
      atTime: 10,
      preferredTrackIndex: 0,
      clip: { src: 'n.mp4', sourceDuration: 3 },
    })

    expect(JSON.stringify(p)).toBe(before)
    expect(p.tracks![0].items[0]).toBe(itemRef)
  })
})
