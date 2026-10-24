import type { Project } from '../../types'
import type { CaptionSegment } from '../../schema'
import { floorWordDurations } from '../captionWordFloor'
import { isCaptionTranslation } from '../captionTranslation'

/**
 * §558: the words of an edited text that are the old words, unchanged, paired by a longest common subsequence of
 * their text: `[old index, new index]`. Compared case and punctuation aside (captionRepair's key), so "pauses" typed
 * as "pauses," is the same word. A word's own `color` and `accent` are carried over these pairs, so retyping one word
 * of a caption never drops what another word carries.
 */
const wordKey = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

export function unchangedWords(oldRaw: readonly string[], newRaw: readonly string[]): Array<[number, number]> {
  const oldWords = oldRaw.map(wordKey)
  const newWords = newRaw.map(wordKey)
  const n = oldWords.length
  const m = newWords.length
  const len: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i][j] = oldWords[i] === newWords[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1])
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldWords[i] === newWords[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (len[i + 1][j] >= len[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  return pairs
}

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
          // §244: a translation keeps no words (it draws as a plain line).
          if (definedPatch.text === undefined || isCaptionTranslation(next)) return next
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
          const floored = floorWordDurations(spreadWords, next.end)
          // §558: a word whose text is unchanged keeps its own colour and accent.
          const oldWords = Array.isArray(s.words) ? s.words : []
          for (const [oi, ni] of unchangedWords(oldWords.map((w) => w?.word ?? ''), newWords)) {
            const color = oldWords[oi]?.color
            const accent = oldWords[oi]?.accent
            if (typeof color === 'string' && color) floored[ni] = { ...floored[ni], color }
            if (accent) floored[ni] = { ...floored[ni], accent }
          }
          next.words = floored
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

/**
 * The selection sibling of `makeCaptionEditAll`: a DIFFERENT patch per
 * segment, keyed by id, landed as one project change so the host records one
 * undo step for the whole selection. Used when "Apply to all" is off and
 * several captions are selected, where each caption keeps its own geometry
 * and takes the same relative change (see `captionGroupDragPatches`).
 *
 * The same field guard as "Apply to all": only `ALL_SEGMENT_FIELDS` are read,
 * so text and timing can never be written across a selection. Ids that match
 * no segment are ignored. A no-op (no callback) when nothing would change.
 */
export function makeCaptionEditMany(
  project: Project,
  onProjectChange?: (p: Project) => void,
  onCaptionEdit?: (p: Project) => void,
) {
  return (patches: Record<string, CaptionEditAllPatch>) => {
    const captions = project.captions
    if (!captions) return
    let changed = false
    const segments = captions.segments.map((s) => {
      // Own keys only: project.json is hand-editable, so an id like
      // `constructor` must not read through to Object.prototype.
      const patch = s.id !== undefined && Object.prototype.hasOwnProperty.call(patches, s.id) ? patches[s.id] : undefined
      if (!patch) return s
      const definedPatch: CaptionEditAllPatch = {}
      for (const key of ALL_SEGMENT_FIELDS) {
        if (patch[key] !== undefined && patch[key] !== s[key]) (definedPatch as Record<string, unknown>)[key] = patch[key]
      }
      if (Object.keys(definedPatch).length === 0) return s
      changed = true
      return { ...s, ...definedPatch }
    })
    if (!changed) return
    const updated = { ...project, captions: { ...captions, segments } }
    onProjectChange?.(updated)
    onCaptionEdit?.(updated)
  }
}
