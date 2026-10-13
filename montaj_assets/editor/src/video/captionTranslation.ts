import type { CaptionSegment } from '../schema'

/**
 * §244: a translated caption segment — its language in `lang`, the ids of the
 * source segments it translates in `translationOf`, and no word timings. The
 * caption templates draw it as a plain line stacked under its source, inside
 * the source's block, so it has no words to invent, no position of its own
 * while stacked, and does not count as a row a regeneration replaces.
 */
export function isCaptionTranslation(seg: Pick<CaptionSegment, 'lang' | 'translationOf'>): boolean {
  return typeof seg.lang === 'string' && Array.isArray(seg.translationOf)
}
