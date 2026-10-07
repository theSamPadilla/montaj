/**
 * Helpers for turning an ffmpeg failure into an error message that keeps the
 * reason. ffmpeg's stderr opens with a ~2,000-character version/configuration
 * banner and puts the real line last, and every downstream cap (reports, the
 * app's error box) keeps the head of a message, so wrapping the whole stderr
 * lost exactly the line that said what went wrong.
 */
import { existsSync } from 'fs'

const BANNER = /^(ffmpeg version|ffprobe version|\s*built with|\s*configuration:|\s*lib\w+\s+\d+\.\s*\d+\.\s*\d+)/

/**
 * The last `lines` non-empty lines of ffmpeg's stderr, banner lines dropped.
 * @param {string|Buffer|null|undefined} stderr
 * @param {number} [lines=10]
 * @returns {string}
 */
export function ffmpegErrorTail(stderr, lines = 10) {
  const kept = String(stderr ?? '')
    .split(/\r?\n/)
    .filter(l => l.trim() !== '' && !BANNER.test(l))
  return kept.slice(-lines).join('\n')
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
