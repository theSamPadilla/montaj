/**
 * SDR tone curves: which look an HDR project is tone-mapped through when the
 * render produces a standard-range (SDR) file.
 *
 * Background: an HDR project can export its HDR master untouched, an SDR
 * deliverable, or both. Every SDR deliverable goes through one of Montaj's
 * signature 3D LUTs — the curve decides how highlights land once the extra HDR
 * range is folded down.
 *
 * The preview, the proxies and the editor thumbnails ALWAYS use the default
 * curve. This picker changes the exported file only, which is why choosing a
 * non-default curve swaps the modal's honesty line (see `honestyLine` below).
 *
 * Keep ids in sync with the `curves` keys in montaj_assets/luts/looks.json,
 * which is what the render pipeline validates against.
 */
export type SdrCurve = 'vivid1' | 'vivid1-neutral'

export const DEFAULT_SDR_CURVE: SdrCurve = 'vivid1'

export interface SdrCurveInfo {
  id: SdrCurve
  label: string
  /** One-line summary shown under the label. Plain English, no jargon. */
  blurb: string
}

export const SDR_CURVES: SdrCurveInfo[] = [
  {
    id: 'vivid1',
    label: 'Montaj Vivid',
    blurb: 'The signature look. Rich color with highlights rolled off gently, and what your preview shows.',
  },
  {
    id: 'vivid1-neutral',
    label: 'Neutral brights',
    blurb: 'The same color, with flatter bright areas. Calmer on skies, windows and lit skin.',
  },
]

/** Descriptor for a curve id, or the default curve's when the id is unknown. */
export function sdrCurveInfo(id: string | undefined): SdrCurveInfo {
  return SDR_CURVES.find(c => c.id === id) ?? SDR_CURVES[0]
}

/**
 * The line under the curve picker. On the default curve it tells the user how
 * each export relates to what they are looking at; on any other curve it
 * becomes a caveat, because the preview is always Montaj Vivid and the export
 * no longer matches it.
 */
export function honestyLine(curve: string | undefined): string {
  return (curve ?? DEFAULT_SDR_CURVE) === DEFAULT_SDR_CURVE
    ? 'SDR export matches this preview; HDR export adds highlight range on HDR displays.'
    : 'Heads up: this export will not match your preview. The preview always uses Montaj Vivid, so the curve you picked shows up in the exported file only.'
}
