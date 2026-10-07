/**
 * Helpers for turning an ffmpeg failure into an error message that keeps the
 * reason. ffmpeg's stderr opens with a ~2,000-character version/configuration
 * banner and puts the real line last, and every downstream cap (reports, the
 * app's error box) keeps the head of a message, so wrapping the whole stderr
 * lost exactly the line that said what went wrong.
 */
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
