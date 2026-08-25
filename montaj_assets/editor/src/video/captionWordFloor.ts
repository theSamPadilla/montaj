/**
 * captionWordFloor — TS mirror of steps/lyrics/caption.py's
 * `floor_word_durations`. Same waterfall, same constant (50ms — enough for
 * >=1 frame at every fps montaj ships), same binary donation gate: a shared
 * boundary between two words moves fully to `start_i + floor` or not at
 * all, never partially, because the per-word caption templates select with
 * `.find()` (first match wins) — a partial donation would leave a sliver of
 * dead time where nothing matches, reproducing the invisibility bug the
 * floor exists to fix. See caption.py's docstring for the full rationale;
 * this file only documents the one deliberate divergence from it.
 *
 * WHY A MIRROR EXISTS AT ALL: caption.py is the single funnel for the SSE
 * route and the CLI step, but two editor-side generators independently
 * invent word timings with no minimum — `captionRepair.ts` and
 * `makeCaptionEdit.ts`, both via a uniform `segDur / n` spread. This helper
 * is applied to that spread's output, but on a uniform spread the donation
 * gate is unsatisfiable by construction: it needs `2*dur - floor >= floor`,
 * i.e. `dur >= floor`, which contradicts `dur < floor` — the precondition
 * for a word being short enough to enter this function's donation logic at
 * all. So the call is inert at both sites today; this file exists so a
 * future non-uniform editor spread is covered without anyone having to
 * remember it. (Hand-authored `PUT` captions stay uncovered by design —
 * Montaj stores whatever it receives.)
 *
 * AND THAT INERTNESS IS DELIBERATE — do not "fix" it by widening the
 * segment. The only way to give n words a floor inside a fixed segment is
 * to make the segment longer (a uniform spread has no surplus to
 * redistribute: `dur < floor` implies `segDur < n * floor`), and montaj
 * follows CapCut here — editing a caption's text never moves its end.
 * Duration is the user's to set; a caption holding more words than it has
 * room for shows them fast, and the remedy is to lengthen or split the
 * caption, both of which the timeline supports via caption trim handles.
 * Auto-growing a caption because its text changed would surprise anyone
 * coming from CapCut. See MASTER.md open thread 1.
 *
 * THE ONE DIVERGENCE: caption.py runs at the flatten, before any segment
 * exists, so its transcript-final word has no `seg_end` to clamp against and
 * is extended unconditionally into trailing silence. This mirror runs
 * per-segment instead — both call sites regenerate `words` for ONE segment
 * at a time from a freshly uniform-spread duration — so a segment end IS
 * available here, and the segment-final word is extended only up to
 * `segEnd`, never past it: overrunning the segment boundary would bleed
 * this caption's last word into whatever comes next on the timeline.
 */
import type { Word } from '../schema'

export const MIN_WORD_DURATION_S = 0.05

export function floorWordDurations(words: Word[], segEnd: number, floorS = MIN_WORD_DURATION_S): Word[] {
  if (words.length === 0) return words

  const out = words.map((w) => ({ ...w }))
  const n = out.length
  for (let i = 0; i < n; i++) {
    const dur = out[i].end - out[i].start
    if (dur >= floorS) continue

    if (i + 1 >= n) {
      // Segment-final word: extend up to the floor, clamped at segEnd — the
      // one divergence from caption.py, see file header.
      out[i].end = Math.min(out[i].end + (floorS - dur), segEnd)
      continue
    }

    const gap = out[i + 1].start - out[i].end
    if (gap > 0) {
      // Non-contiguous: spend existing slack, never touch the successor.
      out[i].end = Math.min(out[i].end + (floorS - dur), out[i + 1].start)
      continue
    }

    // Contiguous: binary donation gate on the shared boundary.
    const candidateBoundary = out[i].start + floorS
    const successorNewDur = out[i + 1].end - candidateBoundary
    if (successorNewDur >= floorS) {
      out[i].end = candidateBoundary
      out[i + 1].start = candidateBoundary
    }
    // else: donation refused. Word i is left completely unchanged.
  }

  return out
}
