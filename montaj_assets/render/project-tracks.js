// render/project-tracks.js
/**
 * Both-shapes tolerance for `project.tracks`.
 *
 * A project's `tracks` is on disk in one of two shapes. The legacy shape is a
 * bare array of arrays:
 *
 *     "tracks": [[item, item], [item]]
 *
 * The object shape gives each track somewhere to hang properties that belong to
 * the TRACK rather than to a clip:
 *
 *     "tracks": [
 *       { "id": "trk-0", "items": [item, item] },
 *       { "id": "trk-1", "items": [item], "volume": 0.8, "muted": false }
 *     ]
 *
 * `volume` / `muted` / `enabled` are optional and ABSENT by default, so a
 * normalized project behaves identically to the legacy one it came from. Track
 * order is unchanged and still meaningful (`tracks[0]` is the primary footage
 * track; higher indices render on top).
 *
 * The house rule is read-tolerant everywhere, write-normalized on open: readers
 * call `trackItems()` and never care which shape is on disk; whoever opens the
 * project calls `normalizeTracks()` and persists the result.
 *
 * `normalizeTracks` returns the very same object when the project is already
 * normalized, which is how the lazy on-open migration decides whether it needs
 * to write to disk at all — a converged project must trigger no write.
 *
 * Mirrored, semantics for semantics, by `lib/project_tracks.py` and by
 * `normalizeTracks`/`trackItems` in
 * `montaj_assets/editor/src/video/timeline/timeline-model.ts`. Change one,
 * change all three — a legacy project normalized by any of them must produce
 * the same ids and the same structure.
 */

/** Plain object (not an array, not null) — the shape a track dict arrives as. */
const isTrackObject = v => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A usable id: a non-empty string. */
const isId = v => typeof v === 'string' && v.length > 0

/**
 * True when `tracks` needs no work: every element is an object carrying a
 * non-empty string `id` and an array `items`, and no two share an id.
 */
function isObjectForm(tracks) {
  const seen = new Set()
  for (const track of tracks) {
    if (!isTrackObject(track)) return false
    if (!isId(track.id)) return false
    if (!Array.isArray(track.items)) return false
    if (seen.has(track.id)) return false
    seen.add(track.id)
  }
  return true
}

/**
 * Generate an id for the track at `index`, avoiding every id in `taken`. The
 * rule: `trk-<index>`; if that is already taken, append an incrementing counter
 * starting at 2 — `trk-<index>-2`, `trk-<index>-3`, … — until one is free.
 * Deterministic and collision-free. `taken` is updated in place with the id
 * handed out.
 */
function assignId(index, taken) {
  let candidate = `trk-${index}`
  let suffix = 2
  while (taken.has(candidate)) {
    candidate = `trk-${index}-${suffix}`
    suffix += 1
  }
  taken.add(candidate)
  return candidate
}

/**
 * Return `project` with `tracks` in object form. Accepts either shape.
 *
 * Pure — never mutates the input, at any depth. New track objects and new item
 * ARRAYS are built; the item objects themselves are carried over by reference.
 *
 * Idempotent, and identity-preserving: when `tracks` is already in object form
 * the input object itself is returned, so `normalizeTracks(p) === p`. Same for
 * a project with no `tracks`, a `tracks` of `null`, or a `tracks` that is not
 * an array — validation is someone else's job and normalization never throws.
 *
 * Per element of `tracks`:
 *   - an array  → `{ id: <generated>, items: <copy> }`
 *   - an object → preserved, with every other key (`volume`, `muted`,
 *     `enabled`, anything unknown) carried through untouched; `items` coerced
 *     to an array (missing / null / non-array → `[]`); `id` filled in when
 *     missing, not a string, empty, or a duplicate of an earlier track's id.
 *   - anything else (null, a string, a number) → `{ id: <generated>, items: [] }`
 *
 * @param {object} project
 * @returns {object}
 */
export function normalizeTracks(project) {
  if (!isTrackObject(project)) return project
  const tracks = project.tracks
  if (!Array.isArray(tracks)) return project
  if (isObjectForm(tracks)) return project

  // Every explicit id in the project, collected up front so a generated
  // `trk-<i>` can never land on an id a LATER track already claims.
  const taken = new Set()
  for (const track of tracks) {
    if (isTrackObject(track) && isId(track.id)) taken.add(track.id)
  }

  const kept = new Set()  // ids handed out so far, so a duplicate loses to the first holder
  const out = tracks.map((track, index) => {
    let normalized
    if (Array.isArray(track)) {
      normalized = { id: assignId(index, taken), items: [...track] }
    } else if (isTrackObject(track)) {
      const items = Array.isArray(track.items) ? [...track.items] : []
      const id = isId(track.id) && !kept.has(track.id) ? track.id : assignId(index, taken)
      normalized = { ...track, id, items }
    } else {
      normalized = { id: assignId(index, taken), items: [] }
    }
    kept.add(normalized.id)
    return normalized
  })

  return { ...project, tracks: out }
}

/**
 * Just the items, in track order — for the many callers that only read.
 * `[]` when the project has no tracks (or a `tracks` too malformed to
 * normalize). The returned arrays are the normalized project's own item
 * arrays; treat them as read-only.
 *
 * @param {object} project
 * @returns {Array<Array<object>>}
 */
export function trackItems(project) {
  const tracks = isTrackObject(project) ? normalizeTracks(project).tracks : null
  if (!Array.isArray(tracks)) return []
  return tracks.map(track => track.items)
}

/**
 * The items of ENABLED tracks only, in track order — for the surfaces that
 * PRODUCE picture and sound.
 *
 * The counterpart to `trackItems`. Editing surfaces keep seeing a skipped
 * track; playback and export do not. `enabled` is absent by default, so
 * `!== false` is the test.
 *
 * A skipped track's slot is EMPTIED, not removed — this maps, it does not
 * filter. Every consumer indexes this array positionally (`[0]` is "the base
 * footage track", `.slice(1)` is "the overlay tracks"); filtering would shift
 * every later track's index down and silently reassign it to the wrong role.
 * Emptying preserves position while still contributing nothing to playback or
 * export.
 *
 * Items pass through BY REFERENCE, never copied — `resolveProjectPaths` in
 * render.js and sample-frame.js mutates `item.src` in place through this view,
 * so a defensive copy here would break path resolution with nothing failing.
 *
 * @param {object} project
 * @returns {Array<Array<object>>}
 */
export function enabledTrackItems(project) {
  const tracks = isTrackObject(project) ? normalizeTracks(project).tracks : null
  if (!Array.isArray(tracks)) return []
  return tracks.map(track => (track.enabled !== false ? track.items : []))
}

/**
 * The ENABLED tracks themselves, in track order — the object-shape sibling of
 * `enabledTrackItems`, for callers that need a track's own settings
 * (`volume`, `muted`) alongside its items, not just the items. Exists for the
 * render-time volume/mute fold in `collectAllItems` (render.js), which needs
 * each item's OWN track to compute `effectiveItemAudio(track, item)` —
 * something `enabledTrackItems`'s flattened item-array view has nowhere to
 * carry.
 *
 * Same treatment as `enabledTrackItems`: a skipped track's slot is emptied in
 * place (`items: []`) rather than removed, so index i here is always index i
 * there — the two accessors can never disagree about which tracks are "in".
 *
 * @param {object} project
 * @returns {Array<object>}
 */
export function enabledTracks(project) {
  const tracks = isTrackObject(project) ? normalizeTracks(project).tracks : null
  if (!Array.isArray(tracks)) return []
  return tracks.map(track => (track.enabled !== false ? track : { ...track, items: [] }))
}

/**
 * `project` with its `tracks` swapped for the bare items view — the adapter for
 * the `@bycrux/timeline-core` boundary.
 *
 * That package is plain JS and its contract (`ResolverProject`,
 * `DurationProject`) still reads `tracks` as an array of item arrays. It takes
 * the WHOLE project, not just the tracks, so a caller can't route it through
 * `trackItems()` the way every in-package reader does. Everything but `tracks`
 * passes through by reference — items stay shared by reference too, which is
 * load-bearing: `resolveProjectPaths` mutates `item.src` in place, and callers
 * that resolve paths before sampling depend on that mutation being visible
 * through the adapted view.
 *
 * @param {object} project
 * @returns {object}
 */
export function withItemTracks(project) {
  return { ...project, tracks: trackItems(project) }
}

/**
 * `withItemTracks`, but showing only the enabled tracks — the timeline-core
 * adapter for playback and export.
 *
 * Both halves are required together. Filtering without the unwrap re-breaks
 * `@bycrux/timeline-core` (it reads `tracks` as bare item arrays and throws
 * `TypeError: object is not iterable` on the object shape); unwrapping without
 * the filter silently ignores skip, so a skipped track keeps rendering. Use
 * this at every project-level timeline-core call on a playback/export path.
 *
 * Mirrors `withEnabledItemTracks` in
 * `montaj_assets/editor/src/video/timeline/timeline-model.ts`.
 *
 * @param {object} project
 * @returns {object}
 */
export function withEnabledItemTracks(project) {
  return { ...project, tracks: enabledTrackItems(project) }
}

/**
 * Fold a track's volume/mute settings into one of its item's effective audio
 * values. Volume **multiplies** — never replaces — so a clip an editor
 * already turned down stays proportionally quieter under a track that's also
 * pulled down; replacing would silently discard that per-clip work. Mute is
 * **either/or** — either the track or the item being muted silences it.
 *
 *     effectiveVolume = (track.volume ?? 1) * (item.volume ?? 1)
 *     effectiveMuted  = track.muted === true || item.muted === true
 *
 * Pure, and tolerant of absent fields on either argument — `track`/`item` may
 * each be `undefined`/`null`/`{}`. That is the common case: nothing writes
 * `track.volume`/`track.muted` by default, so most calls see an absent track
 * side and the result reduces to the item's own settings, unchanged.
 *
 * Mirrored by `effectiveItemAudio` in
 * `montaj_assets/editor/src/video/timeline/timeline-model.ts` — the two must
 * agree or preview and render will disagree on how loud a clip actually is.
 *
 * @param {{volume?: number, muted?: boolean} | null | undefined} track
 * @param {{volume?: number, muted?: boolean} | null | undefined} item
 * @returns {{volume: number, muted: boolean}}
 */
export function effectiveItemAudio(track, item) {
  const volume = (track?.volume ?? 1) * (item?.volume ?? 1)
  const muted = track?.muted === true || item?.muted === true
  return { volume, muted }
}
