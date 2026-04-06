import type { Project, VisualItem, CaptionSegment, Word } from './project'

/** A time range to excise from the timeline. */
export interface Cut {
  start: number
  end: number
}

// ── ID generation ───────────────────────────────────────────────────────────

function uniqueId(base: string): string {
  return `${base}_split_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

// ── Single base-clip helpers ────────────────────────────────────────────────

function trimClipEnd(item: VisualItem, at: number): VisualItem {
  const trimmedDur = at - item.start
  return {
    ...item,
    end: at,
    ...(item.outPoint !== undefined ? { outPoint: (item.inPoint ?? 0) + trimmedDur } : {}),
  }
}

function trimClipStart(item: VisualItem, at: number): VisualItem {
  // Lift-style: clip start advances to the cut end; inPoint advances by the same amount.
  // The resulting gap before the clip's new start position is intentional.
  const sourceOffset = at - item.start
  return {
    ...item,
    start: at,
    ...(item.inPoint !== undefined ? { inPoint: (item.inPoint ?? 0) + sourceOffset } : {}),
  }
}

function splitClip(item: VisualItem, cut: Cut): [VisualItem, VisualItem] {
  const leftDur = cut.start - item.start
  const rightSourceOffset = cut.end - item.start

  const left: VisualItem = {
    ...item,
    end: cut.start,
    ...(item.outPoint !== undefined ? { outPoint: (item.inPoint ?? 0) + leftDur } : {}),
  }
  const right: VisualItem = {
    ...item,
    id: uniqueId(item.id),
    start: cut.end,  // lift: right fragment stays at its original timeline position
    ...(item.inPoint !== undefined ? { inPoint: (item.inPoint ?? 0) + rightSourceOffset } : {}),
  }
  return [left, right]
}

function applyCutToBaseClip(item: VisualItem, cut: Cut): VisualItem[] {
  const { start: A, end: B } = cut

  if (item.end <= A) return [item]               // fully before — unchanged
  if (item.start >= B) return [item]             // fully after — unchanged (lift, no shift)
  if (item.start >= A && item.end <= B) return [] // fully within — deleted

  if (item.start < A && item.end <= B) return [trimClipEnd(item, A)]   // overlaps left
  if (item.start >= A && item.start < B) return [trimClipStart(item, B)] // overlaps right
  return splitClip(item, cut)                                             // spans
}

// ── Caption helpers (captions shift — they're anchored to audio timing) ────

function applyCutToWords(words: Word[], cut: Cut): Word[] {
  const cutDur = cut.end - cut.start
  return words
    .filter(w => !(w.start >= cut.start && w.end <= cut.end))
    .map(w => {
      if (w.end <= cut.start) return w
      if (w.start >= cut.end) return { ...w, start: w.start - cutDur, end: w.end - cutDur }
      if (w.start < cut.start) return { ...w, end: cut.start }
      return { ...w, start: cut.start, end: w.end - cutDur }
    })
    .filter(w => w.end > w.start)
}

function applyCutToCaptions(segments: CaptionSegment[], cut: Cut): CaptionSegment[] {
  const cutDur = cut.end - cut.start
  const result: CaptionSegment[] = []

  for (const seg of segments) {
    if (seg.end <= cut.start) { result.push(seg); continue }
    if (seg.start >= cut.end) {
      result.push({
        ...seg,
        start: seg.start - cutDur,
        end: seg.end - cutDur,
        words: seg.words?.map(w => ({ ...w, start: w.start - cutDur, end: w.end - cutDur })),
      })
      continue
    }
    if (seg.start >= cut.start && seg.end <= cut.end) continue  // deleted

    // Partial overlap or spanning: trim to the kept portion
    const newStart = seg.start < cut.start ? seg.start : cut.start
    const newEnd   = seg.end > cut.end ? seg.end - cutDur : cut.start
    if (newEnd <= newStart) continue
    result.push({
      ...seg,
      start: newStart,
      end: newEnd,
      words: seg.words ? applyCutToWords(seg.words, cut).filter(w => w.end > w.start) : undefined,
    })
  }
  return result
}

// ── Per-item collapse cut ────────────────────────────────────────────────────

/**
 * Collapse a single item around a cut.
 * `cut` must already be clamped to [item.start, item.end].
 * Right fragment starts at cut.start (item shrinks; gap appears at item tail).
 */
function cutSingleItem(item: VisualItem, cut: Cut): VisualItem[] {
  const inPoint  = item.inPoint  ?? 0
  const outPoint = item.outPoint ?? (inPoint + (item.end - item.start))

  const physStart = inPoint + (cut.start - item.start)
  const physEnd   = inPoint + (cut.end   - item.start)

  const result: VisualItem[] = []

  if (physStart > inPoint) {
    result.push({
      ...item,
      end: cut.start,
      ...(item.outPoint !== undefined ? { outPoint: physStart } : {}),
    })
  }
  if (outPoint - physEnd > 0.001) {
    result.push({
      ...item,
      id: uniqueId(item.id),
      start: cut.start,
      end: cut.start + (outPoint - physEnd),
      ...(item.inPoint !== undefined ? { inPoint: physEnd } : {}),
    })
  }

  return result
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Apply a lift-style cut to a project.
 *
 * Only tracks[0] (primary clips) and captions are mutated.
 * tracks[1+] overlay items are passed through unchanged — their start/end are
 * absolute and they intentionally sit over any gap left in the primary track.
 *
 * Returns a new Project — no re-encoding, pure JSON.
 */
export function applyCutToTracks(project: Project, cut: Cut): Project {
  if (cut.end <= cut.start) return project

  const [primaryTrack = [], ...overlayTracks] = project.tracks ?? []
  const newPrimaryTrack = primaryTrack.flatMap(item => applyCutToBaseClip(item, cut))

  const newCaptions = project.captions
    ? { ...project.captions, segments: applyCutToCaptions(project.captions.segments, cut) }
    : project.captions

  return { ...project, tracks: [newPrimaryTrack, ...overlayTracks], captions: newCaptions }
}

/**
 * Apply a collapse-style cut to a single item identified by `itemId`.
 *
 * - If the item is in `tracks[0]`, captions are adjusted for the clamped cut,
 *   but only for segments within [item.start, item.end] — other clips' captions
 *   are left untouched.
 * - If the item is in an overlay track, captions are not touched.
 * - If `itemId` is not found, the project is returned unchanged.
 *
 * Returns a new Project — no re-encoding, pure JSON.
 */
export function applyCutToItem(project: Project, itemId: string, cut: Cut): Project {
  if (cut.end <= cut.start) return project

  const [primaryTrack = [], ...overlayTracks] = project.tracks ?? []

  // ── Primary track ──
  const primaryIdx = primaryTrack.findIndex(item => item.id === itemId)
  if (primaryIdx !== -1) {
    const item     = primaryTrack[primaryIdx]
    const cutStart = Math.max(cut.start, item.start)
    const cutEnd   = Math.min(cut.end,   item.end)
    if (cutEnd <= cutStart) return project

    const clamped = { start: cutStart, end: cutEnd }
    const newPrimary = [
      ...primaryTrack.slice(0, primaryIdx),
      ...cutSingleItem(item, clamped),
      ...primaryTrack.slice(primaryIdx + 1),
    ]
    // Only adjust captions within this clip's timeline window [item.start, item.end].
    // Captions belonging to other clips must not be shifted — applyCutToCaptions shifts
    // everything after cutEnd, which would misalign adjacent clips.
    let newCaptions = project.captions
    if (newCaptions) {
      const inner = newCaptions.segments.filter(s => s.end > item.start && s.start < item.end)
      const outer = newCaptions.segments.filter(s => !(s.end > item.start && s.start < item.end))
      const adjusted = applyCutToCaptions(inner, clamped)
      const merged = [...adjusted, ...outer].sort((a, b) => a.start - b.start)
      newCaptions = { ...newCaptions, segments: merged }
    }

    return { ...project, tracks: [newPrimary, ...overlayTracks], captions: newCaptions }
  }

  // ── Overlay tracks ──
  for (let ti = 0; ti < overlayTracks.length; ti++) {
    const track   = overlayTracks[ti]
    const itemIdx = track.findIndex(item => item.id === itemId)
    if (itemIdx === -1) continue

    const item     = track[itemIdx]
    const cutStart = Math.max(cut.start, item.start)
    const cutEnd   = Math.min(cut.end,   item.end)
    if (cutEnd <= cutStart) return project

    const clamped    = { start: cutStart, end: cutEnd }
    const newTrack   = [
      ...track.slice(0, itemIdx),
      ...cutSingleItem(item, clamped),
      ...track.slice(itemIdx + 1),
    ]
    const newOverlays = overlayTracks.map((t, i) => (i === ti ? newTrack : t))
    return { ...project, tracks: [primaryTrack, ...newOverlays] }
  }

  return project  // itemId not found
}
