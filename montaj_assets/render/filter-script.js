// render/filter-script.js
/**
 * Move a filter graph off ffmpeg's command line and into a file (WIN1b).
 *
 * Windows caps a whole command line at 32,767 characters (CreateProcess), and
 * one eased zoom on one photo writes a graph of ~90k. ffmpeg 7+ reads any
 * option's value from a file when the option is spelled `-/opt <path>`, so the
 * graph travels as a path instead. This runs on EVERY spawn on every OS, never
 * above a threshold: a threshold would leave the Mac, where every test and
 * daily export runs, exercising only the inline path Windows never takes.
 *
 * Callers keep building `'-filter_complex', graph` (so `_dryRun` output and the
 * encode-args goldens still mean "the graph is unchanged") and call this just
 * before the spawn.
 *
 * The file is UTF-8, no BOM, no trailing newline: the exact bytes the argv
 * element would have carried. Its name is unique per call (`wx` refuses to
 * reuse a path), so concurrent segments and concurrent test runs never share
 * one. writeFileSync closes the fd before this returns, so before the spawn.
 */
import { writeFileSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'

const NOOP = () => {}

/**
 * @param {string[]} args  ffmpeg args, possibly holding one `'-filter_complex', graph` pair
 * @param {string} dir     where the script file goes; must exist
 * @returns {{ args: string[], path: string | null, cleanup: () => void }}
 *   `args` with only that pair replaced by `'-/filter_complex', path`, every
 *   other element in place. With no `-filter_complex`, `args` comes back as
 *   given, `path` is null and nothing is written. `cleanup` removes the file,
 *   is idempotent and never throws; a file it cannot remove is left behind, like a cancelled one.
 */
export function externalizeFilterGraph(args, dir) {
  const at = []
  for (let i = 0; i < args.length; i++) if (args[i] === '-filter_complex') at.push(i)
  if (at.length === 0) return { args, path: null, cleanup: NOOP }
  if (at.length > 1) throw new Error(`externalizeFilterGraph: ${at.length} -filter_complex options; ffmpeg takes one`)
  const i = at[0]
  const graph = args[i + 1]
  if (typeof graph !== 'string') throw new Error('externalizeFilterGraph: -filter_complex has no graph after it')

  const path = join(dir, `montaj-fc-${process.pid}-${randomBytes(6).toString('hex')}.txt`)
  writeFileSync(path, graph, { encoding: 'utf8', flag: 'wx' })
  return {
    args: [...args.slice(0, i), '-/filter_complex', path, ...args.slice(i + 2)],
    path,
    cleanup: () => { try { rmSync(path, { force: true }) } catch {} },
  }
}
