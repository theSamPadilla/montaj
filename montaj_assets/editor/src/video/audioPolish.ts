// The audio-polish planner. Pure: no React, no I/O, no clock, no randomness —
// every function here is a transform of data the caller already has, so the
// modal can rebuild a whole draft on every checkbox tick and the whole thing is
// unit-testable without a DOM.
//
// The four pieces it plans for, and how each is expressed in the project:
//
//   silence / fillers  →  `applyCutToTracks` per approved range, then ONE
//                         `collapseGaps` (see APPLY ORDER below)
//   loudness           →  `item.volume`
//   voice isolation    →  a new `project.audio.tracks[]` entry + `item.muted`
//
// No new schema field, no render change: every field written here is already
// honoured by both the preview and the renderer.
//
// ── TWO COORDINATE SPACES, AND THE RULE FOR KEEPING THEM APART ──────────────
//
// The analysis steps speak SOURCE time — an offset into the file named by the
// clip's `src`. The timeline speaks TIMELINE time. For a clip they are related
// by `start`, `inPoint` and `speed`:
//
//     sourceToTimeline(clip, t) = clip.start + (t - (clip.inPoint ?? 0)) / (clip.speed ?? 1)
//     timelineToSource(clip, t) = (t - clip.start) * (clip.speed ?? 1) + (clip.inPoint ?? 0)
//
// BOTH GUARDS RUN IN SOURCE TIME. Two of their three inputs arrive that way
// already (step removals, and `waveform_trim`'s keep ranges); the odd one out is
// caption words, which are stored in TIMELINE time — which is exactly what
// `captionWordsInSourceTime` exists to fix, and why `flagRemovals` takes every
// argument in one clip's source time. Mixing the two spaces here silently
// produces garbage for every clip whose `start` and `inPoint` differ, which is
// most of them, and the damage is invisible: removals still look plausible, they
// just land on the wrong audio.
//
// Timeline mapping happens exactly ONCE afterwards, in `buildDraft`.
//
// ── APPLY ORDER (load-bearing) ──────────────────────────────────────────────
//
//   speech cuts (pooled, descending)
//     → gap close with `remapCaptions: false`
//     → loudness
//     → voice isolation
//
// `applyCutToTracks` and `collapseGaps` mutate `tracks[0]`, `tracks[1+]` and
// `captions` only; they deliberately do NOT shift `project.audio.tracks` (a
// music bed must not ripple when you trim a take). A stem track minted before
// the cuts would therefore end up misaligned. Cuts and the gap close run first,
// so clip geometry is final before stem tracks are built against it. Loudness
// sits in the middle because it is per-clip and order-insensitive.
//
// `remapCaptions: false` is not an optimisation — see the invariant comment
// above `collapseGaps` in cuts.ts. `applyCutToTracks` has ALREADY rippled the
// captions; letting `collapseGaps` remap them too shifts every one of them
// twice.
//
// ── LOOPING CLIPS ARE EXCLUDED FROM THE CUT AND VOICE PIECES ────────────────
//
// `VisualItem.loop` (`schema.ts`) replays a clip's `[inPoint, outPoint)` source
// window repeatedly across the whole clip's TIMELINE span (`scheduler.ts`'s
// `placeInSource`). That breaks the one-to-one relation `sourceToTimeline` /
// `timelineToSource` assume above: a removal detected once in SOURCE time
// actually recurs at every wrap, and mapping it through either function picks
// exactly one of those timeline positions and calls it correct — silently, the
// removal still looks plausible, it just lands on the wrong repetition. Silence
// and filler removals depend on that one-to-one relation directly; so does the
// voice stem, because it is attached as a plain `AudioTrack` with a single
// `inPoint`/`outPoint` window and nothing plays an audio track more than once
// (see the restriction on `voiceTrackFor` below). `buildDraft` drops removals,
// and refuses to mint a stem, for a looping clip rather than act on either
// wrong. Loudness has NO coordinate mapping at all — it only assigns
// `item.volume` — so it is unaffected and stays available on a looping clip.
//
// Making the mapping loop-aware (one source removal fanning out to several
// timeline removals) is a real feature, not a bug fix: it touches cut
// ordering, caption ripple and stem windows, and is deliberately left undone
// here rather than half-built. See `pieceSupported` for the query surface and
// the cut-pooling step in `buildDraft` for the enforcement.

import type { Project } from '../types'
import type { AudioTrack, VisualItem, VisualTrack, Word } from '../schema'
import { mapTrackItems, normalizeTracks, trackItems } from './timeline/timeline-model'
import { applyCutToTracks, collapseGaps, type Cut } from './cuts'

// ── Constants ───────────────────────────────────────────────────────────────

/** Float slop for overlap and no-op checks. Matches `cuts.ts`'s own EPSILON, so
 *  a range that butts against a boundary here butts against it there too. */
const EPSILON = 0.001

/** How much a proposed silence removal may overlap an independently-detected
 *  KEEP range before the cross-check calls it out. `waveform_trim`'s energy
 *  thresholding has coarse edges, so a few tens of milliseconds of overlap at a
 *  boundary is normal; a real disagreement is far larger than this. */
const SILENCE_KEEP_TOLERANCE = 0.05

/** True-peak ceiling the gain is held under, in dBTP. Nothing distorts at or
 *  below this. */
const TRUE_PEAK_CEILING_DBTP = -1.5

/** Schema ceiling on `VisualItem.volume` (≈ +6 dB). */
const VOLUME_MAX = 2

// Flag reasons are rendered verbatim in the review list, so they follow the
// UI copy rule: no em dashes.
//
// The two caption reasons differ by the PRECISION of the evidence, and the
// operator is told which they are looking at rather than left to infer it: a
// word-level hit on a 200ms word is strong evidence, a whole-segment hit on a
// four-second segment is much weaker. See `captionWordsInSourceTime`.
const CAPTION_WORD_REASON = 'Overlaps a caption word.'
const CAPTION_SEGMENT_REASON =
  'Overlaps a caption segment. This clip has no word timings, so the check is less precise.'
const SILENCE_REASON = 'The independent silence check heard sound here. This may not be silence.'

// `pieceSupported`'s reasons, rendered verbatim as the "why is this greyed
// out" badge. No em dashes (UI copy rule), and — unlike the flag reasons
// above — NO TRAILING PERIOD, so the badge family reads as one voice.
const VOICE_SPEED_REASON = 'Voice isolation unavailable: this clip does not play at normal speed'
const VOICE_LOOP_REASON =
  'Voice isolation unavailable: this clip loops, so the isolated audio would drift out of sync'
const SILENCE_LOOP_REASON =
  'Silence removal unavailable: this clip loops, so cuts would land in the wrong place'
const FILLERS_LOOP_REASON =
  'Filler removal unavailable: this clip loops, so cuts would land in the wrong place'

// ── Types ───────────────────────────────────────────────────────────────────

/** A span the analysis proposes to remove. `text` is the recognized words, set
 *  by the filler piece. Times are in whichever space the producer works in —
 *  SOURCE for anything coming back from a step, TIMELINE once `mapRemovals` has
 *  been through it. */
export interface Removal {
  start: number
  end: number
  text?: string
}

/** A removal plus the guards' verdict. `flagged` removals default to OFF in the
 *  UI and require a deliberate tick. */
export interface FlaggedRemoval extends Removal {
  flagged: boolean
  /** Present only when `flagged`; user-facing. */
  reason?: string
}

/** A caption word pulled into a clip's source time, carrying HOW precisely it is
 *  known: `'word'` from a real word timing, `'segment'` from the whole-segment
 *  fallback (see `captionWordsInSourceTime`). Structurally still a `Word`. */
export interface SourceCaptionWord extends Word {
  precision: 'word' | 'segment'
}

/** The slice of `normalize --measure-only`'s pass-1 output the gain needs, in
 *  dB. Structurally satisfied by the `'loudness'` arm of `AudioPolishAnalysis`. */
export interface LoudnessStats {
  measuredI: number
  measuredTP: number
}

/** What the operator approved for one clip. Every field is independent: a piece
 *  that is switched off simply leaves its field absent. */
export interface ClipPlan {
  /** Approved removals, in this clip's SOURCE time — `buildDraft` maps them. */
  removals?: readonly Removal[]
  /** Gain in dB from `loudnessGainDb`. `buildDraft` folds in the track volume. */
  gainDb?: number
  /** Path to the isolated vocals WAV for this clip's source. */
  vocalsPath?: string
}

/** Everything the modal has decided, keyed by `VisualItem.id`. Clips absent
 *  from `clips` are left exactly as they are. */
export interface PolishPlan {
  clips: Readonly<Record<string, ClipPlan>>
}

// ── Scope ───────────────────────────────────────────────────────────────────

/**
 * The video clips the polish will act on: the current multi-selection when there
 * is one, otherwise every video clip on `tracks[0]`, in track order.
 *
 * Selected ids that are not video clips on `tracks[0]` (images, overlays, items
 * on a higher track) are dropped rather than widening the scope — an explicit
 * selection of nothing polishable means nothing to polish.
 */
export function targetClips<P extends Project>(
  project: P,
  selectionIds: readonly string[] = [],
): VisualItem[] {
  const items = (trackItems(project)[0] ?? []).filter(item => item.type === 'video')
  if (selectionIds.length === 0) return items
  const wanted = new Set(selectionIds)
  return items.filter(item => wanted.has(item.id))
}

// ── Coordinate mapping ──────────────────────────────────────────────────────

/** SOURCE seconds → TIMELINE seconds for one clip. */
export function sourceToTimeline(clip: VisualItem, t: number): number {
  return clip.start + (t - (clip.inPoint ?? 0)) / (clip.speed ?? 1)
}

/** TIMELINE seconds → SOURCE seconds for one clip. The inverse of the above,
 *  and what pulls caption words into source time for the guards. */
export function timelineToSource(clip: VisualItem, t: number): number {
  return (t - clip.start) * (clip.speed ?? 1) + (clip.inPoint ?? 0)
}

/**
 * Map source-time removals onto the timeline and clip them to `[clip.start,
 * clip.end]`, dropping anything that survives as nothing.
 *
 * Clipping is what makes a removal straddling a clip edge safe: the step
 * analysed a window of the source, but only the part of that window this clip
 * actually plays may be cut.
 */
export function mapRemovals(clip: VisualItem, removals: readonly Removal[]): Removal[] {
  const out: Removal[] = []
  for (const r of removals) {
    const start = Math.max(sourceToTimeline(clip, r.start), clip.start)
    const end = Math.min(sourceToTimeline(clip, r.end), clip.end)
    if (end - start <= EPSILON) continue
    out.push(r.text !== undefined ? { start, end, text: r.text } : { start, end })
  }
  return out
}

// ── Guard inputs ────────────────────────────────────────────────────────────

/**
 * The caption words overlapping this clip's timeline span, inverse-mapped into
 * the clip's SOURCE time so `flagRemovals` can compare them against step
 * removals without a second coordinate conversion.
 *
 * A segment carrying no `words` falls back to the segment's own span, marked
 * `precision: 'segment'`. Word-level timings are the normal case, but a segment
 * without them is still known-spoken audio, and checking `words[]` strictly
 * would leave such a project with zero protection while the modal reported the
 * guard as available — the worst failure mode there is for a guard that exists
 * to enforce never-cut-spoken-words. Over-flagging is the safe direction: a
 * flagged removal is not deleted, it is shown to the operator switched off. The
 * `precision` field is what lets the reason string say which kind of hit it was,
 * so weaker evidence reads as weaker.
 *
 * Words are NOT clamped to the clip span. The mapping is exact and monotone, so
 * clamping cannot change any overlap verdict for a removal that is itself inside
 * the clip, and leaving a word whole keeps its reported timing honest.
 */
export function captionWordsInSourceTime<P extends Project>(
  project: P,
  clip: VisualItem,
): SourceCaptionWord[] {
  const segments = project.captions?.segments ?? []
  const out: SourceCaptionWord[] = []
  for (const seg of segments) {
    const hasWords = Boolean(seg.words?.length)
    const words: Word[] = hasWords
      ? seg.words!
      : [{ word: seg.text, start: seg.start, end: seg.end }]
    for (const w of words) {
      if (w.end <= clip.start || w.start >= clip.end) continue
      out.push({
        word: w.word,
        start: timelineToSource(clip, w.start),
        end: timelineToSource(clip, w.end),
        precision: hasWords ? 'word' : 'segment',
      })
    }
  }
  return out
}

// ── The two guards ──────────────────────────────────────────────────────────

/** Overlap of two closed intervals; <= 0 when they merely touch or miss. */
function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.min(aEnd, bEnd) - Math.max(aStart, bStart)
}

/**
 * Run both safety guards over one clip's removals. **EVERY ARGUMENT IS IN THAT
 * CLIP'S SOURCE TIME** — see the coordinate note at the top of this file.
 *
 * 1. **Caption-word overlap.** A removal intersecting any caption word is
 *    claiming to delete something that was said. This is the mechanical form of
 *    the never-cut-spoken-words rule. Pass `captionWords` from
 *    `captionWordsInSourceTime`; an empty list or an absent one means the guard
 *    finds nothing (the modal decides whether to describe that as "no captions"
 *    rather than implying a check ran). A hit on a real word outranks a hit on
 *    a whole-segment fallback, so a removal that touches both reports the
 *    tighter, stronger reason.
 *
 * 2. **Independent silence cross-check.** `silenceKeeps` comes from
 *    `waveform_trim` — plain ffmpeg energy thresholding, which knows nothing
 *    about words, models or languages. A removal overlapping a KEEP range by
 *    more than `SILENCE_KEEP_TOLERANCE` is claiming that audibly non-silent
 *    audio is silence, which is the exact shape of the documented failure where
 *    a wrong-language transcription made real speech look like silence.
 *    **Silence piece only** — pass `silenceKeeps` only for that piece; filler
 *    removals are word-targeted by construction and are guarded by (1) plus the
 *    visible word text.
 *
 * When both fire the caption reason is reported: it is the stronger rule and the
 * one the operator needs to see.
 */
export function flagRemovals(
  removals: readonly Removal[],
  guards: {
    captionWords?: readonly SourceCaptionWord[]
    silenceKeeps?: readonly (readonly [number, number])[]
  },
): FlaggedRemoval[] {
  const { captionWords, silenceKeeps } = guards
  return removals.map(r => {
    const hits = captionWords?.filter(w => overlap(r.start, r.end, w.start, w.end) > EPSILON) ?? []
    if (hits.length > 0) {
      const reason = hits.some(w => w.precision === 'word')
        ? CAPTION_WORD_REASON
        : CAPTION_SEGMENT_REASON
      return { ...r, flagged: true, reason }
    }
    if (silenceKeeps?.some(k => overlap(r.start, r.end, k[0], k[1]) > SILENCE_KEEP_TOLERANCE)) {
      return { ...r, flagged: true, reason: SILENCE_REASON }
    }
    return { ...r, flagged: false }
  })
}

// ── Loudness ────────────────────────────────────────────────────────────────

/**
 * The gain, in dB, to put this clip at `targetI` LUFS without distorting:
 *
 *     gainDb = min(targetI - measuredI, TRUE_PEAK_CEILING - measuredTP)
 *
 * The first term is the level change `loudnorm` would make; the second holds it
 * back so true peak stays at or under −1.5 dBTP.
 *
 * NAMED LIMITATION: this is a level change plus a peak guard, not `loudnorm`'s
 * dynamic pass, and it levels each clip rather than mastering the finished mix.
 * Whole-mix mastering is a render change and is deliberately out of scope.
 */
export function loudnessGainDb(stats: LoudnessStats, targetI: number): number {
  return Math.min(targetI - stats.measuredI, TRUE_PEAK_CEILING_DBTP - stats.measuredTP)
}

/**
 * The `item.volume` that delivers `gainDb`, given the track's own gain:
 *
 *     item.volume = clamp(10^(gainDb/20) / (track.volume ?? 1), 0, 2)
 *
 * The engine folds item and track volume together before playback
 * (`effectiveItemAudio`), so the track gain is divided back out here to land on
 * the absolute level that was asked for.
 *
 * IDEMPOTENT BY CONSTRUCTION: the measurement behind `gainDb` reads the FILE,
 * never the project, and this result is ASSIGNED to `item.volume` rather than
 * multiplied into it, so re-running the polish converges instead of compounding.
 */
export function itemVolumeFor(gainDb: number, trackVolume?: number): number {
  return Math.min(VOLUME_MAX, Math.max(0, rawVolumeFor(gainDb, trackVolume)))
}

/** True when the requested gain needs more than the schema's 2.0 ceiling can
 *  deliver, so the UI can say the clip is under-lifted instead of silently
 *  under-delivering. */
export function volumeCeilingClamps(gainDb: number, trackVolume?: number): boolean {
  return rawVolumeFor(gainDb, trackVolume) > VOLUME_MAX
}

function rawVolumeFor(gainDb: number, trackVolume?: number): number {
  return Math.pow(10, gainDb / 20) / (trackVolume ?? 1)
}

// ── Voice isolation ─────────────────────────────────────────────────────────

function basename(p: string): string {
  return p.split('/').pop() ?? p
}

/**
 * The stem id for the `ordinal`-th surviving fragment of the planned clip
 * `baseId`, counting in timeline order.
 *
 * The whole point of the stable-id rule is that a re-run REPLACES its own tracks
 * instead of stacking duplicates beside them, so the id must depend only on the
 * baseline clip and the fragment's position — never on the fragment's OWN id,
 * which `cuts.ts` mints from `Date.now()` and `Math.random()` and which
 * therefore differs on every rebuild of the same draft.
 *
 * Ordinal 0 is the bare `polish_voice_<id>` the spec names, so the common
 * one-fragment case is unchanged. The `__<n>` suffix on the rest is a shape
 * neither `uniqueId` (`<base>_split_<…>`) nor `newClipId` (`clip_<…>`) nor
 * init's `clip-<n>` can produce, so a suffixed id cannot collide with a stem
 * named after some other real clip.
 */
function stemIdFor(baseId: string, ordinal: number): string {
  return ordinal === 0 ? `polish_voice_${baseId}` : `polish_voice_${baseId}__${ordinal + 1}`
}

/** Whether `trackId` is a stem this run owns on behalf of planned clip `baseId`
 *  — i.e. one `stemIdFor(baseId, …)` could have minted. */
function ownsStem(trackId: string, baseId: string): boolean {
  const bare = `polish_voice_${baseId}`
  if (trackId === bare) return true
  const suffix = trackId.startsWith(`${bare}__`) ? trackId.slice(bare.length + 2) : ''
  return suffix.length > 0 && /^\d+$/.test(suffix)
}

/**
 * The stem track for one clip, or `null` when the clip is not eligible.
 *
 * The vocals WAV is separated from the WHOLE source and stays 1:1 with it, so a
 * clip's slice of it is just the clip's own source window. `id` defaults to the
 * clip's own `polish_voice_<id>`; `buildDraft` passes a `stemIdFor` id instead,
 * because a fragment's id is not stable across rebuilds.
 *
 * RESTRICTION — SPEED 1 ONLY. `AudioTrack` has no tempo field and nothing plays
 * audio tracks at anything but native tempo: the renderer seeks with `-ss`/`-to`
 * and applies only `adelay`/`volume`/`afade`, and neither preview path
 * stretches. A clip's own inline audio does get an `atempo` chain, but that path
 * is not available to an audio track. So on a 2× clip the stem would play at
 * native tempo, overrun its slot and drift against the picture, silently.
 * Returning `null` lets the caller report the clip as skipped WITH the reason
 * instead. This is also why the `outPoint` formula below carries no `* speed`
 * factor: at speed 1 it is exact, and no other speed reaches it.
 *
 * RESTRICTION — NOT LOOPING EITHER, for the same underlying reason: `AudioTrack`
 * has no loop field either, so a stem placed at a single `[inPoint, outPoint)`
 * window plays that window once. A looping clip repeats that same source window
 * across its whole timeline span (`scheduler.ts`'s `placeInSource`), so a stem
 * built for it would track the picture for the first pass only and go silent,
 * or keep replaying the first pass, under every wrap after that. See the
 * LOOPING CLIPS note at the top of this file.
 *
 * Pass the FINAL, post-cut item — a clip that a cut split into fragments needs
 * one stem track per fragment, because the fragments are contiguous on the
 * timeline but discontiguous in the source and one track cannot follow both.
 */
export function voiceTrackFor(
  item: VisualItem,
  vocalsPath: string,
  id: string = stemIdFor(item.id, 0),
): AudioTrack | null {
  if ((item.speed ?? 1) !== 1) return null
  if (item.loop) return null
  const inPoint = item.inPoint ?? 0
  return {
    id,
    type: 'voiceover',
    src: vocalsPath,
    start: item.start,
    end: item.end,
    inPoint,
    outPoint: inPoint + (item.end - item.start),
    label: `Voice: ${item.src ? basename(item.src) : item.id}`,
  }
}

// ── Piece eligibility ───────────────────────────────────────────────────────

/**
 * The audio-polish pieces `pieceSupported` can be asked about. Matches
 * `AnalyzeAudioPolishArgs['piece']` (`types.ts`) exactly, including
 * `'silence-check'` — the whole-source `waveform_trim` dry run behind the
 * silence guard in `flagRemovals`, which is a distinct scheduled job from the
 * `'silence'` removal piece itself even though the two rise and fall together
 * (see the `'silence-check'` case below).
 */
export type PolishPiece = 'silence' | 'fillers' | 'loudness' | 'voice' | 'silence-check'

/** `pieceSupported`'s answer for one (clip, piece) pair. `reason` is present
 *  exactly when `available` is false, and is the badge string verbatim — the
 *  UI renders it, it does not reconstruct it from a boolean. */
export interface PieceSupport {
  available: boolean
  reason?: string
}

/**
 * Whether `piece` may run on `clip` at all, and — when it may not — the
 * user-facing reason why, so the modal has one thing to ask instead of
 * hardcoding the visible half of this module's rules itself (as it does
 * today for the speed badge). Every site that needs to know — the
 * voice-eligibility probe, the plan builder's per-piece gates, analysis
 * scheduling, the review-list badge, the per-piece error mapping — asks this,
 * never `clip.loop` or `clip.speed` directly. `buildDraft` enforces the same
 * answer on its own regardless of what a caller asks first.
 *
 * `'voice'` defers its AVAILABILITY to `voiceTrackFor` rather than re-testing
 * `loop` or `speed` here, so each restriction keeps exactly one home — the
 * same pattern the modal already uses for its own `voiceEligible`.
 * `voiceTrackFor` returning `null` says only THAT voice is blocked, not WHY,
 * so the reason is chosen here.
 *
 * PRECEDENCE, when a clip is both looping and sped up: voice reports the LOOP
 * reason, not the speed one. This is decided on the merits, not to match any
 * one caller's wording. `loop` excludes THREE pieces on this clip (silence,
 * fillers, voice); `speed` excludes only voice. Reporting "sped up" would give
 * the operator two different explanations for what reads as one broken clip —
 * and the speed one is individually misleading, since un-sped-up-ing the clip
 * would still leave voice blocked by `loop`. Reporting "loops" names the one
 * thing that actually has to change before ANY of the three pieces come back,
 * and — a weaker, secondary point — `loop` is the more consequential failure
 * of the two: ignored, it cuts the wrong audio outright, where `speed` only
 * desyncs a stem.
 */
export function pieceSupported(clip: VisualItem, piece: PolishPiece): PieceSupport {
  switch (piece) {
    // `'silence-check'` answers exactly as `'silence'` does: it is a pure
    // dry run that only ever FLAGS removals, never makes one, and with
    // `'silence'` itself excluded on a looping clip there is nothing left to
    // flag — running it would spend a real sidecar job on a check whose
    // result the operator will never see used.
    case 'silence':
    case 'silence-check':
      return clip.loop ? { available: false, reason: SILENCE_LOOP_REASON } : { available: true }
    case 'fillers':
      return clip.loop ? { available: false, reason: FILLERS_LOOP_REASON } : { available: true }
    case 'loudness':
      // No source window, no coordinate mapping — correct on every clip,
      // looping or not. Deliberately exempt: see the LOOPING CLIPS note at
      // the top of this file.
      return { available: true }
    case 'voice': {
      if (voiceTrackFor(clip, '') !== null) return { available: true }
      return { available: false, reason: clip.loop ? VOICE_LOOP_REASON : VOICE_SPEED_REASON }
    }
  }
}

// ── The apply ───────────────────────────────────────────────────────────────

/** Merge overlapping and touching ranges. Descending application is exact for
 *  DISJOINT ranges only: two overlapping cuts still leave the clips right (they
 *  lift) but ripple the captions by the sum of their durations instead of by the
 *  duration of their union. Silence and filler removals are disjoint by
 *  construction, so this is a no-op in the normal case and a cheap guarantee in
 *  every other one. */
function mergeRanges(ranges: readonly Cut[]): Cut[] {
  const out: Cut[] = []
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + EPSILON) last.end = Math.max(last.end, r.end)
    else out.push({ start: r.start, end: r.end })
  }
  return out
}

/**
 * The planned clip a surviving item descends from.
 *
 * A cut splits a clip into fragments whose ids `cuts.ts` mints as
 * `` `${originalId}_split_…` `` (nested splits stack the suffix), so an item
 * belongs to the planned clip that is either its exact id or a `_split_` prefix
 * of it. The LONGEST such match wins, so a project that was already cut once —
 * where both `a` and `a_split_x` can be planned clips in their own right —
 * resolves each fragment to its nearest ancestor rather than to `a`.
 */
function ancestorOf(itemId: string, plannedIds: readonly string[]): string | undefined {
  let best: string | undefined
  for (const id of plannedIds) {
    if (itemId !== id && !itemId.startsWith(`${id}_split_`)) continue
    if (best === undefined || id.length > best.length) best = id
  }
  return best
}

/**
 * Close the leading gap the polish itself opened, leaving one the operator
 * placed exactly where it was.
 *
 * WHY THIS EXISTS. `collapseGaps` compacts from `sorted[0].start`, so it never
 * touches the head of the timeline. Remove silence from the start of the first
 * clip and that clip's `start` advances with nothing to pull it back. The
 * operator gets black frames at the head — and, far worse, the captions have
 * ALREADY been rippled left past that cut by `applyCutToCaptions`, so every
 * caption ends up adrift from the footage it describes by exactly the width of
 * the gap.
 *
 * WHICH IS WHY CAPTIONS DO NOT MOVE HERE. This is not "slide the whole timeline
 * left". It is the CLIPS catching up to where the captions already are: the
 * cuts rippled the captions, the clips lifted and stayed put, and this closes
 * the difference. Shifting the captions again would double-count it — the same
 * bug the `remapCaptions` flag exists to prevent (see the invariant comment
 * above `collapseGaps` in cuts.ts), one level up.
 *
 * WHY THE DELTA IS MEASURED IN CUT MATERIAL rather than as
 * `leadAfter - leadBefore`. The two agree whenever the first clip survives its
 * cut, which is the ordinary case. They diverge when the plan empties the first
 * clip entirely AND a gap followed it: the positional difference then also
 * swallows that gap, while `applyCutToCaptions` only ever rippled by the CUT
 * duration, so the clips would overshoot the captions by the gap's width and
 * land every caption on the wrong clip. Counting the cut material that fell in
 * the head region is the exact statement of the rule — remove the offset the
 * polish introduced and nothing else. A project deliberately starting at 3s
 * still starts at 3s, and a gap the operator placed survives as a gap.
 *
 * WHY AUDIO TRACKS MOVE HERE THOUGH `collapseGaps` LEAVES THEM ALONE. Different
 * operations, different correct answers. `collapseGaps` closes an INTERIOR gap,
 * where a music bed should hold its own timing while a take is trimmed under
 * it. This re-bases the timeline's ORIGIN, where a bed that did not move would
 * desync against every frame after it.
 *   TRADE, accepted: a bed timed against the original start moves too. Right
 *   when the head was a false start, wrong when the bed was deliberately
 *   offset. The former is the common case.
 * A track that would be pushed before time 0 is head-TRIMMED instead (`start`
 * clamped to 0, `inPoint` advanced by the overshoot), which keeps it in perfect
 * sync with the picture and simply drops the part that sat under the removed
 * head. Negative start times are not representable downstream — `mix-audio.js`
 * delays with `adelay` off `start ?? 0`. A track that ends entirely inside the
 * removed head has nothing left to trim to, so it is left where it is rather
 * than deleted: losing an audio track is not this operation's call to make.
 *
 * Overlay items STARTING before the new head are likewise left where they are,
 * which is how `collapseGaps` already treats an overlay over material a cut
 * removed. Everything at or after the new head travels with the clips.
 */
function closeLeadGap<P extends Project>(draft: P, baseline: P, cuts: readonly Cut[]): P {
  const baseClips = trackItems(baseline)[0] ?? []
  const survivors = trackItems(draft)[0] ?? []
  // `Math.min()` of an empty list is Infinity, which would shift the whole
  // project to -Infinity. Every clip emptied, or none to begin with, is a no-op.
  if (baseClips.length === 0 || survivors.length === 0) return draft

  const leadBefore = Math.min(...baseClips.map(c => c.start))
  const leadAfter = Math.min(...survivors.map(c => c.start))

  let delta = 0
  for (const cut of cuts) {
    if (cut.start >= leadAfter) continue
    delta += Math.min(cut.end, leadAfter) - Math.max(cut.start, leadBefore)
  }
  if (delta <= EPSILON) return draft

  const tracks = mapTrackItems(draft, (items, i) =>
    items.map(item =>
      i !== 0 && item.start < leadAfter - EPSILON
        ? item
        : { ...item, start: item.start - delta, end: item.end - delta },
    ),
  )

  const audio = draft.audio
    ? { ...draft.audio, tracks: draft.audio.tracks.map(t => shiftAudioTrack(t, delta)) }
    : draft.audio

  return { ...draft, tracks, audio }
}

/** One audio track moved `delta` earlier, head-trimmed instead of going
 *  negative. See `closeLeadGap`. */
function shiftAudioTrack(track: AudioTrack, delta: number): AudioTrack {
  const start = track.start - delta
  const end = track.end - delta
  if (start >= 0) return { ...track, start, end }
  if (end <= EPSILON) return track          // entirely inside the removed head
  return { ...track, start: 0, end, inPoint: (track.inPoint ?? 0) - start }
}

/**
 * Apply a whole plan to a baseline project, returning a NEW project. The
 * baseline is never mutated, so the modal can rebuild the draft from the same
 * snapshot on every toggle.
 *
 * The order is the one documented at the top of this file and it is
 * load-bearing. Two details worth knowing at the call site:
 *
 *  - Removals arrive in each clip's SOURCE time and are mapped, clipped, then
 *    pooled across EVERY targeted clip into one global list which is applied
 *    back to front. Pooling globally is required: per-clip batching lets an
 *    earlier clip's cuts ripple the captions out from under a later clip's
 *    still-unmapped ranges. Descending order is required because
 *    `applyCutToCaptions` ripples later captions left, so a front-to-back pass
 *    would invalidate every not-yet-applied range.
 *  - The gap close runs only when at least one cut was made, so switching on
 *    the loudness or voice piece alone cannot silently close gaps the operator
 *    placed by hand. It is `collapseGaps`, so it closes pre-existing gaps
 *    between clips too, and it preserves the timeline's leading offset.
 */
export function buildDraft<P extends Project>(baseline: P, plan: PolishPlan): P {
  const plannedIds = Object.keys(plan.clips)
  if (plannedIds.length === 0) return baseline

  const byId = new Map((trackItems(baseline)[0] ?? []).map(item => [item.id, item]))

  // 1 — speech cuts, pooled across every clip and applied back to front.
  // A looping clip's removals are dropped here regardless of what the caller
  // asked for: `sourceToTimeline` would map each one onto exactly one of its
  // several timeline repetitions and call that correct. See the LOOPING CLIPS
  // note at the top of this file and `pieceSupported`.
  const pooled: Cut[] = []
  for (const id of plannedIds) {
    const item = byId.get(id)
    const removals = plan.clips[id].removals
    if (!item || !removals?.length || item.loop) continue
    for (const r of mapRemovals(item, removals)) pooled.push({ start: r.start, end: r.end })
  }
  const cuts = mergeRanges(pooled).sort((a, b) => b.start - a.start)

  let draft = baseline
  for (const cut of cuts) draft = applyCutToTracks(draft, cut)

  // 2 — one gap close, then the head. `collapseGaps` compacts from the first
  // clip's start and so cannot close a LEADING gap; `closeLeadGap` finishes the
  // job. Both run before loudness and voice, so clip geometry is final before
  // stem tracks are built against it. The cuts have already put the captions
  // where they belong, and neither of these moves them.
  if (cuts.length > 0) {
    draft = collapseGaps(draft, { remapCaptions: false })
    draft = closeLeadGap(draft, baseline, cuts)
  }

  const needsItemPass = plannedIds.some(id => {
    const cp = plan.clips[id]
    return byId.has(id) && (cp.gainDb !== undefined || cp.vocalsPath !== undefined)
  })
  if (!needsItemPass) return draft

  // 3 and 4 — loudness, then voice, both against the now-final clip geometry.
  const trackVolume = ((normalizeTracks(draft).tracks ?? []) as VisualTrack[])[0]?.volume
  const survivors = trackItems(draft)[0] ?? []

  // Each surviving fragment's ordinal within its planned clip, counted in
  // TIMELINE order so a stem id depends only on (baseline, plan) and never on
  // array order or on the fragment's own generated id.
  const ordinal = new Map<string, number>()
  const counted = new Map<string, number>()
  for (const item of [...survivors].sort((a, b) => a.start - b.start)) {
    const baseId = ancestorOf(item.id, plannedIds)
    if (baseId === undefined) continue
    const n = counted.get(baseId) ?? 0
    ordinal.set(item.id, n)
    counted.set(baseId, n + 1)
  }

  const voiceTracks: AudioTrack[] = []
  const newItems = survivors.map(item => {
    const baseId = ancestorOf(item.id, plannedIds)
    if (baseId === undefined) return item
    const { gainDb, vocalsPath } = plan.clips[baseId]

    let next = item
    if (gainDb !== undefined) next = { ...next, volume: itemVolumeFor(gainDb, trackVolume) }
    if (vocalsPath !== undefined) {
      // Mint and mute together or do neither: a fragment muted without a stem
      // track under it is a silent clip, which is the one outcome worse than
      // not isolating at all.
      const stem = voiceTrackFor(next, vocalsPath, stemIdFor(baseId, ordinal.get(item.id) ?? 0))
      if (stem) {
        voiceTracks.push(stem)
        next = { ...next, muted: true }
      }
    }
    return next
  })

  const withItems: P = {
    ...draft,
    tracks: mapTrackItems(draft, (items, i) => (i === 0 ? newItems : items)),
  }

  // This run OWNS the stems of every clip it was asked to isolate: drop that
  // clip's existing ones wholesale, then add the freshly minted set. Replacing
  // by id alone would strand a `__2` behind whenever a re-run's cuts leave the
  // clip in fewer fragments than the previous run did. Every audio track this
  // run does not own is left exactly as it was.
  const existing = draft.audio?.tracks ?? []
  const owners = plannedIds.filter(id => plan.clips[id].vocalsPath !== undefined)
  const kept = existing.filter(t => !owners.some(baseId => ownsStem(t.id, baseId)))
  if (voiceTracks.length === 0 && kept.length === existing.length) return withItems

  return { ...withItems, audio: { ...draft.audio, tracks: [...kept, ...voiceTracks] } }
}
