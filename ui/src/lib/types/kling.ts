// GENERATED FROM schema/enums.yaml — DO NOT EDIT BY HAND.
// Run `python3 scripts/gen_types.py` after editing the YAML source.

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const
export type AspectRatio = typeof ASPECT_RATIOS[number]
export const DEFAULT_ASPECT_RATIO: AspectRatio = '16:9'

export function isAspectRatio(value: unknown): value is AspectRatio {
  return typeof value === 'string' && (ASPECT_RATIOS as readonly string[]).includes(value)
}

export function normalizeAspectRatio(value: unknown): AspectRatio {
  if (value === null || value === undefined) return DEFAULT_ASPECT_RATIO
  if (isAspectRatio(value)) return value
  // eslint-disable-next-line no-console
  console.warn(
    `Unknown aspect_ratio ${JSON.stringify(value)} — falling back to ${DEFAULT_ASPECT_RATIO}. ` +
    `Valid values: ${ASPECT_RATIOS.join(', ')}`,
  )
  return DEFAULT_ASPECT_RATIO
}
