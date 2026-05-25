/**
 * bundle.js — Compile a JSX overlay/caption component into a self-contained HTML page
 * loadable by Puppeteer.
 *
 * The entry shim:
 *   - Imports the component
 *   - Mounts it into #root with initial frame=0
 *   - Exposes window.__setFrame(n) which calls flushSync so React updates synchronously
 *     before Puppeteer takes the next screenshot
 */
import esbuild from 'esbuild'
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'fs'
import { join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
// `core/` and `node_modules/` are siblings of bundle.js — always resolve via
// __dirname, not via process.env.MONTAJ_ROOT (which points at the Python
// project root and now sits two levels above us under montaj_assets/render/).

/**
 * Compile a component into a temp directory containing index.html + bundle.js.
 *
 * @param {Object} opts
 * @param {string}  opts.componentPath   - Absolute path to the .jsx file
 * @param {Object}  opts.props           - Props to pass (from project.json item, minus id/type/start/end/src)
 * @param {number}  opts.fps
 * @param {number}  opts.durationFrames  - Total frames this segment runs for
 * @param {number}  opts.width
 * @param {number}  opts.height
 * @returns {Promise<{ htmlPath: string, workDir: string }>}
 */
export async function bundleComponent({ componentPath, props, fps, durationFrames, width, height, offsetX = 0, offsetY = 0, scale = 1, opaque = false, googleFonts = [] }) {
  const id      = randomBytes(8).toString('hex')
  const workDir = join(tmpdir(), `montaj-bundle-${id}`)
  mkdirSync(workDir, { recursive: true })

  const shimPath   = join(workDir, 'shim.jsx')
  const bundlePath = join(workDir, 'bundle.js')
  const htmlPath   = join(workDir, 'index.html')

  writeFileSync(shimPath, generateShim(componentPath, props, fps, durationFrames, offsetX, offsetY, scale))

  await esbuild.build({
    entryPoints: [shimPath],
    bundle:      true,
    format:      'esm',
    platform:    'browser',
    outfile:     bundlePath,
    jsx:         'automatic',
    loader:      { '.jsx': 'jsx', '.js': 'js', '.tsx': 'tsx', '.ts': 'ts' },
    alias: {
      'montaj/render':  join(__dirname, 'core', 'index.js'),
      // Force all transitive imports of React to resolve from render's own
      // node_modules, not from overlay-runtime's nested copy. montaj-overlay-runtime
      // is a `file:` symlink, so esbuild follows the symlink and would otherwise
      // pick up react from overlay-runtime/node_modules, producing two React
      // instances which breaks r3f's reconciler.
      'react':          join(__dirname, 'node_modules', 'react'),
      'react-dom':      join(__dirname, 'node_modules', 'react-dom'),
      'react-dom/client': join(__dirname, 'node_modules', 'react-dom', 'client'),
    },
    nodePaths: [join(__dirname, 'node_modules')],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    logLevel: 'silent',
  })

  writeFileSync(htmlPath, generateHtml(width, height, opaque, googleFonts))

  return { htmlPath, workDir }
}

/** Remove the temp directory for a bundle. Call after the WebM segment is encoded. */
export function cleanupBundle(workDir) {
  rmSync(workDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve a path that may contain macOS narrow no-break spaces (\u202f). */
function resolveFilePath(p) {
  if (existsSync(p)) return p
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

/**
 * Recursively rewrite absolute filesystem path strings in props to file:// URLs
 * so they resolve correctly in Puppeteer's file:// page context.
 */
function rewritePathsToFileUrls(value) {
  if (typeof value === 'string' && value.startsWith('/')) {
    // Resolve the actual path on disk — macOS screenshot filenames contain narrow
    // no-break spaces (\u202f) that don't match the regular spaces in project.json.
    const resolved = resolveFilePath(value) ?? value
    return 'file://' + encodeURI(resolved)
  }
  if (Array.isArray(value)) {
    return value.map(rewritePathsToFileUrls)
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = rewritePathsToFileUrls(v)
    return out
  }
  return value
}

function generateShim(componentPath, props, fps, durationFrames, offsetX, offsetY, scale) {
  // JSON.stringify handles path quoting and props serialisation safely.
  // Rewrite absolute paths → file:// so <img src> resolves in Puppeteer's file:// context
  const rewrittenProps = rewritePathsToFileUrls(props)
  return `
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { makeOverlayGlobals } from 'montaj-overlay-runtime'
import Component from ${JSON.stringify(componentPath)}

// Overlay components use frame, fps, duration, props, interpolate, spring, Ph, FaIcon,
// FaSolid, FaBrands, THREE, Canvas, useThreeFrame as bare globals (no imports, no props
// destructuring). Inject them onto window so bare-identifier access resolves correctly
// inside the component.
// NOTE: do NOT use esbuild define for these — define rewrites to the import alias name
// which esbuild renames during bundling, making the reference undefined at runtime.
const __overlayGlobals = makeOverlayGlobals('render')
for (const [__k, __v] of Object.entries(__overlayGlobals)) {
  window[__k] = __v
}
window.fps         = ${fps}
window.duration    = ${durationFrames}
window.props       = ${JSON.stringify(rewrittenProps)}
window.frame       = 0

const __props = ${JSON.stringify(rewrittenProps)}
let __setFrame

function App() {
  const [frame, setFrame] = useState(0)
  __setFrame = setFrame
  window.frame = frame  // keep global in sync with React state during render
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Component
        frame={frame}
        fps={${fps}}
        duration={${durationFrames}}
        {...__props}
      />
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)

// flushSync makes React process the state update synchronously within this call,
// so the DOM is fully updated before Puppeteer takes the next screenshot.
// After flushSync, stamp the rendered frame number onto the root element so
// Puppeteer can use waitForFunction to confirm the DOM reflects the right frame
// before taking the screenshot (rAF-only waits are unreliable in headless Chrome).
//
// Block frame 0 paint on document.fonts.ready so any Google Fonts declared in
// the page <head> are fully loaded before the first screenshot (otherwise the
// first frames flash a CSS fallback). 5s timeout so a flaky network can't stall
// the render; on timeout we proceed and frames paint with whatever fallback the
// JSX declared. After the first call settles, subsequent calls re-use the same
// resolved promise (effectively free).
//
// __setFrame is defined synchronously — renderer.js does a one-shot
// \`typeof window.__setFrame === 'function'\` check right after page.goto and
// gating that on a promise would race. The fonts-ready wait happens inside the
// function, on the first call only.
//
// We read \`document.fonts.ready\` lazily on the first call, not at shim eval
// time, because the FontFaceSet.ready promise reflects only loads that are
// pending *when accessed*. If we capture it before React has committed any
// font-family styles to the DOM, the browser hasn't kicked off the woff2 load
// yet and ready resolves immediately. By first __setFrame call, React's initial
// render has committed and any required font fetches are in flight.
let __fontsReadyPromise
function __waitForFonts() {
  if (__fontsReadyPromise) return __fontsReadyPromise
  __fontsReadyPromise = Promise.race([
    document.fonts ? document.fonts.ready : Promise.resolve(),
    new Promise(resolve => setTimeout(() => {
      console.warn('[montaj] document.fonts.ready timed out after 5s — rendering with fallback')
      resolve()
    }, 5000)),
  ])
  return __fontsReadyPromise
}
window.__setFrame = async (n) => {
  await __waitForFonts()
  window.frame = n  // update global before React re-renders
  flushSync(() => __setFrame?.(n))
  // If the overlay mounted a <Canvas> and called useThreeFrame, force Three's
  // WebGL draw to complete now so Puppeteer's next screenshot reflects this
  // frame. No-op for overlays that don't use Three (the global is never set).
  window.__renderThree?.()
  document.documentElement.dataset.renderedFrame = String(n)
}
`
}

function generateHtml(width, height, opaque = false, googleFonts = []) {
  const bgRule = opaque ? '' : 'background: transparent;'
  // Each entry in googleFonts is appended verbatim as a `family=...` parameter
  // on the Google Fonts CSS2 API URL. Callers format entries as
  // "Anton" / "Playfair+Display:ital@1" / "Roboto:wght@400;700" (spaces as +).
  // We intentionally do NOT URL-encode the entries — Google's API requires
  // literal '+', ':', '@', ';' which would be percent-encoded otherwise.
  const fontLinks = googleFonts.length === 0 ? '' : `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${googleFonts.map(f => `family=${f}`).join('&')}&display=swap">`
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">${fontLinks}
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #root {
  width: ${width}px;
  height: ${height}px;
  ${bgRule}
  overflow: hidden;
}
</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="bundle.js"></script>
</body>
</html>`
}
