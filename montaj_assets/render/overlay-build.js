/**
 * overlay-build.js — the esbuild options every overlay bundle shares.
 *
 * Render (bundle.js's bundleComponent, render-carousel.js's slide bundle) and
 * the editor preview (preview-bundle.js) must resolve an overlay's imports the
 * same way: the same loaders, the same `montaj/render` module, the same
 * node_modules search path. Keeping one copy of those options here is what
 * stops the three from drifting apart.
 *
 * Per-call fields (`entryPoints`, `outfile`, `metafile`, `write`) are left to
 * the caller. A fresh object is returned on every call, so a caller may
 * override or mutate what it gets without touching anyone else's build.
 */
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
