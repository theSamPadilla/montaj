// render/filter-number.js
/**
 * A project.json number that goes into an ffmpeg filter graph as text (§563).
 *
 * ffmpeg parses the graph, so a value that arrives as text there could add an
 * option or a filter. Each check passes a valid value through UNCHANGED, so a
 * valid project's arguments stay byte-identical, and refuses anything else
 * with an error naming the field.
 */

/** A finite number, unchanged. */
export function finiteNumber(value, field) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new Error(`${field} must be a finite number, got ${JSON.stringify(value)}`)
}

/** A finite number above zero (a frame rate, a speed), unchanged. */
export function positiveNumber(value, field) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  throw new Error(`${field} must be a number above zero, got ${JSON.stringify(value)}`)
}

/** A whole number above zero (a size in pixels), unchanged. */
export function pixelCount(value, field) {
  if (Number.isInteger(value) && value > 0) return value
  throw new Error(`${field} must be a whole number above zero, got ${JSON.stringify(value)}`)
}

/** `<width>x<height>` for an ffmpeg size option: settings.resolution's two whole numbers, unchanged. */
export function frameSize(width, height) {
  return `${pixelCount(width, 'settings.resolution[0]')}x${pixelCount(height, 'settings.resolution[1]')}`
}

/** `value` cast with Number(): a number of at least `min`, unchanged when it already was one. For fields an older
 *  project may hold as a numeric string (an opacity, a volume), which have always worked and must keep working. */
export function castNumber(value, field, min = -Infinity) {
  const n = typeof value === 'number' ? value : Number(value)
  if (Number.isFinite(n) && n >= min) return n
  const want = min === 0 ? 'a number of zero or more' : 'a finite number'
  throw new Error(`${field} must be ${want}, got ${JSON.stringify(value)}`)
}
