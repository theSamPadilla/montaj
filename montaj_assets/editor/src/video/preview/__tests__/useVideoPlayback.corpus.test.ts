import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { containsTime, resolveAt, sourceWindow } from '@bycrux/timeline-core'
import { useVideoPlayback } from '../useVideoPlayback'
import type { EditorProject, VisualItem } from '../../../schema'

// The fixture is imported by RELATIVE path, not as `@bycrux/timeline-core/fixtures/…`:
// the package's `exports` map declares only the `"."` entry, so subpath imports are
// not part of its public API and T6 does not get to widen it. Everything else in this
// file goes through the package's real barrel.
import negativeStart from '../../../../../timeline-core/fixtures/negative-start.json'

// ── Corpus parity: useVideoPlayback's derived collections vs. the resolver ────
//
// `useVideoPlayback` does not expose a Scene. It exposes the editor's own
// PARTITION of the timeline — `clips` (tracks[0] videos, sorted by start),
// `tracks0NonVideo` (everything else on tracks[0]) and `overlayTracks`
// (tracks[1..]) — and each consumer applies the activation predicate itself.
// This test reassembles those three collections back into a flat, ordered scene
// and asserts it is exactly what `resolveAt(project, t, {variant: 'preview'})`
// reports: same items, same track indices, same kinds, same source windows.
//
// `negative-start.json` is the corpus's "background reel anchored before the
// origin" case: a tracks[0] video over [0, 6) with a tracks[1] JSX overlay over
// [-0.5, 5.5). It exercises the partition (a clip AND an overlay track), the
// half-open predicate at both ends, and a negative `start` — while keeping ONE
// item per track, so the same-trackIdx tie-order divergence (D7 in
// KNOWN-DIVERGENCES.md) can't muddy the comparison.
const project = negativeStart as unknown as EditorProject

// -0.25 → overlay only (before the clip starts, after the overlay does)
//  2.00 → both on screen
//  5.75 → clip only (the overlay ended at 5.5; the clip runs to 6)
const TIMESTAMPS = [-0.25, 2.0, 5.75]

interface FlatItem {
  id: string
  trackIdx: number
  kind: string
}

/**
 * Reassemble the editor's three derived collections into the resolver's flat,
 * back-to-front scene: track 0 first, then each overlay track in order. Track
 * indices are absolute (overlayTracks[0] is project track 1) because that is
 * what `ResolvedItem.trackIdx` reports.
 */
function editorSceneAt(
  derived: {
    clips: VisualItem[]
    tracks0NonVideo: VisualItem[]
    overlayTracks: VisualItem[][]
  },
  t: number,
): FlatItem[] {
  const flat: FlatItem[] = []
  const push = (items: VisualItem[], trackIdx: number) => {
    for (const item of items) {
      if (containsTime(item.start, item.end, t)) flat.push({ id: item.id, trackIdx, kind: item.type })
    }
  }
  push(derived.clips, 0)
  push(derived.tracks0NonVideo, 0)
  derived.overlayTracks.forEach((items, i) => push(items, i + 1))
  return flat.sort((a, b) => a.trackIdx - b.trackIdx)
}

function resolverSceneAt(t: number): FlatItem[] {
  return resolveAt(project, t, { variant: 'preview' }).items.map((r) => ({
    id: r.item.id as string,
    trackIdx: r.trackIdx,
    kind: r.kind,
  }))
}

// Testing Library auto-cleans between tests, so the hook is mounted fresh per
// case at the timestamp under test rather than reused and re-rendered.
function derivedAt(t: number) {
  return renderHook(() => useVideoPlayback(project, t, () => {}, (p) => p)).result.current
}

describe('useVideoPlayback derived collections vs. resolveAt (negative-start corpus fixture)', () => {
  it.each(TIMESTAMPS)('agrees on what is on screen at t=%s', (t) => {
    const { clips, tracks0NonVideo, overlayTracks } = derivedAt(t)
    expect(editorSceneAt({ clips, tracks0NonVideo, overlayTracks }, t)).toEqual(resolverSceneAt(t))
  })

  it('splits the fixture the way the resolver labels it', () => {
    const { clips, tracks0NonVideo, overlayTracks } = derivedAt(TIMESTAMPS[1])
    expect(clips.map((c) => c.id)).toEqual(['mainClip'])
    expect(tracks0NonVideo).toEqual([])
    expect(overlayTracks.map((tr) => tr.map((i) => i.id))).toEqual([['bgReel']])
  })

  it.each(TIMESTAMPS)('seeks the active clip where the resolver says, at t=%s', (t) => {
    const { clips } = derivedAt(t)
    const scene = resolveAt(project, t, { variant: 'preview' })
    const videos = scene.items.filter((r) => r.kind === 'video')
    // t=-0.25 is before the only clip starts — assert that, so a fixture change
    // that silently empties this loop can't turn the case into a no-op.
    expect(videos.length).toBe(t < 0 ? 0 : 1)
    for (const resolved of videos) {
      const clip = clips.find((c) => c.id === resolved.item.id)!
      // What the hook assigns to `video.currentTime` for this clip at this
      // instant (useVideoPlayback's scrub branch), against ResolvedItem.seek.
      const inPoint = sourceWindow(clip, 'preview').inPoint
      expect(Math.max(inPoint, inPoint + (t - clip.start))).toBeCloseTo(resolved.seek, 10)
      expect(resolved.window).toEqual(sourceWindow(clip, 'preview'))
    }
  })

  it('reports an empty scene past the end of every item (no last-clip fallback)', () => {
    // The resolver has no fallback; PreviewPlayer's `?? clips[clips.length - 1]`
    // is editor-side presentation and lives there, not here.
    expect(resolverSceneAt(6.5)).toEqual([])
  })
})
