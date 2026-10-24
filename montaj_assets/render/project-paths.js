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

// What ffmpeg opens as something other than a file: `concat:`, `subfile,`, `http:`, any `scheme:` of two or more
// characters (a Windows drive, `C:`, is a path).
const PROTOCOL = /^(?:[A-Za-z][A-Za-z0-9+.-]+:|subfile,)/

/**
 * `nobg_src` and `normalizedSrc`, which the render reads in place of `src`. montaj writes them as absolute
 * paths, but they are project.json text that reaches ffmpeg's -i, so a URL or protocol form is refused, naming
 * the field (§563), and a relative one resolves like `src`. An absolute path is returned unchanged.
 */
export function resolveDerivedSrc(value, projectDir, field) {
  if (typeof value !== 'string' || PROTOCOL.test(value)) {
    throw new Error(`${field} must be a file path, not ${JSON.stringify(value)}`)
  }
  return resolveProjectSrc(value, projectDir)
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
