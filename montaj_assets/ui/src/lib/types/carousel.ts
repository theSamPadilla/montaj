// GENERATED FROM schema/enums.yaml — DO NOT EDIT BY HAND.
// Run `python3 scripts/gen_types.py` after editing the YAML source.

export const CAROUSEL_ASPECTS = ['square', 'portrait', 'vertical'] as const
export type CarouselAspect = typeof CAROUSEL_ASPECTS[number]
export const DEFAULT_CAROUSEL_ASPECT: CarouselAspect = 'square'

export function isCarouselAspect(value: unknown): value is CarouselAspect {
  return typeof value === 'string' && (CAROUSEL_ASPECTS as readonly string[]).includes(value)
}

export function normalizeCarouselAspect(value: unknown): CarouselAspect {
  if (value === null || value === undefined) return DEFAULT_CAROUSEL_ASPECT
  if (isCarouselAspect(value)) return value
  // eslint-disable-next-line no-console
  console.warn(
    `Unknown carousel_aspect ${JSON.stringify(value)} — falling back to ${DEFAULT_CAROUSEL_ASPECT}. ` +
    `Valid values: ${CAROUSEL_ASPECTS.join(', ')}`,
  )
  return DEFAULT_CAROUSEL_ASPECT
}

export const CAROUSEL_RESOLUTIONS = {
  'square': [1080, 1080],
  'portrait': [1080, 1350],
  'vertical': [1080, 1920],
} as const satisfies Record<CarouselAspect, readonly [number, number]>
