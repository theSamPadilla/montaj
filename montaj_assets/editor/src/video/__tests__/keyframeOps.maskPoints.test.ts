import { describe, it, expect } from 'vitest'
import { samplePointsTrack } from '@bycrux/timeline-core'
import type { EditorProject as Project, KeyframeTrack, VisualItem, VisualTrack } from '../../schema'
import { splitAtTime, applyCutToTracks, setClipSpeed } from '../cuts'
import { copySelection, pasteAt, duplicateSelection } from '../clipboard-ops'
import {
  addKeyframeAt, canKeyframeProp, disableKeyframing, enableKeyframing, moveKeyframe, offsetTrack,
  removeKeyframeAt, removeKeyframesAt, setKeyframe, setKeyframeEasing, transformProps, trackFor, writeProp,
} from '../keyframeOps'
import { normalizeTrack, sampleTrackValue } from '../keyframeTrack'
import { keyframeUnionTimes } from '../timeline/canvas/keyframe-strip'

// §616: a path mask's `maskPoints` track keys point LISTS. The editor never
// authors one, but it must carry it through every keyframe edit, cut, copy and
// retime with the arrays intact, and never read a number out of it.

const A: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]]
const B: Array<[number, number]> = [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]]
const C: Array<[number, number]> = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]

// `value` is typed as a number in the schema; a points track is built the way project.json carries it.
const pointsTrack = (...keys: Array<[number, Array<[number, number]>, string?]>): KeyframeTrack => ({
  prop: 'maskPoints',
  points: keys.map(([t, v, easing]) => ({ t, value: v as unknown as number, ...(easing ? { easing } : {}) })),
} as unknown as KeyframeTrack)

const valuesOf = (track: KeyframeTrack | undefined) => (track?.points ?? []).map(p => [p.t, p.value as unknown])
const pointsOfTrack = (item: VisualItem) => item.keyframes!.find(k => (k.prop as string) === 'maskPoints')

function clip(over: Partial<VisualItem> = {}): VisualItem {
  return {
    id: 'c', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10,
    mask: { shape: 'path', points: A },
    keyframes: [pointsTrack([0, A], [4, B], [10, C])],
    ...over,
  } as VisualItem
}

function vtracks(...items: VisualItem[][]): VisualTrack[] {
  return items.map((its, i) => ({ id: `trk-${i}`, items: its }))
}
const project = (item: VisualItem): Project => ({ id: 'p', status: 'draft', settings: { resolution: [1080, 1920] }, tracks: vtracks([item]) } as Project)

describe('normalizeTrack (editor)', () => {
  it('keeps a maskPoints track, sorted and last-wins, where timeline-core would drop every key', () => {
    const out = normalizeTrack(pointsTrack([4, B], [0, A], [4, C]))
    expect(valuesOf(out)).toEqual([[0, A], [4, C]])
  })

  it('drops a key whose value is not a valid point list', () => {
    const track = { prop: 'maskPoints', points: [{ t: 0, value: A }, { t: 1, value: 0.5 }, { t: 2, value: [[0, 0]] }] } as unknown as KeyframeTrack
    expect(valuesOf(normalizeTrack(track))).toEqual([[0, A]])
  })

  it('still normalizes a number track', () => {
    const out = normalizeTrack({ prop: 'maskX', points: [{ t: 2, value: 1 }, { t: 0, value: 0 }] })
    expect(out.points.map(p => p.t)).toEqual([0, 2])
  })

  it('samples a maskPoints track as point lists, a number track as a number', () => {
    const track = pointsTrack([0, A], [2, B])
    expect(sampleTrackValue(track, 1)).toEqual(samplePointsTrack(track, 1, 4))
    expect(sampleTrackValue(track, 1)).toEqual([[0, 0], [0.75, 0], [0.75, 0.75], [0, 0.75]])
    expect(sampleTrackValue({ prop: 'maskX', points: [{ t: 0, value: 0 }, { t: 2, value: 1 }] }, 1)).toBe(0.5)
  })
})

describe('keyframeOps on a maskPoints track', () => {
  it('is never a number prop: canKeyframeProp false, number writes are no-ops', () => {
    const item = clip()
    const prop = 'maskPoints' as never
    expect(canKeyframeProp(item, prop)).toBe(false)
    expect(writeProp(item, prop, 1, 0.5)).toBe(item)
    expect(setKeyframe(item, prop, 1, 0.5)).toBe(item)
    expect(enableKeyframing(item, prop, 1)).toBe(item)
    expect(addKeyframeAt(item, prop, 1)).toBe(item)
    expect(offsetTrack(item, prop, 1, 0.5)).toBe(item)
  })

  it('key-everything on the transform and the mask props never touches it', () => {
    let item = clip()
    for (const prop of transformProps(item)) item = setKeyframe(enableKeyframing(item, prop, 2), prop, 2, 0.4)
    expect(valuesOf(pointsOfTrack(item))).toEqual([[0, A], [4, B], [10, C]])
  })

  it('retimes a key with its point list intact', () => {
    const out = moveKeyframe(clip(), 'maskPoints' as never, 4, 6)
    expect(valuesOf(pointsOfTrack(out))).toEqual([[0, A], [6, B], [10, C]])
  })

  it('a retime onto another key replaces it with the moved key, lists intact', () => {
    const out = moveKeyframe(clip(), 'maskPoints' as never, 4, 10)
    expect(valuesOf(pointsOfTrack(out))).toEqual([[0, A], [10, B]])
  })

  it('sets an easing on a key without losing the lists', () => {
    const out = setKeyframeEasing(clip(), 'maskPoints' as never, 4, 'hold')
    expect(pointsOfTrack(out)!.points[1]).toMatchObject({ t: 4, easing: 'hold', value: B })
    expect(pointsOfTrack(out)!.points[0].value).toEqual(A)
  })

  it('removing one diamond (all props at t) drops that key, keeps the rest', () => {
    const out = removeKeyframesAt(clip(), 4)
    expect(valuesOf(pointsOfTrack(out))).toEqual([[0, A], [10, C]])
  })

  it('removing the only key drops the track and leaves the mask points alone, with no NaN written', () => {
    const item = clip({ keyframes: [pointsTrack([3, B])] })
    const out = removeKeyframeAt(item, 'maskPoints' as never, 3)
    expect(out.keyframes).toBeUndefined()
    expect(out.mask).toEqual(item.mask)
    expect(JSON.stringify(out)).not.toContain('null')
    expect(disableKeyframing(item, 'maskPoints' as never, 3).keyframes).toBeUndefined()
  })

  it('a clip with only a maskPoints track has diamonds at its key times', () => {
    expect(keyframeUnionTimes(clip())).toEqual([0, 4, 10])
    expect(trackFor(clip(), 'maskPoints' as never)!.points).toHaveLength(3)
  })
})

describe('a maskPoints track through cuts, copy and speed', () => {
  const sampled = (track: KeyframeTrack | undefined, t: number) => samplePointsTrack(track as never, t, 4)

  it('a split between two keys gives each side the sampled list at the cut, and keeps its own keys', () => {
    const out = splitAtTime(project(clip()), 2, 'c')
    const [left, right] = out.tracks![0].items
    const lt = pointsOfTrack(left)!
    const rt = pointsOfTrack(right)!
    const mid = samplePointsTrack(pointsTrack([0, A], [4, B]) as never, 2, 4)!
    expect(valuesOf(lt)).toEqual([[0, A], [2, mid]])
    expect(valuesOf(rt)).toEqual([[0, mid], [2, B], [8, C]])
    // Re-anchored: the right half at its t=0 reads the original curve at the cut.
    expect(sampled(rt, 0)).toEqual(mid)
    for (const k of [...lt.points, ...rt.points]) {
      expect(Array.isArray(k.value)).toBe(true)
      expect(Number.isNaN(k.value as unknown as number)).toBe(false)
    }
  })

  it('the split halves do not share the arrays', () => {
    const [left, right] = splitAtTime(project(clip()), 4, 'c').tracks![0].items
    expect(pointsOfTrack(left)!.points).not.toBe(pointsOfTrack(right)!.points)
  })

  it('a trim of the in-point (cut over the start) re-bases the keys and samples the edge', () => {
    const out = applyCutToTracks(project(clip()), { start: 0, end: 2 })
    const item = out.tracks![0].items[0]
    const mid = samplePointsTrack(pointsTrack([0, A], [4, B]) as never, 2, 4)!
    expect(valuesOf(pointsOfTrack(item))).toEqual([[0, mid], [2, B], [8, C]])
  })

  it('a trim of the out-point keeps the earlier keys and samples the edge', () => {
    const out = applyCutToTracks(project(clip()), { start: 7, end: 10 })
    const item = out.tracks![0].items[0]
    const edge = samplePointsTrack(pointsTrack([4, B], [10, C]) as never, 7, 4)!
    expect(valuesOf(pointsOfTrack(item))).toEqual([[0, A], [4, B], [7, edge]])
  })

  it('a hold easing steps at the cut: the edge key carries the earlier list', () => {
    const item = clip({ keyframes: [pointsTrack([0, A, 'hold'], [4, B])] })
    const [left, right] = splitAtTime(project(item), 2, 'c').tracks![0].items
    expect(valuesOf(pointsOfTrack(left))).toEqual([[0, A], [2, A]])
    expect(pointsOfTrack(right)!.points[0].value).toEqual(A)
  })

  it('a speed change leaves the track as it was', () => {
    const out = setClipSpeed(project(clip()), 'c', 2)
    expect(valuesOf(pointsOfTrack(out.tracks![0].items[0]))).toEqual([[0, A], [4, B], [10, C]])
  })

  it('copy / paste and duplicate carry the lists intact', () => {
    const p = project(clip())
    const pasted = pasteAt(p, copySelection(p, ['c']), 12)
    const copy = pasted.tracks![0].items.find(i => i.id !== 'c')!
    expect(valuesOf(pointsOfTrack(copy))).toEqual([[0, A], [4, B], [10, C]])
    expect(copy.mask).toEqual({ shape: 'path', points: A })
    const dup = duplicateSelection(p, ['c']).tracks!.flatMap(t => t.items).filter(i => i.id !== 'c')
    expect(dup).toHaveLength(1)
    expect(valuesOf(pointsOfTrack(dup[0]))).toEqual([[0, A], [4, B], [10, C]])
  })
})
