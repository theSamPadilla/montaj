import type { Project } from '../types'
import type { VisualItem, AudioTrack, CaptionSegment, Word, VisualTrack, KeyframeTrack } from '../schema'
import { mapTrackItems, trackItems, normalizeTracks } from './timeline/timeline-model'
import { normalizeTrack } from '@bycrux/timeline-core'
import { canKeyframe } from './keyframeOps'

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
  return {
    ...item,
    end: at,
    ...(item.outPoint !== undefined ? { outPoint: (item.inPoint ?? 0) + trimmedDur * s } : {}),
  }
}

function trimClipStart(item: VisualItem, at: number): VisualItem {
  // Lift-style: clip start advances to the cut end; inPoint advances by the same
  // timeline distance converted to SOURCE seconds (`·S`, montaj/speed).
  // The resulting gap before the clip's new start position is intentional.
  const sourceOffset = (at - item.start) * (item.speed ?? 1)
  return {
    ...item,
    start: at,
    ...(item.inPoint !== undefined ? { inPoint: (item.inPoint ?? 0) + sourceOffset } : {}),
  }
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
    .map(track => normalizeTrack({ prop: track.prop, points: track.points.filter(p => p.t <= leftDur) }))
    .filter((track): track is KeyframeTrack => !!track && track.points.length > 0)
  const right = tracks
    .map(track => normalizeTrack({
      prop: track.prop,
      points: track.points.filter(p => p.t >= rightOffset).map(p => ({ ...p, t: p.t - rightOffset })),
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
  const right: VisualItem = {
    ...item,
    id: uniqueId(item.id),
    start: cut.end,  // lift: right fragment stays at its original timeline position
    ...(item.inPoint !== undefined ? { inPoint: (item.inPoint ?? 0) + rightSourceOffset } : {}),
  }

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
    const right: VisualItem = {
      ...item,
      id: uniqueId(item.id),
      start: cut.start,
      end: cut.start + (outPoint - physEnd) / s,
      ...(item.inPoint !== undefined ? { inPoint: physEnd } : {}),
    }
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
 * Only tracks[0] (primary clips) and captions are mutated.
 * tracks[1+] overlay items are passed through unchanged — their start/end are
 * absolute and they intentionally sit over any gap left in the primary track.
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

  return { ...project, tracks: newTracks, captions: newCaptions }
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

  const primaryIdx = tracks.findIndex(t => t.some(c => c.type === 'video'))
  const effectiveIdx = primaryIdx >= 0 ? primaryIdx : 0

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

  return { ...project, tracks: newTracks, captions: newCaptions }
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
 * - If `itemId` is null, every clip across all tracks that contains `at` is split.
 * - Returns the same project reference if nothing was split.
 */
export function splitAtTime<P extends Project>(project: P, at: number, itemId: string | null): P {
  let changed = false

  const newTracks = mapTrackItems(project, items =>
    items.flatMap(item => {
      if (itemId !== null && item.id !== itemId) return [item]
      if (at <= item.start || at >= item.end) return [item]      // playhead not inside this clip
      changed = true
      return splitClip(item, { start: at, end: at })
    }),
  )

  // Also split audio tracks
  const audioTracks = project.audio?.tracks ?? []
  const newAudioTracks = audioTracks.flatMap(track => {
    if (itemId !== null && track.id !== itemId) return [track]
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
// AUDIO COUPLING: `project.audio.tracks` is never moved by these ops, matching
// `collapseGaps` — music beds and voiceover are timed independently of the
// visual track, so rippling video must not desync them. `splitAtTime` is the
// only op in this file that reaches into audio, and it splits rather than
// shifts. Ripple targets are visual items only; an audio-track id is a no-op.

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
 * - Audio tracks are untouched (see AUDIO COUPLING above).
 * - Empty tracks are kept, as everywhere else in this file.
 * - Returns the same project reference if `itemId` names no visual item.
 */
export function rippleDelete<P extends Project>(project: P, itemId: string): P {
  const tracks = trackItems(project)
  const found = findItem(tracks, itemId)
  if (!found) return project

  const item = tracks[found.ti][found.ii]
  const duration = item.end - item.start

  const newTracks = mapTrackItems(project, items =>
    items
      .filter(other => other.id !== itemId)
      .map(other =>
        duration > EPSILON && other.start >= item.end - EPSILON
          ? { ...other, start: other.start - duration, end: other.end - duration }
          : other,
      ),
  )

  const newCaptions = project.captions && duration > EPSILON
    ? {
        ...project.captions,
        segments: applyCutToCaptions(project.captions.segments, { start: item.start, end: item.end }),
      }
    : project.captions

  return { ...project, tracks: newTracks, captions: newCaptions }
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
 * Source clamps apply to video items only; images/overlays roll geometrically.
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
  if (minDelta > maxDelta) return project        // already past both limits — nothing safe to do

  const d = Math.max(minDelta, Math.min(delta, maxDelta))
  if (Math.abs(d) <= EPSILON) return project

  const newLeft: VisualItem = {
    ...left,
    end: left.end + d,
    ...(left.outPoint !== undefined ? { outPoint: left.outPoint + d * sLeft } : {}),
  }
  const newRight: VisualItem = {
    ...right,
    start: right.start + d,
    ...(right.inPoint !== undefined ? { inPoint: right.inPoint + d * sRight } : {}),
  }
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
    moved.set(next.id, {
      ...next,
      start: next.start + d,
      ...(next.inPoint !== undefined ? { inPoint: next.inPoint + d * sNext } : {}),
    })
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
 *     splitting the straddling clip is intentionally NOT done here.
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

  return { ...project, tracks: mapTrackItems(project, (items, i) => (i === trackIdx ? newItems : items)) }
}
