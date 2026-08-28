/**
 * The marker model — every mutation markers can undergo, as pure functions.
 *
 * Same contract as the rest of the timeline model: a function returns the SAME
 * project reference when it would change nothing, so callers can use `next ===
 * base` as their no-op guard and never push an empty undo entry or queue a
 * pointless save (the convention `splitAtTime`, `computeAutoCrossfade` and
 * `normalizeCaptionLanes` all follow).
 *
 * Markers are stored SORTED BY TIME. Nothing downstream re-sorts: the painter
 * walks the array in order, and `serve/context.py` hands it to the agent as-is.
 * Sorting on write rather than on read means one rule in one place.
 */
import type { EditorProject, Marker } from '../../schema'

/** Fallback frame rate when a project's settings omit one — matches the fps
 *  default `serve/context.py` and the renderer both use. */
const DEFAULT_FPS = 30

/** Fresh marker ids. Same shape as `cuts.ts`'s `uniqueId`: a time base plus
 *  randomness, so two markers dropped in the same millisecond still differ. */
function markerId(): string {
  return `mk-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * The label a new marker gets: one past the highest PURELY NUMERIC label in
 * use.
 *
 * Reading the max rather than counting the array is what stops a delete from
 * handing out a number twice — delete "2" of 1/2/3 and the next marker must be
 * "4", not "3". A renamed marker ("cut this") contributes nothing, so renaming
 * never stalls or rewinds the counter.
 */
export function nextMarkerLabel(markers: readonly Marker[]): string {
  let max = 0
  for (const m of markers) {
    // `Number('')` is 0 and `Number('3px')` is NaN — require an all-digits
    // label so neither can be mistaken for a counter value.
    if (!/^\d+$/.test(m.label)) continue
    const n = Number(m.label)
    if (n > max) max = n
  }
  return String(max + 1)
}

const byTime = (a: Marker, b: Marker) => a.t - b.t

/** Write a marker list back, dropping the key entirely when it empties. */
function withMarkers(project: EditorProject, markers: Marker[]): EditorProject {
  if (markers.length === 0) {
    const { markers: _dropped, ...rest } = project
    return rest as EditorProject
  }
  return { ...project, markers }
}

/**
 * Drop a marker at `t`.
 *
 * Returns the same project when one already sits within HALF A FRAME: holding
 * `M` down fires key repeat at the OS's repeat rate, and without this a held
 * key buries the strip in stacked markers that then have to be deleted one by
 * one. Half a frame is below the resolution the timeline can even distinguish,
 * so nothing an operator could deliberately place is refused.
 */
export function addMarker(project: EditorProject, t: number, fps = project.settings?.fps ?? DEFAULT_FPS): EditorProject {
  const at = Math.max(0, t)
  const existing = project.markers ?? []
  const halfFrame = 0.5 / (fps > 0 ? fps : DEFAULT_FPS)
  if (existing.some(m => Math.abs(m.t - at) < halfFrame)) return project
  const next = [...existing, { id: markerId(), t: at, label: nextMarkerLabel(existing) }].sort(byTime)
  return { ...project, markers: next }
}

/** Retime a marker. Same reference for an unknown id or an unchanged time. */
export function moveMarker(project: EditorProject, id: string, t: number): EditorProject {
  const existing = project.markers
  if (!existing) return project
  const at = Math.max(0, t)
  const found = existing.find(m => m.id === id)
  if (!found || found.t === at) return project
  return withMarkers(project, existing.map(m => (m.id === id ? { ...m, t: at } : m)).sort(byTime))
}

/**
 * Rename a marker. The label is trimmed, and an all-whitespace one is refused
 * rather than committed — a blank marker draws as an empty box and tells the
 * agent nothing, so a cleared rename box means "leave it alone", not "erase the
 * name". Deleting the marker is the way to get rid of it.
 */
export function renameMarker(project: EditorProject, id: string, label: string): EditorProject {
  const existing = project.markers
  if (!existing) return project
  const next = label.trim()
  if (!next) return project
  const found = existing.find(m => m.id === id)
  if (!found || found.label === next) return project
  return withMarkers(project, existing.map(m => (m.id === id ? { ...m, label: next } : m)))
}

/** Remove every marker whose id is in `ids`. Same reference when none matched. */
export function removeMarkers(project: EditorProject, ids: ReadonlySet<string>): EditorProject {
  const existing = project.markers
  if (!existing || existing.length === 0) return project
  const kept = existing.filter(m => !ids.has(m.id))
  if (kept.length === existing.length) return project
  return withMarkers(project, kept)
}
