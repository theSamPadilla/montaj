/**
 * Helpers for turning an ffmpeg failure into an error message that keeps the
 * reason. ffmpeg's stderr opens with a ~2,000-character version/configuration
 * banner and puts the real line last, and every downstream cap (reports, the
 * app's error box) keeps the head of a message, so wrapping the whole stderr
 * lost exactly the line that said what went wrong.
 */
import { existsSync, statfsSync } from 'fs'
import { isDiskFull } from './disk-space.js'

const BANNER = /^(ffmpeg version|ffprobe version|\s*built with|\s*configuration:|\s*lib\w+\s+\d+\.\s*\d+\.\s*\d+)/

const PROGRESS = /^\s*(frame|size)=/
const LINE_CAP = 600

/** One kept line, capped: a giant line keeps its head and tail (300 each). */
function capLine(l) {
  return l.length <= LINE_CAP ? l : `${l.slice(0, 300)} ... ${l.slice(-300)}`
}

/**
 * The last `lines` non-empty, non-progress lines of ffmpeg's stderr, banner
 * lines dropped, then the LAST progress line (`frame=... time=...`) if any.
 * ffmpeg rewrites its progress line with `\r`, so splitting on `\n` alone made
 * the whole run one giant line and lost the error before it; every kept line is
 * capped at 600 characters.
 * @param {string|Buffer|null|undefined} stderr
 * @param {number} [lines=10]
 * @returns {string}
 */
export function ffmpegErrorTail(stderr, lines = 10) {
  const all = String(stderr ?? '')
    .split(/\r\n|\r|\n/)
    .filter(l => l.trim() !== '' && !BANNER.test(l))
  const kept = all.filter(l => !PROGRESS.test(l)).slice(-lines)
  const progress = all.filter(l => PROGRESS.test(l)).slice(-1)
  return [...kept, ...progress].map(capLine).join('\n')
}

/**
 * A one-line account of how ffmpeg ended, then its tail, for error messages:
 * `exit 1`, `killed by SIGKILL`, `timed out after 600 s`, `no output for 300 s
 * (stalled)`. A disk-full failure (ENOSPC in stderr or `error`) leads with
 * `out of disk: <N> GB free on <dir>`, free space read from `statfs(outputDir)`.
 * Pure: `statfs` is injected.
 * @param {{status?: number|null, signal?: string|null, timedOut?: boolean,
 *   timeoutMs?: number, stalledMs?: number, stderr?: string|Buffer|null,
 *   error?: Error|null, outputDir?: string,
 *   statfs?: (dir: string) => {bavail: number|bigint, bsize: number|bigint}}} o
 * @returns {string}
 */
export function describeFfmpegExit({ status, signal, timedOut, timeoutMs, stalledMs, hardCapMs, stderr, error, outputDir, statfs = statfsSync } = {}) {
  let how
  if (stalledMs) how = `no output for ${Math.round(stalledMs / 1000)} s (stalled)`
  else if (timedOut && hardCapMs) how = `timed out after ${Math.round(hardCapMs / 1000)} s`
  else if (timedOut) how = timeoutMs ? `timed out after ${Math.round(timeoutMs / 1000)} s` : 'timed out'
  else if (signal) how = `killed by ${signal}`
  else how = `exit ${status}`
  const cause = error?.message ? `${error.message}\n` : ''
  const tail = ffmpegErrorTail(stderr)
  const body = `${cause}${tail}`
  const diskFull = isDiskFull(error) || isDiskFull({ message: String(stderr ?? '') })
  if (diskFull) {
    let head = 'out of disk'
    try {
      const st = statfs(outputDir)
      head = `out of disk: ${((Number(st.bavail) * Number(st.bsize)) / 1e9).toFixed(1)} GB free on ${outputDir}`
    } catch { /* unreadable: say so without a number */ }
    return `${head} (${how})\n${body}`
  }
  return `${how}\n${body}`
}

/**
 * Throw `missing_files` (the same code and message shape render.js's
 * validateProjectFiles fails with) when any path is gone. For code that reads a
 * project file long after that preflight ran: a file deleted in between would
 * otherwise surface as an ffmpeg error. `err.code` lets render.js's top-level
 * handler report it under its own code.
 * @param {Array<string|null|undefined>} paths
 * @param {(p: string) => boolean} [exists]
 */
export function assertInputsExist(paths, exists = existsSync) {
  const missing = [...new Set(paths.filter(p => typeof p === 'string' && p !== '' && !p.includes('\0')))].filter(p => !exists(p))
  if (missing.length === 0) return
  const err = new Error(`Referenced files not found:\n  ${missing.join('\n  ')}`)
  err.code = 'missing_files'
  throw err
}

/**
 * The file inputs of an ffmpeg argument list: every `-i <path>` that is not a
 * `-f lavfi` generator source.
 * @param {string[]} args
 * @returns {string[]}
 */
export function fileInputsOf(args) {
  const out = []
  for (let k = 0; k < args.length - 1; k++) {
    if (args[k] === '-i' && !(args[k - 2] === '-f' && args[k - 1] === 'lavfi')) out.push(String(args[k + 1]))
  }
  return out
}
