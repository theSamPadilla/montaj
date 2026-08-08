/**
 * repairCaptionWords — pure caption-data normalizer.
 *
 * When a caption segment's text has been edited inline, `seg.words[]` may lag
 * behind and hold stale word text (or be missing entirely). This function walks
 * every segment and, whenever the words[] text diverges from `seg.text`,
 * regenerates words with uniform timing across [seg.start, seg.end].
 *
 * Returns the repaired `Captions` object when at least one segment was changed,
 * or `null` when the data was already consistent (so callers can skip the
 * downstream save/notify).
 */
import type { Captions, CaptionSegment } from '../schema'

// Collapses any run of whitespace to a single space, in addition to trim +
// case-fold, before the two sides are compared. `newWords` below is always
// rejoined with single spaces, so comparing against a non-collapsed `seg.text`
// would forever "diverge" whenever the segment's text contains a double space,
// tab, or newline between words: repairSegment would re-repair on every call,
// producing a same-content but referentially-new `words` array each time. A
// caller that re-invokes this after every repair (VideoEditor's caption-repair
// effect does, to catch mid-session caption regeneration) depends on repairing
// converging to a true no-op on the very next pass — without this
// normalization it never would, and that caller would applyExternal forever.
const normalizeForCompare = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

function repairSegment(seg: CaptionSegment): CaptionSegment {
  const wordsText = (seg.words ?? []).map(w => w.word).join(' ')
  if (normalizeForCompare(wordsText) === normalizeForCompare(seg.text)) return seg

  const newWords = seg.text.split(/\s+/).filter(Boolean)
  const segDur = seg.end - seg.start
  const wordDur = segDur / (newWords.length || 1)
  return {
    ...seg,
    words: newWords.map((w, i) => ({
      word: w,
      start: seg.start + i * wordDur,
      end: seg.start + (i + 1) * wordDur,
    })),
  }
}

export function repairCaptionWords(captions: Captions): Captions | null {
  let changed = false
  const repairedSegments = captions.segments.map(seg => {
    const repaired = repairSegment(seg)
    if (repaired !== seg) changed = true
    return repaired
  })
  if (!changed) return null
  return { ...captions, segments: repairedSegments }
}
