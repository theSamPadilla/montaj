import type { Project } from '../types'
import type { VisualItem, AudioTrack, CaptionSegment, Word, VisualTrack, KeyframeTrack, Marker, Note } from '../schema'
import { mapTrackItems, trackItems, normalizeTracks } from './timeline/timeline-model'
import { isNote } from './timeline/notes'
import { normalizeTrack, sampleTrackValue } from './keyframeTrack'
import { canKeyframe } from './keyframeOps'
import { isScene3dItem, scene3dInPoint, shiftScene3dInPoint } from './scene3d'

/** A time range to excise from the timeline. */
export interface Cut {
  start: number
  end: number
}

/** Shortest a clip may be left by a trim op. Mirrors the timeline drag clamp in
 *  `timeline/multiSelectOps.ts`, which owns the same constant module-privately. */
const MIN_DURATION = 0.1

/** Float slop for adjacency and no-op checks — matches the tolerance already
 *  used when deciding whether a collapse fragment is worth keeping. */
const EPSILON = 0.001

// ── ID generation ───────────────────────────────────────────────────────────

function uniqueId(base: string): string {
  return `${base}_split_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

// ── Single base-clip helpers ────────────────────────────────────────────────

function trimClipEnd(item: VisualItem, at: number): VisualItem {
  // A timeline delta maps to a SOURCE delta of `·S` (montaj/speed); `·1` is exact
  // so a clip at S=1/absent is byte-identical to the pre-speed op.
  const s = item.speed ?? 1
  const trimmedDur = at - item.start
  const out: VisualItem = {
    ...item,
    end: at,
    ...(item.outPoint !== undefined ? { outPoint: (item.inPoint ?? 0) + trimmedDur * s } : {}),
  }
  if (canKeyframe(item) && item.keyframes && item.keyframes.length > 0) {
    const { left } = splitKeyframeTracks(item, { start: at, end: item.end })
    if (left) out.keyframes = left
    else delete out.keyframes
  }
  return out
}

function trimClipStart(item: VisualItem, at: number): VisualItem {
  // Lift-style: clip start advances to the cut end; inPoint advances by the same
  // timeline distance converted to SOURCE seconds (`·S`, montaj/speed).
  // The resulting gap before the clip's new start position is intentional.
  const sourceOffset = (at - item.start) * (item.speed ?? 1)
  // A 3D item's in point advances the same way (scene3d.ts).
  const out = shiftScene3dInPoint({
    ...item,
    start: at,
    ...(item.inPoint !== undefined ? { inPoint: (item.inPoint ?? 0) + sourceOffset } : {}),
  }, at - item.start)
  if (canKeyframe(item) && item.keyframes && item.keyframes.length > 0) {
    // Keyframe `t` is relative to the item's own start, which just moved.
    const { right } = splitKeyframeTracks(item, { start: item.start, end: at })
    if (right) out.keyframes = right
    else delete out.keyframes
  }
  return out
}

/**
 * A new edge (split/trim) that falls strictly BETWEEN two keys of a track
 * needs a key of its own, else the half that keeps only one neighbour holds
 * flat and loses the ramp through the edge. The value is `sampleTrack`'s, so
 * the track's own easing (and `hold` step semantics) decide it; the key
 * carries the easing of the segment it lands in. Returns [] when the edge sits
 * on a key, before the first or after the last (clamped as before).
 */
function edgeKey(track: KeyframeTrack, t: number): KeyframeTrack['points'] {
  const pts = track.points
  if (pts.length < 2) return []
  if (!(t > pts[0].t && t < pts[pts.length - 1].t)) return []
  if (pts.some(p => p.t === t)) return []
  const value = sampleTrackValue(track, t)
  if (value === undefined) return []
  let prev = pts[0]
  for (const p of pts) { if (p.t < t) prev = p }
  return [{ t, value, ...(prev.easing !== undefined ? { easing: prev.easing } : {}) }]
}

/**
 * Split `item.keyframes` (overlay-only; see schema.ts) into the two tracks
 * each fragment of a cut should carry. Shared by BOTH `splitClip` (lift: the
 * right fragment stays at `cut.end`, a gap opens where the cut was) and
 * `cutSingleItem` (collapse: the right fragment moves to `cut.start`, no gap)
 * — the two disagree about WHERE the right fragment ends up on the timeline,
 * but that disagreement never reaches this function. `t` is item-relative
 * TIMELINE seconds (docs/schemas/project.md), unrelated to `speed`'s source
 * scaling — unlike `outPoint`/`inPoint` elsewhere in this file, keyframe
 * times need no `·s` conversion, and this function never reads `item.speed`.
 *
 * Left keeps every point at or before the cut (its own new span is
 * `[item.start, cut.start)`, so `t` is unchanged — the left fragment's start
 * didn't move, in EITHER caller). Right keeps every point at or after the cut
 * and RE-ANCHORS it by subtracting `cut.end − item.start`, so `t` stays
 * relative to the right fragment's own new `start` — wherever that new
 * `start` physically lands, the point is still "this far past the cut" in
 * the ORIGINAL animation curve, which is the one thing both callers need.
 * (For `splitClip` specifically, where the right fragment's new `start` IS
 * `cut.end`, this re-anchoring also happens to preserve the original
 * ABSOLUTE wall-clock instant — a stronger property that only holds for a
 * lift, not a collapse, but follows for free from the same subtraction.) A
 * point exactly at a zero-width split (`splitAtTime`, where `cut.start ===
 * cut.end`) is legitimately kept by BOTH fragments — as the last point of
 * left's curve and the first of right's — so the animation stays continuous
 * across the cut rather than only one side inheriting the boundary value.
 *
 * Each returned track is a fresh array (`normalizeTrack` always allocates),
 * so the two fragments never share a reference with each other or with
 * `item.keyframes` — the bug this exists to fix. Returns `undefined` for a
 * side with no points left, matching `keyframeOps.ts`'s `withTrack`
 * invariant: no lingering empty-`points` track, no lingering empty array.
 */
function splitKeyframeTracks(item: VisualItem, cut: Cut): { left?: KeyframeTrack[]; right?: KeyframeTrack[] } {
  const tracks = item.keyframes
  if (!tracks || tracks.length === 0) return {}

  const leftDur     = cut.start - item.start
  const rightOffset = cut.end   - item.start

  const left = tracks
    .map(track => normalizeTrack({
      ...track,
      points: [...track.points.filter(p => p.t <= leftDur), ...edgeKey(track, leftDur)],
    }))
    .filter((track): track is KeyframeTrack => !!track && track.points.length > 0)
  const right = tracks
    .map(track => normalizeTrack({
      ...track,
      points: [...edgeKey(track, rightOffset), ...track.points.filter(p => p.t >= rightOffset)]
        .map(p => ({ ...p, t: p.t - rightOffset })),
    }))
    .filter((track): track is KeyframeTrack => !!track && track.points.length > 0)

  return {
    left:  left.length  > 0 ? left  : undefined,
    right: right.length > 0 ? right : undefined,
  }
}

function splitClip(item: VisualItem, cut: Cut): [VisualItem, VisualItem] {
  const s = item.speed ?? 1
  const leftDur = cut.start - item.start
  const rightSourceOffset = (cut.end - item.start) * s

  const left: VisualItem = {
    ...item,
    end: cut.start,
    ...(item.outPoint !== undefined ? { outPoint: (item.inPoint ?? 0) + leftDur * s } : {}),
  }
  // A 3D item's right fragment continues its 3D where the cut leaves it
  // (scene3d.ts): its in point advances by the fragment's offset into the item.
  const right: VisualItem = shiftScene3dInPoint({
    ...item,
    id: uniqueId(item.id),
    start: cut.end,  // lift: right fragment stays at its original timeline position
    ...(item.inPoint !== undefined ? { inPoint: (item.inPoint ?? 0) + rightSourceOffset } : {}),
  }, cut.end - item.start)

  // Overlay-only (schema.ts). Every OTHER item type either never carries
  // `keyframes` or has it ignored (docs/schemas/project.md), so this never
  // runs for a video/image clip even if one somehow had a stray array.
  if (canKeyframe(item) && item.keyframes && item.keyframes.length > 0) {
    const { left: leftKf, right: rightKf } = splitKeyframeTracks(item, cut)
    if (leftKf) left.keyframes = leftKf
    else delete left.keyframes
    if (rightKf) right.keyframes = rightKf
    else delete right.keyframes
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

// ── The base footage track ──────────────────────────────────────────────────

/** The base footage track: the first track holding a video item, else track
 *  0. `collapseGaps` closes its gaps; a ripple on it moves everything (§527). */
function baseTrackIndex(tracks: VisualItem[][]): number {
  const i = tracks.findIndex(t => t.some(c => c.type === 'video'))
  return i >= 0 ? i : 0
}

// ── Anchors: audio tracks, notes and markers ride a ripple (§527) ──────────
//
// A ripple moves EVERYTHING after it (Sam, 2026-10-22), not only the visual
// items and the captions:
//   - an audio track whose start is at or after the ripple point moves with
//     it; one that starts before it stays put, as a straddling item does. Audio
//     is only ever MOVED by a ripple, never trimmed or deleted, and keeps its
//     length;
//   - a note or marker inside a ripple-DELETED window (the item `rippleDelete`
//     removes, a lift cut's range) is deleted, and a note range that overlaps
//     one is clipped to its edge;
//   - one in a gap `collapseGaps` closes MOVES to where the gap closes: a gap
//     held no footage, so nothing it marked is gone.
// A point exactly on a window's edge (within EPSILON) is outside it. Slide
// notes (no `t`, carousel projects) never move: a list holding anything
// `isNote` refuses is left alone.

/** A point `t` against a removed window [a, b]: kept before it, moved by
 *  `shift` (the window's length for a ripple, 0 for a lift, which moves
 *  nothing) after it, null inside it. */
function cutPoint(t: number, cut: Cut, shift: number): number | null {
  if (t <= cut.start + EPSILON) return t
  if (t >= cut.end - EPSILON) return t - shift
  return null
}

function cutNote(n: Note, cut: Cut, shift: number): Note | null {
  const { start: a, end: b } = cut
  if (n.tEnd === undefined) {
    const t = cutPoint(n.t, cut, shift)
    return t === null ? null : t === n.t ? n : { ...n, t }
  }
  const e = n.tEnd
  if (e <= a + EPSILON) return n
  if (n.t >= b - EPSILON) return shift ? { ...n, t: n.t - shift, tEnd: e - shift } : n
  if (n.t >= a - EPSILON && e <= b + EPSILON) return null
  // Overlaps an edge: the part inside the window goes, what follows it moves.
  const t = n.t < a ? n.t : b - shift
  const tEnd = e > b ? e - shift : a
  return tEnd - t > EPSILON ? { ...n, t, tEnd } : null
}

const byT = <T extends { t: number }>(x: T, y: T) => x.t - y.t

/** `list` through `each`, null entries dropped, re-sorted by `t`; the same
 *  array when nothing changed, `null` when it emptied (an explicit null, as
 *  the notes and markers models write it: serve shallow-merges a save). */
function remapList<T extends { t: number }>(list: readonly T[], each: (x: T) => T | null): T[] | null | undefined {
  let changed = false
  const out: T[] = []
  for (const x of list) {
    const y = each(x)
    if (y !== x) changed = true
    if (y !== null) out.push(y)
  }
  if (!changed) return undefined
  return out.length === 0 ? null : out.sort(byT)
}

/** The notes and markers of `project` through `noteFn` and `markerFn`: only the
 *  keys that changed, so a project with neither is spread unchanged. */
function remapAnchors<P extends Project>(
  project: P,
  noteFn: (n: Note) => Note | null,
  markerFn: (m: Marker) => Marker | null,
): Partial<Pick<P, 'notes' | 'markers'>> {
  const out: Partial<Pick<Project, 'notes' | 'markers'>> = {}
  const notes = project.notes
  if (Array.isArray(notes) && notes.length > 0 && notes.every(isNote)) {
    const next = remapList(notes as Note[], noteFn)
    if (next !== undefined) out.notes = next
  }
  const markers = project.markers
  if (Array.isArray(markers) && markers.length > 0) {
    const next = remapList(markers, markerFn)
    if (next !== undefined) out.markers = next
  }
  return out as Partial<Pick<P, 'notes' | 'markers'>>
}

/** Notes and markers for a removed window: deleted inside, clipped on an edge,
 *  moved `shift` earlier after it. */
function cutAnchors<P extends Project>(project: P, cut: Cut, shift: number): Partial<Pick<P, 'notes' | 'markers'>> {
  return remapAnchors(
    project,
    n => cutNote(n, cut, shift),
    m => {
      const t = cutPoint(m.t, cut, shift)
      return t === null ? null : t === m.t ? m : { ...m, t }
    },
  )
}

/**
 * Move the notes and markers at or after `from` by `by` seconds (a note range
 * that starts before `from` and ends after it moves its end only). For a
 * ripple that moves the rest itself: `audioPolish`'s lead-gap close shifts its
 * own tracks and audio. The caller keeps every time at or above 0.
 */
export function shiftMarks<P extends Project>(project: P, from: number, by: number): P {
  if (by === 0) return project
  const at = (t: number) => t >= from - EPSILON
  const anchors = remapAnchors(
    project,
    n => {
      if (at(n.t)) return { ...n, t: n.t + by, ...(n.tEnd !== undefined ? { tEnd: n.tEnd + by } : {}) }
      if (n.tEnd === undefined || !at(n.tEnd)) return n
      const tEnd = n.tEnd + by
      if (tEnd - n.t > EPSILON) return { ...n, tEnd }
      const { tEnd: _gone, ...point } = n
      return point
    },
    m => (at(m.t) ? { ...m, t: m.t + by } : m),
  )
  return 'notes' in anchors || 'markers' in anchors ? { ...project, ...anchors } : project
}

/** An audio track's start: absent means 0 (docs/schemas/project.md, Audio). */
const audioStart = (t: AudioTrack): number => (typeof t.start === 'number' && Number.isFinite(t.start) ? t.start : 0)

/** An audio track moved by `d`, its length kept: `start` written, `end` moved
 *  only when it is a number (an end-less track plays to its slice's end). */
function movedAudio(t: AudioTrack, d: number): AudioTrack {
  const out: AudioTrack = { ...t, start: audioStart(t) + d }
  if (typeof t.end === 'number' && Number.isFinite(t.end)) out.end = t.end + d
  return out
}

/** The audio tracks that start at or after `from`, moved by `by`, length kept;
 *  the same object when none moves. */
function rippleAudio(audio: Project['audio'], from: number, by: number): Project['audio'] {
  if (!audio?.tracks?.length || by === 0) return audio
  let changed = false
  const tracks = audio.tracks.map(t => {
    if (!(audioStart(t) >= from - EPSILON)) return t
    changed = true
    return movedAudio(t, by)
  })
  return changed ? { ...audio, tracks } : audio
}

/** Caption segments at or after `from` moved by `by`; a segment straddling
 *  `from` keeps its start, its later words move and its end moves. The same
 *  captions object when none moves. */
function shiftCaptionsAfter(captions: Project['captions'], from: number, by: number): Project['captions'] {
  if (!captions?.segments?.length || by === 0) return captions
  const at = (t: number) => t >= from - EPSILON
  let changed = false
  const segments = captions.segments.map(seg => {
    if (at(seg.start)) {
      changed = true
      return { ...seg, start: seg.start + by, end: seg.end + by, words: seg.words?.map(w => ({ ...w, start: w.start + by, end: w.end + by })) }
    }
    if (!(seg.end > from + EPSILON)) return seg
    changed = true
    return { ...seg, end: seg.end + by, words: seg.words?.map(w => (at(w.start) ? { ...w, start: w.start + by, end: w.end + by } : w)) }
  })
  return changed ? { ...captions, segments } : captions
}

// ── Per-item collapse cut ────────────────────────────────────────────────────

/**
 * Collapse a single item around a cut.
 * `cut` must already be clamped to [item.start, item.end].
 * Right fragment starts at cut.start (item shrinks; gap appears at item tail).
 */
function cutSingleItem(item: VisualItem, cut: Cut): VisualItem[] {
  // Timeline↔source conversions carry the clip's speed S (montaj/speed): a
  // timeline delta is `·S` source-seconds, and a source length is `/S` timeline
  // seconds. `·1`/`/1` are exact, so S=1/absent is byte-identical.
  const s        = item.speed ?? 1
  const inPoint  = item.inPoint  ?? 0
  const outPoint = item.outPoint ?? (inPoint + (item.end - item.start) * s)

  const physStart = inPoint + (cut.start - item.start) * s
  const physEnd   = inPoint + (cut.end   - item.start) * s

  const result: VisualItem[] = []

  // Same overlay-keyframe split `splitClip` performs, for the same reason: a
  // bare `...item` spread would hand BOTH fragments the same `keyframes` array
  // object, and leave the right fragment's points anchored to the ORIGINAL
  // item's start even though its own `start` has moved — so its animation would
  // play at the wrong times, and every point inside the removed range would sit
  // dead in the data.
  //
  // `splitKeyframeTracks` applies unchanged despite this function COLLAPSING
  // the right fragment onto `cut.start` (where `splitClip`'s LIFT leaves it at
  // `cut.end`, unmoved): a keyframe's `t` is relative to its own fragment's
  // `start`, wherever that new `start` physically lands, so the collapse vs.
  // lift distinction cancels out and the re-anchor is `t - (cut.end -
  // item.start)` either way. It also holds at any speed, since `(outPoint -
  // physEnd) / s` reduces to `item.end - cut.end`, exactly the timeline span
  // the re-anchored points cover.
  const keyed = canKeyframe(item) && !!item.keyframes && item.keyframes.length > 0
  const { left: leftKf, right: rightKf } = keyed ? splitKeyframeTracks(item, cut) : {}

  if (physStart > inPoint) {
    const left: VisualItem = {
      ...item,
      end: cut.start,
      ...(item.outPoint !== undefined ? { outPoint: physStart } : {}),
    }
    if (keyed) {
      if (leftKf) left.keyframes = leftKf
      else delete left.keyframes
    }
    result.push(left)
  }
  if (outPoint - physEnd > 0.001) {
    // A 3D item's right fragment picks its 3D up where the removed range
    // ended (scene3d.ts), wherever the collapse puts it.
    const right: VisualItem = shiftScene3dInPoint({
      ...item,
      id: uniqueId(item.id),
      start: cut.start,
      end: cut.start + (outPoint - physEnd) / s,
      ...(item.inPoint !== undefined ? { inPoint: physEnd } : {}),
    }, cut.end - item.start)
    if (keyed) {
      if (rightKf) right.keyframes = rightKf
      else delete right.keyframes
    }
    result.push(right)
  }

  return result
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Apply a lift-style cut to a project.
 *
 * Only tracks[0] (primary clips), captions, notes and markers are mutated.
 * tracks[1+] overlay items are passed through unchanged — their start/end are
 * absolute and they intentionally sit over any gap left in the primary track.
 *
 * §527: a note or marker inside the cut is deleted, and a note range over one
 * of its edges is clipped to it; nothing else moves here. Audio tracks, notes
 * and markers ride the `collapseGaps` that closes the lifted range (`audioPolish`
 * composes the two), so each moves exactly once.
 *
 * Returns a new Project — no re-encoding, pure JSON.
 */
export function applyCutToTracks<P extends Project>(project: P, cut: Cut): P {
  if (cut.end <= cut.start) return project

  const newTracks = mapTrackItems(project, (items, i) =>
    i === 0 ? items.flatMap(item => applyCutToBaseClip(item, cut)) : items,
  )

  const newCaptions = project.captions
    ? { ...project.captions, segments: applyCutToCaptions(project.captions.segments, cut) }
    : project.captions

  return { ...project, tracks: newTracks, captions: newCaptions, ...cutAnchors(project, cut, 0) }
}

/** Options for `collapseGaps`. */
export interface CollapseGapsOptions {
  /** Remap `project.captions` with the same shifts the clips get. Default true
   *  — see the "exactly one caption-mover" note on `collapseGaps`. */
  remapCaptions?: boolean
}

/**
 * Close all gaps between primary clips by shifting each clip left to butt
 * against the previous one. Captions and all other tracks are remapped to
 * follow using the same shifts.
 *
 * §527: audio tracks, notes and markers follow too, through the same time map:
 * a point inside a clip moves with that clip, one in a closed gap to where the
 * gap closes (it is moved, never deleted: a gap held no footage), one past the
 * last clip with the last clip. An audio track moves by where its START lands
 * and keeps its length, so a bed that starts before the first gap stays put.
 * `remapCaptions` governs the captions alone: a lift cut moves none of these.
 *
 * The primary track is the first track containing video clips; falls back to
 * tracks[0] if no video track exists.
 *
 * Returns the same project reference if no gaps exist (safe to call always).
 *
 * EXACTLY ONE CAPTION-MOVER PER COMPOSITION. `applyCutToTracks` ripples captions
 * itself (via `applyCutToCaptions`), and `collapseGaps` remaps them too — so
 * composing those two shifts every caption TWICE. That is why the audio-polish
 * path (`video/audioPolish.ts`) passes `remapCaptions: false`. By contrast
 * `deleteSelection` is tracks-and-audio vocabulary only and never touches
 * `project.captions`, which is why `deleteSelection` + `collapseGaps`
 * (Timeline.tsx's delete keymap) is safe with the default. Naming both the
 * unsafe and the safe composition is what makes this checkable.
 *
 * `remapCaptions` therefore defaults to TRUE — today's behaviour, byte-identical
 * for every call site that passes no options — and is opted OUT of only by a
 * caller that has already moved the captions itself.
 */
export function collapseGaps<P extends Project>(
  project: P,
  { remapCaptions = true }: CollapseGapsOptions = {},
): P {
  const tracks = trackItems(project)

  const effectiveIdx = baseTrackIndex(tracks)

  const primaryTrack = tracks[effectiveIdx] ?? []
  if (primaryTrack.length < 2) return project

  const sorted = [...primaryTrack].sort((a, b) => a.start - b.start)

  let cursor = sorted[0].start
  let anyGap = false
  const shifts: Array<{ oldStart: number; oldEnd: number; delta: number }> = []

  const compacted = sorted.map(clip => {
    const duration = clip.end - clip.start
    const delta = cursor - clip.start
    if (delta !== 0) anyGap = true
    shifts.push({ oldStart: clip.start, oldEnd: clip.end, delta })
    const out = { ...clip, start: cursor, end: cursor + duration }
    cursor += duration
    return out
  })

  if (!anyGap) return project

  function applyShift(start: number, end: number): number {
    const mid = (start + end) / 2
    const entry = shifts.find(s => mid >= s.oldStart && mid < s.oldEnd)
    return entry?.delta ?? 0
  }

  // The collapse as a map of time (§527): before the first clip, unchanged (the
  // lead is not collapsed); inside a clip's old window, that clip's delta; in
  // the gap after clip k, the point it closes to (clip k's new end); past the
  // last clip, the last clip's delta. `shifts` is in old-start order.
  function mapTime(t: number): number {
    let k = -1
    for (let i = 0; i < shifts.length && shifts[i].oldStart <= t + EPSILON; i++) k = i
    if (k < 0) return t
    const s = shifts[k]
    if (t < s.oldEnd - EPSILON || k === shifts.length - 1) return t + s.delta
    return s.oldEnd + s.delta
  }

  const newTracks = mapTrackItems(project, (items, i) => {
    if (i === effectiveIdx) return compacted
    return items.map(clip => {
      const d = applyShift(clip.start, clip.end)
      if (d === 0) return clip
      return { ...clip, start: clip.start + d, end: clip.end + d }
    })
  })

  let newCaptions = project.captions
  if (remapCaptions && newCaptions) {
    const segments = newCaptions.segments.map(seg => {
      const d = applyShift(seg.start, seg.end)
      if (d === 0) return seg
      return {
        ...seg,
        start: seg.start + d,
        end: seg.end + d,
        words: seg.words?.map(w => ({ ...w, start: w.start + d, end: w.end + d })),
      }
    })
    newCaptions = { ...newCaptions, segments }
  }

  const anchors = remapAnchors(
    project,
    n => {
      const t = mapTime(n.t)
      if (n.tEnd === undefined) return t === n.t ? n : { ...n, t }
      const tEnd = mapTime(n.tEnd)
      if (t === n.t && tEnd === n.tEnd) return n
      if (tEnd - t > EPSILON) return { ...n, t, tEnd }
      const { tEnd: _gone, ...point } = n // a range wholly in a closed gap is now a point
      return { ...point, t }
    },
    m => {
      const t = mapTime(m.t)
      return t === m.t ? m : { ...m, t }
    },
  )

  // An audio track moves by where its start lands, its length kept; the key
  // is written only when one moved.
  const audio = project.audio
  let audioPatch: Pick<Project, 'audio'> | undefined
  if (audio?.tracks?.length) {
    let moved = false
    const tracks = audio.tracks.map(track => {
      const start = audioStart(track)
      const d = mapTime(start) - start
      if (d === 0) return track
      moved = true
      return movedAudio(track, d)
    })
    if (moved) audioPatch = { audio: { ...audio, tracks } }
  }

  return { ...project, tracks: newTracks, captions: newCaptions, ...audioPatch, ...anchors }
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
export function applyCutToItem<P extends Project>(project: P, itemId: string, cut: Cut): P {
  if (cut.end <= cut.start) return project

  const tracks = trackItems(project)
  const primaryTrack = tracks[0] ?? []

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

    return {
      ...project,
      tracks: mapTrackItems(project, (items, i) => (i === 0 ? newPrimary : items)),
      captions: newCaptions,
    }
  }

  // ── Overlay tracks ──
  // `ti` is an ABSOLUTE track index (the loop starts at 1, just above the
  // primary track), so the rebuild below addresses the same track the item was
  // found on without an off-by-one.
  for (let ti = 1; ti < tracks.length; ti++) {
    const track   = tracks[ti]
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
    return { ...project, tracks: mapTrackItems(project, (items, i) => (i === ti ? newTrack : items)) }
  }

  return project  // itemId not found
}

// ── Audio split helper ────────────────────────────────────────────────────

function splitAudioTrack(track: AudioTrack, at: number): [AudioTrack, AudioTrack] {
  // Resolve the ORIGINAL track's effective source window the same way the canvas
  // waveform painter (`audioTrackSourceWindow`) and the DOM `AudioWaveformLayer`
  // default it — `inPoint ?? 0`, `outPoint ?? sourceDuration ?? span` — then hand
  // BOTH halves a fully-specified [inPoint, outPoint] window. Audio always runs at
  // speed 1, so the split point's source offset equals its timeline offset.
  //
  // The right half MUST carry an explicit `outPoint`. Previously it only inherited
  // whatever the source had, so a track with no `outPoint`/`sourceDuration` left
  // the fragment's source end unknown; `audioTrackSourceWindow` then fell back to
  // the fragment's own `end - start` (its timeline span, not the source end),
  // yielding a truncated window — and, for any split past the track's midpoint, a
  // non-positive one that the painter skips entirely. That is why the new fragment
  // rendered as a solid block with no waveform while the left half (which already
  // got an explicit `outPoint`) kept its bars. Slicing by src+window is the
  // codebase's design (peaks are fetched per source window and cached by
  // src+window+bucket), so the fix is to give the fragment the correct window; no
  // extra decode beyond the one cheap windowed peaks fetch each new half needs.
  const inPoint  = track.inPoint ?? 0
  const outPoint = track.outPoint ?? track.sourceDuration ?? (track.end - track.start)
  const splitPoint = inPoint + (at - track.start)

  // A FADE BELONGS TO AN EDGE, NOT TO THE CLIP. Spreading `...track` into both
  // halves gave both fragments both fades, which is wrong on the two edges the
  // split just created: the left half fades OUT into the cut and the right half
  // fades IN out of it, neither of which anyone asked for. On a voiceover
  // carrying the usual trailing fade-out that is very visible — every cut
  // produced a fragment that ramps to silence at the razor, and the operator
  // has to zero it by hand each time. Fades are added deliberately; a cut is
  // not a request for one.
  //
  // So each half keeps only the fade whose EDGE it still owns:
  //   • the left half keeps the original START, so it keeps `fadeIn`;
  //   • the right half keeps the original END, so it keeps `fadeOut`;
  //   • the two new edges at the cut carry no fade at all.
  // The paired curve goes with its fade — a `fadeOutCurve` describing a
  // fade-out that no longer exists is dead data, and the operator's next
  // hand-drawn fade should start from the default shape like any other new one.
  //
  // The kept fade is then clamped to its own fragment's span. A 3s fade-out on
  // a 20s track is fine; split that track 1s from its end and the 3s fade no
  // longer fits inside the 1s fragment it lands on. Nothing downstream
  // re-clamps for us — the pointer-machine and the properties panel each clamp
  // their OWN edits, and the renderer just anchors `st = end - fadeOut`, which
  // for an oversized fade starts before the fragment's audio does.
  const { fadeOut: _outAmt, fadeOutCurve: _outCurve, ...leftBase } = track
  const { fadeIn: _inAmt, fadeInCurve: _inCurve, ...rightBase } = track

  const left: AudioTrack = {
    ...leftBase,
    end: at,
    inPoint,
    outPoint: splitPoint,
  }
  const right: AudioTrack = {
    ...rightBase,
    id: uniqueId(track.id),
    start: at,
    inPoint: splitPoint,
    outPoint,
  }
  if (left.fadeIn !== undefined)  left.fadeIn  = Math.min(left.fadeIn, at - track.start)
  if (right.fadeOut !== undefined) right.fadeOut = Math.min(right.fadeOut, track.end - at)
  return [left, right]
}

/**
 * Split a clip at a single point in time, producing two adjacent clips with no gap.
 *
 * - If `itemId` is provided, only that item is split (must contain `at`).
 *   Works for both visual items (tracks[][]) and audio tracks (audio.tracks[]).
 * - If `itemId` is a list, every listed item the time falls inside is split in
 *   one pass; listed items not under the time are left alone.
 * - If `itemId` is null, every clip across all tracks that contains `at` is split.
 * - Returns the same project reference if nothing was split.
 */
export function splitAtTime<P extends Project>(project: P, at: number, itemId: string | readonly string[] | null): P {
  let changed = false
  // A list splits every listed item the time falls strictly inside, in one
  // pass (one result, one undo step). Splitting never touches captions, so a
  // list cannot cut them twice. An empty list matches nothing.
  const ids: ReadonlySet<string> | null =
    itemId === null ? null : new Set(typeof itemId === 'string' ? [itemId] : itemId)

  const newTracks = mapTrackItems(project, items =>
    items.flatMap(item => {
      if (ids !== null && !ids.has(item.id)) return [item]
      if (at <= item.start || at >= item.end) return [item]      // playhead not inside this clip
      changed = true
      return splitClip(item, { start: at, end: at })
    }),
  )

  // Also split audio tracks
  const audioTracks = project.audio?.tracks ?? []
  const newAudioTracks = audioTracks.flatMap(track => {
    if (ids !== null && !ids.has(track.id)) return [track]
    if (at <= track.start || at >= track.end) return [track]
    changed = true
    return splitAudioTrack(track, at)
  })

  if (!changed) return project
  return {
    ...project,
    tracks: newTracks,
    audio: { ...project.audio, tracks: newAudioTracks },
  }
}

// ── Trim ops (ripple / roll / slip / slide) ─────────────────────────────────
//
// Four pure editing ops over the same data the cut engine above works on. Rules
// shared by all four, matching the ops above:
//
//   • in/outPoints are ORIGINAL SOURCE coordinates; `normalizedInPoint` is a
//     cache origin and is never rewritten here (see schema.ts).
//   • Source points are written only when the item already carries them, so an
//     op never invents an inPoint/outPoint on an item that had none.
//   • A clip's per-clip speed S (`item.speed ?? 1`, montaj/speed) is the timeline
//     ↔source scale: `outPoint − inPoint === S·(end − start)`. A timeline delta
//     converts to a SOURCE delta by `·S`, and a source length back to a timeline
//     length by `/S`. `·1`/`/1` are exact, so every op is byte-identical at
//     S=1/absent. MIN_DURATION clamps stay in TIMELINE terms (clip spans are
//     timeline); only the source-media bounds (`inPoint ≥ 0`, `outPoint ≤
//     sourceDuration`) pick up the `/S` factor, so a sped clip can't be trimmed
//     to a negative or oversized source window.
//   • `sourceDuration` absent ⇒ the source end is unknown ⇒ no upper clamp,
//     the same `?? Infinity` convention `timeline/multiSelectOps.ts` uses.
//   • Every op returns the SAME project reference when it would change nothing.
//
// AUDIO COUPLING (§527, Sam 2026-10-22: a ripple on the base footage moves
// everything): a base-track ripple (`rippleDelete` of base footage,
// `collapseGaps`, a base-track ripple insert) moves the audio tracks that start
// at or after its point, as it moves the visual items, and leaves a track that
// starts before it (a music bed under the edit) where it is. A ripple on any
// other track moves no audio. It only ever MOVES audio,
// never trims or deletes it. `splitAtTime` splits audio rather than shifting
// it. Ripple targets are visual items only; an audio-track id is a no-op.

/** Locate an item by id in a project's ITEMS — the `trackItems(project)` view,
 *  not `project.tracks` — so `{ti, ii}` indexes straight back into that view.
 *  `ti` is also the track's index in `project.tracks`: `trackItems` preserves
 *  track order, so a `mapTrackItems` rebuild addresses the same track. */
function findItem(tracks: VisualItem[][], itemId: string): { ti: number; ii: number } | null {
  for (let ti = 0; ti < tracks.length; ti++) {
    const ii = tracks[ti].findIndex(item => item.id === itemId)
    if (ii !== -1) return { ti, ii }
  }
  return null
}

/** Source window of an item in original-source coordinates, defaulted the same
 *  way `cutSingleItem` defaults it — the synthesized length carries speed S
 *  (`(end − start)·S`) so `outPoint − inPoint === S·(end − start)` holds whether
 *  outPoint was stored or defaulted. */
function sourceWindow(item: VisualItem): { inPoint: number; outPoint: number } {
  const inPoint = item.inPoint ?? 0
  return { inPoint, outPoint: item.outPoint ?? (inPoint + (item.end - item.start) * (item.speed ?? 1)) }
}

/** Shift the segments whose midpoint falls inside `window` by `delta`, leaving
 *  every other segment at the same reference. Midpoint ownership is the rule
 *  `collapseGaps` already uses to decide which clip a caption belongs to. */
function shiftCaptionsInWindow(
  segments: CaptionSegment[],
  window: { start: number; end: number },
  delta: number,
): CaptionSegment[] {
  return segments.map(seg => {
    const mid = (seg.start + seg.end) / 2
    if (mid < window.start || mid >= window.end) return seg
    return {
      ...seg,
      start: seg.start + delta,
      end: seg.end + delta,
      words: seg.words?.map(w => ({ ...w, start: w.start + delta, end: w.end + delta })),
    }
  })
}

/**
 * Delete an item and close the gap it leaves by pulling later timeline content
 * earlier by its duration.
 *
 * Contrast with `collapseGaps`, which normalizes EVERY gap in the primary track:
 * ripple-delete shifts only content that starts at or after the deletion point,
 * so gaps the editor placed deliberately earlier in the timeline survive.
 *
 * - Items in every track (primary and overlay) whose `start` is at/after the
 *   deleted item's `end` shift earlier; items overlapping the deleted window are
 *   not "subsequent" and stay put. Shifted items move on the timeline only —
 *   their source windows are untouched.
 * - Captions are remapped with the same `applyCutToCaptions` rules the lift cut
 *   uses: segments inside the deleted window are dropped, partials are trimmed,
 *   and later segments (and their words) shift by the deleted duration.
 * - §527 (Sam): on the BASE footage track the ripple moves everything: audio
 *   tracks that start at/after the deleted item's end shift earlier by its
 *   duration (moved, never trimmed), the notes and markers inside its window
 *   are deleted, a note range over its edge is clipped, and later ones shift
 *   (see AUDIO COUPLING above). On any other track it closes the gap on that
 *   track only: the other tracks, captions, audio, notes and markers stay.
 * - Empty tracks are kept, as everywhere else in this file.
 * - Returns the same project reference if `itemId` names no visual item.
 */
export function rippleDelete<P extends Project>(project: P, itemId: string): P {
  const tracks = trackItems(project)
  const found = findItem(tracks, itemId)
  if (!found) return project

  const item = tracks[found.ti][found.ii]
  const duration = item.end - item.start
  // §527 (Sam, 2026-10-22): a ripple on the base footage track moves
  // everything after it; one on any other track closes the gap on THAT track
  // only, since the footage, and the captions, audio, notes, markers and other
  // tracks timed to it, did not move.
  const onBase = found.ti === baseTrackIndex(tracks)

  const newTracks = mapTrackItems(project, (items, i) =>
    !onBase && i !== found.ti
      ? items
      : items
          .filter(other => other.id !== itemId)
          .map(other =>
            duration > EPSILON && other.start >= item.end - EPSILON
              ? { ...other, start: other.start - duration, end: other.end - duration }
              : other,
          ),
  )
  if (!onBase || duration <= EPSILON) return { ...project, tracks: newTracks }

  const removed = { start: item.start, end: item.end }
  const newCaptions = project.captions
    ? {
        ...project.captions,
        segments: applyCutToCaptions(project.captions.segments, removed),
      }
    : project.captions
  const audio = rippleAudio(project.audio, item.end, -duration)
  return {
    ...project,
    tracks: newTracks,
    captions: newCaptions,
    ...(audio !== project.audio ? { audio } : {}),
    ...cutAnchors(project, removed, duration),
  }
}

/**
 * Move the boundary shared by two adjacent clips: the left clip's outPoint and
 * the right clip's inPoint travel together, so the pair's combined duration and
 * every other item on the timeline stay exactly where they are.
 *
 * `delta` is the boundary movement in seconds (positive = later) and is clamped,
 * not rejected, so a drag past a limit parks the boundary at that limit:
 *   - neither clip may drop below MIN_DURATION;
 *   - the left clip may not run past the end of its source media;
 *   - the right clip may not start before the start of its source media.
 * Source clamps apply to video items only; images/overlays roll geometrically,
 * except that a 3D item's head carries its in point and stops where its 3D
 * begins (scene3d.ts).
 *
 * Captions and audio are untouched — a roll swaps which source frames play at
 * the boundary without moving anything on the timeline.
 *
 * Returns the same project reference when either id is missing, the two clips
 * are on different tracks, they are not adjacent (which is also what a reversed
 * argument pair looks like), or the clamped movement is zero.
 */
export function rollEdit<P extends Project>(
  project: P,
  leftItemId: string,
  rightItemId: string,
  delta: number,
): P {
  const tracks = trackItems(project)
  const l = findItem(tracks, leftItemId)
  const r = findItem(tracks, rightItemId)
  if (!l || !r) return project
  if (l.ti !== r.ti) return project              // a boundary only exists within one track

  const left  = tracks[l.ti][l.ii]
  const right = tracks[r.ti][r.ii]
  if (Math.abs(left.end - right.start) > EPSILON) return project   // not adjacent

  const { outPoint: leftOut } = sourceWindow(left)
  const { inPoint: rightIn }  = sourceWindow(right)
  // The two clips may run at different speeds: the boundary moves `d` on the
  // TIMELINE, so each clip's source point moves by `d·S` in ITS OWN source, and
  // each source-media clamp on `d` is that clip's source room `/S`.
  const sLeft  = left.speed  ?? 1
  const sRight = right.speed ?? 1

  let minDelta = left.start + MIN_DURATION - left.end
  let maxDelta = right.end - MIN_DURATION - right.start
  if (left.type === 'video')  maxDelta = Math.min(maxDelta, ((left.sourceDuration ?? Infinity) - leftOut) / sLeft)
  if (right.type === 'video') minDelta = Math.max(minDelta, -rightIn / sRight)
  // A 3D item's head may not roll before its 3D begins (scene3d.ts).
  if (isScene3dItem(right)) minDelta = Math.max(minDelta, -scene3dInPoint(right))
  if (minDelta > maxDelta) return project        // already past both limits — nothing safe to do

  const d = Math.max(minDelta, Math.min(delta, maxDelta))
  if (Math.abs(d) <= EPSILON) return project

  const newLeft: VisualItem = {
    ...left,
    end: left.end + d,
    ...(left.outPoint !== undefined ? { outPoint: left.outPoint + d * sLeft } : {}),
  }
  const newRight: VisualItem = shiftScene3dInPoint({
    ...right,
    start: right.start + d,
    ...(right.inPoint !== undefined ? { inPoint: right.inPoint + d * sRight } : {}),
  }, d)
  const newTrack = tracks[l.ti].map(item =>
    item.id === left.id ? newLeft : item.id === right.id ? newRight : item,
  )

  return { ...project, tracks: mapTrackItems(project, (items, i) => (i === l.ti ? newTrack : items)) }
}

/**
 * Slide an item's source window through its media while the item keeps its exact
 * timeline position: for a `delta`-second timeline drag `inPoint` and `outPoint`
 * both move by `delta·S` in source (montaj/speed), `start` and `end` do not. The
 * window length never changes, so MIN_DURATION cannot bind — only the
 * source-media bounds do (`inPoint` >= 0, `outPoint` <= sourceDuration), and each
 * bound on `delta` is that room `/S`.
 *
 * Nothing else on the timeline is affected, so captions and audio are untouched.
 *
 * Returns the same project reference when the item is missing, is not a video
 * clip, carries no source window to slip, or the clamped movement is zero.
 */
export function slipItem<P extends Project>(project: P, itemId: string, delta: number): P {
  const tracks = trackItems(project)
  const found = findItem(tracks, itemId)
  if (!found) return project

  const item = tracks[found.ti][found.ii]
  if (item.type !== 'video') return project                                  // no source media
  if (item.inPoint === undefined && item.outPoint === undefined) return project

  const s = item.speed ?? 1
  const { inPoint, outPoint } = sourceWindow(item)
  const minDelta = -inPoint / s
  const maxDelta = ((item.sourceDuration ?? Infinity) - outPoint) / s
  if (minDelta > maxDelta) return project

  const d = Math.max(minDelta, Math.min(delta, maxDelta))
  if (Math.abs(d) <= EPSILON) return project

  const newItem: VisualItem = {
    ...item,
    ...(item.inPoint  !== undefined ? { inPoint:  item.inPoint  + d * s } : {}),
    ...(item.outPoint !== undefined ? { outPoint: item.outPoint + d * s } : {}),
  }
  const newTrack = tracks[found.ti].map(other => (other.id === item.id ? newItem : other))

  return { ...project, tracks: mapTrackItems(project, (items, i) => (i === found.ti ? newTrack : items)) }
}

/**
 * Move an item along the timeline with its source window unchanged, letting its
 * adjacent neighbors absorb the movement: the previous neighbor's outPoint
 * extends or shrinks to meet the item's new start, and the next neighbor's
 * inPoint does the same at its new end. The three-clip span therefore keeps its
 * total duration and nothing outside it moves.
 *
 * `delta` is clamped rather than rejected:
 *   - neither neighbor may drop below MIN_DURATION;
 *   - the previous neighbor may not extend past the end of its source media;
 *   - the next neighbor may not extend before the start of its source media;
 *   - the item may not cross the timeline origin.
 * A neighbor that is absent or separated by a gap absorbs nothing and imposes no
 * limit — the item simply moves through the empty space.
 *
 * Captions whose midpoint sits over the item's OLD window travel with it, the
 * same midpoint-ownership rule `collapseGaps` uses; captions over the neighbors
 * do not move, because the neighbors' existing content does not move either.
 * Audio is untouched.
 *
 * Returns the same project reference when the item is missing or the clamped
 * movement is zero.
 */
export function slideItem<P extends Project>(project: P, itemId: string, delta: number): P {
  const tracks = trackItems(project)
  const found = findItem(tracks, itemId)
  if (!found) return project

  const track = tracks[found.ti]
  const item  = track[found.ii]

  // Neighbors are the items either side of this one in TIMELINE order, which is
  // not necessarily array order.
  const sorted = [...track].sort((a, b) => a.start - b.start)
  const pos    = sorted.findIndex(other => other.id === itemId)
  const before = pos > 0 ? sorted[pos - 1] : undefined
  const after  = pos < sorted.length - 1 ? sorted[pos + 1] : undefined
  const prev   = before && Math.abs(before.end - item.start) <= EPSILON ? before : undefined
  const next   = after  && Math.abs(after.start - item.end)  <= EPSILON ? after  : undefined

  // A neighbor absorbs the move by re-timing its source window: the previous
  // neighbor's outPoint and the next neighbor's inPoint travel `d·S` in each
  // neighbor's OWN source (montaj/speed), so each neighbor's source-media bound
  // on `d` is its room `/S`. The timeline MIN_DURATION clamps are unaffected.
  const sPrev = prev?.speed ?? 1
  const sNext = next?.speed ?? 1
  let minDelta = -item.start
  let maxDelta = Infinity
  if (prev) {
    minDelta = Math.max(minDelta, MIN_DURATION - (prev.end - prev.start))
    if (prev.type === 'video') {
      maxDelta = Math.min(maxDelta, ((prev.sourceDuration ?? Infinity) - sourceWindow(prev).outPoint) / sPrev)
    }
  }
  if (next) {
    maxDelta = Math.min(maxDelta, (next.end - next.start) - MIN_DURATION)
    if (next.type === 'video') minDelta = Math.max(minDelta, -sourceWindow(next).inPoint / sNext)
    if (isScene3dItem(next)) minDelta = Math.max(minDelta, -scene3dInPoint(next))
  }
  if (minDelta > maxDelta) return project

  const d = Math.max(minDelta, Math.min(delta, maxDelta))
  if (Math.abs(d) <= EPSILON) return project

  const moved = new Map<string, VisualItem>()
  moved.set(item.id, { ...item, start: item.start + d, end: item.end + d })
  if (prev) {
    moved.set(prev.id, {
      ...prev,
      end: prev.end + d,
      ...(prev.outPoint !== undefined ? { outPoint: prev.outPoint + d * sPrev } : {}),
    })
  }
  if (next) {
    moved.set(next.id, shiftScene3dInPoint({
      ...next,
      start: next.start + d,
      ...(next.inPoint !== undefined ? { inPoint: next.inPoint + d * sNext } : {}),
    }, d))
  }
  const newTrack = track.map(other => moved.get(other.id) ?? other)

  const newCaptions = project.captions
    ? {
        ...project.captions,
        segments: shiftCaptionsInWindow(
          project.captions.segments,
          { start: item.start, end: item.end },
          d,
        ),
      }
    : project.captions

  return {
    ...project,
    tracks: mapTrackItems(project, (items, i) => (i === found.ti ? newTrack : items)),
    captions: newCaptions,
  }
}

// ── Speed ────────────────────────────────────────────────────────────────────

/** Speed bounds (montaj/speed). Mirrors the schema note on `VisualItem.speed`
 *  and `engine/validate.py`'s range check. */
const MIN_SPEED = 0.25
const MAX_SPEED = 4

/**
 * Set a clip's per-clip playback speed and re-fit its timeline span to the same
 * source range at the new rate.
 *
 * `speed` is clamped to [MIN_SPEED, MAX_SPEED]. `inPoint`/`outPoint` are
 * speed-independent ORIGINAL-source coordinates and are left untouched; only the
 * timeline `end` moves:
 *
 *     end = start + (effectiveOutPoint − effectiveInPoint) / speed
 *
 * The effective window comes from the same `sourceWindow` helper the trim ops
 * use, so the source length is read consistently whether `outPoint` was stored
 * or synthesized — which makes a re-speed from ANY prior S correct, since the
 * source length is speed-invariant. The op re-times the ONE clip only; it
 * deliberately does not close the gap it opens (speeding up) or the overlap it
 * creates (slowing down) — the caller decides based on the magnet toggle
 * (`collapseGaps`).
 *
 * Returns a new Project. Same reference back when `clipId` names no item, or
 * the item is not a video clip — speed is video-only per the schema, so an
 * image/overlay must not pick up a `speed` field or a rescaled `end`.
 */
export function setClipSpeed<P extends Project>(project: P, clipId: string, speed: number): P {
  const tracks = trackItems(project)
  const found = findItem(tracks, clipId)
  if (!found) return project

  const item = tracks[found.ti][found.ii]
  if (item.type !== 'video') return project

  const clamped = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed))
  const { inPoint, outPoint } = sourceWindow(item)

  const newItem: VisualItem = {
    ...item,
    speed: clamped,
    end: item.start + (outPoint - inPoint) / clamped,
  }
  const newTrack = tracks[found.ti].map(other => (other.id === clipId ? newItem : other))

  return { ...project, tracks: mapTrackItems(project, (items, i) => (i === found.ti ? newTrack : items)) }
}

// ── Insert (place a new clip from the media bin) ──────────────────────────────

/** The footage a media-bin drop hands to `insertClipAt`: enough to place a
 *  whole-source video item, nothing more. `sourceDuration` is required — it is
 *  both the placed clip's timeline length and its source window's end. */
export interface NewClipInput {
  src: string
  proxySrc?: string
  sourceDuration: number
  sourceWidth?: number
  sourceHeight?: number
}

/**
 * A generic, collision-resistant timeline-item id — distinct in SHAPE from the
 * `clip-<n>` ids init hands source clips, and from the `<base>_split_…` ids
 * `uniqueId` mints for split fragments, so a bin placement can never be mistaken
 * for either. Date.now()+random is fine in app runtime code (this is not a pure
 * transform of the project).
 */
export function newClipId(): string {
  // Two independent random draws (each ~52 bits, base36) plus the timestamp:
  // a single 4-char draw is only ~1.7M-wide, so a tight burst of ids minted in
  // the same millisecond (Date.now() constant) collides at a birthday rate that
  // is small but real. Doubling the random tail makes a collision negligible.
  const rand = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8)
  return `clip_${Date.now().toString(36)}${rand}`
}

/** True when [s, e) overlaps any item's window by more than float slop. Touching
 *  edges (butt-adjacency) are NOT an overlap, matching the EPSILON tolerance the
 *  rest of this file uses for adjacency. Exported because `timeline/placement.ts`
 *  reuses it for its own free-window check — the butt-adjacency tolerance
 *  (`EPSILON`) is defined exactly once, here, rather than redeclared. */
export function overlapsAny(s: number, e: number, items: VisualItem[]): boolean {
  return items.some(it => Math.min(e, it.end) - Math.max(s, it.start) > EPSILON)
}

/**
 * Place a NEW whole-source video clip on the track identified by `trackId`,
 * returning a new Project (inputs — the project, its tracks/items, and the
 * `clip` descriptor — are never mutated).
 *
 * The built item is a whole-source window: `inPoint 0 → outPoint sourceDuration`,
 * `start → end` spanning exactly `sourceDuration` on the timeline, with a fresh
 * `newClipId()`. `atTime` is clamped to `>= 0`.
 *
 * Placement follows the magnet, exactly as the other timeline ops treat it:
 *
 *   • `ripple: true` — shift-right insert. If the drop point lands inside an
 *     existing item's span (straddles it), the effective insertion point snaps
 *     to that item's NEAREST edge — start or end, ties going to START — so the
 *     new clip never lands inside another clip's window. Every existing item
 *     whose `start` is at/after the (possibly snapped) insertion point then
 *     moves right by the new clip's length, and the new clip takes the freed
 *     slot at the insertion point. This leaves NO overlaps and preserves order;
 *     splitting the straddling clip is intentionally NOT done here. §527: a
 *     ripple insert on the BASE footage track moves everything after it, so
 *     when it pushed that track's items, the other tracks' items that start
 *     at/after that point, the captions, the audio tracks that start there,
 *     the notes and the markers move right by the same length (one that
 *     straddles the point keeps its start). An insert on any other track, or
 *     one that pushed nothing, moves nothing else.
 *
 *     The tie-break is Sam's product call (2026-08-25): "never split a clip,
 *     always keep them whole — if the drop is over 50% into the clip, make
 *     room to the RIGHT of it (push everything else right); at or before 50%,
 *     make room to the LEFT of it." A drop in the first half of a clip reads
 *     as "put the new clip before this one", so an exact-midpoint drop (the
 *     tie) resolves the same way — to the clip's start, not its end.
 *
 *   • `ripple: false` — place at the drop point WITHOUT moving anything, but
 *     never overlapping: if the drop window collides, the new clip snaps to the
 *     nearest free gap at/after the drop point that fits it, and if no such gap
 *     fits it is appended after the last item on the track. No overlaps result.
 *
 * The returned track's items are sorted by `start`. An unknown `trackId` returns
 * the project unchanged (matching how the sibling ops no-op on a missing id).
 */
export function insertClipAt<P extends Project>(
  project: P,
  trackId: string,
  clip: NewClipInput,
  atTime: number,
  opts: { ripple: boolean },
): P {
  const tracks = (normalizeTracks(project).tracks ?? []) as VisualTrack[]
  const trackIdx = tracks.findIndex(t => t.id === trackId)
  if (trackIdx === -1) return project

  const len = clip.sourceDuration
  const dropAt = Math.max(0, atTime)
  const existing = tracks[trackIdx].items

  // Where the new clip's timeline window actually lands.
  let start: number
  let shifted = existing
  if (opts.ripple) {
    // If the drop point lands inside an existing item's span, snap the
    // effective insertion point to that item's nearest edge (ties → START —
    // Sam's call, see this function's doc comment) so the new clip never
    // lands inside another clip's window. At most one item can straddle a
    // point on a non-overlapping track.
    const straddler = existing.find(it => it.start < dropAt - EPSILON && it.end > dropAt + EPSILON)
    const insertAt = straddler
      ? (dropAt - straddler.start <= straddler.end - dropAt ? straddler.start : straddler.end)
      : dropAt

    start = insertAt
    shifted = existing.map(it =>
      it.start >= insertAt - EPSILON ? { ...it, start: it.start + len, end: it.end + len } : it,
    )
  } else {
    // Earliest start >= dropAt whose [start, start+len] window is free. The
    // candidate starts are the drop point itself and the end of every item
    // at/after it; the last item's end always fits (nothing follows it).
    const candidates = [
      dropAt,
      ...existing.filter(it => it.end >= dropAt - EPSILON).map(it => it.end),
    ].sort((a, b) => a - b)
    start = candidates.find(s => !overlapsAny(s, s + len, existing)) ?? dropAt
  }

  const placed: VisualItem = {
    id: newClipId(),
    type: 'video',
    src: clip.src,
    start,
    end: start + len,
    inPoint: 0,
    outPoint: len,
    sourceDuration: len,
    ...(clip.proxySrc !== undefined ? { proxySrc: clip.proxySrc } : {}),
    ...(clip.sourceWidth !== undefined ? { sourceWidth: clip.sourceWidth } : {}),
    ...(clip.sourceHeight !== undefined ? { sourceHeight: clip.sourceHeight } : {}),
  }

  const newItems = [...shifted, placed].sort((a, b) => a.start - b.start)
  // §527: a ripple insert that pushed this track's later items moves everything
  // after the insertion point, the other tracks' items too. One that pushed
  // nothing (an empty or freshly made track, a drop past the last item) made
  // no room in anything, so nothing else moves.
  // On the base footage track only (Sam, §527): a ripple insert on any other
  // track pushes that track alone, since the footage did not move.
  const baseIdx = baseTrackIndex(tracks.map(t => t.items))
  const pushed = opts.ripple && trackIdx === baseIdx && shifted.some((it, i) => it !== existing[i])
  const tracksOut = mapTrackItems(project, (items, i) => {
    if (i === trackIdx) return newItems
    if (!pushed) return items
    return items.map(it => (it.start >= start - EPSILON ? { ...it, start: it.start + len, end: it.end + len } : it))
  })
  if (!pushed) return { ...project, tracks: tracksOut }

  // §527: and the captions, the audio tracks that start at or after the
  // insertion point, the notes and the markers (straddling ones keep their
  // start), as `rippleDelete` moves them the other way.
  const captions = shiftCaptionsAfter(project.captions, start, len)
  const audio = rippleAudio(project.audio, start, len)
  return shiftMarks(
    {
      ...project,
      tracks: tracksOut,
      ...(captions !== project.captions ? { captions } : {}),
      ...(audio !== project.audio ? { audio } : {}),
    },
    start,
    len,
  )
}
