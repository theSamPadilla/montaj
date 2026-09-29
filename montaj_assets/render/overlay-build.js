/**
 * overlay-build.js — what every overlay bundle shares.
 *
 * Render (bundle.js's bundleComponent, render-carousel.js's slide bundle) and
 * the editor preview (preview-bundle.js) must resolve an overlay's imports the
 * same way: the same loaders, the same `montaj/render` module, the same
 * node_modules search path. Keeping one copy of those options here is what
 * stops the three from drifting apart. The same goes for deciding which of a
 * bundle's inputs are the user's own files: overlayInputsFromMetafile.
 */
import { join, dirname, resolve, sep } from 'path'
import { realpathSync, readdirSync, lstatSync } from 'fs'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * The esbuild options every overlay bundle starts from.
 *
 * Per-call fields (`entryPoints`, `outfile`, `metafile`, `write`) are left to
 * the caller. A fresh object is returned on every call, so a caller may
 * override or mutate what it gets without touching anyone else's build.
 */
export function overlayEsbuildOptions() {
  return {
    bundle:   true,
    format:   'esm',
    platform: 'browser',
    jsx:      'automatic',
    loader:   { '.jsx': 'jsx', '.js': 'js', '.tsx': 'tsx', '.ts': 'ts' },
    alias: {
      'montaj/render':    join(__dirname, 'core', 'index.js'),
      // Force all transitive imports of React to resolve from render's own
      // node_modules, not from overlay-runtime's nested copy. montaj-overlay-runtime
      // is a `file:` symlink, so esbuild follows the symlink and would otherwise
      // pick up react from overlay-runtime/node_modules, producing two React
      // instances which breaks r3f's reconciler.
      'react':            join(__dirname, 'node_modules', 'react'),
      'react-dom':        join(__dirname, 'node_modules', 'react-dom'),
      'react-dom/client': join(__dirname, 'node_modules', 'react-dom', 'client'),
    },
    nodePaths: [join(__dirname, 'node_modules')],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    logLevel: 'silent',
  }
}

// ---------------------------------------------------------------------------
// inputs: the user's own files
// ---------------------------------------------------------------------------

/**
 * The esbuild namespace of preview-bundle.js's virtual modules. Its metafile
 * keys look like `montaj-preview-globals:react` and are never files. Matched
 * exactly, not as "anything before a colon": a relative path whose first
 * segment contains a colon (macOS allows one, and shows it as a slash) is
 * still a file.
 */
export const PREVIEW_NAMESPACE = 'montaj-preview-globals'

let engineRootsCache = null

/**
 * Directories whose files are montaj's, not the user's: render's node_modules
 * and core/, overlay-runtime, and the real target of every package render's
 * node_modules links to (`montaj-overlay-runtime`, `@bycrux/timeline-core` are
 * `file:` symlinks in both a dev checkout and the app's install). Each is
 * listed as spelled and as its realpath, since esbuild reports realpaths.
 */
export function engineRoots() {
  if (engineRootsCache) return engineRootsCache
  const roots = new Set()
  const nodeModules = join(__dirname, 'node_modules')
  addWithRealpath(roots, nodeModules)
  addWithRealpath(roots, join(__dirname, 'core'))
  addWithRealpath(roots, join(__dirname, '..', 'overlay-runtime'))
  const addLinks = dir => {
    let names
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      const p = join(dir, name)
      if (name.startsWith('@')) { addLinks(p); continue }
      try { if (lstatSync(p).isSymbolicLink()) addWithRealpath(roots, p) } catch { /* raced away */ }
    }
  }
  addLinks(nodeModules)
  engineRootsCache = [...roots]
  return engineRootsCache
}

function addWithRealpath(set, p) {
  set.add(p)
  try { set.add(realpathSync(p)) } catch { /* absent in this install */ }
}

const isUnder = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)

/**
 * The user's own source files among an esbuild build's inputs: absolute,
 * deduped and sorted. Dropped are the preview's virtual modules, everything
 * under engineRoots(), and everything under each directory in `exclude`
 * (bundle.js passes its temp work dir, so its generated shim is not reported).
 *
 * esbuild reports realpaths, so each `exclude` root is matched both as spelled
 * and as its realpath: a work dir under macOS's /var/folders is reported as
 * /private/var/folders.
 *
 * @param {{ inputs: Record<string, unknown> }} metafile  esbuild's metafile
 * @param {string} absWorkingDir  the working dir the build ran with; metafile
 *   keys are relative to it (esbuild defaults it to process.cwd())
 * @param {{ exclude?: string[] }} [opts]  extra absolute directory roots to drop
 * @returns {string[]}
 */
export function overlayInputsFromMetafile(metafile, absWorkingDir, { exclude = [] } = {}) {
  const extra = new Set()
  for (const root of exclude) addWithRealpath(extra, resolve(root))
  const roots = [...engineRoots(), ...extra]
  const out = new Set()
  for (const key of Object.keys(metafile.inputs)) {
    if (key.startsWith(`${PREVIEW_NAMESPACE}:`)) continue
    const abs = resolve(absWorkingDir, key)
    if (roots.some(r => isUnder(abs, r))) continue
    out.add(abs)
  }
  return [...out].sort()
}
