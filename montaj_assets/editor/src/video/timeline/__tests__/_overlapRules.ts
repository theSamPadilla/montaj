/**
 * The two overlap shapes `engine/validate.py` rejects on a project's visual
 * tracks (lines 566-635), restated for the editor's tests. There is no
 * editor-side validator to call, so the shapes are checked directly:
 *
 * - CONTAINMENT, on every track except tracks[0]: one item's span swallows a
 *   neighbour's, identical spans included (`<=`/`>=`, so touching ends count).
 * - THREE OR MORE ITEMS LIVE at one instant, on every track: `start <= t < end`
 *   at some item's start.
 *
 * Not a test file (no `.test.`), same convention as `_canvasSelect.ts`.
 */
import type { Project } from '../../../types'
import { trackItems } from '../timeline-model'

/** Every violation in `project`, as readable strings. Empty means the
 *  validator would accept its visual tracks' overlaps. */
export function overlapViolations(project: Project): string[] {
  const out: string[] = []
  trackItems(project).forEach((items, i) => {
    const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end)
    if (i !== 0) {
      for (let x = 0; x < sorted.length; x++) {
        for (let y = x + 1; y < sorted.length; y++) {
          const a = sorted[x]
          const b = sorted[y]
          if (b.start >= a.end) break
          if ((a.start <= b.start && a.end >= b.end) || (b.start <= a.start && b.end >= a.end)) {
            out.push(`tracks[${i}]: ${a.id} (${a.start}-${a.end}) and ${b.id} (${b.start}-${b.end}) are a containment`)
          }
        }
      }
    }
    for (const probe of sorted) {
      const t = probe.start
      const live = sorted.filter(x => x.start <= t && t < x.end)
      if (live.length > 2) out.push(`tracks[${i}]: ${live.length} items live at t=${t} (${live.map(x => x.id).join(', ')})`)
    }
  })
  return out
}
