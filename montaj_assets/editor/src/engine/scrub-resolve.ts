/**
 * Where in the timeline an audible scrub position lands.
 *
 * The scrubber ({@link ./scrub-source.ts `createScrubSource`}) must composite
 * over the engine's own decode plan without re-deriving it — same
 * `resolveAt(..., {variant:'preview'})`, same earliest-start-wins tiebreak on
 * track-0 video items, same proxy-only src gate. Duplicating any of that risks
 * drift the moment either side changes, so this builder reuses the exact
 * helpers `scheduler.planTick` calls:
 *   • `resolveAt` (timeline-core) — the scene the resolver hands the engine
 *     (scheduler.ts:543).
 *   • `engineSrcFor` (scheduler.ts:527) — the "engine-decodable proxy" gate,
 *     which BOTH catches a missing `proxySrc` AND catches a higher-precedence
 *     preview src the engine cannot decode (e.g. `nobg_preview_src`, VP9
 *     WebM-with-alpha — SP4 T1). That second half is why the `<video>`
 *     fallback is excluded here for free: a fallback project's clips either
 *     lack `proxySrc` outright or resolve to a src the engine can't open.
 *   • `placeInSource` (scheduler.ts:324) — project-time → source-media
 *     seconds, including per-clip speed and loop wrap.
 *
 * Returned `null` (the scrubber stays silent) covers the four cases the plan
 * names: gap between clips, canvas project (no track-0 video items), a clip
 * whose `engineSrcFor` is blocked, and by extension a `<video>`-fallback
 * project.
 *
 * The builder takes a project GETTER, not a bare project. `createScrubSource`
 * has no `setResolve`, so the resolver must stay stable across edits; a
 * closure that reads the latest project on each call keeps the same scrub
 * source instance live as the timeline mutates.
 */
import { resolveAt } from '@bycrux/timeline-core'
import type { EditorProject as Project, VisualItem } from '../schema'
import { withEnabledItemTracks } from '../video/timeline/timeline-model'
import { engineSrcFor, placeInSource } from './scheduler'
import type { ScrubTarget } from './scrub-source'

export type ScrubResolver = (projectS: number) => ScrubTarget | null

export function createScrubResolver(getProject: () => Project | null | undefined): ScrubResolver {
  return (projectS) => {
    const project = getProject()
    if (!project) return null
    const scene = resolveAt(withEnabledItemTracks(project), projectS, { variant: 'preview' })

    // Mirror `planTick`'s active-clip loop (scheduler.ts:566-587): filter to
    // track-0 video items with a resolved window, then keep the
    // earliest-start on overlap. `resolveAt` returns items in document order,
    // so the tiebreak has to be explicit.
    let bestItem: VisualItem | null = null
    let bestWindow: NonNullable<(typeof scene.items)[number]['window']> | null = null
    for (const resolved of scene.items) {
      if (resolved.trackIdx !== 0 || resolved.kind !== 'video' || !resolved.window) continue
      const item = resolved.item as unknown as VisualItem
      if (bestItem && (bestItem.start ?? 0) <= (item.start ?? 0)) continue
      bestItem = item
      bestWindow = resolved.window
    }
    if (!bestItem || !bestWindow) return null

    const usable = engineSrcFor(bestItem, bestWindow)
    if (usable.blocked) return null

    const placement = placeInSource(bestItem, bestWindow, projectS)
    return { src: usable.src, mediaS: placement.mediaS }
  }
}
