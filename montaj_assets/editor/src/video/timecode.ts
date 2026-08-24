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

/**
 * Format seconds for the preview transport row's timecode readout, as
 * `m:ss.f` (or `h:mm:ss.f` once the value reaches an hour) — one decimal
 * place, rounded to the nearest tenth of a second.
 *
 * Deliberately NOT frames (no CapCut-style `hh:mm:ss:ff`): `parseTimecode`
 * above has no notion of frames — its trailing fractional part is seconds
 * only — so a frames-style display would silently mis-parse if a user
 * copied it into the command palette's "go to time" field (a trailing
 * `:18` would be read as 18 SECONDS, not 18 frames). Emitting the same
 * `m:ss[.f]` shape `parseTimecode` already accepts keeps the two in sync;
 * see the round-trip tests in `__tests__/timecode.test.ts`.
 */
export function formatTimecode(sec: number): string {
  const clamped = Number.isFinite(sec) ? Math.max(0, sec) : 0
  const totalTenths = Math.round(clamped * 10)
  const wholeSeconds = Math.floor(totalTenths / 10)
  const tenths = totalTenths % 10
  const hours = Math.floor(wholeSeconds / 3600)
  const minutes = Math.floor((wholeSeconds % 3600) / 60)
  const seconds = wholeSeconds % 60
  const secondsStr = `${String(seconds).padStart(2, '0')}.${tenths}`
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${secondsStr}`
    : `${minutes}:${secondsStr}`
}
