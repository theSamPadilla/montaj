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
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONTAJ_ROOT = process.env.MONTAJ_ROOT || join(__dirname, '..')

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
export async function bundleComponent({ componentPath, props, fps, durationFrames, width, height, offsetX = 0, offsetY = 0, scale = 1, opaque = false }) {
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
    format:      'iife',
    platform:    'browser',
    outfile:     bundlePath,
    jsx:         'automatic',
    loader:      { '.jsx': 'jsx', '.js': 'js', '.tsx': 'tsx', '.ts': 'ts' },
    alias: {
      'montaj/render': join(MONTAJ_ROOT, 'render', 'core', 'index.js'),
    },
    nodePaths: [join(MONTAJ_ROOT, 'render', 'node_modules')],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    logLevel: 'silent',
  })

  writeFileSync(htmlPath, generateHtml(width, height, opaque))

  return { htmlPath, workDir }
}

/** Remove the temp directory for a bundle. Call after the WebM segment is encoded. */
export function cleanupBundle(workDir) {
  rmSync(workDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively rewrite absolute filesystem path strings in props to file:// URLs
 * so they resolve correctly in Puppeteer's file:// page context.
 */
function rewritePathsToFileUrls(value) {
  if (typeof value === 'string' && value.startsWith('/')) {
    return 'file://' + value
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
import * as __iconPh__ from '@phosphor-icons/react'
import { FontAwesomeIcon as __iconFaIcon__ } from '@fortawesome/react-fontawesome'
import * as __iconFaSolid__ from '@fortawesome/free-solid-svg-icons'
import * as __iconFaBrands__ from '@fortawesome/free-brands-svg-icons'
import { interpolate, spring } from 'montaj/render'
import Component from ${JSON.stringify(componentPath)}

// Overlay components use frame, fps, duration, props, interpolate, spring, Ph, FaIcon,
// FaSolid, FaBrands as bare globals (no imports, no props destructuring). Inject them
// onto window so bare-identifier access resolves correctly inside the component.
// NOTE: do NOT use esbuild define for these — define rewrites to the import alias name
// which esbuild renames during bundling, making the reference undefined at runtime.
window.interpolate = interpolate
window.spring      = spring
window.Ph          = __iconPh__
window.FaIcon      = __iconFaIcon__
window.FaSolid     = __iconFaSolid__
window.FaBrands    = __iconFaBrands__
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
window.__setFrame = (n) => {
  window.frame = n  // update global before React re-renders
  flushSync(() => __setFrame?.(n))
  document.documentElement.dataset.renderedFrame = String(n)
}
`
}

function generateHtml(width, height, opaque = false) {
  const bgRule = opaque ? '' : 'background: transparent;'
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
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
<script src="bundle.js"></script>
</body>
</html>`
}
