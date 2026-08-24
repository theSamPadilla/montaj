import type { Project } from '../../types'
import type { CaptionSegment } from '../../schema'
import { floorWordDurations } from '../captionWordFloor'

/** Fields `makeCaptionEdit` can patch onto a single caption segment. */
export type CaptionEditPatch = Partial<CaptionSegment>

export function makeCaptionEdit(
  target: number | string,
  project: Project,
  onProjectChange?: (p: Project) => void,
  onCaptionEdit?: (p: Project) => void,
) {
  return (patch: string | CaptionEditPatch) => {
    if (!project.captions) return
    const segments = project.captions.segments
    // `target` addresses a segment by index (legacy call sites) or by `id`
    // (new callers). A non-matching target is a no-op — no update, no callback.
    const idx = typeof target === 'number' ? target : segments.findIndex((s) => s.id === target)
    if (idx < 0 || idx >= segments.length) return

    // A bare string is sugar for `{ text }`, preserving EditableSegment's contract.
    const patchObj: CaptionEditPatch = typeof patch === 'string' ? { text: patch } : patch
    // Only keys explicitly present (and not undefined) may overwrite the
    // segment — an omitted or undefined key must never clobber the existing value.
    const definedPatch = Object.fromEntries(
      Object.entries(patchObj).filter(([, v]) => v !== undefined),
    ) as CaptionEditPatch

    const updated = {
      ...project,
      captions: {
        ...project.captions,
        segments: segments.map((s, j) => {
          if (j !== idx) return s
          const next: CaptionSegment = { ...s, ...definedPatch }
          if (definedPatch.text === undefined) return next
          // Respread words evenly across the segment duration. Applied AFTER the
          // patch merge so a combined `{ text, start, end }` edit retimes words
          // against the new duration, not the stale one.
          const newWords = next.text.split(/\s+/).filter(Boolean)
          const segDur = next.end - next.start
          const wordDur = segDur / (newWords.length || 1)
          const spreadWords = newWords.map((w, wi) => ({
            word: w,
            start: next.start + wi * wordDur,
            end: next.start + (wi + 1) * wordDur,
          }))
          // Uniform spread has no minimum of its own — floor it so a short
          // word never falls below a frame at any fps. See captionWordFloor.ts.
          next.words = floorWordDurations(spreadWords, next.end)
          return next
        }),
      },
    }
    onProjectChange?.(updated)
    onCaptionEdit?.(updated)
  }
}
