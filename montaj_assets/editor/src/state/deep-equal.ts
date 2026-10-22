/**
 * editor-core / state / deep-equal: structural equality over project.json values.
 *
 * Tree shape (project.json) is small, no cycles, no special types, so a
 * recursive walk is fine and short-circuits early on mismatch.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (Array.isArray(b)) return false
  // Compare objects treating `undefined`-valued properties as absent. Required
  // because the reducer writes `{...el, crop: undefined}` to clear a field,
  // but the SSE echo round-trip serialises through Montaj's `json.dumps`,
  // which drops undefined-valued keys. Without this normalisation, the
  // identity short-circuit in mergeProject silently misses on every echo
  // following an image resize.
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = new Set<string>()
  for (const k of Object.keys(ao)) if (ao[k] !== undefined) keys.add(k)
  for (const k of Object.keys(bo)) if (bo[k] !== undefined) keys.add(k)
  for (const k of keys) {
    if (!deepEqual(ao[k], bo[k])) return false
  }
  return true
}
