#!/usr/bin/env node
/**
 * export-pages.js — Overlays as web pages.
 *
 * Writes each overlay (and the caption layer) of a project as ONE self-contained HTML page that plays by itself:
 * the overlay's own bundle (render/bundle.js, the page the render captures) inlined with its props, a small player
 * that steps `window.__setFrame` at the item's fps and loops, a transparent background, and the files its props
 * name copied beside the page with relative paths. Nothing here draws: the page runs the same code the render does,
 * so its frames are the render's frames.
 *
 * Usage:
 *   node export-pages.js --project <project.json> --out <dir> [--items id,id] [--name <prefix>]
 *   node export-pages.js --project <project.json> --list          (what could be exported, as JSON; writes nothing)
 *
 * stdout: one JSON object. `--list`: {items: [{id, name, caption, start, end}]}.
 *         export: {dir, pages: [{id, name, file, start, end}], files: [paths relative to dir], warnings: [...]}.
 * stderr: progress lines; on failure the last line is {"error": {code, message}}. exit 0 on success, 1 on failure.
 *
 * Fonts: the page links Google Fonts as the render's page does, so it needs the network the first time it opens.
 * Props URLs (http/https) stay URLs.
 *
 * Scratch (the bundles) goes to the OS temp dir and is removed.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, statSync, readdirSync } from 'fs'
import { join, dirname, basename, extname, resolve } from 'path'
import { tmpdir } from 'os'
import esbuild from 'esbuild'
import { collectPuppeteerSegments, overlayBakeInputs } from './render.js'
import { bundleComponent, cleanupBundle, resolveFilePath } from './bundle.js'
import { fromFileHref, propFilePath } from './file-url.js'
import { isMain as isMainModule } from './is-main.js'

const isMain = isMainModule(import.meta.url, process.argv[1])

/** A folder this module wrote, so a re-export may replace it. */
export const MARKER = '.montaj-overlay-pages'

class ExportError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'overlay'

/** The player appended to every page. `?frame=N` freezes the page on that frame (tests, thumbnails). */
export function playerScript(fps, frames) {
  return `<script>
(function () {
  var fps = ${Number(fps)}, frames = ${Math.max(1, Math.floor(frames))}
  var q = new URLSearchParams(location.search)
  var last = -1, t0 = null
  function show(f) { if (f !== last && typeof window.__setFrame === 'function') { last = f; window.__setFrame(f) } }
  if (q.has('frame')) {
    var n = Math.max(0, Math.min(frames - 1, parseInt(q.get('frame'), 10) || 0))
    var wait = function () { if (typeof window.__setFrame === 'function') show(n); else requestAnimationFrame(wait) }
    requestAnimationFrame(wait)
    return
  }
  function tick(ts) {
    if (t0 === null) t0 = ts
    show(Math.floor((ts - t0) / 1000 * fps) % frames)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()
</script>`
}

/** Inline the render's own page (index.html + bundle.js) into one file: bundle as an inline module, player after it, no CSP. */
export function inlinePage(html, bundleJs, { title, fps, frames }) {
  const tag = '<script type="module" src="bundle.js"></script>'
  if (!html.includes(tag)) throw new ExportError('page_shape', 'the overlay page has an unexpected shape (no bundle script tag)')
  // The render's bundle is unminified (it is read once, locally); a page someone ships should be small.
  const mini = esbuild.transformSync(bundleJs, { minify: true, format: 'esm', legalComments: 'none' }).code
  const code = mini.replace(/<\/script/gi, '<\\/script')
  return html
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, '')
    .replace('<meta charset="utf-8">', () => `<meta charset="utf-8">\n<title>${String(title).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</title>`)
    .replace(tag, () => `<script type="module">\n${code}\n</script>\n${playerScript(fps, frames)}`)
}

/** Does the overlay (or a file it imports from beside it) name an icon? When unsure, yes: the icons stay. */
export function usesIcons(componentPath) {
  const seen = new Set()
  const scan = (file, depth) => {
    if (seen.has(file)) return false
    seen.add(file)
    let src
    try { src = readFileSync(file, 'utf8') } catch { return true }
    if (/\b(Ph|FaSolid|FaBrands|FaIcon)\b|phosphor|fortawesome|icons?\b/i.test(src)) return true
    if (depth === 0) return false
    for (const m of src.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const base = resolve(dirname(file), m[1])
      const next = [base, `${base}.jsx`, `${base}.js`, `${base}.tsx`, `${base}.ts`].find((f) => { try { return statSync(f).isFile() } catch { return false } })
      if (!next || scan(next, depth - 1)) return true
    }
    return false
  }
  return scan(componentPath, 2)
}

/** The path a `file://` prop names, read as the render reads it (overlay-build's collectNamed), else null. */
function fileHrefProp(value) {
  if (typeof value !== 'string' || !/^file:\/\//i.test(value)) return null
  try { return fromFileHref(new URL(value).href.replace(/[?#].*$/, '')) } catch { return null }
}

/** Copy every file a props value names into `assetsDir`, and give back props pointing at the copies, relative. */
export function relocateProps(value, assetsDir, copied, warnings, counter = { n: 0 }) {
  const file = propFilePath(value) ?? fileHrefProp(value)
  if (file !== null) {
    const resolved = resolveFilePath(file) ?? file
    let ok = false
    try { ok = statSync(resolved).isFile() } catch { ok = false }
    if (!ok) { warnings.push(`a file the overlay names is missing: ${basename(file)}`); return value }
    if (!copied.has(resolved)) {
      mkdirSync(assetsDir, { recursive: true })
      const name = `${String(++counter.n).padStart(2, '0')}-${basename(resolved)}`
      copyFileSync(resolved, join(assetsDir, name))
      copied.set(resolved, `assets/${name}`)
    }
    return copied.get(resolved)
  }
  if (Array.isArray(value)) return value.map((v) => relocateProps(v, assetsDir, copied, warnings, counter))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = relocateProps(v, assetsDir, copied, warnings, counter)
    return out
  }
  return value
}

function readProject(path) {
  // Item srcs are relative to the project's folder, as the render reads them (it works from there).
  process.chdir(dirname(resolve(path)))
  let project
  try { project = JSON.parse(readFileSync(path, 'utf8')) } catch (e) {
    throw new ExportError('invalid_project', `Could not read project.json at ${path}: ${e.message}`)
  }
  const settings = project.settings ?? {}
  const fps = Number.isFinite(settings.fps) && settings.fps > 0 ? Math.round(settings.fps) : 30
  const [width, height] = Array.isArray(settings.resolution) && settings.resolution.length === 2 ? settings.resolution : [1080, 1920]
  return { project, fps, width, height }
}

/** The layers that can be a page: every overlay item, and the caption layer. */
export function listLayers(projectPath) {
  projectPath = resolve(projectPath)
  const { project, fps, width, height } = readProject(projectPath)
  const specs = collectPuppeteerSegments(project, fps, width, height, tmpdir())
  const used = new Set()
  return specs.map((spec) => {
    let name = spec.isCaption ? 'captions' : slug(basename(spec.componentPath, extname(spec.componentPath)))
    for (let i = 2; used.has(name); i++) name = `${name}-${i}`
    used.add(name)
    return { spec, id: spec.id, name, caption: !!spec.isCaption, start: spec.startSeconds, end: spec.endSeconds }
  })
}

/** Is `dir` safe to replace: absent, empty, or one this module wrote. */
function checkOut(dir) {
  if (!existsSync(dir)) return
  if (!statSync(dir).isDirectory()) throw new ExportError('out_exists', `${dir} is a file`)
  if (readdirSync(dir).length === 0 || existsSync(join(dir, MARKER))) return
  throw new ExportError('out_exists', `${dir} already has other files in it; pick an empty folder`)
}

export async function exportPages({ projectPath, outDir, items = null, log = () => {} }) {
  projectPath = resolve(projectPath)
  outDir = resolve(outDir)
  const { fps, width, height } = readProject(projectPath)
  const projectDir = dirname(resolve(projectPath))
  const layers = listLayers(projectPath)
  const chosen = items && items.length ? layers.filter((l) => items.includes(l.id) || items.includes(l.name)) : layers
  if (chosen.length === 0) throw new ExportError('no_items', items && items.length ? 'None of the named overlays are in the project' : 'The project has no overlays to export')
  checkOut(outDir)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, MARKER), 'written by export-pages.js; a re-export replaces this folder\n')

  const warnings = []
  const pages = []
  const copied = new Map()
  const counter = { n: 0 }
  const assetsDir = join(outDir, 'assets')
  let n = 0
  for (const layer of chosen) {
    n++
    log(`page ${n}/${chosen.length} (${layer.name})`)
    const { spec } = layer
    const props = relocateProps(spec.props ?? {}, assetsDir, copied, warnings, counter)
    const { htmlPath, workDir } = await bundleComponent({
      componentPath: spec.componentPath,
      props,
      fps,
      durationFrames: spec.frameCount,
      width,
      height,
      ...overlayBakeInputs(spec),
      googleFonts: spec.googleFonts ?? [],
      fontsBaseDir: '',
      projectDir,
      stubIcons: !usesIcons(spec.componentPath),
    })
    try {
      const html = readFileSync(htmlPath, 'utf8')
      const bundleJs = readFileSync(join(workDir, 'bundle.js'), 'utf8')
      const file = `${layer.name}.html`
      writeFileSync(join(outDir, file), inlinePage(html, bundleJs, { title: layer.name, fps, frames: spec.frameCount }))
      pages.push({ id: layer.id, name: layer.name, file, start: layer.start, end: layer.end })
      if (/https:\/\/fonts\.googleapis\.com/.test(html)) warnings.push(`${layer.name}: its fonts load from Google Fonts, so the page needs the network the first time it opens`)
    } finally {
      cleanupBundle(workDir)
    }
  }
  const files = [...pages.map((p) => p.file), ...[...copied.values()]]
  return { dir: outDir, pages, files, warnings }
}

function parseArgs(argv) {
  const out = { items: null, list: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--project') out.project = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--items') out.items = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--list') out.list = true
  }
  return out
}

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const fail = (code, message) => { process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`); process.exit(1) }
  if (!args.project) fail('invalid_args', 'Usage: export-pages.js --project <project.json> (--out <dir> [--items id,id] | --list)')
  try {
    if (args.list) {
      const items = listLayers(args.project).map(({ id, name, caption, start, end }) => ({ id, name, caption, start, end }))
      process.stdout.write(`${JSON.stringify({ items })}\n`)
    } else {
      if (!args.out) fail('invalid_args', '--out <dir> is required')
      const result = await exportPages({ projectPath: args.project, outDir: resolve(args.out), items: args.items, log: (m) => process.stderr.write(`${m}\n`) })
      process.stdout.write(`${JSON.stringify(result)}\n`)
    }
  } catch (e) {
    fail(e.code ?? 'export_failed', e.message ?? String(e))
  }
}
