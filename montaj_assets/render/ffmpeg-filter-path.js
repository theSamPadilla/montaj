/**
 * ffmpeg-filter-path.js — filtergraph-safe path escaping (lut3d=file=,
 * drawtext=fontfile=), mirroring lib/common.py::ffmpeg_filter_path.
 *
 * ':' is ffmpeg's own key=value separator inside a filter's option list, and
 * '\' is its escape character, so a raw Windows path spliced into a filter
 * description (`lut3d=file=C:\Users\a\x.cube`) breaks twice: `file=C` ends at
 * the drive colon, and the backslashes are read as escapes rather than path
 * separators.
 *
 * Windows-ness is read from the string itself (a drive letter, or any literal
 * backslash), never from process.platform, so this is provable on any host.
 *
 * A plain path with none of `: ' , ; [ ]` or a space is returned UNCHANGED —
 * every existing caller's filter string stays byte-for-byte identical.
 */

const DRIVE = /^[A-Za-z]:/
const NEEDS_ESCAPE = /[:'[\],; ]/

/**
 * Escape a filesystem path for splicing into an ffmpeg filtergraph option
 * value.
 *
 * A path that looks like Windows (a drive letter, or any backslash) has its
 * backslashes turned into forward slashes first. Then, if the (possibly
 * slash-converted) value contains any of the characters above, the whole
 * value is quoted per ffmpeg's documented *two-level* filtergraph escaping:
 * ffmpeg parses a filter option value once as a filtergraph (splitting on
 * unquoted `'`) and again as the option's own value (interpreting `\`
 * escapes). A single-level `'\''` for an embedded `'` survives the first
 * parse but is then re-read as a quote by the second, so the value must be
 * escaped for the inner (option) level first, and only then quoted for the
 * outer (filtergraph) level: a literal `'` becomes `\'` and a literal `:`
 * becomes `\:` at the inner level, then any literal `'` still present (from
 * that inner escape) is itself requoted as `'\''` before the whole value is
 * wrapped in single quotes.
 *
 * @param {string} p
 * @returns {string}
 */
export function ffmpegFilterPath(p) {
  let s = p
  if (DRIVE.test(s) || s.includes('\\')) {
    s = s.replace(/\\/g, '/')
  }
  if (!NEEDS_ESCAPE.test(s)) return s
  const inner = s.replace(/'/g, "\\'").replace(/:/g, '\\:')
  return `'${inner.replace(/'/g, "'\\''")}'`
}
