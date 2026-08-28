import { describe, it, expect } from 'vitest'
import { addMarker, moveMarker, removeMarkers, renameMarker, nextMarkerLabel } from '../markers'
import type { EditorProject, Marker } from '../../../schema'

function proj(markers?: Marker[]): EditorProject {
  return {
    id: 'p1', status: 'draft', settings: { resolution: [1920, 1080], fps: 30 },
    tracks: [{ id: 'trk-0', items: [] }],
    ...(markers ? { markers } : {}),
  } as EditorProject
}
const mk = (id: string, t: number, label: string): Marker => ({ id, t, label })

describe('nextMarkerLabel', () => {
  it('starts at 1 on a project with no markers', () => {
    expect(nextMarkerLabel([])).toBe('1')
  })

  it('continues past the highest NUMERIC label, ignoring renamed ones', () => {
    // A renamed marker must not stall the counter, and must not be parsed as 0.
    expect(nextMarkerLabel([mk('a', 1, '1'), mk('b', 2, 'cut this'), mk('c', 3, '7')])).toBe('8')
  })

  it('does not reuse a number after a delete', () => {
    // Counting markers instead of reading the max would hand out '2' twice here.
    expect(nextMarkerLabel([mk('a', 1, '1'), mk('c', 3, '3')])).toBe('4')
  })
})

describe('addMarker', () => {
  it('creates the markers array on a project that has none', () => {
    const out = addMarker(proj(), 4.25)
    expect(out.markers).toHaveLength(1)
    expect(out.markers![0]).toMatchObject({ t: 4.25, label: '1' })
    expect(typeof out.markers![0].id).toBe('string')
    expect(out.markers![0].id.length).toBeGreaterThan(0)
  })

  it('keeps markers sorted by time whatever order they are added in', () => {
    let p = addMarker(proj(), 10)
    p = addMarker(p, 2)
    p = addMarker(p, 6)
    expect(p.markers!.map(m => m.t)).toEqual([2, 6, 10])
    // Labels record creation order, not position.
    expect(p.markers!.map(m => m.label)).toEqual(['2', '3', '1'])
  })

  it('returns the SAME reference when a marker already sits within half a frame', () => {
    // Key repeat: holding M must not spray a pile of stacked markers.
    const p = addMarker(proj(), 5)
    const again = addMarker(p, 5 + (1 / 30) * 0.4, 30)
    expect(again).toBe(p)
  })

  it('does allow a second marker just outside the half-frame window', () => {
    const p = addMarker(proj(), 5)
    const again = addMarker(p, 5 + (1 / 30) * 0.6, 30)
    expect(again).not.toBe(p)
    expect(again.markers).toHaveLength(2)
  })

  it('clamps a negative time to 0', () => {
    expect(addMarker(proj(), -3).markers![0].t).toBe(0)
  })

  it('never mutates the project it was given', () => {
    const p = proj([mk('a', 1, '1')])
    const before = JSON.stringify(p)
    addMarker(p, 9)
    expect(JSON.stringify(p)).toBe(before)
  })
})

describe('moveMarker', () => {
  it('retimes and re-sorts', () => {
    const p = proj([mk('a', 1, '1'), mk('b', 2, '2'), mk('c', 3, '3')])
    const out = moveMarker(p, 'a', 2.5)
    expect(out.markers!.map(m => m.id)).toEqual(['b', 'a', 'c'])
    expect(out.markers!.find(m => m.id === 'a')!.t).toBe(2.5)
  })

  it('clamps to 0 and returns the same reference for an unknown id or an unchanged time', () => {
    const p = proj([mk('a', 1, '1')])
    expect(moveMarker(p, 'a', -5).markers![0].t).toBe(0)
    expect(moveMarker(p, 'nope', 4)).toBe(p)
    expect(moveMarker(p, 'a', 1)).toBe(p)
  })
})

describe('renameMarker', () => {
  it('replaces the label', () => {
    const out = renameMarker(proj([mk('a', 1, '1')]), 'a', 'intro')
    expect(out.markers![0].label).toBe('intro')
  })

  it('trims, and rejects an empty label by returning the same reference', () => {
    const p = proj([mk('a', 1, '1')])
    expect(renameMarker(p, 'a', '  hi  ').markers![0].label).toBe('hi')
    expect(renameMarker(p, 'a', '   ')).toBe(p)
    expect(renameMarker(p, 'a', '1')).toBe(p)   // unchanged label, no commit
  })
})

describe('removeMarkers', () => {
  it('drops every id in the set and leaves the rest', () => {
    const p = proj([mk('a', 1, '1'), mk('b', 2, '2'), mk('c', 3, '3')])
    expect(removeMarkers(p, new Set(['a', 'c'])).markers!.map(m => m.id)).toEqual(['b'])
  })

  it('drops the markers key entirely when the last one goes', () => {
    // Keeps a marker-less project byte-identical to one that never had markers.
    const out = removeMarkers(proj([mk('a', 1, '1')]), new Set(['a']))
    expect(out).not.toHaveProperty('markers')
  })

  it('returns the same reference when nothing matched', () => {
    const p = proj([mk('a', 1, '1')])
    expect(removeMarkers(p, new Set(['zzz']))).toBe(p)
  })

  it('returns the same reference when the project has no markers at all', () => {
    const p = proj()
    expect(removeMarkers(p, new Set(['a']))).toBe(p)
  })
})
