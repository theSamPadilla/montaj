/**
 * captionActiveWord — derives the ONE caption word currently under the
 * playhead, for the caption-styling panel's live font specimen (it shows the
 * actual word from the user's video, rendered in the candidate typeface, so
 * a font choice is judged against real content rather than a placeholder).
 *
 * DERIVED, NOT SELECTED — deliberately. The editor has no word-level
 * selection: `selectedIds` (CaptionListPanel.tsx:76) is segment-level and
 * shared across captions, clips, and audio. Inventing a word-selection model
 * just for a font preview would mean touching that shared selection system
 * for no benefit elsewhere. The playhead already tells us which word the
 * user is looking at, so this module reads it from there instead.
 *
 * The active-segment test mirrors two existing call sites exactly rather than
 * inventing a third notion of "active": the half-open `currentTime >= start
 * && currentTime < end` predicate is `CaptionListPanel`'s row-highlight test
 * and the caption render templates' `activeSegments` test. Segments can be
 * simultaneously active across different lanes (`seg.lane`, see
 * `captionLanes.ts`); when more than one is active this picks the operator's
 * selection if it's among them, else the highest lane — the caption painted
 * last and therefore on top — mirroring the target-segment pick in
 * `preview/CaptionPreview.tsx`.
 */
import type { CaptionSegment, Captions } from '../schema'
import { laneOf } from './captionLanes'

export interface ActiveCaptionWord {
  word: string
  segmentId?: string
}

const isSegmentActive = (seg: CaptionSegment, t: number): boolean => t >= seg.start && t < seg.end

/** Non-empty after trimming, else `undefined` — the shared guard behind the
 *  "never return an empty-string word" rule: a hand-authored segment can have
 *  blank `text` and no `words`, and that must read as "no word", not `''`. */
function nonEmpty(s: string | undefined): string | undefined {
  const trimmed = s?.trim()
  return trimmed ? s : undefined
}

/** A segment's own first word, for when the playhead doesn't land inside any
 *  `words[]` span: the segment's first transcribed word if it has one,
 *  else the first whitespace-separated token of its `text` (segments authored
 *  without word-level timing, e.g. non-animated styles). */
function firstWordOfSegment(seg: CaptionSegment): string | undefined {
  return nonEmpty(seg.words?.[0]?.word) ?? nonEmpty(seg.text?.trim().split(/\s+/)[0])
}

export function activeCaptionWord(
  captions: Captions | undefined,
  currentTime: number,
  selectedSegmentId?: string,
): ActiveCaptionWord | null {
  const segments = captions?.segments ?? []
  const activeSegs = segments.filter((seg) => isSegmentActive(seg, currentTime))

  let target: CaptionSegment | undefined
  if (activeSegs.length > 0) {
    target =
      (selectedSegmentId ? activeSegs.find((seg) => seg.id === selectedSegmentId) : undefined) ??
      activeSegs.reduce((top, seg) => (laneOf(seg) > laneOf(top) ? seg : top))
  } else if (selectedSegmentId) {
    target = segments.find((seg) => seg.id === selectedSegmentId)
  }

  if (!target) return null

  const spanningWord = target.words?.find((word) => currentTime >= word.start && currentTime < word.end)
  const word = nonEmpty(spanningWord?.word) ?? firstWordOfSegment(target)
  if (!word) return null

  return { word, segmentId: target.id }
}
