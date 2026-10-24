// §569: an overlay template stored as the absolute path of an overlay shipped with Montaj.
//
// The editor's "+ Text" (and the slides step) store a carousel overlay's `template` as the jsxPath serve listed: the
// shipped overlay inside the maker's own runtime, e.g. `/Users/<name>/Library/Application Support/Montaj/runtime-home/
// .cache/montaj/render/templates/overlays/static-text/static-text.jsx`. The same project opened on another Mac (another
// user name, or Windows) names a path that is not there, and its text would not draw. So a path that is MISSING and ends
// in `templates/overlays/<name>/<name>.jsx` (or the flat `templates/overlays/<name>.jsx`) is read from the shipped copy
// of that name beside this render. A path that exists is always used as it is; anything else resolves as before.

import { existsSync, statSync } from 'fs'
import { join, resolve } from 'path'

const NAME = /^[A-Za-z0-9_-]{1,128}$/

/** `templates/overlays/<name>/<name>.jsx` or `templates/overlays/<name>.jsx` for a path that ends in one, else null. */
export function shippedTemplateKey(p) {
  if (typeof p !== 'string' || p === '') return null
  const segs = p.split(/[\\/]+/)
  if (segs.includes('..')) return null
  const n = segs.length
  const file = segs[n - 1]
  if (!file || !file.endsWith('.jsx')) return null
  const name = file.slice(0, -'.jsx'.length)
  if (!NAME.test(name)) return null
  if (n >= 4 && segs[n - 4] === 'templates' && segs[n - 3] === 'overlays' && segs[n - 2] === name) {
    return `templates/overlays/${name}/${name}.jsx`
  }
  if (n >= 3 && segs[n - 3] === 'templates' && segs[n - 2] === 'overlays') return `templates/overlays/${name}.jsx`
  return null
}

const isFile = (p) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** The file to read for an overlay `template`: the path itself when it is there, else this runtime's shipped copy
 *  (`renderDir`, the folder holding templates/) for a missing shipped overlay, else the path resolved as before. */
export function resolveTemplatePath(p, renderDir) {
  const asIs = resolve(p)
  if (existsSync(asIs)) return asIs
  const key = shippedTemplateKey(p)
  if (!key || typeof renderDir !== 'string' || renderDir === '') return asIs
  const shipped = join(renderDir, ...key.split('/'))
  return isFile(shipped) ? shipped : asIs
}
