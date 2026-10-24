// render/filter-number.js
/**
 * A project.json number that goes into an ffmpeg filter graph as text (§563).
 *
 * ffmpeg parses the graph, so a value that arrives as text there could add an
 * option or a filter. Each check passes a number UNCHANGED, so a valid
 * project's arguments stay byte-identical. A numeric string ("30", " 0.8 ",
 * "1e-3"), which older projects hold and which always rendered, becomes its
 * number, so it builds exactly the arguments its number does. Anything else is
 * refused with an error naming the field.
 */

// A number written as text: optional sign, digits with an optional point, an optional exponent, spaces around.
const NUMERIC = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/

/** A number as it is, a numeric string as its number, anything else NaN. */
function asNumber(value) {
  if (typeof value === 'number') return value
  return typeof value === 'string' && NUMERIC.test(value) ? Number(value) : NaN
}

function refuse(field, want, value) {
  throw new Error(`${field} must be ${want}, got ${JSON.stringify(value)}`)
}

/** A finite number of at least `min`. */
export function finiteNumber(value, field, min = -Infinity) {
  const n = asNumber(value)
  if (Number.isFinite(n) && n >= min) return n
  refuse(field, min === 0 ? 'a number of zero or more' : 'a finite number', value)
}

/** A finite number above zero (a frame rate, a speed). */
export function positiveNumber(value, field) {
  const n = asNumber(value)
  if (Number.isFinite(n) && n > 0) return n
  refuse(field, 'a number above zero', value)
}

/** A whole number above zero (a size in pixels). */
export function pixelCount(value, field) {
  const n = asNumber(value)
  if (Number.isInteger(n) && n > 0) return n
  refuse(field, 'a whole number above zero', value)
}

/** `<width>x<height>` for an ffmpeg size option: settings.resolution's two whole numbers. */
export function frameSize(width, height) {
  return `${pixelCount(width, 'settings.resolution[0]')}x${pixelCount(height, 'settings.resolution[1]')}`
}
