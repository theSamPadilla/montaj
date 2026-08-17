/**
 * Parse a user-typed timecode into seconds, for the command palette's
 * "go to time" entry. Accepted shapes:
 *
 *   - bare seconds:  "90", "12.5"
 *   - mm:ss:         "1:30", "12:03.5"
 *   - hh:mm:ss:      "01:02:03", "1:02:03.25"
 *
 * A fractional part is only valid on the LAST component (seconds) — "1.5:30"
 * is rejected. Minutes/seconds components (everywhere except the leading
 * hours) must be < 60. Anything that doesn't match — empty input, letters,
 * too many `:` groups, out-of-range minutes/seconds — returns `null`.
 */
export function parseTimecode(input: string): number | null {
  const trimmed = input.trim()
  if (!/^\d+(:\d+){0,2}(\.\d+)?$/.test(trimmed)) return null

  const parts = trimmed.split(':').map(Number)
  if (parts.length === 1) return parts[0]

  const seconds = parts[parts.length - 1]
  if (seconds >= 60) return null

  if (parts.length === 2) {
    const [minutes] = parts
    return minutes * 60 + seconds
  }

  const [hours, minutes] = parts
  if (minutes >= 60) return null
  return hours * 3600 + minutes * 60 + seconds
}
