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

/** The fields "Apply to all" writes onto every segment: the preview's
 *  position (`offsetX`/`offsetY`) and size (`scale`), and the base text
 *  `color`. Nothing else is ever spread across segments. */
const ALL_SEGMENT_FIELDS = ['offsetX', 'offsetY', 'scale', 'color'] as const
export type CaptionEditAllPatch = Partial<Pick<CaptionSegment, typeof ALL_SEGMENT_FIELDS[number]>>

/**
 * The segment-wide sibling of `makeCaptionEdit`, for the captions panel's
 * "Apply to all": every segment gets the SAME ABSOLUTE values the edited one
 * got (not a delta), in one project change, so the host can land it as one
 * undo step.
 *
 * Only `ALL_SEGMENT_FIELDS` are read from the patch, so a stray `text` or
 * `start`/`end` can never be copied onto every caption. An omitted or
 * undefined key never clobbers a segment's own value. A no-op (no callback,
 * so no empty undo step) when there is nothing to write: no segments, an
 * empty patch, or every segment already holding exactly these values.
 */
export function makeCaptionEditAll(
  project: Project,
  onProjectChange?: (p: Project) => void,
  onCaptionEdit?: (p: Project) => void,
) {
  return (patch: CaptionEditAllPatch) => {
    const captions = project.captions
    if (!captions || captions.segments.length === 0) return
    const definedPatch: CaptionEditAllPatch = {}
    for (const key of ALL_SEGMENT_FIELDS) {
      if (patch[key] !== undefined) (definedPatch as Record<string, unknown>)[key] = patch[key]
    }
    const keys = Object.keys(definedPatch) as (keyof CaptionEditAllPatch)[]
    if (keys.length === 0) return
    if (captions.segments.every((s) => keys.every((k) => s[k] === definedPatch[k]))) return

    const updated = {
      ...project,
      captions: { ...captions, segments: captions.segments.map((s) => ({ ...s, ...definedPatch })) },
    }
    onProjectChange?.(updated)
    onCaptionEdit?.(updated)
  }
}
