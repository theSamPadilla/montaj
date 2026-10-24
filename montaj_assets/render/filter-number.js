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
