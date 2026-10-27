// Ported from render/shipped-template.js (§569): the key of an overlay shipped
// with Montaj, so one stored as the maker's absolute runtime path (another Mac,
// another user name, Windows) is still recognised as the same shipped overlay.

const NAME = /^[A-Za-z0-9_-]{1,128}$/

/** `templates/overlays/<name>/<name>.jsx` (or the flat `templates/overlays/<name>.jsx`) for a path that ends in one under a `render/` folder, else null. */
export function shippedTemplateKey(p: unknown): string | null {
  if (typeof p !== 'string' || p === '') return null
  const segs = p.split(/[\\/]+/)
  if (segs.includes('..')) return null
  const n = segs.length
  const file = segs[n - 1]
  if (!file || !file.endsWith('.jsx')) return null
  const name = file.slice(0, -'.jsx'.length)
  if (!NAME.test(name)) return null
  if (n >= 5 && segs[n - 5] === 'render' && segs[n - 4] === 'templates' && segs[n - 3] === 'overlays' && segs[n - 2] === name) {
    return `templates/overlays/${name}/${name}.jsx`
  }
  if (n >= 4 && segs[n - 4] === 'render' && segs[n - 3] === 'templates' && segs[n - 2] === 'overlays') return `templates/overlays/${name}.jsx`
  return null
}
