// Source-capped export resolution/fps ceiling for a project. Pure — the export
// dialog uses this to decide which resolution/fps tiers are worth offering, so
// we never upscale past what the source footage actually carries.

import type { EditorProject as Project } from '../schema'
import { trackItems } from './timeline/timeline-model'

/** Short-side "class" a tier is named after — 720p / 1080p / 1440p / 2160p. */
export const STANDARD_RESOLUTION_TIERS = [720, 1080, 1440, 2160] as const

export const STANDARD_FPS_TIERS = [24, 30, 60] as const

// ── Internal helpers ────────────────────────────────────────────────────────

/** Max, across video items with known source dims, of `min(sourceWidth, sourceHeight)`.
 *  Undefined when no video item carries usable dims. Goes through `trackItems()`
 *  (not `project.tracks` directly) so a project still on disk in the legacy
 *  `VisualItem[][]` shape — a bare array of item arrays, with no `.items` to
 *  read — is tolerated the same way every other reader tolerates it. */
function maxSourceShortSide(project: Project): number | undefined {
  let max: number | undefined
  for (const items of trackItems(project)) {
    for (const item of items) {
      if (item.type !== 'video') continue
      const { sourceWidth: sw, sourceHeight: sh } = item
      if (!sw || !sh || sw <= 0 || sh <= 0) continue
      const short = Math.min(sw, sh)
      if (max === undefined || short > max) max = short
    }
  }
  return max
}

/** Converts a short-side tier to [w,h], preserving the project's aspect and
 *  orientation. Long side is rounded to the nearest EVEN integer (encoders
 *  demand even dims). */
function tierToResolution(tier: number, project: Project): [number, number] {
  const [pw, ph] = project.settings.resolution
  const shortP = Math.min(pw, ph)
  const longP = Math.max(pw, ph)
  if (shortP === 0) return [tier, tier]

  const ratio = longP / shortP
  const longSide = Math.round((tier * ratio) / 2) * 2
  return pw <= ph ? [tier, longSide] : [longSide, tier]
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Source-capped export resolution ceiling as [w,h]. Falls back to
 *  `project.settings.resolution` verbatim when no video clip carries source
 *  dims, or when the source is smaller than the smallest standard tier. */
export function maxExportResolution(project: Project): [number, number] {
  const maxShort = maxSourceShortSide(project)
  if (maxShort === undefined) return project.settings.resolution

  const tier = [...STANDARD_RESOLUTION_TIERS].reverse().find(t => t <= maxShort)
  if (tier === undefined) return project.settings.resolution

  return tierToResolution(tier, project)
}

/** Source-capped export fps ceiling. No per-clip source-fps exists in the
 *  schema, so this is just the project's own setting (default 30). */
export function maxExportFps(project: Project): number {
  return project.settings.fps ?? 30
}

/** Every resolution tier offerable in the export dialog, as [w,h] preserving
 *  project aspect, filtered to the source cap and ordered ascending. Always
 *  non-empty — falls back to the project's current resolution when the source
 *  is below every standard tier. */
export function availableResolutionTiers(project: Project): Array<[number, number]> {
  const maxShort = maxSourceShortSide(project)
  const capShort = maxShort ?? Math.min(...project.settings.resolution)

  const tiers = STANDARD_RESOLUTION_TIERS.filter(t => t <= capShort).map(t => tierToResolution(t, project))
  return tiers.length > 0 ? tiers : [project.settings.resolution]
}

/** Every fps tier offerable in the export dialog, filtered to the source cap
 *  and ordered ascending. Always non-empty. */
export function availableFpsTiers(project: Project): number[] {
  const cap = maxExportFps(project)
  const tiers = STANDARD_FPS_TIERS.filter(f => f <= cap)
  return tiers.length > 0 ? tiers : [cap]
}

/** The tier from `availableResolutionTiers` matching the project's CURRENT
 *  `settings.resolution` (by short-side), or the nearest smaller one.
 *  Convenience for the export dialog's default selection. */
export function currentResolutionTier(project: Project): [number, number] | undefined {
  const tiers = availableResolutionTiers(project)
  if (tiers.length === 0) return undefined

  const currentShort = Math.min(...project.settings.resolution)
  const exact = tiers.find(([w, h]) => Math.min(w, h) === currentShort)
  if (exact) return exact

  const smaller = [...tiers].reverse().find(([w, h]) => Math.min(w, h) <= currentShort)
  return smaller ?? tiers[0] // current is below every offered tier — nearest is the smallest one
}
