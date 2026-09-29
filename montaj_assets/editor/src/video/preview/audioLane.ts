/**
 * Whether an audio lane's element has nothing left to play at `trackTime`
 * (seconds into its own source file), so the sync loop must leave it paused.
 *
 * Why the sync loop needs this: `play()` on a media element that has reached
 * the end of its file restarts it from 0. timeline-core's `audioWindow` knows a
 * track's `end` and `outPoint` but not the file's length, so a window can
 * outlast the audio in it: a short SFX with no `end`, or an `end` past the end
 * of the file. Without this guard every tick after the file finished would call
 * `play()` again and loop or stutter the lane.
 *
 * Exhausted when the element knows its duration and either
 *   - `trackTime` is at or past it, or
 *   - the element has already ENDED and `trackTime` is within `threshold` of
 *     the end: it ran slightly ahead of the playhead and finished first, so the
 *     sync loop would not re-seek it (inside the drift tolerance) and `play()`
 *     would restart it from 0. There is nothing left to play there anyway.
 *
 * An unknown duration (metadata not loaded yet: `NaN`) is never exhausted, so a
 * lane that has not loaded plays exactly as before.
 */
export function laneSourceExhausted(
  el: Pick<HTMLMediaElement, 'duration' | 'ended'>,
  trackTime: number,
  threshold: number,
): boolean {
  const d = el.duration
  if (!Number.isFinite(d)) return false
  if (trackTime >= d) return true
  return el.ended && d - trackTime <= threshold
}
