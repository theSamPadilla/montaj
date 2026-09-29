/**
 * preview-bundle.js — bundle one overlay for the editor preview.
 *
 * The preview does not mount an overlay the way render does. It runs the
 * overlay's module body inside
 *
 *   new Function('React', 'frame', 'fps', 'duration', 'props', ...globalNames, body)
 *
 * and calls that function once per frame, so every top-level statement, and
 * every function the overlay defines, sees that call's `frame`. Render instead
 * bundles the overlay with esbuild, which is why imports have always worked in
 * render and never in the preview.
 *
 * This file gives the preview the same bundler render uses:
 *
 *   - The same resolution: `overlayEsbuildOptions()` (overlay-build.js) supplies
 *     the loaders, `nodePaths` and `define`, so a relative import resolves here
 *     exactly as it does in render, and an unresolvable one (`from 'remotion'`)
 *     fails here with the error render would give.
 *   - An IIFE assigned to `__montajOverlay`, so the preview runs `code` in its
 *     existing wrapper and reads `__montajOverlay.default`.
 *   - Classic JSX against the wrapper's `React` parameter.
 *   - The `montaj-preview-globals` plugin: the packages the wrapper already has
 *     in scope (React, the JSX runtimes, `montaj/render`,
 *     `montaj-overlay-runtime`) become virtual modules that read those in-scope
 *     identifiers. The bundle therefore never carries a second React (hooks
 *     would break) and never re-evaluates the runtime on every frame call.
 *     The list is exactly the set render can resolve; see SHIMMED_SPECIFIERS.
 *
 * The free identifiers the overlay reads (`frame`, `React`, `THREE`, …) are
 * left unbound by the bundle, so they bind to the wrapper's parameters. esbuild
 * never renames an unbound identifier, and renames any module-level binding
 * that would collide with one (proved in test/preview-bundle.test.mjs).
 *
 * Returns `{ code, inputs }`. `inputs` is every file of the user's own the
 * bundle read, absolute and sorted: the files the preview must watch. Engine
 * files (render's node_modules and core/, overlay-runtime, and any package
 * render's node_modules links to) and the virtual modules are left out.
 *
 * CLI: `node preview-bundle.js <absolute path>` prints exactly one JSON line.
 *   success       {"ok":true,"code":"…","inputs":[…]}                          exit 0
 *   build failure {"ok":false,"error":"build_failed","message":"<file>:<line>:<col>: <text>"}  exit 2
 *   usage / internal error: a message on stderr, nothing on stdout           exit 1
 * In a build failure's message, `<file>` is absolute, `<line>` is 1-based and
 * `<col>` is 0-based, both exactly as esbuild reports them.
 */
import esbuild from 'esbuild'
import { resolve, join, dirname, isAbsolute, sep } from 'path'
import { realpathSync, readdirSync, lstatSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { overlayEsbuildOptions } from './overlay-build.js'
import { isMain } from './is-main.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const PREVIEW_GLOBAL_NAME = '__montajOverlay'
export const PREVIEW_NAMESPACE   = 'montaj-preview-globals'

// WHICH SPECIFIERS ARE SHIMMED, AND WHY EXACTLY THESE
//
// The preview shims a specifier only when render resolves it too, so that an
// import behaves the same in both: it works in both, or it fails in both with
// the same "Could not resolve" error. From a user's overlay, render resolves
// `react` and its subpaths, `react-dom` and `react-dom/client` (render's own
// node_modules, and its aliases), `montaj/render` (its alias onto core/) and
// `montaj-overlay-runtime` (a package linked into render's node_modules).
//
// It does NOT resolve three, @react-three/fiber, recharts, @phosphor-icons/react
// or the @fortawesome packages: they are dependencies of overlay-runtime and
// live in overlay-runtime/node_modules, which is not on render's search path.
// So they are deliberately NOT shimmed here, and an overlay importing one fails
// in the preview exactly as its export would. Overlays reach those libraries
// through the globals (THREE, Canvas, Ph, FaIcon, FaSolid, FaBrands, the chart
// components) or through `montaj-overlay-runtime`, which carries the same
// objects. test/preview-bundle.test.mjs builds both sides with bundleComponent
// to pin this; if render ever learns to resolve one of those packages, add it
// here in the same change.

/**
 * Packages whose preview global IS the whole package. Each becomes a CommonJS
 * virtual module (`module.exports = <global>`), so default, namespace and
 * named imports all work, as they do against the real package.
 *
 *   React     the wrapper's first parameter
 */
export const WHOLE_PACKAGE_GLOBALS = Object.freeze({
  'react': 'React',
})

// Every key of overlay-runtime's makeOverlayGlobals('preview'). A drift test
// pins this list to the real function.
const OVERLAY_GLOBAL_NAMES = [
  'interpolate', 'spring', 'springStep', 'springSum',
  'captionOuterStyle', 'captionInnerStyle',
  'useThreeFrame', 'Canvas', 'useCanvas2DFrame',
  'THREE', 'Ph', 'FaIcon', 'FaSolid', 'FaBrands',
  'BarChart', 'Bar', 'LineChart', 'Line', 'PieChart', 'Pie', 'Cell',
  'XAxis', 'YAxis', 'CartesianGrid', 'Tooltip', 'Legend', 'ResponsiveContainer',
]

const identity = names => Object.freeze(Object.fromEntries(names.map(n => [n, n])))

/**
 * Packages the preview has only PART of. Each becomes an ESM virtual module
 * with explicit named exports `{ exportedName: globalName }`, so importing a
 * name the preview lacks fails at build time, naming it, instead of arriving
 * as `undefined` mid-frame.
 *
 *   montaj/render           exactly what render's core/index.js exports
 *   montaj-overlay-runtime  the preview globals (not the make* factories)
 *   react-dom, react-dom/client  nothing: the wrapper has no ReactDOM
 */
export const SUBSET_PACKAGE_GLOBALS = Object.freeze({
  'montaj/render':          identity(['interpolate', 'spring', 'useThreeFrame', 'captionOuterStyle', 'captionInnerStyle']),
  'montaj-overlay-runtime': identity(OVERLAY_GLOBAL_NAMES),
  'react-dom':              Object.freeze({}),
  'react-dom/client':       Object.freeze({}),
})

// The automatic JSX runtime, built on the wrapper's React. Only reached when a
// file opts into it (a `@jsxRuntime automatic` pragma, or a tsconfig that says
// `react-jsx`), since the preview's own setting is classic JSX.
//
// Key handling matches React 19's jsx(): the key argument is used unless the
// props object carries a defined `key` of its own, which then wins.
// createElement reads `key` out of its config, so both cases route there.
//
// jsxs() is for STATIC children (JSX siblings, not a mapped array). Passing
// them to createElement as separate arguments is what tells React they need no
// keys, exactly as the real jsxs() does; leaving them in props.children would
// make a development build warn about missing keys on every frame.
const JSX_RUNTIME_SOURCE = `const __React = React;
export const Fragment = __React.Fragment;
export function jsx(type, props, key) {
  if (key === undefined || (props != null && props.key !== undefined)) return __React.createElement(type, props);
  return __React.createElement(type, Object.assign({}, props, { key: key }));
}
export function jsxs(type, props, key) {
  if (props == null || !Array.isArray(props.children)) return jsx(type, props, key);
  const config = {};
  for (const k of Object.keys(props)) if (k !== 'children') config[k] = props[k];
  if (key !== undefined && config.key === undefined) config.key = key;
  return __React.createElement(type, config, ...props.children);
}
export function jsxDEV(type, props, key, isStaticChildren) {
  return isStaticChildren ? jsxs(type, props, key) : jsx(type, props, key);
}
`

export const JSX_RUNTIME_SPECIFIERS = Object.freeze(['react/jsx-runtime', 'react/jsx-dev-runtime'])

function wholePackageSource(globalName) {
  return `module.exports = ${globalName};\n`
}

function subsetSource(exportsMap) {
  const entries = Object.entries(exportsMap)
  if (entries.length === 0) return 'export {};\n'
  // A local alias per export: `export { interpolate }` would need a local
  // binding named `interpolate`, which would shadow the very global it reads.
  const decls = entries.map(([exp, glob]) => `const __preview_${exp} = ${glob};`)
  const list  = entries.map(([exp]) => `__preview_${exp} as ${exp}`).join(', ')
  return `${decls.join('\n')}\nexport { ${list} };\n`
}

/** The virtual module source for one shimmed specifier, or null if not shimmed. */
export function previewModuleSource(specifier) {
  if (Object.hasOwn(WHOLE_PACKAGE_GLOBALS, specifier)) return wholePackageSource(WHOLE_PACKAGE_GLOBALS[specifier])
  if (Object.hasOwn(SUBSET_PACKAGE_GLOBALS, specifier)) return subsetSource(SUBSET_PACKAGE_GLOBALS[specifier])
  if (JSX_RUNTIME_SPECIFIERS.includes(specifier)) return JSX_RUNTIME_SOURCE
  return null
}

export const SHIMMED_SPECIFIERS = Object.freeze([
  ...Object.keys(WHOLE_PACKAGE_GLOBALS),
  ...Object.keys(SUBSET_PACKAGE_GLOBALS),
  ...JSX_RUNTIME_SPECIFIERS,
])

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const SHIM_FILTER = new RegExp(`^(?:${SHIMMED_SPECIFIERS.map(escapeRe).join('|')})$`)

function previewGlobalsPlugin() {
  return {
    name: PREVIEW_NAMESPACE,
    setup(build) {
      // Runs before `alias` (measured on esbuild 0.20.2), so the base options'
      // react/montaj-render aliases never get a say for these specifiers.
      build.onResolve({ filter: SHIM_FILTER }, args => ({ path: args.path, namespace: PREVIEW_NAMESPACE }))
      build.onLoad({ filter: /.*/, namespace: PREVIEW_NAMESPACE }, args => ({
        contents: previewModuleSource(args.path),
        loader:   'js',
      }))
    },
  }
}

// ---------------------------------------------------------------------------
// inputs: the user's own files
// ---------------------------------------------------------------------------

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
  const add = p => {
    roots.add(p)
    try { roots.add(realpathSync(p)) } catch { /* absent in this install */ }
  }
  const nodeModules = join(__dirname, 'node_modules')
  add(nodeModules)
  add(join(__dirname, 'core'))
  add(join(__dirname, '..', 'overlay-runtime'))
  const addLinks = dir => {
    let names
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      const p = join(dir, name)
      if (name.startsWith('@')) { addLinks(p); continue }
      try { if (lstatSync(p).isSymbolicLink()) add(p) } catch { /* raced away */ }
    }
  }
  addLinks(nodeModules)
  engineRootsCache = [...roots]
  return engineRootsCache
}

const isUnder = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)

function collectInputs(metafile, absWorkingDir) {
  const roots = engineRoots()
  const out = new Set()
  for (const key of Object.keys(metafile.inputs)) {
    if (key.startsWith(`${PREVIEW_NAMESPACE}:`)) continue
    const abs = resolve(absWorkingDir, key)
    if (roots.some(r => isUnder(abs, r))) continue
    out.add(abs)
  }
  return [...out].sort()
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

/** esbuild's first error, as `<abs file>:<line>:<col>: <text>` (or `<text>` with no location). */
export class PreviewBuildError extends Error {
  constructor(errors, absWorkingDir) {
    super(formatBuildMessage(errors[0], absWorkingDir))
    this.name   = 'PreviewBuildError'
    this.errors = errors
  }
}

function formatBuildMessage(msg, absWorkingDir) {
  const loc = msg.location
  if (!loc || !loc.file) return msg.text
  const file = loc.file.startsWith(`${PREVIEW_NAMESPACE}:`) ? loc.file : resolve(absWorkingDir, loc.file)
  return `${file}:${loc.line}:${loc.column}: ${msg.text}`
}

/** The esbuild options for one preview build. Exported for tests. */
export function previewEsbuildOptions(entryPath, absWorkingDir = process.cwd()) {
  return {
    ...overlayEsbuildOptions(),
    entryPoints:   [entryPath],
    absWorkingDir,
    format:        'iife',
    globalName:    PREVIEW_GLOBAL_NAME,
    write:         false,
    metafile:      true,
    jsx:           'transform',
    jsxFactory:    'React.createElement',
    jsxFragment:   'React.Fragment',
    plugins:       [previewGlobalsPlugin()],
  }
}

/**
 * Bundle `entryPath` (absolute) for the preview.
 *
 * @returns {Promise<{ code: string, inputs: string[] }>}
 * @throws {PreviewBuildError} when esbuild reports an error
 */
export async function bundleOverlayForPreview(entryPath) {
  if (typeof entryPath !== 'string' || !isAbsolute(entryPath)) {
    throw new TypeError(`bundleOverlayForPreview: expected an absolute path, got ${JSON.stringify(entryPath)}`)
  }
  const absWorkingDir = process.cwd()
  let result
  try {
    result = await esbuild.build(previewEsbuildOptions(entryPath, absWorkingDir))
  } catch (err) {
    if (Array.isArray(err?.errors) && err.errors.length > 0) throw new PreviewBuildError(err.errors, absWorkingDir)
    throw err
  }
  return {
    code:   result.outputFiles[0].text,
    inputs: collectInputs(result.metafile, absWorkingDir),
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  const args = argv.slice(2)
  if (args.length !== 1 || !isAbsolute(args[0])) {
    process.stderr.write('usage: node preview-bundle.js <absolute path to overlay>\n')
    process.exitCode = 1
    return
  }
  const entry = args[0]
  let isFile = false
  try { isFile = statSync(entry).isFile() } catch { /* missing */ }
  if (!isFile) {
    process.stderr.write(`preview-bundle: no such file: ${entry}\n`)
    process.exitCode = 1
    return
  }
  try {
    const { code, inputs } = await bundleOverlayForPreview(entry)
    process.stdout.write(JSON.stringify({ ok: true, code, inputs }) + '\n')
    process.exitCode = 0
  } catch (err) {
    if (err instanceof PreviewBuildError) {
      process.stdout.write(JSON.stringify({ ok: false, error: 'build_failed', message: err.message }) + '\n')
      process.exitCode = 2
      return
    }
    process.stderr.write(`preview-bundle: ${err?.stack || err}\n`)
    process.exitCode = 1
  }
}

// exitCode, never process.exit(): a large bundle on a piped stdout must drain
// before the process ends.
if (isMain(import.meta.url, process.argv[1])) await main(process.argv)
