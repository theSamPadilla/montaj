/**
 * A child process that dies from a signal (the OS killing it for memory, a
 * user's SIGKILL) has no exit code, so `status !== 0` used to read as a bare
 * ffmpeg failure with an empty tail. These helpers keep the signal: the error
 * carries `code: 'child_killed'`, the `child`, the `signal` and the `phase`.
 * The engine's own timeout kill is not one of these and keeps its own error.
 */

/**
 * Every `phase` a child_killed error can carry: the app reads it to say where
 * the export died, so it is a fixed list. A new call site names one of these,
 * or adds it here; child-killed.test.mjs fails a call site whose phase is not
 * listed, and a listed phase no call site emits.
 */
export const CHILD_KILLED_PHASES = Object.freeze([
  'overlay-load',       // Chrome: loading a chunk's overlay page
  'overlay-capture',    // Chrome: capturing a chunk's frames
  'overlay-encode',     // ffmpeg: a chunk's PNGs into FFV1
  'chunk-concat',       // ffmpeg: joining a segment's chunks
  'sdr-derive',         // ffmpeg: the SDR rendition derived from an HDR master
  'segment-encode',     // ffmpeg: composing one segment
  'segment-group-join', // ffmpeg: joining short segments into one encode
  'segment-concat',     // ffmpeg: joining the segments into the output
  'audio-mix',          // ffmpeg: mixing the audio tracks
  'audio-copy',         // ffmpeg: copying the output through, no audio tracks to mix
  'loudness-measure',   // ffmpeg: measuring loudness
  'loudness-normalize', // ffmpeg: normalizing loudness
])

/**
 * @param {{child: string, signal: string, phase?: string, message: string}} p
 * @returns {Error & {code: 'child_killed', child: string, signal: string, phase?: string}}
 */
export function childKilledError({ child, signal, phase, message }) {
  const err = new Error(message)
  err.code = 'child_killed'
  err.child = child
  err.signal = signal
  err.phase = phase
  return err
}

/** @param {unknown} err */
export function isChildKilled(err) {
  return !!err && typeof err === 'object' && err.code === 'child_killed'
}

/**
 * For a spawnSync result: a child_killed error when the child died from a
 * signal, else null (the caller keeps its own error for an exit code).
 * A spawnSync timeout also reports a signal, so `result.error` (ETIMEDOUT)
 * or a missing signal returns null.
 * @param {{status: number|null, signal: string|null, error?: Error, stderr?: any}} result
 * @param {{child: string, phase?: string, message?: string}} ctx
 */
export function syncResultError(result, { child, phase, message }) {
  if (!result || !result.signal || result.error) return null
  return childKilledError({
    child, signal: result.signal, phase,
    message: message ?? `${child} was killed by ${result.signal}`,
  })
}
