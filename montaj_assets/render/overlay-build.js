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
import { join, dirname, resolve, sep, basename, isAbsolute } from 'path'
import { realpathSync, readdirSync, lstatSync, readFileSync, existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { propFilePath, fromFileHref } from './file-url.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * The start of the error an import outside the read boundary gets. It names
 * the path only: the guard refuses the file before esbuild reads it, so no
 * text of it can reach the message.
 */
export const IMPORT_REFUSED = 'import outside the allowed folders:'

/** The esbuild plugin name of the read-boundary guard. */
export const READ_BOUNDARY_PLUGIN = 'montaj-read-boundary'

/**
 * The esbuild options every overlay bundle starts from.
 *
 * Per-call fields (`entryPoints`, `outfile`, `metafile`, `write`) are left to
 * the caller. A fresh object is returned on every call, so a caller may
 * override or mutate what it gets without touching anyone else's build.
 *
 * `boundary` (from `overlayReadBoundary`) is REQUIRED, so no overlay can be
 * built without it. It becomes an `onResolve` and an `onLoad` guard
 * (readBoundaryPlugin), and a file the boundary refuses is never read: the
 * build fails with `import outside the allowed folders: <path>` instead. An overlay's imports
 * are otherwise unbounded, and a `.json` or `.txt` import is bundled into the
 * page, where it can be drawn (PV54). A caller adding plugins of its own must
 * keep this one: `plugins: [...base.plugins, mine]`.
 */
export function overlayEsbuildOptions({ boundary } = {}) {
  if (!boundary || typeof boundary.allows !== 'function') {
    throw new TypeError('overlayEsbuildOptions: a read boundary is required (overlayReadBoundary)')
  }
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
    // esbuild reads config files while RESOLVING, which no load guard sees.
    // Measured with esbuild's own verbose log (PV54): for a file inside the
    // workspace it walks every ancestor directory up to `/`, listing each, and
    // reads any tsconfig.json and package.json it finds there, and a
    // tsconfig.json outside the workspace was APPLIED to the overlay.
    // tsconfigRaw supplies the config inline, so no tsconfig.json is read at
    // all (measured). absWorkingDir pins metafile keys and relative resolution
    // to render's own dir instead of the caller's cwd; overlayInputsFromMetafile
    // must be given the same dir.
    //
    // What remains, stated so nobody upgrades it to "no file outside the
    // boundary is ever read": directory listings of every ancestor, and the
    // package.json of ancestor directories and of node_modules directories on
    // a bare import's search path. Those can steer resolution; what they
    // resolve to still meets the onLoad guard, so none of it is bundled. An
    // import naming a directory outside the boundary is refused before
    // esbuild resolves it (readBoundaryPlugin's onResolve), so esbuild never
    // reads that directory's package.json.
    tsconfigRaw: {},
    absWorkingDir: __dirname,
    logLevel: 'silent',
    plugins: [readBoundaryPlugin(boundary)],
  }
}

// Two guards, on purpose, and neither is redundant. onResolve refuses a
// relative or absolute import whose target is outside the boundary BEFORE
// esbuild resolves it, so esbuild never lists that directory or reads its
// package.json (measured: without it, an import naming a directory made
// esbuild read its package.json, and the refusal named `<dir>/<main>`). onLoad refuses any file
// outside the boundary that reaches loading by another route: a bare
// specifier, a package.json `main`/`browser` field, a symlink. Both return
// `undefined` for an allowed path, handing it on to esbuild unchanged, so an
// allowed file builds exactly as it would with no guard.
// Both errors start with IMPORT_REFUSED: serve's bundle route matches it.
function readBoundaryPlugin(boundary) {
  const refuse = path => ({ errors: [{ text: `${IMPORT_REFUSED} ${path}` }] })
  return {
    name: READ_BOUNDARY_PLUGIN,
    setup(build) {
      // Relative (`.`, `..`, `./x`, `../x`) and absolute specifiers only, from
      // a file: bare specifiers (packages, the aliases) and other namespaces
      // (preview-bundle.js's virtual modules) pass through untouched.
      //
      // An import made BY an engine file (engineRoots(): montaj's own code,
      // ~10k of a bundle's resolves) is not checked here, which cut this
      // guard's cost from ~370 to ~170 ms a bundle (measured); onLoad still
      // checks every file it loads.
      const engine = engineRoots()
      build.onResolve({ filter: /^(\.\.?(\/|$)|\/)/ }, args => {
        if (args.namespace !== 'file') return undefined
        if (args.importer && engine.some(r => isUnder(args.importer, r))) return undefined
        const target = isAbsolute(args.path) ? args.path : resolve(args.resolveDir, args.path)
        return boundary.allows(target) ? undefined : refuse(target)
      })
      build.onLoad({ filter: /.*/, namespace: 'file' }, args =>
        boundary.allows(args.path) ? undefined : refuse(args.path))
    },
  }
}

// ---------------------------------------------------------------------------
// the read boundary
// ---------------------------------------------------------------------------

/**
 * The workspace directory, with serve's precedence (`resolve_workspace` in
 * serve/common.py): `MONTAJ_WORKSPACE_DIR`, then `~/.montaj/config.json`'s
 * `workspaceDir`, then `~/Montaj`. Read at call time, like serve's.
 * tests/test_overlay_read_boundary_parity.py pins the two to each other.
 */
export function workspaceDir() {
  const envDir = process.env.MONTAJ_WORKSPACE_DIR
  if (envDir) return envDir
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.montaj', 'config.json'), 'utf8'))
    // serve's Path(cfg["workspaceDir"]) raises on a non-string, and falls back.
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg) && typeof cfg.workspaceDir === 'string') {
      return cfg.workspaceDir
    }
  } catch { /* absent or unreadable: serve falls back too */ }
  return join(homedir(), 'Montaj')
}

/**
 * The realpathed directory roots an overlay page may read under: the
 * workspace, `~/.montaj/overlays` and `~/.montaj/profiles` (serve's
 * `_allowed_file_roots()`), render's `templates/`, engineRoots(), the vendored
 * fonts base (`MONTAJ_FONTS_DIR`, and the caller's `fontsDir`) when set, the
 * caller's `projectDir` when it is inside one of those, and `workDir`.
 * Deduped, in that order.
 */
export function overlayReadRoots({ projectDir = null, workDir = null, fontsDir = null } = {}) {
  const home = homedir()
  const spelled = [
    workspaceDir(),
    join(home, '.montaj', 'overlays'),
    join(home, '.montaj', 'profiles'),
    join(__dirname, 'templates'),
    ...engineRoots(),
  ]
  if (process.env.MONTAJ_FONTS_DIR) spelled.push(process.env.MONTAJ_FONTS_DIR)
  // The fonts base the page's stylesheet links (bundleComponent's fontsBaseDir),
  // which a caller may pass without the env.
  if (fontsDir) spelled.push(fontsDir)
  // The roots above are ours: fixed paths, or a directory we create. `projectDir`
  // is not — it is wherever the project.json happens to live, so it is the one
  // caller-supplied root a user controls.
  //
  // Operator rule (Sam, 2026-09-29): a project folder counts as an allowed root
  // ONLY if it is already inside the workspace or another allowed root. So the
  // push below can only ever be redundant, and that is the point: a project
  // saved directly in `~` would otherwise make the home directory a root, which
  // admits `~/.ssh/id_rsa` and `~/.env` — the exact files this boundary exists
  // to refuse. One over-broad root defeats every other one, because `allows()`
  // is a disjunction.
  //
  // An allowlist, not a blocklist, deliberately. Enumerating "too broad"
  // directories (`~`, `/`, `/Users`) was the first attempt and it is the wrong
  // shape: it has to anticipate every such directory, and missing one
  // (`/Volumes`, a mounted share) reopens the hole silently.
  //
  // What a project outside the workspace loses: nothing that `props` names,
  // because the exact files in `props` are allowed wherever they live. What it
  // loses is an overlay IMPORTING a sibling from outside the workspace, which
  // then fails through the ordinary onLoad guard with its own path named.
  const fixedRoots = spelled.map(p => realpathLoose(resolve(p)))
  if (projectDir && isUnderAnyRoot(projectDir, fixedRoots)) spelled.push(projectDir)
  // `workDir` is the bundle's own temp directory, created by render, never
  // user-supplied, so the rule above does not apply to it.
  if (workDir) spelled.push(workDir)
  return [...new Set(spelled.map(p => realpathLoose(resolve(p))))]
}

/** Is `dir` inside (or equal to) one of `roots`? Compared by realpath, like allows(). */
function isUnderAnyRoot(dir, roots) {
  const p = realpathLoose(resolve(dir))
  return roots.some(r => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep))
}

/**
 * The read boundary of one overlay page:
 * `{ roots, files, urls, unfetchedUrls, allows(path) }`.
 *
 *   roots          overlayReadRoots({ projectDir, workDir, fontsDir })
 *   files          the exact files named: every absolute path (or file://
 *                  URL) in `props`, found the way bundle.js's
 *                  rewritePathsToFileUrls finds them, plus `files` (the
 *                  overlay's own entry). Users reference images outside the
 *                  workspace, so a named file is allowed even there; nothing
 *                  beside it is.
 *   urls           the http(s) URLs in `props` that name media
 *                  (isPropsMediaUrl), normalized (`new URL(u).href`): the
 *                  ones fetched for the page (page-guard.js)
 *   unfetchedUrls  the other http(s) URLs in `props`, never fetched
 *
 * `allows(path)` compares by realpath against realpathed roots, so a symlink
 * inside a root that points outside is refused, as serve's /api/files refuses
 * it. A path that does not exist (nothing to read) is judged by the realpath
 * of its nearest existing ancestor with the missing tail appended, so a
 * missing file or folder inside a root is a plain not-found (esbuild's "Could
 * not resolve") rather than a block.
 */
export function overlayReadBoundary({ projectDir = null, workDir = null, fontsDir = null, props = undefined, files = [] } = {}) {
  const roots = overlayReadRoots({ projectDir, workDir, fontsDir })
  const named = new Set()
  const urls = new Set()
  collectNamed(props, named, urls)
  for (const f of files) addNamedFile(named, f)
  const underRoot = real => roots.some(r => isUnder(real, r))
  return Object.freeze({
    roots,
    files: named,
    urls: new Set([...urls].filter(isPropsMediaUrl)),
    unfetchedUrls: new Set([...urls].filter(u => !isPropsMediaUrl(u))),
    allows(p) {
      if (typeof p !== 'string' || !isAbsolute(p) || p.includes('\0')) return false
      const real = realpathOrNull(p)
      if (real !== null) return named.has(real) || underRoot(real)
      return underRoot(realpathLoose(resolve(p)))
    },
  })
}

/**
 * The file extensions of a props URL that is fetched for the page: images,
 * video, audio, fonts and data files. Props also hold URLs that are only shown
 * as text (a call-to-action link, a QR code's target), and fetching one of
 * those could act on it (an unsubscribe or confirm link), so a URL is fetched
 * only when its path ends in one of these. A remote image with no extension
 * belongs in the project as a file.
 */
export const PROPS_MEDIA_EXTENSIONS = Object.freeze([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'apng', 'tif', 'tiff', 'heic',
  'mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv',
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus',
  'woff', 'woff2', 'ttf', 'otf',
  'json', 'csv', 'vtt', 'srt',
])
const MEDIA_PATH = new RegExp(`\\.(${PROPS_MEDIA_EXTENSIONS.join('|')})$`, 'i')

/** Whether a props URL names media, and so is fetched for the page. */
export function isPropsMediaUrl(href) {
  try {
    const u = new URL(href)
    return (u.protocol === 'http:' || u.protocol === 'https:') && MEDIA_PATH.test(u.pathname)
  } catch {
    return false
  }
}

/** The distinct http(s) media URLs in `props` (isPropsMediaUrl), normalized. */
export function namedPropsUrls(props) {
  const urls = new Set()
  collectNamed(props, new Set(), urls)
  return [...urls].filter(isPropsMediaUrl)
}

function collectNamed(value, files, urls) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) {
      try { urls.add(new URL(value).href) } catch { /* not a URL: nothing to fetch */ }
    } else if (/^file:\/\//i.test(value)) {
      try { addNamedFile(files, fromFileHref(new URL(value).href.replace(/[?#].*$/, ''))) } catch { /* malformed */ }
    } else {
      const file = propFilePath(value)
      if (file !== null) addNamedFile(files, resolveFilePath(file) ?? file)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectNamed(v, files, urls)
    return
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectNamed(v, files, urls)
  }
}

// A named FILE, exactly: a directory is not added, or a prop naming a folder
// would open everything under it.
function addNamedFile(set, p) {
  const real = realpathOrNull(p)
  if (real === null) return
  try { if (statSync(real).isFile()) set.add(real) } catch { /* raced away */ }
}

/** Resolve a path that may contain macOS narrow no-break spaces (\u202f). */
export function resolveFilePath(p) {
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

function realpathOrNull(p) {
  try { return realpathSync.native(p) } catch { return null }
}

// Python's non-strict Path.resolve(): the realpath of the nearest existing
// ancestor, with the missing tail appended, so a root that does not exist yet
// (a fresh machine's ~/Montaj) compares the way serve's does.
function realpathLoose(p) {
  const tail = []
  let cur = p
  for (;;) {
    const real = realpathOrNull(cur)
    if (real !== null) return tail.length ? join(real, ...tail.reverse()) : real
    const parent = dirname(cur)
    if (parent === cur) return p
    tail.push(basename(cur))
    cur = parent
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
 * and core/, the sibling overlay-runtime and timeline-core, and the real
 * target of every package render's node_modules links to. Each is listed as
 * spelled and as its realpath, since esbuild reports realpaths.
 *
 * The fixed entries are what make the roots the same in any layout: whether
 * `montaj-overlay-runtime` and `@bycrux/timeline-core` are symlinks into those
 * siblings depends on how npm linked the `file:` dependencies (its
 * `install-links` default has flipped before), and a wheel ships no
 * node_modules at all. The symlink pass catches the rest. Do not drop a fixed
 * entry as redundant with it.
 */
export function engineRoots() {
  if (engineRootsCache) return engineRootsCache
  const roots = new Set()
  const nodeModules = join(__dirname, 'node_modules')
  addWithRealpath(roots, nodeModules)
  addWithRealpath(roots, join(__dirname, 'core'))
  addWithRealpath(roots, join(__dirname, '..', 'overlay-runtime'))
  addWithRealpath(roots, join(__dirname, '..', 'timeline-core'))
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
