/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest'
import { sampleTrack } from '@bycrux/timeline-core'
import type { VisualItem } from '../../schema'
import {
  trackFor,
  hasKeyframes,
  isKeyframed,
  canKeyframe,
  valueAt,
  setKeyframe,
  removeKeyframe,
  moveKeyframe,
  setKeyframeEasing,
  enableKeyframing,
  disableKeyframing,
  removeKeyframesAt,
  isUniformScale,
  transformProps,
} from '../keyframeOps'

function overlay(over: Partial<VisualItem> = {}): VisualItem {
  return {
    id: 'o1',
    type: 'overlay',
    src: 'o.jsx',
    start: 5, // deliberately non-zero: `t` must stay item-relative, never absolute
    end: 15,
    props: {},
    ...over,
  }
}

describe('trackFor', () => {
  it('returns undefined for an item with no keyframes at all', () => {
    expect(trackFor(overlay(), 'scale')).toBeUndefined()
  })

  it('returns undefined when other props are keyframed but not this one', () => {
    const item = overlay({ keyframes: [{ prop: 'opacity', points: [{ t: 0, value: 1 }] }] })
    expect(trackFor(item, 'scale')).toBeUndefined()
  })

  it('returns the matching track', () => {
    const track = { prop: 'scale' as const, points: [{ t: 0, value: 2 }] }
    const item = overlay({ keyframes: [track] })
    expect(trackFor(item, 'scale')).toBe(track)
  })
})

describe('hasKeyframes', () => {
  it('is false for no track', () => {
    expect(hasKeyframes(overlay(), 'scale')).toBe(false)
  })

  it('is false for an empty-points track (defensive, not just "no track")', () => {
    const item = overlay({ keyframes: [{ prop: 'scale', points: [] }] })
    expect(hasKeyframes(item, 'scale')).toBe(false)
  })

  it('is true for a track with at least one point', () => {
    const item = overlay({ keyframes: [{ prop: 'scale', points: [{ t: 0, value: 2 }] }] })
    expect(hasKeyframes(item, 'scale')).toBe(true)
  })
})

describe('isKeyframed', () => {
  it('is false for an item with no keyframes field', () => {
    expect(isKeyframed(overlay())).toBe(false)
  })

  it('is false when every track present is empty', () => {
    expect(isKeyframed(overlay({ keyframes: [{ prop: 'scale', points: [] }] }))).toBe(false)
  })

  it('is true when any track has a point', () => {
    const item = overlay({
      keyframes: [
        { prop: 'scale', points: [] },
        { prop: 'opacity', points: [{ t: 0, value: 1 }] },
      ],
    })
    expect(isKeyframed(item)).toBe(true)
  })
})

describe('valueAt', () => {
  it('returns the correct defaults when the item has neither keyframes nor static scalars', () => {
    const item = overlay()
    expect(valueAt(item, 'scale', 0)).toBe(1)
    expect(valueAt(item, 'opacity', 0)).toBe(1)
    expect(valueAt(item, 'offsetX', 0)).toBe(0)
    expect(valueAt(item, 'offsetY', 0)).toBe(0)
    expect(valueAt(item, 'rotation', 0)).toBe(0)
  })

  it('falls back to the static scalar when the prop is not keyframed', () => {
    const item = overlay({ scale: 1.5, offsetX: 12, rotation: 90 })
    expect(valueAt(item, 'scale', 3)).toBe(1.5)
    expect(valueAt(item, 'offsetX', 3)).toBe(12)
    expect(valueAt(item, 'rotation', 3)).toBe(90)
  })

  it('samples the curve when the prop is keyframed, ignoring the static scalar', () => {
    const item = overlay({
      offsetX: 999, // must be ignored — the track wins once it exists
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] }],
    })
    expect(valueAt(item, 'offsetX', 0)).toBe(0)
    expect(valueAt(item, 'offsetX', 10)).toBe(100)
    expect(valueAt(item, 'offsetX', 5)).toBe(50) // linear midpoint
  })
})

describe('setKeyframe', () => {
  it('creates a track on a prop with none yet', () => {
    const item = overlay()
    const next = setKeyframe(item, 'opacity', 2, 0.5)
    expect(trackFor(next, 'opacity')).toEqual({ prop: 'opacity', points: [{ t: 2, value: 0.5 }] })
  })

  it('adds a keyframe to an existing track', () => {
    const item = overlay({ keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }] }] })
    const next = setKeyframe(item, 'scale', 5, 2)
    expect(trackFor(next, 'scale')!.points).toEqual([{ t: 0, value: 1 }, { t: 5, value: 2 }])
  })

  it('does not mutate the input item, its keyframes array, or its point objects', () => {
    const originalPoints = [{ t: 0, value: 1 }]
    const track = { prop: 'scale' as const, points: originalPoints }
    const item = overlay({ keyframes: [track] })
    const snapshot = JSON.parse(JSON.stringify(item))

    const next = setKeyframe(item, 'scale', 5, 2)

    expect(item).toEqual(snapshot)
    expect(item.keyframes![0]).toBe(track)
    expect(item.keyframes![0].points).toBe(originalPoints)
    expect(originalPoints).toEqual([{ t: 0, value: 1 }])
    expect(next).not.toBe(item)
    expect(next.keyframes).not.toBe(item.keyframes)
  })

  it('out-of-order t values come back ascending (the normalize invariant)', () => {
    let item = overlay()
    item = setKeyframe(item, 'scale', 10, 2)
    item = setKeyframe(item, 'scale', 0, 1)
    item = setKeyframe(item, 'scale', 5, 1.5)
    expect(trackFor(item, 'scale')!.points.map(p => p.t)).toEqual([0, 5, 10])
  })

  it('a duplicate t collapses to one point, the new value winning', () => {
    let item = overlay()
    item = setKeyframe(item, 'scale', 5, 1)
    item = setKeyframe(item, 'scale', 5, 9)
    const points = trackFor(item, 'scale')!.points
    expect(points).toHaveLength(1)
    expect(points[0]).toEqual({ t: 5, value: 9 })
  })

  it('replacing an existing point preserves its easing when none is passed', () => {
    let item = overlay()
    item = setKeyframe(item, 'scale', 5, 1, 'ease-in')
    item = setKeyframe(item, 'scale', 5, 2) // no easing arg
    expect(trackFor(item, 'scale')!.points[0]).toEqual({ t: 5, value: 2, easing: 'ease-in' })
  })

  it('a new easing argument overrides the preserved one', () => {
    let item = overlay()
    item = setKeyframe(item, 'scale', 5, 1, 'ease-in')
    item = setKeyframe(item, 'scale', 5, 2, 'hold')
    expect(trackFor(item, 'scale')!.points[0]).toEqual({ t: 5, value: 2, easing: 'hold' })
  })

  it('ignores a non-finite t and returns the item unchanged', () => {
    const item = overlay()
    expect(setKeyframe(item, 'scale', NaN, 1)).toBe(item)
  })

  it('ignores a non-finite value and returns the item unchanged', () => {
    const item = overlay()
    expect(setKeyframe(item, 'scale', 0, Infinity)).toBe(item)
  })
})

describe('removeKeyframe', () => {
  it('removes one point, leaving the rest of the track', () => {
    const item = overlay({
      keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }, { t: 5, value: 2 }] }],
    })
    const next = removeKeyframe(item, 'scale', 0)
    expect(trackFor(next, 'scale')!.points).toEqual([{ t: 5, value: 2 }])
  })

  it('removing the last point removes the whole track', () => {
    const item = overlay({
      keyframes: [
        { prop: 'scale', points: [{ t: 0, value: 1 }] },
        { prop: 'opacity', points: [{ t: 0, value: 1 }] },
      ],
    })
    const next = removeKeyframe(item, 'scale', 0)
    expect(trackFor(next, 'scale')).toBeUndefined()
    expect(trackFor(next, 'opacity')).toBeDefined() // untouched
  })

  it('removing the last track removes item.keyframes entirely (undefined, not [])', () => {
    const item = overlay({ keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }] }] })
    const next = removeKeyframe(item, 'scale', 0)
    expect(next.keyframes).toBeUndefined()
    expect('keyframes' in next).toBe(false)
  })

  it('is a no-op when t is not present', () => {
    const item = overlay({ keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }] }] })
    expect(removeKeyframe(item, 'scale', 99)).toBe(item)
  })

  it('is a no-op when the prop has no track', () => {
    const item = overlay()
    expect(removeKeyframe(item, 'scale', 0)).toBe(item)
  })

  it('does not mutate the input item, its keyframes array, or its point objects', () => {
    const points = [{ t: 0, value: 1 }, { t: 5, value: 2 }]
    const item = overlay({ keyframes: [{ prop: 'scale', points }] })
    const snapshot = JSON.parse(JSON.stringify(item))

    removeKeyframe(item, 'scale', 0)

    expect(item).toEqual(snapshot)
    expect(item.keyframes![0].points).toBe(points)
  })
})

describe('moveKeyframe', () => {
  it('retimes a keyframe, preserving value and easing', () => {
    const item = overlay({
      keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1, easing: 'ease-out' }] }],
    })
    const next = moveKeyframe(item, 'scale', 0, 7)
    expect(trackFor(next, 'scale')!.points).toEqual([{ t: 7, value: 1, easing: 'ease-out' }])
  })

  it('landing on an occupied t: the moved keyframe wins', () => {
    const item = overlay({
      keyframes: [
        { prop: 'scale', points: [{ t: 0, value: 1 }, { t: 5, value: 9 }] },
      ],
    })
    const next = moveKeyframe(item, 'scale', 0, 5)
    const points = trackFor(next, 'scale')!.points
    expect(points).toHaveLength(1)
    expect(points[0]).toEqual({ t: 5, value: 1 }) // moved point's value (1), not the resident's (9)
  })

  it('is a no-op when fromT is not present', () => {
    const item = overlay({ keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }] }] })
    expect(moveKeyframe(item, 'scale', 99, 5)).toBe(item)
  })

  it('ignores non-finite fromT/toT', () => {
    const item = overlay({ keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }] }] })
    expect(moveKeyframe(item, 'scale', NaN, 5)).toBe(item)
    expect(moveKeyframe(item, 'scale', 0, Infinity)).toBe(item)
  })

  it('does not mutate the input item, its keyframes array, or its point objects', () => {
    const points = [{ t: 0, value: 1 }]
    const item = overlay({ keyframes: [{ prop: 'scale', points }] })
    const snapshot = JSON.parse(JSON.stringify(item))

    moveKeyframe(item, 'scale', 0, 7)

    expect(item).toEqual(snapshot)
    expect(item.keyframes![0].points).toBe(points)
  })
})

describe('setKeyframeEasing', () => {
  it('sets the outgoing easing on the keyframe at t', () => {
    const item = overlay({ keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }] }] })
    const next = setKeyframeEasing(item, 'scale', 0, 'ease-in-out')
    expect(trackFor(next, 'scale')!.points[0].easing).toBe('ease-in-out')
  })

  it('overwrites an existing easing', () => {
    const item = overlay({ keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1, easing: 'hold' }] }] })
    const next = setKeyframeEasing(item, 'scale', 0, 'linear')
    expect(trackFor(next, 'scale')!.points[0].easing).toBe('linear')
  })

  it('is a no-op when there is no point at t', () => {
    const item = overlay({ keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }] }] })
    expect(setKeyframeEasing(item, 'scale', 5, 'hold')).toBe(item)
  })

  it('does not mutate the input item, its keyframes array, or its point objects', () => {
    const points = [{ t: 0, value: 1 }]
    const item = overlay({ keyframes: [{ prop: 'scale', points }] })
    const snapshot = JSON.parse(JSON.stringify(item))

    setKeyframeEasing(item, 'scale', 0, 'ease')

    expect(item).toEqual(snapshot)
    expect(item.keyframes![0].points).toBe(points)
  })
})

describe('enableKeyframing', () => {
  it('seeds a single keyframe at atT with the current static value', () => {
    const item = overlay({ scale: 1.75 })
    const next = enableKeyframing(item, 'scale', 3)
    expect(trackFor(next, 'scale')!.points).toEqual([{ t: 3, value: 1.75 }])
  })

  it('seeds the prop default when there is no static scalar either', () => {
    const item = overlay()
    const next = enableKeyframing(item, 'opacity', 0)
    expect(trackFor(next, 'opacity')!.points).toEqual([{ t: 0, value: 1 }])
  })

  it('the overlay does not move: valueAt is identical before and after, at atT', () => {
    const item = overlay({ offsetY: -8 })
    const before = valueAt(item, 'offsetY', 4)
    const next = enableKeyframing(item, 'offsetY', 4)
    const after = valueAt(next, 'offsetY', 4)
    expect(after).toBe(before)
  })

  it('ignores a non-finite atT', () => {
    const item = overlay()
    expect(enableKeyframing(item, 'scale', NaN)).toBe(item)
  })

  it('does not mutate the input item', () => {
    const item = overlay({ scale: 2 })
    const snapshot = JSON.parse(JSON.stringify(item))
    enableKeyframing(item, 'scale', 0)
    expect(item).toEqual(snapshot)
  })

  it('is a no-op when the prop already has keyframes — never resets an existing track', () => {
    const item = overlay({
      keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }, { t: 5, value: 2 }, { t: 9, value: 3 }] }],
    })
    const snapshot = JSON.parse(JSON.stringify(item))
    const next = enableKeyframing(item, 'scale', 5)

    expect(next).toBe(item)
    expect(next).toEqual(snapshot)
    expect(trackFor(next, 'scale')!.points).toHaveLength(3)
  })

  it('the explicit reset path — disableKeyframing then enableKeyframing — reseeds a single point at atT', () => {
    const item = overlay({
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] }],
    })
    const off = disableKeyframing(item, 'offsetX', 5) // curve value at t=5 is 50, written to the static scalar
    const on = enableKeyframing(off, 'offsetX', 5)
    expect(trackFor(on, 'offsetX')!.points).toEqual([{ t: 5, value: 50 }])
  })
})

describe('disableKeyframing', () => {
  it('removes the track and writes the curve value at atT into the static scalar', () => {
    const item = overlay({
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] }],
    })
    const next = disableKeyframing(item, 'offsetX', 5)
    expect(trackFor(next, 'offsetX')).toBeUndefined()
    expect(next.offsetX).toBe(50)
  })

  it('removing the only track drops item.keyframes entirely', () => {
    const item = overlay({
      keyframes: [{ prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 10, value: 100 }] }],
    })
    const next = disableKeyframing(item, 'offsetX', 5)
    expect(next.keyframes).toBeUndefined()
  })

  it('the overlay does not jump: valueAt is identical before and after, at atT', () => {
    const item = overlay({
      keyframes: [{ prop: 'rotation', points: [{ t: 0, value: 0 }, { t: 10, value: 90 }] }],
    })
    const before = valueAt(item, 'rotation', 3)
    const next = disableKeyframing(item, 'rotation', 3)
    const after = valueAt(next, 'rotation', 3)
    expect(after).toBe(before)
  })

  it('ignores a non-finite atT', () => {
    const item = overlay({ keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }] }] })
    expect(disableKeyframing(item, 'scale', NaN)).toBe(item)
  })

  it('does not mutate the input item, its keyframes array, or its point objects', () => {
    const points = [{ t: 0, value: 1 }, { t: 10, value: 2 }]
    const item = overlay({ keyframes: [{ prop: 'scale', points }] })
    const snapshot = JSON.parse(JSON.stringify(item))

    disableKeyframing(item, 'scale', 5)

    expect(item).toEqual(snapshot)
    expect(item.keyframes![0].points).toBe(points)
  })
})

// ── Round-trip: prove the module's output is actually consumable by the
// read path (`sampleTrack`, imported directly from timeline-core here). ────

describe('round-trip with sampleTrack', () => {
  it('a track built through several ops reads back the expected curve', () => {
    let item = overlay()
    item = setKeyframe(item, 'opacity', 10, 0)
    item = setKeyframe(item, 'opacity', 0, 1, 'linear')
    item = moveKeyframe(item, 'opacity', 10, 8)
    item = setKeyframeEasing(item, 'opacity', 0, 'hold')

    const track = trackFor(item, 'opacity')!
    expect(track.points).toEqual([
      { t: 0, value: 1, easing: 'hold' },
      { t: 8, value: 0 },
    ])

    // 'hold' is step-end: the value stays 1 for the whole segment and only
    // reaches 0 exactly at the next keyframe's own t.
    expect(sampleTrack(track, 0)).toBe(1)
    expect(sampleTrack(track, 4)).toBe(1)
    expect(sampleTrack(track, 7.999)).toBe(1)
    expect(sampleTrack(track, 8)).toBe(0)
    expect(sampleTrack(track, 100)).toBe(0) // clamped past the last keyframe
  })

  it('setKeyframe followed by removeKeyframe leaves sampleTrack with the sentinel (no track)', () => {
    let item = overlay()
    item = setKeyframe(item, 'scale', 0, 2)
    item = removeKeyframe(item, 'scale', 0)
    expect(trackFor(item, 'scale')).toBeUndefined()
    expect(sampleTrack(trackFor(item, 'scale'), 0)).toBeUndefined()
  })
})

describe('canKeyframe — the single gate on which items support keyframing', () => {
  it('accepts an overlay', () => {
    expect(canKeyframe({ id: 'o', type: 'overlay', start: 0, end: 5 } as VisualItem)).toBe(true)
  })

  it('ACCEPTS video and image items (SP9d)', () => {
    // Was false, and the reason it was false is gone. The ffmpeg path used to
    // emit ONE static box per segment with no per-frame hook; encode-segment.js
    // now compiles a curve into a time-varying filter expression, and the
    // preview animates clips to match. Three coordinated changes, landed
    // together: this predicate, that preview branch, and the renderer.
    expect(canKeyframe({ id: 'v', type: 'video', start: 0, end: 5 } as VisualItem)).toBe(true)
    expect(canKeyframe({ id: 'i', type: 'image', start: 0, end: 5 } as VisualItem)).toBe(true)
  })

  it('still rejects kinds with no transform at all', () => {
    expect(canKeyframe({ id: 'a', type: 'audio', start: 0, end: 5 } as unknown as VisualItem)).toBe(false)
  })

  it('accepts a video item carrying a keyframes array', () => {
    const kf = {
      id: 'v', type: 'video', start: 0, end: 5,
      keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }] }],
    } as unknown as VisualItem
    expect(canKeyframe(kf)).toBe(true)
  })

  it('rejects null/undefined without throwing', () => {
    expect(canKeyframe(null as unknown as VisualItem)).toBe(false)
    expect(canKeyframe(undefined as unknown as VisualItem)).toBe(false)
  })
})

describe('valueAt — samples with the item\'s OWN kind', () => {
  it('reads the five props identically for any item kind', () => {
    // `geometryAt`'s `kind` only drives `fit`, which is not keyframeable, so
    // this is behaviour-preserving today. It stops the function LYING about
    // the item's kind, which is what makes Task 1 a safe foundation.
    const base = { id: 'x', start: 0, end: 10, scale: 1.5, offsetX: 20 }
    const asOverlay = { ...base, type: 'overlay' } as VisualItem
    const asVideo = { ...base, type: 'video' } as VisualItem
    expect(valueAt(asOverlay, 'scale', 0)).toBe(1.5)
    expect(valueAt(asVideo, 'scale', 0)).toBe(1.5)
    expect(valueAt(asVideo, 'offsetX', 0)).toBe(20)
  })
})

describe('removeKeyframesAt — removes every prop keyed at one instant, without jumping', () => {
  it('removes the point from every prop that has one at t', () => {
    const item = {
      id: 'o', type: 'overlay', start: 0, end: 10, scale: 9, offsetX: 9,
      keyframes: [
        { prop: 'scale', points: [{ t: 0, value: 1 }, { t: 5, value: 2 }] },
        { prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 5, value: 50 }] },
        { prop: 'opacity', points: [{ t: 2, value: 0.5 }] },
      ],
    } as unknown as VisualItem

    const next = removeKeyframesAt(item, 5)
    expect(trackFor(next, 'scale')!.points.map(p => p.t)).toEqual([0])
    expect(trackFor(next, 'offsetX')!.points.map(p => p.t)).toEqual([0])
    // A prop with no point at t is untouched.
    expect(trackFor(next, 'opacity')!.points.map(p => p.t)).toEqual([2])
  })

  it('freezes the sampled value when t was a track\'s LAST point, so nothing jumps', () => {
    // THE BUG THIS FIXES: plain `removeKeyframe` drops the track without
    // writing the scalar, so the overlay snaps back to the stale `scale: 9`.
    const item = {
      id: 'o', type: 'overlay', start: 0, end: 10, scale: 9,
      keyframes: [{ prop: 'scale', points: [{ t: 3, value: 2 }] }],
    } as unknown as VisualItem

    const next = removeKeyframesAt(item, 3)
    expect(hasKeyframes(next, 'scale')).toBe(false)
    expect(next.scale).toBe(2)      // the curve's value, NOT the stale 9
  })

  it('is a no-op when no prop has a point at t', () => {
    const item = {
      id: 'o', type: 'overlay', start: 0, end: 10,
      keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }] }],
    } as unknown as VisualItem
    expect(removeKeyframesAt(item, 7)).toBe(item)
  })

  it('drops item.keyframes entirely when the last point of the last track goes', () => {
    const item = {
      id: 'o', type: 'overlay', start: 0, end: 10, scale: 9,
      keyframes: [{ prop: 'scale', points: [{ t: 1, value: 3 }] }],
    } as unknown as VisualItem
    expect(removeKeyframesAt(item, 1).keyframes).toBeUndefined()
  })
})

describe('isUniformScale — how an overlay is AUTHORED, not what its numbers are', () => {
  it('is true for an item carrying no per-axis scale at all', () => {
    expect(isUniformScale(overlay())).toBe(true)
    expect(isUniformScale(overlay({ scale: 1.2 }))).toBe(true)
  })

  it('is false for either per-axis SCALAR on its own', () => {
    expect(isUniformScale(overlay({ scaleX: 1.2 }))).toBe(false)
    expect(isUniformScale(overlay({ scaleY: 1.2 }))).toBe(false)
  })

  it('is false for either per-axis TRACK, even with no scalar', () => {
    const keyed = (prop: 'scaleX' | 'scaleY') =>
      overlay({ keyframes: [{ prop, points: [{ t: 0, value: 1 }] }] })
    expect(isUniformScale(keyed('scaleX'))).toBe(false)
    expect(isUniformScale(keyed('scaleY'))).toBe(false)
  })

  it('stays false when the two axes happen to be EQUAL', () => {
    // The whole reason absence is the test. An overlay the operator unlocked on
    // purpose and left at 120%/120% is authored per-axis; an equality test
    // would silently re-lock it the moment the two numbers met.
    expect(isUniformScale(overlay({ scaleX: 1.2, scaleY: 1.2 }))).toBe(false)
  })

  it('ignores an EMPTY per-axis track, which is not an animation', () => {
    // withTrack never leaves one behind, but a hand-edited project.json can.
    expect(isUniformScale(overlay({ keyframes: [{ prop: 'scaleX', points: [] }] }))).toBe(true)
  })

  it('is unmoved by tracks on other props', () => {
    expect(isUniformScale(overlay({
      keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }, { t: 5, value: 2 }] }],
    }))).toBe(true)
  })
})

describe('transformProps — the set an all-props action may walk', () => {
  it('gives a uniform item `scale` and NEITHER per-axis prop', () => {
    const props = transformProps(overlay({ scale: 1.2 }))
    expect(props).toEqual(['offsetX', 'offsetY', 'scale', 'rotation', 'opacity'])
  })

  it('gives a per-axis item both axes and NOT `scale`', () => {
    const props = transformProps(overlay({ scaleX: 1.5, scaleY: 0.5 }))
    expect(props).toEqual(['offsetX', 'offsetY', 'scaleX', 'scaleY', 'rotation', 'opacity'])
  })

  it('never mixes the uniform and per-axis scale props', () => {
    // The invariant, whatever the item: the scale props returned are EITHER
    // exactly ['scale'] OR exactly ['scaleX','scaleY']. A list carrying all
    // three would have one shadowing the others.
    const items = [
      overlay(),
      overlay({ scale: 2 }),
      overlay({ scaleX: 1 }),
      overlay({ scaleY: 1 }),
      overlay({ scale: 2, scaleX: 1, scaleY: 1 }),
      overlay({ keyframes: [{ prop: 'scaleX', points: [{ t: 0, value: 1 }] }] }),
      overlay({ keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }] }] }),
    ]
    for (const item of items) {
      const scaleProps = transformProps(item).filter(p => p.startsWith('scale'))
      expect([['scale'], ['scaleX', 'scaleY']]).toContainEqual(scaleProps)
    }
  })

  it('returns the same prop ORDER for both shapes, so the two agree bar the scale slot', () => {
    const strip = (item: VisualItem) => transformProps(item).filter(p => !p.startsWith('scale'))
    expect(strip(overlay())).toEqual(strip(overlay({ scaleX: 1, scaleY: 1 })))
    expect(strip(overlay())).toEqual(['offsetX', 'offsetY', 'rotation', 'opacity'])
  })

  it('keying every returned prop leaves a uniform animation still animating', () => {
    // The failure this function exists to prevent, driven end to end: a
    // one-point scaleX track would shadow the `scale` track and freeze the zoom.
    const item = overlay({
      keyframes: [{ prop: 'scale', points: [{ t: 0, value: 1 }, { t: 10, value: 3 }] }],
    })
    let next = item
    for (const prop of transformProps(item)) {
      next = setKeyframe(enableKeyframing(next, prop, 5), prop, 5, valueAt(item, prop, 5))
    }

    expect(trackFor(next, 'scaleX')).toBeUndefined()
    expect(valueAt(next, 'scaleX', 0)).toBe(1)
    expect(valueAt(next, 'scaleX', 10)).toBe(3)
    expect(valueAt(next, 'scaleY', 10)).toBe(3)
  })

  it('keying every returned prop actually bites on a per-axis item', () => {
    // The symmetric failure: `scale` is shadowed there, so keying it would look
    // like the gesture did nothing.
    const item = overlay({ scaleX: 1.5, scaleY: 0.5 })
    let next = item
    for (const prop of transformProps(item)) {
      next = setKeyframe(enableKeyframing(next, prop, 5), prop, 5, valueAt(item, prop, 5))
    }

    expect(trackFor(next, 'scaleX')!.points).toEqual([{ t: 5, value: 1.5 }])
    expect(trackFor(next, 'scaleY')!.points).toEqual([{ t: 5, value: 0.5 }])
    expect(trackFor(next, 'scale')).toBeUndefined()
  })
})
