/**
 * probeVideoDuration — a fast, purely local duration probe for a `File` the
 * user just dropped, with no server round-trip. Backs the timeline
 * filesystem-drop import (`../app/editor/timelineImport.ts`): the ghost band
 * that appears the instant a video is dropped needs SOME length to draw
 * itself at, well before the server has even received the upload.
 *
 * Loads the file into a detached, never-mounted `<video>` with
 * `preload="metadata"` and reads `.duration` off `loadedmetadata` — the
 * browser only has to parse the container header for that, not decode a
 * single frame, so this resolves in milliseconds even for a large file.
 *
 * Best-effort, not authoritative: the browser's demuxer is less thorough
 * than the server's own ffprobe (an exotic codec or a slightly malformed
 * header can fail here while the file still ingests fine server-side), so a
 * rejection means "no local estimate available right now", never "this file
 * is bad" — the caller's job, not this module's, is deciding what that
 * implies for the UI.
 */

/** How long to wait for `loadedmetadata` before giving up. A probe is
 *  metadata-only and normally resolves near-instantly; ~10s is generous
 *  enough to absorb a slow disk/decoder without leaving a drop's ghost band
 *  (or its footage-bin fallback — see timelineImport.ts) hanging forever. */
export const PROBE_TIMEOUT_MS = 10_000

export function probeVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    // Some browsers surface a console warning for an unmuted media element
    // that never plays; this element never plays at all, so mute it up front.
    video.muted = true

    let settled = false

    // Always fires exactly once, however the probe ends, and always revokes
    // the object URL as its last act — an object URL nobody revokes pins the
    // whole file's bytes in memory for the life of the page, and a drop can
    // bring in many files at once.
    function finish(action: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('error', onError)
      URL.revokeObjectURL(url)
      action()
    }

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out probing duration for "${file.name}"`)))
    }, PROBE_TIMEOUT_MS)

    function onLoaded(): void {
      const duration = video.duration
      if (!Number.isFinite(duration) || duration <= 0) {
        finish(() => reject(new Error(`Could not read a usable duration for "${file.name}"`)))
        return
      }
      finish(() => resolve(duration))
    }

    function onError(): void {
      finish(() => reject(new Error(`Could not probe "${file.name}" as a video`)))
    }

    video.addEventListener('loadedmetadata', onLoaded)
    video.addEventListener('error', onError)
    video.src = url
  })
}
