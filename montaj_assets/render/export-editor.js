#!/usr/bin/env node
// render/export-editor.js
/**
 * Export for editor: write a project's edit as a package an editor opens.
 *
 *   export-editor.js --project <project.json> [--editor premiere|resolve|fcp|ae] [--name <name>] [--out <folder>]
 *
 * `--out` is the folder the package goes IN (default `<projectDir>/export/`); the package is
 * `<out>/<name> (<Editor label>)/`, and when that name is taken it becomes `... 2`, `... 3`. Nothing already in the
 * folder is ever touched or replaced. The package:
 *
 *   <name>.xml          FCP7 XML, for premiere (Premiere Pro) and resolve (DaVinci Resolve)
 *   <name>.fcpxml       FCPXML 1.9, for fcp (Final Cut Pro)
 *   <name>.jsx          for ae (After Effects): a script that builds the composition and saves <name>.aep beside it
 *   media/<file>        a copy of every footage and audio file the timeline uses, so the package opens anywhere
 *   graphics/<id>.mov   one ProRes 4444 alpha movie per overlay
 *   captions.mov        the caption layer, ProRes 4444 alpha
 *   captions.srt        the captions as text
 *
 * The XML and FCPXML link the copies in the package by their absolute path; move the folder and the editor asks to
 * locate the media, as for any package. The .jsx finds them beside itself.
 *
 * Progress goes to stderr, one JSON line per finished step: `{"progress":{"done":3,"total":8,"label":"..."}}`.
 * The ONE result goes to stdout: `{ dir, open, openSha256, xml, files, leftOut, warnings, seconds }`, plus `aep` for
 * ae; `open` (and `xml`) is the file to hand the editor (the .xml, .fcpxml or .jsx), `openSha256` the lower-case hex
 * SHA-256 of that file as it is in the package (so a launcher can check it is what was written), `aep` is where the
 * script saves the project, `leftOut` is what the timeline marks as staying in Montaj, `[{ clip, label }]`. A failure
 * is `{"error","message"}` on stderr and a non-zero exit.
 *
 * Every package holds a `.montaj-editor-export` marker file (the app launches only a file whose folder has it).
 *
 * The package is built in a hidden sibling folder and renamed into place at the end, so a failed export leaves no
 * half package.
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, existsSync, readdirSync, statSync, chmodSync, copyFileSync, constants as fsConstants } from 'node:fs'
import { dirname, join, resolve, relative, basename, sep, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { isMain as isMainModule } from './is-main.js'
import { buildNleTimeline } from './nle/timeline.js'
import { probeSources } from './nle/probe.js'
import { renderNleGraphics, removeNleScratch } from './nle/graphics.js'
import { captionsToSrt } from './nle/srt.js'
import { writeXmeml } from './nle/xmeml.js'
import { writeAeScript } from './nle/aejsx.js'
import { writeFcpxml } from './nle/fcpxml.js'
import { cleanFileName } from './nle/file-name.js'
import { ExportError } from './nle/export-error.js'
import { resolveProjectSrc, resolveFilePath } from './project-paths.js'
import { trackItems } from './project-tracks.js'

/** Written into every package: the app launches only a file whose folder has it. */
export const PACKAGE_MARKER = '.montaj-editor-export'

const isMain = isMainModule(import.meta.url, process.argv[1])

/** The editors a package can be written for, each with the label its folder carries. `file` is what `open` names. */
export const EDITORS = {
  premiere: { label: 'Premiere Pro', writer: 'xmeml' },
  resolve: { label: 'DaVinci Resolve', writer: 'xmeml' },
  fcp: { label: 'Final Cut Pro', writer: 'fcpxml' },
  ae: { label: 'After Effects', writer: 'jsx' },
}
/** What this build writes. All four write. */
export const AVAILABLE_EDITORS = ['premiere', 'resolve', 'fcp', 'ae']

/** How many times the package is moved into place before the export gives up. */
export const RENAME_TRIES = 50
/** Windows: a folder still held open (an indexer, an antivirus scan) refuses a rename for a moment. */
const WIN_BUSY = new Set(['EPERM', 'EBUSY', 'EACCES'])

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * @param {{
 *   projectPath: string,
 *   name?: string,
 *   out?: string,       the folder the package goes in
 *   editor?: 'premiere' | 'resolve' | 'fcp' | 'ae',
 *   onProgress?: (p: { done: number, total: number, label: string }) => void,
 * }} options
 * @returns {Promise<{ dir: string, open: string, openSha256: string, xml: string, aep?: string, files: string[], leftOut: { clip: string, label: string }[], warnings: string[], seconds: number }>}
 */
export async function exportForEditor({ projectPath, name, out, editor = 'premiere', onProgress }) {
  const startedAt = Date.now()
  if (!projectPath) throw new ExportError('invalid_args', '--project is required')
  if (!EDITORS[editor]) throw new ExportError('invalid_args', `--editor must be one of ${Object.keys(EDITORS).join(', ')} (got ${JSON.stringify(editor)})`)
  if (!AVAILABLE_EDITORS.includes(editor)) throw new ExportError('not_supported', `${EDITORS[editor].label} is not available in this version of Montaj`)
  const absProject = resolve(projectPath)
  const projectDir = dirname(absProject)

  let project
  try {
    project = JSON.parse(readFileSync(absProject, 'utf8'))
  } catch (e) {
    throw new ExportError(e?.code === 'ENOENT' ? 'project_not_found' : 'invalid_project', `Could not read ${absProject}: ${e.message}`)
  }

  const packageName = cleanFileName(String(name ?? '').trim() || project.name || project.id || basename(projectDir))
  const base = resolve(out || join(projectDir, 'export'))
  const inside = relative(base, projectDir)
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    throw new ExportError('invalid_args', `--out ${base} is the project folder or holds it; pick a folder of its own`)
  }
  if (existsSync(base) && !statSync(base).isDirectory()) {
    throw new ExportError('out_exists', `--out ${base} is a file; pick a folder`)
  }
  const label = EDITORS[editor].label

  mkdirSync(base, { recursive: true })
  const tmpDir = mkdtempSync(join(base, `.${packageName}.tmp-`))
  // mkdtemp makes it owner-only; the package should have the folder's usual mode.
  chmodSync(tmpDir, 0o777 & ~process.umask())
  // Killed mid-run, the hidden folder (and any movie's scratch) must not stay behind. Cleanup never throws, so it
  // cannot hide the error that brought it on.
  const cleanup = () => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    try { removeNleScratch() } catch {}
  }
  process.on('exit', cleanup)
  try {
    // The package's own folder: `<name> (<label>)`, then `... 2`, `... 3`; one that exists is never touched.
    const pickDir = () => {
      for (let n = 1; ; n++) {
        const dir = join(base, `${packageName} (${label})${n === 1 ? '' : ` ${n}`}`)
        if (!existsSync(dir)) return dir
      }
    }
    let finalDir = pickDir()
    // The movies and the media are in the temp folder until the rename; the XML must name their FINAL paths, so map
    // every path across. If another export takes the folder name meanwhile, the rename below re-picks and this is
    // redone; the paths are only strings until then.
    const toFinal = (p) => join(finalDir, relative(tmpDir, p))

    const timeline = buildNleTimeline(renderResolved(project, projectDir), { projectDir })
    const sourcePaths = Object.keys(timeline.sources)
    const sourceProbes = await probeSources(sourcePaths)

    // Footage and audio, copied beside the timeline so the package opens anywhere (App Store Resolve cannot read
    // ~/Montaj, only the folders it was handed).
    const mediaCopies = copyMedia(sourcePaths, tmpDir, onProgress)

    const rendered = await renderNleGraphics(project, timeline, { projectDir, outDir: tmpDir, onProgress })

    const movies = [...Object.values(rendered.graphics), ...(rendered.captions ? [rendered.captions] : [])]
    const movieProbes = await probeSources(movies)

    const srt = captionsToSrt(project)
    if (srt !== null) writeFileSync(join(tmpDir, 'captions.srt'), srt, 'utf8')

    const isJsx = EDITORS[editor].writer === 'jsx'
    const isFcp = EDITORS[editor].writer === 'fcpxml'
    const xmlName = `${packageName}.${isJsx ? 'jsx' : isFcp ? 'fcpxml' : 'xml'}`
    const build = () => {
      const probes = { ...sourceProbes }
      for (const m of movies) probes[toFinal(m)] = movieProbes[m]
      const graphics = Object.fromEntries(Object.entries(rendered.graphics).map(([id, p]) => [id, toFinal(p)]))
      const captions = rendered.captions ? toFinal(rendered.captions) : null
      const mediaPaths = Object.fromEntries(Object.entries(mediaCopies.paths).map(([orig, copy]) => [orig, toFinal(copy)]))
      if (isJsx) {
        const r = writeAeScript(timeline, probes, {
          name: packageName, pkgDir: finalDir, mediaPaths, graphics, captions,
          captionSegments: project?.captions?.segments ?? [],
        })
        return { xml: r.jsx, aep: r.aep, warnings: r.warnings, leftOut: r.leftOut }
      }
      if (isFcp) return writeFcpxml(timeline, probes, { name: packageName, graphics, captions, mediaPaths })
      return writeXmeml(timeline, probes, { name: packageName, graphics, captions, xmlDir: finalDir, mediaPaths })
    }
    let built = build()
    writeFileSync(join(tmpDir, xmlName), built.xml, 'utf8')
    writeFileSync(join(tmpDir, PACKAGE_MARKER), `Montaj Export for editor (${label}).\n`, 'utf8')

    finalDir = renameIntoPlace(tmpDir, finalDir, {
      repick: () => {
        finalDir = pickDir()
        built = build()
        writeFileSync(join(tmpDir, xmlName), built.xml, 'utf8')
        return finalDir
      },
    })

    // The hash of the file to open, read back from its final place.
    const openPath = join(finalDir, xmlName)
    const openSha256 = createHash('sha256').update(readFileSync(openPath)).digest('hex')

    return {
      dir: finalDir,
      open: openPath,
      openSha256,
      xml: openPath,
      ...(isJsx ? { aep: built.aep } : {}),
      files: listFiles(finalDir),
      leftOut: built.leftOut,
      warnings: [...new Set([...timeline.warnings, ...rendered.warnings, ...built.warnings, ...mediaCopies.warnings])],
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
 * Rename `from` to `to`; when another export took `to` meanwhile, `repick()` names the next free folder (and rewrites
 * what names it). On Windows a folder that is busy for a moment is retried after 100 ms. At most `tries` attempts;
 * the last error is thrown after that. Returns where the folder went.
 */
export function renameIntoPlace(from, to, { repick, tries = RENAME_TRIES, platform = process.platform, rename = renameSync, wait = sleepSync, exists = existsSync }) {
  let dest = to
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, dest)
      return dest
    } catch (e) {
      if (attempt >= tries) throw e
      const code = e?.code
      if (code === 'ENOTEMPTY' || code === 'EEXIST') dest = repick()
      else if (platform === 'win32' && WIN_BUSY.has(code)) {
        // Windows says EPERM for a folder that is already there, too.
        if (exists(dest)) dest = repick()
        else wait(100)
      } else throw e
    }
  }
}

/**
 * Copy every media file the timeline names into `<tmpDir>/media/`, each under its own name (a second file of the same
 * name gets ` 2`, ...). A clone where the volume has them (APFS), a plain copy elsewhere. A file that is not there is
 * left linked where it was, with a warning. Returns `{ paths: {original: copy}, warnings }`.
 */
export function copyMedia(sourcePaths, tmpDir, onProgress) {
  const paths = {}
  const warnings = []
  const used = new Set()
  const dir = join(tmpDir, 'media')
  let done = 0
  for (const src of sourcePaths) {
    let ok = false
    try { ok = statSync(src).isFile() } catch { ok = false }
    if (!ok) {
      warnings.push(`${basename(src)} is not on this computer, so the timeline links where it was`)
      continue
    }
    mkdirSync(dir, { recursive: true })
    const clean = cleanFileName(basename(src))
    const dot = clean.lastIndexOf('.')
    const stem = dot > 0 ? clean.slice(0, dot) : clean
    const ext = dot > 0 ? clean.slice(dot) : ''
    let name = clean
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem} ${n}${ext}`
    used.add(name.toLowerCase())
    copyFileSync(src, join(dir, name), fsConstants.COPYFILE_FICLONE)
    paths[src] = join(dir, name)
    done += 1
    if (onProgress) onProgress({ done, total: sourcePaths.length, label: `Copying ${name}` })
  }
  return { paths, warnings }
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
    if (flag === '--project' || flag === '--name' || flag === '--out' || flag === '--editor') {
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
  // So does the parent going away while stderr is quiet (the step killed during a long movie): an orphan is
  // re-parented (its ppid changes), and on Windows, which does not re-parent, the parent is simply gone.
  const parent = process.ppid
  const parentGone = () => {
    if (process.ppid !== parent) return true
    try { process.kill(parent, 0); return false } catch (e) { return e?.code === 'ESRCH' }
  }
  setInterval(() => { if (parentGone()) process.exit(1) }, 2000).unref()
  // A signal's default is to die without running exit hooks; exit instead.
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(128 + (sig === 'SIGINT' ? 2 : 15)))
  try {
    const argv = process.argv.slice(2)
    if (!argv.length || argv.includes('--help')) {
      process.stderr.write('Usage: export-editor.js --project <project.json> [--editor premiere|resolve|fcp|ae] [--name <name>] [--out <folder>]\n')
      process.exit(1)
    }
    const args = parseArgs(argv)
    const result = await exportForEditor({
      projectPath: args.project,
      name: args.name,
      out: args.out,
      editor: args.editor,
      onProgress: (p) => process.stderr.write(`${JSON.stringify({ progress: p })}\n`),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0))
  } catch (e) {
    fail(e)
  }
}
