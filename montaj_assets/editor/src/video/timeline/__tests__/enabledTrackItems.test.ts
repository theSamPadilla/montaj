/// <reference types="vitest/globals" />
/**
 * The accessor split that IS the skip feature: editing surfaces see every
 * track, playback and export see only the enabled ones. If these two ever
 * return the same thing, either skip does nothing or a skipped track becomes
 * uneditable — both are silent failures on screen.
 */
import { describe, it, expect } from 'vitest'
import {
  enabledTrackItems,
  enabledTracks,
  trackItems,
  withEnabledItemTracks,
  withItemTracks,
} from '../timeline-model'
import type { VisualItem } from '../../../schema'

const item = (id: string): VisualItem =>
  ({ id, type: 'video', src: `${id}.mp4`, start: 0, end: 1 }) as VisualItem

const project = {
  id: 'p',
  tracks: [
    { id: 'trk-0', items: [item('a')] },
    { id: 'trk-1', items: [item('b')], enabled: false },
    { id: 'trk-2', items: [item('c')], enabled: true },
  ],
} as never

describe('enabledTrackItems', () => {
  it('empties tracks marked enabled:false, in place', () => {
    // A map, not a filter: the skipped track KEEPS its slot (index 1) so every
    // positional consumer downstream ([0] = base track, .slice(1) = overlay
    // tracks) still lines up.
    expect(enabledTrackItems(project).map(t => t.map(i => i.id))).toEqual([['a'], [], ['c']])
  })

  it('does not renumber later tracks when an earlier one is skipped', () => {
    // Reproduction of the bug this shape guards against: with track 0 skipped
    // and two overlay tracks, a FILTER would promote trk-1 into slot 0 and
    // drop trk-2 out of the overlay set (`.slice(1)`) entirely.
    const p = {
      tracks: [
        { id: 'trk-0', items: [item('base')], enabled: false },
        { id: 'trk-1', items: [item('o1')] },
        { id: 'trk-2', items: [item('o2')] },
      ],
    } as never
    const out = enabledTrackItems(p)
    expect(out.map(t => t.map(i => i.id))).toEqual([[], ['o1'], ['o2']])
    expect(out.slice(1).map(t => t.map(i => i.id))).toEqual([['o1'], ['o2']])
  })

  it('keeps every track when none is disabled', () => {
    const all = { id: 'p', tracks: [{ id: 't0', items: [item('a')] }, { id: 't1', items: [item('b')] }] } as never
    expect(enabledTrackItems(all)).toHaveLength(2)
  })

  it('treats an absent `enabled` as enabled — untouched projects are unaffected', () => {
    // The default matters: nothing writes `enabled` in, so every project that
    // predates this feature has it missing on every track.
    const legacyish = { id: 'p', tracks: [{ id: 't0', items: [item('a')] }] } as never
    expect(enabledTrackItems(legacyish)).toEqual([[item('a')]])
  })

  it('accepts the legacy array-of-arrays shape, with every track enabled', () => {
    expect(enabledTrackItems({ tracks: [[item('a')], [item('b')]] } as never)).toHaveLength(2)
  })

  it('returns one slot per track, same as the editing accessor — only a skipped slot is emptied', () => {
    // The other half of the invariant — a skipped track must stay visible and
    // editable on the timeline, and its slot must not disappear from either view.
    expect(trackItems(project)).toHaveLength(3)
    expect(enabledTrackItems(project)).toHaveLength(3)
    expect(enabledTrackItems(project)[1]).toEqual([])
  })

  it('shares item objects by reference, never copies', () => {
    // Load-bearing: the renderer's `resolveProjectPaths` rewrites `item.src` in
    // place through this view. A defensive copy here breaks path resolution in
    // the renderer with nothing failing.
    const src = item('a')
    const p = { tracks: [{ id: 't0', items: [src] }] } as never
    expect(enabledTrackItems(p)[0][0]).toBe(src)
  })

  it('survives absent, empty and malformed tracks instead of throwing', () => {
    expect(enabledTrackItems(undefined)).toEqual([])
    expect(enabledTrackItems(null)).toEqual([])
    expect(enabledTrackItems({} as never)).toEqual([])
    expect(enabledTrackItems({ tracks: 'nonsense' } as never)).toEqual([])
  })
})

describe('enabledTracks', () => {
  // The object-shape sibling. Preview needs it because a track's `volume`/
  // `muted` fold into every clip on it, and the item-array view has nowhere to
  // carry them.
  it('returns the track OBJECTS, so their own settings survive the read', () => {
    const p = { tracks: [{ id: 't0', items: [item('a')], volume: 0.5, muted: true }] } as never
    expect(enabledTracks(p)[0]).toMatchObject({ id: 't0', volume: 0.5, muted: true })
  })

  it('applies the same skip test and order as enabledTrackItems — index i is index i', () => {
    // The whole point of having two accessors with one skip test: if they ever
    // disagree about which track is at [n], the preview folds the WRONG
    // track's fader into its clips and nothing throws.
    expect(enabledTracks(project).map(t => t.id)).toEqual(['trk-0', 'trk-1', 'trk-2'])
    expect(enabledTracks(project).map(t => t.items)).toEqual(enabledTrackItems(project))
    expect(enabledTracks(project)[1].items).toEqual([])
  })

  it('treats an absent `enabled` as enabled', () => {
    expect(enabledTracks({ tracks: [{ id: 't0', items: [] }] } as never)).toHaveLength(1)
  })

  it('normalizes the legacy array-of-arrays shape into settingless tracks', () => {
    const out = enabledTracks({ tracks: [[item('a')], [item('b')]] } as never)
    expect(out).toHaveLength(2)
    // No settings to fold — a legacy project sounds exactly as it always did.
    expect(out[0].volume).toBeUndefined()
    expect(out[0].muted).toBeUndefined()
  })

  it('shares item objects by reference, never copies', () => {
    const src = item('a')
    const p = { tracks: [{ id: 't0', items: [src] }] } as never
    expect(enabledTracks(p)[0].items[0]).toBe(src)
  })

  it('survives absent, empty and malformed tracks instead of throwing', () => {
    expect(enabledTracks(undefined)).toEqual([])
    expect(enabledTracks(null)).toEqual([])
    expect(enabledTracks({} as never)).toEqual([])
    expect(enabledTracks({ tracks: 'nonsense' } as never)).toEqual([])
  })
})

describe('withEnabledItemTracks', () => {
  it('hands timeline-core bare item arrays, not track objects', () => {
    // `@bycrux/timeline-core` reads `tracks` as an array of item arrays and
    // throws `TypeError: object is not iterable` on the object shape. The
    // unwrap is why this shim exists at all.
    const out = withEnabledItemTracks(project)
    expect(Array.isArray(out.tracks[0])).toBe(true)
    expect(out.tracks.map(t => t.map(i => i.id))).toEqual([['a'], [], ['c']])
  })

  it('differs from withItemTracks by exactly the disabled tracks\' content, not the slot count', () => {
    // Filtering without the unwrap re-breaks timeline-core; unwrapping without
    // the filter ignores skip. Both halves, or neither works. Both adapters
    // keep one slot per track — timeline-core resolves `trackIdx` positionally
    // — so the difference shows up as an EMPTIED slot, not a shorter array.
    expect(withItemTracks(project).tracks).toHaveLength(3)
    expect(withEnabledItemTracks(project).tracks).toHaveLength(3)
    expect(withItemTracks(project).tracks[1]).toEqual([item('b')])
    expect(withEnabledItemTracks(project).tracks[1]).toEqual([])
  })

  it('passes every other project field through untouched', () => {
    const out = withEnabledItemTracks({ ...(project as object), name: 'Keep me' } as { tracks?: unknown; name: string })
    expect(out.name).toBe('Keep me')
  })
})
