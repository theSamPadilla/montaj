#!/usr/bin/env node
// render/export-editor.js
/**
 * Export for editor: write a project's edit as a package an editor opens.
 *
 *   export-editor.js --project <project.json> --name <name> [--out <dir>]
 *
 * The package, at `--out` (default `<projectDir>/export/<name> (editor)/`):
 *
 *   <name>.xml          FCP7 XML for Premiere Pro and DaVinci Resolve
 *   graphics/<id>.mov   one ProRes 4444 alpha movie per overlay
 *   captions.mov        the caption layer, ProRes 4444 alpha
 *   captions.srt        the captions as text
 *
 * Progress goes to stderr, one JSON line per finished movie:
 * `{"progress":{"done":3,"total":8,"label":"..."}}`. The ONE result goes to
 * stdout: `{ dir, xml, files, leftOut, warnings, seconds }`; `leftOut` is what
 * the XML marks as staying in Montaj, `[{ clip, label }]`. A failure is
 * `{"error","message"}` on stderr and a non-zero exit.
 *
 * Every package holds a `.montaj-editor-export` marker file. A re-export
 * replaces `--out` only when it is absent, empty, or a package with that marker;
 * any other file or folder there is refused (`out_exists`) and left alone.
 *
 * The package is built in a hidden sibling folder and renamed into place at the
 * end, so a failed export leaves no half package and a re-export of the same
 * name replaces the old one whole.
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, existsSync, readdirSync, statSync, chmodSync } from 'node:fs'
import { dirname, join, resolve, relative, basename, sep, isAbsolute } from 'node:path'
import { isMain as isMainModule } from './is-main.js'
import { buildNleTimeline } from './nle/timeline.js'
import { probeSources } from './nle/probe.js'
import { renderNleGraphics } from './nle/graphics.js'
import { captionsToSrt } from './nle/srt.js'
import { writeXmeml } from './nle/xmeml.js'
import { cleanFileName } from './nle/file-name.js'
import { resolveProjectSrc, resolveFilePath } from './project-paths.js'
import { trackItems } from './project-tracks.js'

/** Written into every package: only a folder with it is ever replaced by a re-export. */
export const PACKAGE_MARKER = '.montaj-editor-export'

const isMain = isMainModule(import.meta.url, process.argv[1])

class ExportError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * @param {{
 *   projectPath: string,
 *   name?: string,
 *   out?: string,
 *   onProgress?: (p: { done: number, total: number, label: string }) => void,
 * }} options
 * @returns {Promise<{ dir: string, xml: string, files: string[], leftOut: { clip: string, label: string }[], warnings: string[], seconds: number }>}
 */
export async function exportForEditor({ projectPath, name, out, onProgress }) {
  const startedAt = Date.now()
  if (!projectPath) throw new ExportError('invalid_args', '--project is required')
  const absProject = resolve(projectPath)
  const projectDir = dirname(absProject)

  let project
  try {
    project = JSON.parse(readFileSync(absProject, 'utf8'))
  } catch (e) {
    throw new ExportError(e?.code === 'ENOENT' ? 'project_not_found' : 'invalid_project', `Could not read ${absProject}: ${e.message}`)
  }

  const packageName = cleanFileName(String(name ?? '').trim() || project.name || project.id || basename(projectDir))
  const finalDir = resolve(out || join(projectDir, 'export', `${packageName} (editor)`))
  const inside = relative(finalDir, projectDir)
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    throw new ExportError('invalid_args', `--out ${finalDir} is the project folder or holds it; pick a folder of its own`)
  }

  if (existsSync(finalDir)) {
    const st = statSync(finalDir)
    if (!st.isDirectory()) {
      throw new ExportError('out_exists', `--out ${finalDir} is a file; pick a folder of its own`)
    }
    if (readdirSync(finalDir).length > 0 && !existsSync(join(finalDir, PACKAGE_MARKER))) {
      throw new ExportError('out_exists', `--out ${finalDir} is a folder that is not a previous editor export; pick an empty or new folder`)
    }
  }

  mkdirSync(dirname(finalDir), { recursive: true })
  const tmpDir = mkdtempSync(join(dirname(finalDir), `.${basename(finalDir)}.tmp-`))
  // mkdtemp makes it owner-only; the package should have the folder's usual mode.
  chmodSync(tmpDir, 0o777 & ~process.umask())
  // Killed mid-run, the hidden folder must not stay behind.
  const cleanup = () => rmSync(tmpDir, { recursive: true, force: true })
  process.on('exit', cleanup)
  try {
    const timeline = buildNleTimeline(renderResolved(project, projectDir), { projectDir })
    const sourceProbes = await probeSources(Object.keys(timeline.sources))

    const rendered = await renderNleGraphics(project, timeline, { projectDir, outDir: tmpDir, onProgress })

    // The movies are in the temp folder until the rename; the XML must name
    // their FINAL paths, so map every path across.
    const toFinal = (p) => join(finalDir, relative(tmpDir, p))
    const movies = [...Object.values(rendered.graphics), ...(rendered.captions ? [rendered.captions] : [])]
    const movieProbes = await probeSources(movies)
    const probes = { ...sourceProbes }
    for (const m of movies) probes[toFinal(m)] = movieProbes[m]
    const graphics = Object.fromEntries(Object.entries(rendered.graphics).map(([id, p]) => [id, toFinal(p)]))
    const captions = rendered.captions ? toFinal(rendered.captions) : null

    const srt = captionsToSrt(project)
    if (srt !== null) writeFileSync(join(tmpDir, 'captions.srt'), srt, 'utf8')

    const xmlName = `${packageName}.xml`
    const { xml, warnings: xmlWarnings, leftOut } = writeXmeml(timeline, probes, { name: packageName, graphics, captions, xmlDir: finalDir })
    writeFileSync(join(tmpDir, xmlName), xml, 'utf8')
    writeFileSync(join(tmpDir, PACKAGE_MARKER), 'Montaj Export for editor. A re-export replaces this folder.\n', 'utf8')

    const replaceWarning = replaceDir(tmpDir, finalDir)

    return {
      dir: finalDir,
      xml: join(finalDir, xmlName),
      files: listFiles(finalDir),
      leftOut,
      warnings: [...new Set([...timeline.warnings, ...rendered.warnings, ...xmlWarnings, ...(replaceWarning ? [replaceWarning] : [])])],
      seconds: (Date.now() - startedAt) / 1000,
    }
  } catch (e) {
    cleanup()
    throw e
  } finally {
    process.off('exit', cleanup)
  }
}

/**
 * A copy of the project with every file path the way the render finds it: a
 * relative path made absolute, and a name with a space where the file on disk
 * has a macOS narrow no-break space pointed at the real file (render.js's
 * `resolveProjectPaths` does the same), so the export links what the render uses.
 */
function renderResolved(project, projectDir) {
  const copy = structuredClone(project)
  const resolveOne = (src) => {
    const abs = resolveProjectSrc(src, projectDir)
    return resolveFilePath(abs) ?? abs
  }
  for (const track of trackItems(copy)) {
    for (const item of track ?? []) {
      if (item?.src) item.src = resolveOne(item.src)
      if (item?.nobg_src) item.nobg_src = resolveOne(item.nobg_src)
    }
  }
  for (const track of copy.audio?.tracks ?? []) {
    if (track?.src) track.src = resolveOne(track.src)
  }
  return copy
}

/**
 * Rename `from` to `to`, replacing an existing `to`; the old one is put back if
 * the rename fails. Returns a warning when the new package is in place but the
 * old one could not be removed.
 */
function replaceDir(from, to) {
  let parked = null
  if (existsSync(to)) {
    parked = mkdtempSync(join(dirname(to), `.${basename(to)}.old-`))
    rmSync(parked, { recursive: true, force: true })
    renameSync(to, parked)
  }
  try {
    renameSync(from, to)
  } catch (e) {
    if (parked) renameSync(parked, to)
    throw e
  }
  if (parked) {
    try {
      rmSync(parked, { recursive: true, force: true })
    } catch (e) {
      return `the new package is in place, but the previous one could not be removed (${parked}): ${e.message}`
    }
  }
  return null
}

/** Every file under `dir`, relative, `/`-separated, sorted. */
function listFiles(dir) {
  const files = []
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry)
      if (statSync(p).isDirectory()) walk(p)
      else if (entry !== PACKAGE_MARKER || d !== dir) files.push(relative(dir, p).split(sep).join('/'))
    }
  }
  walk(dir)
  return files.sort()
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--project' || flag === '--name' || flag === '--out') {
      if (i + 1 >= argv.length) throw new ExportError('invalid_args', `${flag} needs a value`)
      args[flag.slice(2)] = argv[++i]
    } else {
      throw new ExportError('invalid_args', `unknown argument ${flag}`)
    }
  }
  return args
}

if (isMain) {
  const fail = (e) => {
    process.stderr.write(`${JSON.stringify({ error: e?.code && typeof e.code === 'string' && /^[a-z_]+$/.test(e.code) ? e.code : 'export_failed', message: e?.message ?? String(e) })}\n`)
    process.exit(1)
  }
  // A closed stderr (the parent went away) ends the run; the exit hook removes the scratch folder.
  process.stderr.on('error', () => process.exit(1))
  // A signal's default is to die without running exit hooks; exit instead.
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(128 + (sig === 'SIGINT' ? 2 : 15)))
  try {
    const argv = process.argv.slice(2)
    if (!argv.length || argv.includes('--help')) {
      process.stderr.write('Usage: export-editor.js --project <project.json> --name <name> [--out <dir>]\n')
      process.exit(1)
    }
    const args = parseArgs(argv)
    const result = await exportForEditor({
      projectPath: args.project,
      name: args.name,
      out: args.out,
      onProgress: (p) => process.stderr.write(`${JSON.stringify({ progress: p })}\n`),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0))
  } catch (e) {
    fail(e)
  }
}
