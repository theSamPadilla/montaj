// render/nle/srt.js
/**
 * The project's captions as an SRT file, for an editor's own caption tools.
 *
 * `captionsToSrt(project)` reads `project.captions.segments` (`{ text, start,
 * end }`, timeline seconds) and returns the SRT text, or `null` when there is
 * nothing to write (no segments, or none with text and a positive length).
 */

/** @param {number} seconds @returns {string} HH:MM:SS,mmm (rounded to the millisecond). */
function stamp(seconds) {
  const total = Math.max(0, Math.round(seconds * 1000))
  const ms = total % 1000
  const s = Math.floor(total / 1000) % 60
  const m = Math.floor(total / 60000) % 60
  const h = Math.floor(total / 3600000)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`
}

/**
 * @param {object} project
 * @returns {string | null}
 */
export function captionsToSrt(project) {
  const segments = Array.isArray(project?.captions?.segments) ? project.captions.segments : []
  const cues = segments
    .filter((s) => Number.isFinite(s?.start) && Number.isFinite(s?.end)
      && typeof s?.text === 'string' && s.text.trim() !== ''
      && Math.round(s.end * 1000) > Math.round(s.start * 1000))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.start - b.s.start || a.i - b.i)
    .map(({ s }) => s)
  if (cues.length === 0) return null
  return cues
    .map((s, n) => `${n + 1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${s.text.replace(/\r\n?/g, '\n').replace(/\n\s*\n+/g, '\n')}\n`)
    .join('\n')
}
