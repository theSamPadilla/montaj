// What a page says it drew less of than the project asks for. The 3D stage (the app's library/model3d) fails open with
// a `model3d: ` line on the page console (its look pass failed and the rest draws ungraded, a physics bake was not
// played, textures were halved or failed, a sky is missing), and an overlay that skips a part it could not draw says
// so with an `overlay: ` line. Both use console.warn or console.info. The page's console used to be read for errors only,
// so a final render dropped these and came out degraded without a word. renderer.js now writes each one once per page
// to the render log as `page warning: <line>`, which the app reads, and sample-frame.js adds them to a sample's
// `warnings` (and keeps that frame out of the sample cache).
export const STAGE_WARNING_PREFIX = 'page warning: '
export const STAGE_WARNING_SOURCES = Object.freeze(['model3d: ', 'overlay: '])
const MAX_LEN = 300

/** A page console message `{ type, text }` -> its line (trimmed, at most 300 characters), or null. */
export function stageWarningOf({ type, text } = {}) {
  if (type !== 'warning' && type !== 'warn' && type !== 'info' && type !== 'log') return null
  const t = String(text ?? '').trim()
  if (!STAGE_WARNING_SOURCES.some((p) => t.startsWith(p))) return null
  return t.length > MAX_LEN ? `${t.slice(0, MAX_LEN - 3)}...` : t
}
