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

function repairSegment(seg: CaptionSegment): CaptionSegment {
  const wordsText = (seg.words ?? []).map(w => w.word).join(' ')
  if (wordsText.trim().toLowerCase() === seg.text.trim().toLowerCase()) return seg

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
