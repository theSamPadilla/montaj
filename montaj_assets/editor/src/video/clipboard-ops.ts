// Clipboard pure ops: copy / paste / duplicate / paste-attributes over the
// SAME project shape `video/cuts.ts` transforms — visual items
// (`project.tracks[*].items`) and audio tracks (`project.audio.tracks`).
//
// SCOPE: visual items + audio tracks only. Caption segments are deliberately
// EXCLUDED from every op below — they carry word timings and have their own
// editing surface (the caption list / row UI), so duplicating or pasting one
// over the timeline is not a real workflow. A caption id passed in
// `selectedIds` is a no-op for that id: it never matches a visual item or an
// audio track, so it's skipped by construction rather than by an explicit
// check.
//
// CONVENTIONS (mirrors video/cuts.ts):
//   • Every op returns the SAME project reference when it would change
//     nothing — an empty/missing selection or clipboard, or a selection that
//     names no real visual item/audio track (captions only, stale ids).
//   • `mapTrackItems`/`normalizeTracks` (timeline/timeline-model.ts) are the
//     only way this module reads or rebuilds `project.tracks`, so both the
//     legacy array-of-arrays shape and the current `VisualTrack[]` object
//     shape are handled the same way everywhere else in the codebase.
//   • `EPSILON` float slop and the ripple:false "earliest gap that fits"
//     placement below are the SAME tolerance and algorithm `insertClipAt`
//     (cuts.ts) uses, reimplemented here over full copied/duplicated items
//     rather than a single new-clip descriptor — see `pasteAt`'s doc comment
//     for why this does not route through `insertClipAt` itself.
//   • `newClipId()` (cuts.ts) mints every fresh id below; its double-random
//     draw design makes minting several ids in one tick safe.

import type { Project } from '../types'
import type { VisualItem, AudioTrack, VisualTrack } from '../schema'
import { mapTrackItems, normalizeTracks, updateAudioTrack } from './timeline/timeline-model'
import { newClipId } from './cuts'

/**
 * Whether two audio tracks share a rendered LANE, per `groupAudioLanes`
 * (timeline/timeline-model.ts) — audio tracks are PARALLEL rows, not one
 * shared timeline, so only same-lane tracks can ever collide.
 *
 * `groupAudioLanes` assigns every lane-less track a lane strictly above the
 * highest EXPLICIT lane in the whole array (a first pass finds that max, a
 * second pass hands out `nextAutoLane++` to each lane-less track in order).
 * Two consequences that make the direct comparison below exactly equivalent
 * to running the real algorithm, without needing this module to carry a
 * `contentDuration` to call it:
 *   - a lane-less track's auto-assigned lane is never shared with anything
 *     else, regardless of how many other lane-less tracks exist or their
 *     array order — so `lane == null` means "my own lane" unconditionally;
 *   - two EXPLICIT lanes collide iff their numbers are equal, which is just
 *     `===`.
 * So "same lane" reduces to: both tracks declare a lane, and it's the same
 * number.
 */
function sameAudioLane(a: AudioTrack, b: AudioTrack): boolean {
  return a.lane != null && a.lane === b.lane
}

/** Float slop for overlap/adjacency checks — mirrors the tolerance `cuts.ts`
 *  uses for the same purpose. */
const EPSILON = 0.001

// ── Clipboard payload ───────────────────────────────────────────────────────

/** A deep-cloned VisualItem snapshot plus the id of the track it was copied
 *  FROM, so `pasteAt` can try to land it back on that same track. */
export interface ClipboardVisualEntry {
  item: VisualItem
  sourceTrackId: string
}

/** Everything a copy captured. Both arrays may be non-empty at once (a mixed
 *  clip+audio selection); `copySelection` returns `null` instead of an
 *  all-empty payload so callers can no-op on a single falsy check. */
export interface ClipboardPayload {
  items: ClipboardVisualEntry[]
  audioTracks: AudioTrack[]
}

/**
 * Snapshot every selected visual item and audio track into a clipboard
 * payload. Each snapshot is a DEEP clone (`structuredClone`) — mutating the
 * project afterward can never reach back into a copied payload.
 *
 * Caption segment ids in `selectedIds` are ignored (see the module header).
 *
 * Returns `null` when nothing in `selectedIds` names a real visual item or
 * audio track — including an empty `selectedIds` — so every caller can
 * no-op on `!payload` rather than checking two empty arrays.
 */
export function copySelection(project: Project, selectedIds: readonly string[]): ClipboardPayload | null {
  const targets = new Set(selectedIds)
  if (targets.size === 0) return null

  const tracks = (normalizeTracks(project).tracks ?? []) as VisualTrack[]
  const items: ClipboardVisualEntry[] = []
  for (const track of tracks) {
    for (const item of track.items) {
      if (targets.has(item.id)) items.push({ item: structuredClone(item), sourceTrackId: track.id })
    }
  }

  const audioTracks = (project.audio?.tracks ?? [])
    .filter(t => targets.has(t.id))
    .map(t => structuredClone(t))

  if (items.length === 0 && audioTracks.length === 0) return null
  return { items, audioTracks }
}

// ── Local placement (verbatim clone + ripple:false gap resolution) ─────────

/** Earliest `start >= desiredStart` whose `[start, start+duration)` window
 *  doesn't overlap anything in `existing` — the same ripple:false placement
 *  `insertClipAt` (cuts.ts) uses, reimplemented here over full items instead
 *  of a single new-clip descriptor. Candidates are the desired point itself
 *  and the end of every existing item at/after it; the last item's end always
 *  fits, since nothing follows it. */
function earliestFittingGap(
  desiredStart: number,
  duration: number,
  existing: ReadonlyArray<{ start: number; end: number }>,
): number {
  const overlaps = (s: number, e: number) =>
    existing.some(it => Math.min(e, it.end) - Math.max(s, it.start) > EPSILON)
  const candidates = [
    desiredStart,
    ...existing.filter(it => it.end >= desiredStart - EPSILON).map(it => it.end),
  ].sort((a, b) => a - b)
  return candidates.find(s => !overlaps(s, s + duration)) ?? desiredStart
}

/**
 * Paste a clipboard payload onto the timeline at `atTime`.
 *
 * Every copied `VisualItem` is cloned VERBATIM — type, `inPoint`/`outPoint`,
 * every look field, the `moveItemAcrossTracks` (timeline-model.ts) precedent
 * of carrying a full item across tracks — and given a fresh `newClipId()`.
 * This deliberately does NOT route through `insertClipAt` (cuts.ts:854-914):
 * that function takes a `NewClipInput` and unconditionally mints a fresh
 * whole-source `type:'video'` item, which would un-trim a trimmed clip and
 * corrupt an image/overlay item's fields. Placement here is local to this
 * module instead.
 *
 * The group's relative layout is preserved across BOTH arrays together: every
 * copied item/track keeps its original offset from the earliest-starting
 * member of the whole payload, and that earliest member lands exactly at
 * `atTime` (clamped to `>= 0`) — a multi-item copy pastes back in the same
 * shape it was copied in, just moved as one rigid group.
 *
 * Each visual item lands back on its source track when that track id still
 * exists in `project`; otherwise it falls back to track 0. If the target span
 * collides with what's already on that track (including items already placed
 * earlier in this same paste), the item shifts right to the earliest gap that
 * fits (`earliestFittingGap` above).
 *
 * Audio tracks clone the full `AudioTrack` object the same verbatim way, with
 * `start`/`end` shifted by the same delta and appended to
 * `project.audio.tracks`, gap-resolved the same way against the existing
 * tracks plus anything already pasted IN THE SAME LANE (`sameAudioLane`) —
 * audio lanes are parallel rows, so a track in a different lane (e.g. a
 * voiceover pasted under a much longer music bed) never affects placement.
 *
 * Returns the same project reference when the payload is `null` or captured
 * nothing.
 */
export function pasteAt<P extends Project>(project: P, payload: ClipboardPayload | null, atTime: number): P {
  if (!payload || (payload.items.length === 0 && payload.audioTracks.length === 0)) return project

  const tracks = (normalizeTracks(project).tracks ?? []) as VisualTrack[]

  const earliest = Math.min(
    ...payload.items.map(e => e.item.start),
    ...payload.audioTracks.map(t => t.start),
  )
  const delta = Math.max(0, atTime) - earliest

  const byTrackId = new Map<string, VisualItem[]>(tracks.map(t => [t.id, t.items]))
  const fallbackTrackId = tracks[0]?.id

  for (const entry of payload.items) {
    const targetId = byTrackId.has(entry.sourceTrackId) ? entry.sourceTrackId : fallbackTrackId
    if (targetId === undefined) continue   // no track anywhere in the project to land on
    const existing = byTrackId.get(targetId)!
    const duration = entry.item.end - entry.item.start
    const start = earliestFittingGap(entry.item.start + delta, duration, existing)
    const pasted: VisualItem = { ...entry.item, id: newClipId(), start, end: start + duration }
    byTrackId.set(targetId, [...existing, pasted].sort((a, b) => a.start - b.start))
  }

  const newTracks = mapTrackItems(project, (items, i) => byTrackId.get(tracks[i].id) ?? items)

  let audioTracks = project.audio?.tracks ?? []
  for (const track of payload.audioTracks) {
    const duration = track.end - track.start
    // Gap-resolve against SAME-LANE tracks only — see `sameAudioLane` — so a
    // longer clip in a different lane (e.g. a music bed under a voiceover)
    // never shoves this paste past where it actually collides.
    const laneMates = audioTracks.filter(t => sameAudioLane(t, track))
    const start = earliestFittingGap(track.start + delta, duration, laneMates)
    audioTracks = [...audioTracks, { ...track, id: newClipId(), start, end: start + duration }]
  }

  // Only attach `audio` when there's a reason to: the project already had one
  // (preserve it, even if this paste added nothing to it), or this paste
  // actually added audio tracks. Otherwise leave `project.audio` exactly as
  // it was (`undefined` on an audio-less project) — a visual-only paste must
  // not materialize an empty `audio: { tracks: [] }` and its undo/save entry.
  const audio = project.audio
    ? { ...project.audio, tracks: audioTracks }
    : payload.audioTracks.length > 0
      ? { tracks: audioTracks }
      : project.audio

  return { ...project, tracks: newTracks, audio }
}

/**
 * Duplicate every selected visual item and audio track in place: each
 * verbatim copy (fresh `newClipId()`, every field otherwise untouched) lands
 * immediately after its original — at the original's own `end` — resolving
 * any collision with `earliestFittingGap`, the same placement `pasteAt` uses.
 *
 * Selected items are duplicated in (track, start) order, one at a time, so a
 * run of adjacent selected clips stacks its duplicates deterministically
 * against each other instead of depending on `selectedIds`' incoming order.
 *
 * Caption segment ids in `selectedIds` are ignored (see the module header).
 *
 * Returns the same project reference when nothing in `selectedIds` names a
 * real visual item or audio track.
 */
export function duplicateSelection<P extends Project>(project: P, selectedIds: readonly string[]): P {
  const targets = new Set(selectedIds)
  if (targets.size === 0) return project

  const tracks = (normalizeTracks(project).tracks ?? []) as VisualTrack[]
  const byTrackId = new Map<string, VisualItem[]>(tracks.map(t => [t.id, t.items]))
  let changed = false

  for (const track of tracks) {
    const selected = track.items.filter(it => targets.has(it.id)).sort((a, b) => a.start - b.start)
    for (const item of selected) {
      const existing = byTrackId.get(track.id)!
      const duration = item.end - item.start
      const start = earliestFittingGap(item.end, duration, existing)
      const dup: VisualItem = { ...item, id: newClipId(), start, end: start + duration }
      byTrackId.set(track.id, [...existing, dup].sort((a, b) => a.start - b.start))
      changed = true
    }
  }

  const newTracks = mapTrackItems(project, (items, i) => byTrackId.get(tracks[i].id) ?? items)

  const existingAudio = project.audio?.tracks ?? []
  const selectedAudio = existingAudio.filter(t => targets.has(t.id)).sort((a, b) => a.start - b.start)
  let audioTracks = existingAudio
  for (const track of selectedAudio) {
    const duration = track.end - track.start
    // Same-lane scoping — see `sameAudioLane` and its use in `pasteAt` above.
    const laneMates = audioTracks.filter(t => sameAudioLane(t, track))
    const start = earliestFittingGap(track.end, duration, laneMates)
    audioTracks = [...audioTracks, { ...track, id: newClipId(), start, end: start + duration }]
    changed = true
  }

  if (!changed) return project
  return {
    ...project,
    tracks: newTracks,
    audio: project.audio ? { ...project.audio, tracks: audioTracks } : project.audio,
  }
}

// ── Paste attributes (look fields only, type-gated) ─────────────────────────

/**
 * The transferable visual "look" fields, gated on the TARGET item's type —
 * decision 3 of the clipboard-ops spec. `sourceCrop` is deliberately EXCLUDED:
 * it's a source-geometry field (0–1 fractions against THAT source), not a
 * look, so it never belongs in this patch regardless of target type.
 */
function visualAttributesPatch(source: VisualItem, targetType: VisualItem['type']): Partial<VisualItem> {
  return {
    ...(source.offsetX !== undefined ? { offsetX: source.offsetX } : {}),
    ...(source.offsetY !== undefined ? { offsetY: source.offsetY } : {}),
    ...(source.scale !== undefined ? { scale: source.scale } : {}),
    ...(source.opacity !== undefined ? { opacity: source.opacity } : {}),
    ...(source.rotation !== undefined ? { rotation: source.rotation } : {}),
    ...(targetType === 'image' && source.fit !== undefined ? { fit: source.fit } : {}),
    ...(targetType === 'video' && source.volume !== undefined ? { volume: source.volume } : {}),
    ...(targetType === 'video' && source.muted !== undefined ? { muted: source.muted } : {}),
    ...(targetType === 'video' && source.speed !== undefined ? { speed: source.speed } : {}),
  }
}

/** The transferable audio "look" fields — decision 3's audio→audio set. */
function audioAttributesPatch(source: AudioTrack): Partial<AudioTrack> {
  return {
    ...(source.volume !== undefined ? { volume: source.volume } : {}),
    ...(source.muted !== undefined ? { muted: source.muted } : {}),
    ...(source.ducking !== undefined ? { ducking: source.ducking } : {}),
    ...(source.fadeIn !== undefined ? { fadeIn: source.fadeIn } : {}),
    ...(source.fadeOut !== undefined ? { fadeOut: source.fadeOut } : {}),
  }
}

/**
 * Copy "look" attributes from the clipboard's FIRST copied visual item (for
 * selected visual items) and FIRST copied audio track (for selected audio
 * tracks) onto every id in `selectedIds`, type-gated per `visualAttributesPatch`
 * / `audioAttributesPatch` above. A selected item never receives fields from
 * the wrong source kind (e.g. a selected audio track never reads
 * `payload.items[0]`) and never receives a field its own type doesn't carry
 * (e.g. `fit` never lands on a video item).
 *
 * Caption segment ids in `selectedIds` are ignored (see the module header).
 *
 * Returns the same project reference when `selectedIds` is empty, the
 * payload is `null`, the payload has neither a visual item nor an audio track
 * to source from, or applying the gated patch would change nothing (e.g. the
 * only selected items are captions, or the source's fields don't survive type
 * gating for any selected target).
 */
export function pasteAttributes<P extends Project>(
  project: P,
  payload: ClipboardPayload | null,
  selectedIds: readonly string[],
): P {
  const targets = new Set(selectedIds)
  if (targets.size === 0 || !payload) return project

  const sourceVisual = payload.items[0]?.item
  const sourceAudio = payload.audioTracks[0]
  if (!sourceVisual && !sourceAudio) return project

  let changed = false
  let next = project

  if (sourceVisual) {
    const patchCache = new Map<VisualItem['type'], Partial<VisualItem>>()
    const patchFor = (type: VisualItem['type']) => {
      let patch = patchCache.get(type)
      if (!patch) {
        patch = visualAttributesPatch(sourceVisual, type)
        patchCache.set(type, patch)
      }
      return patch
    }

    let visualChanged = false
    const newTracks = mapTrackItems(next, items =>
      items.map(item => {
        if (!targets.has(item.id)) return item
        const patch = patchFor(item.type)
        if (Object.keys(patch).length === 0) return item
        visualChanged = true
        return { ...item, ...patch }
      }),
    )
    if (visualChanged) {
      next = { ...next, tracks: newTracks }
      changed = true
    }
  }

  if (sourceAudio) {
    const patch = audioAttributesPatch(sourceAudio)
    if (Object.keys(patch).length > 0) {
      for (const track of next.audio?.tracks ?? []) {
        if (!targets.has(track.id)) continue
        next = updateAudioTrack(next, track.id, patch) as P
        changed = true
      }
    }
  }

  return changed ? next : project
}
