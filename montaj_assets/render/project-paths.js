// render/project-paths.js
import { resolve, dirname, basename, join } from 'path'
import { existsSync, readdirSync } from 'fs'

/**
 * The one rule for where a project's relative path points: a path that does not
 * start with `/` is relative to the project directory (the folder holding
 * project.json); anything else is returned unchanged, including an empty or
 * missing value.
 *
 * Shared by every reader that resolves a project's paths: `resolveProjectPaths`
 * in render.js and in sample-frame.js (which apply it in place, plus their own
 * extras: render.js also looks the file up on disk for the macOS narrow
 * no-break space) and the editor export's `nle/timeline.js` (which applies it to
 * copies and never touches the disk).
 *
 * @param {string | undefined | null} src
 * @param {string} projectDir
 * @returns {string | undefined | null}
 */
export function resolveProjectSrc(src, projectDir) {
  return src && !src.startsWith('/') ? resolve(projectDir, src) : src
}

/** Resolve a path that may contain a macOS narrow no-break space (\u202f) instead
 *  of a regular space — e.g. screenshot filenames like "Screenshot … 12.44.47 PM.png".
 *  Returns the actual path on disk, or null if not found. */
export function resolveFilePath(p) {
  if (existsSync(p)) return p
  // Normalise both sides: replace \u202f with regular space and compare
  const dn = dirname(p)
  const bn = basename(p)
  const target = bn.replace(/\u202f/g, ' ')
  try {
    for (const name of readdirSync(dn)) {
      if (name.replace(/\u202f/g, ' ') === target) return join(dn, name)
    }
  } catch { /* parent dir missing */ }
  return null
}
