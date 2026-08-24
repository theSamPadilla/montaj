/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest'
import { sampleTrack } from '@bycrux/timeline-core'
import type { VisualItem } from '../../schema'
import {
  trackFor,
  hasKeyframes,
  isKeyframed,
  valueAt,
  setKeyframe,
  removeKeyframe,
  moveKeyframe,
  setKeyframeEasing,
  enableKeyframing,
  disableKeyframing,
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
