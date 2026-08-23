import type { CaptionSegment, Captions } from '../schema'

/**
 * Caption lanes — pure helpers over `CaptionSegment[]` / `Captions`. Every
 * consumer that needs to know which lane a caption sits in, how lanes group
 * up, or where a dragged caption should land reads it through this module, so
 * lane semantics can't drift between the canvas painter, the caption
 * sidebar, and the drag gesture that later phases build on top of this.
 *
 * See the `lane` field doc on `CaptionSegment` (schema.ts) for why caption
 * lanes deliberately do NOT auto-increment the way `AudioTrack.lane` /
 * `groupAudioLanes` do: absent means lane 0, full stop.
 */

// ── Reading a segment's lane ────────────────────────────────────────────────

/**
 * A segment's lane, defaulted and defensively coerced. Absent, negative,
 * non-integer, or non-finite (`NaN`/`Infinity`) stored values all collapse to
 * a safe in-range integer rather than propagating into array indexing or
 * comparisons downstream — a hand-edited project.json is the realistic source
 * of a bad value here, not this codebase.
 */
export function laneOf(seg: CaptionSegment): number {
  const raw = seg.lane
  if (raw == null || !Number.isFinite(raw)) return 0
  const n = Math.trunc(raw)
  return n < 0 ? 0 : n
}

/** Highest lane index present across `segments`, or 0 for an empty/lane-less
 *  track — so callers can size a `0..maxCaptionLane` structure without
 *  special-casing "no captions yet". */
export function maxCaptionLane(segments: CaptionSegment[]): number {
  return segments.reduce((max, seg) => Math.max(max, laneOf(seg)), 0)
}

// ── Grouping ─────────────────────────────────────────────────────────────

export interface CaptionLaneGroup {
  lane: number
  segments: CaptionSegment[]
}

/**
 * Group `segments` into one entry per lane, `0..maxCaptionLane(segments)`,
 * INCLUDING holes as empty groups (`segments: []`). A hole must be
 * representable, not just skipped, because a later phase renders one row per
 * lane and needs a visible, drop-targetable empty band mid-drag even where no
 * caption currently lives.
 */
export function groupCaptionLanes(segments: CaptionSegment[]): CaptionLaneGroup[] {
  const groups: CaptionLaneGroup[] = Array.from(
    { length: maxCaptionLane(segments) + 1 },
    (_, lane) => ({ lane, segments: [] }),
  )
  for (const seg of segments) groups[laneOf(seg)].segments.push(seg)
  return groups
}

/** Every segment whose (coerced) lane is `lane`. */
export function segmentsInLane(segments: CaptionSegment[], lane: number): CaptionSegment[] {
  return segments.filter(seg => laneOf(seg) === lane)
}

// ── Normalizing ──────────────────────────────────────────────────────────

/**
 * Collapse hole lanes and renumber dense from 0, preserving relative lane
 * order (the segment(s) in the lowest occupied lane become lane 0, the next
 * occupied lane becomes 1, and so on). Also rewrites any negative or
 * non-integer stored `lane` to its canonical dense integer.
 *
 * Returns the SAME `Captions` reference when nothing changes — the contract
 * every defensive normalizer in this codebase honours (see
 * `backfillCaptionIds` in video/VideoEditor.tsx and `repairCaptionWords` in
 * video/captionRepair.ts), so a caller that re-runs this after its own write
 * converges to a true no-op instead of looping. Handles `captions` being
 * `undefined` (passed straight back).
 */
export function normalizeCaptionLanes(captions: Captions | undefined): Captions | undefined {
  if (!captions) return captions
  const { segments } = captions
  if (!segments.length) return captions

  // Distinct lanes actually in use (after defensive coercion), ascending —
  // the lane at sorted position i renumbers to i, closing any holes. Lane 0,
  // if present at all, is always the smallest and so always renumbers to 0.
  const present = [...new Set(segments.map(laneOf))].sort((a, b) => a - b)
  const remap = new Map(present.map((lane, i) => [lane, i]))

  let changed = false
  const newSegments = segments.map(seg => {
    const canonical = remap.get(laneOf(seg))!
    const current = seg.lane ?? 0
    if (current === canonical) return seg
    changed = true
    return { ...seg, lane: canonical }
  })
  if (!changed) return captions

  return { ...captions, segments: newSegments }
}

// ── Drag support ─────────────────────────────────────────────────────────

/**
 * Does `[start, end)` avoid every OTHER segment already occupying `lane`?
 * `id` names the segment being placed — if it happens to already sit in
 * `lane`, it is excluded from the check, which is what makes it safe to call
 * this on a segment's own prospective new position while dragging it.
 * Touching edges (`end === seg.start` or `start === seg.end`) are not a
 * collision.
 */
export function fitsInLane(
  segments: CaptionSegment[],
  id: string | undefined,
  lane: number,
  start: number,
  end: number,
): boolean {
  return segmentsInLane(segments, lane).every(other => {
    if (id !== undefined && other.id === id) return true // the segment itself — not a collision
    return end <= other.start || start >= other.end
  })
}

export interface CaptionLaneNeighbours {
  prev: CaptionSegment | null
  next: CaptionSegment | null
}

/**
 * The nearest segments sharing `seg`'s lane on either side, by timeline
 * position: `prev` is the closest segment ending at/before `seg.start`,
 * `next` the closest starting at/after `seg.end`. `seg` itself is excluded
 * (by id when it has one, otherwise by reference).
 */
export function sameLaneNeighbours(segments: CaptionSegment[], seg: CaptionSegment): CaptionLaneNeighbours {
  const others = segmentsInLane(segments, laneOf(seg)).filter(other =>
    seg.id !== undefined ? other.id !== seg.id : other !== seg,
  )

  let prev: CaptionSegment | null = null
  let next: CaptionSegment | null = null
  for (const other of others) {
    if (other.end <= seg.start && (!prev || other.end > prev.end)) prev = other
    if (other.start >= seg.end && (!next || other.start < next.start)) next = other
  }
  return { prev, next }
}

export interface ResolveDropLaneArgs {
  /** Full segment list (including `seg` at its pre-drag position). */
  segments: CaptionSegment[]
  /** The segment being dragged. */
  seg: CaptionSegment
  /** The lane the drag started from. */
  sourceLane: number
  /** Lanes of vertical travel so far (see sign note below). */
  laneDelta: number
  /** The segment's prospective new [start, end) in the target lane. */
  start: number
  end: number
}

/**
 * The target lane for a vertical caption drag.
 *
 * Caption lanes ascend UPWARD on the timeline (higher lane number = higher on
 * screen) — the OPPOSITE of audio lanes — so a downward drag (`laneDelta`
 * increasing) must LOWER the lane number, hence the minus sign below. A later
 * phase's drag gesture relies on this sign.
 *
 * Fans out from `wanted = clamp(sourceLane - laneDelta, 0, maxLane + 1)` in
 * the order `wanted, wanted-1, wanted+1, wanted-2, …`, bounded to
 * `[0, maxLane + 1]`, returning the first lane where `fitsInLane` holds. This
 * mirrors the nearest-first fan-out `moveItemAcrossTracks` uses for visual
 * tracks: land as close to the lane the pointer actually points at as
 * possible, not just at the first open lane found in one direction.
 *
 * `maxLane + 1` is always in range and is empty of every segment (dragged one
 * included — its OWN lane is at most `maxLane`, strictly less than
 * `maxLane + 1`), so `fitsInLane` at that lane always holds. Because the
 * fan-out's largest possible offset (`max(wanted, maxLane + 1 - wanted)`) never
 * exceeds `maxLane + 1`, the search reaches that guaranteed-empty lane before
 * running out of offsets to try — so this function always terminates with an
 * answer, never falling through un-returned.
 */
export function resolveDropLane({ segments, seg, sourceLane, laneDelta, start, end }: ResolveDropLaneArgs): number {
  const upper = maxCaptionLane(segments) + 1
  const wanted = Math.min(upper, Math.max(0, sourceLane - laneDelta))

  for (let offset = 0; offset <= upper; offset++) {
    const candidates = offset === 0 ? [wanted] : [wanted - offset, wanted + offset]
    for (const candidate of candidates) {
      if (candidate < 0 || candidate > upper) continue
      if (fitsInLane(segments, seg.id, candidate, start, end)) return candidate
    }
  }
  return upper // unreachable — see doc comment above — kept only so the function is total
}
