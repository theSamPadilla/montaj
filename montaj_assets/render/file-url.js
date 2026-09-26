/**
 * file-url.js — filesystem path <-> file:// URL, portable to Windows.
 *
 * The render path used to build these inline: `'file://' + encodeURI(p)`,
 * `` `file://${htmlPath}` ``, `startsWith('/')` as the absolute-path test, and
 * `url.replace(/^file:\/\//, '')` to go back. Every one of those is posix-only:
 * a Windows path gives `file://C:\…`, `C:\…` is not "absolute", and stripping
 * the scheme from `file:///C:/…` leaves `/C:/…`.
 *
 * The posix branch is deliberately today's exact string build (encodeURI, not
 * pathToFileURL — they disagree on [ ] ^ |), so macOS output is byte-identical
 * for every path without '#' or '?'. Those two are now escaped: encodeURI left
 * them alone, which cut the URL at a fragment/query and named a missing file.
 *
 * Every function takes `{ windows }` (default: this process's platform) so the
 * win32 behaviour is testable on any host without touching process.platform.
 */

const IS_WIN = process.platform === 'win32'
const DRIVE_ABS = /^[A-Za-z]:[\\/]/
const DRIVE = /^[A-Za-z]:/

function encodePath(p) {
  return encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

/** Absolute filesystem path? posix: starts with '/'. win32: a drive-letter
 *  path (`C:\` or `C:/`), or a '/'-rooted one as before. UNC (`\\host`) is not. */
export function isAbsPath(p, { windows = IS_WIN } = {}) {
  if (typeof p !== 'string') return false
  if (windows && DRIVE_ABS.test(p)) return true
  return p.startsWith('/')
}

/** Absolute path -> file:// href. */
export function toFileHref(p, { windows = IS_WIN } = {}) {
  if (windows && DRIVE.test(p)) return 'file:///' + encodePath(p.replace(/\\/g, '/'))
  return 'file://' + encodePath(p)
}

/** file:// href -> filesystem path. Throws (URIError) on malformed escapes,
 *  exactly as the inline decodeURIComponent it replaces did. */
export function fromFileHref(url, { windows = IS_WIN } = {}) {
  const p = decodeURIComponent(url.replace(/^file:\/\//, ''))
  if (windows && /^\/[A-Za-z]:/.test(p)) return p.slice(1).replace(/\//g, '\\')
  return p
}

/**
 * The vendored fonts stylesheet href for an absolute fonts base directory, or
 * '' for "no base". Both renderers' `vendoredFontsHref` copies delegate here.
 * Refuses UNC in both spellings (`//host`, `\\host`): see vendoredFontsHref's
 * comment in bundle.js for why a `//host` base must never become a URL.
 */
export function fontsCssHref(fontsBaseDir, { windows = IS_WIN } = {}) {
  if (typeof fontsBaseDir !== 'string' || !isAbsPath(fontsBaseDir, { windows })
      || fontsBaseDir.startsWith('//') || fontsBaseDir.startsWith('\\\\')) return ''
  const trimmed = fontsBaseDir.replace(windows ? /[\\/]+$/ : /\/+$/, '')
  return toFileHref(trimmed, { windows }) + '/fonts.css'
}

/**
 * Source text of the `resolveAsset` function render-carousel.js injects into
 * its page shim. That function runs in Chromium, where there is no Node path
 * module, so the platform decision is made here, in Node, before injection.
 *
 * posix: today's text, byte-for-byte (it reads the shim's `projectDir` const).
 * win32: drive-letter assets become file:///C:/…, and relative assets hang off
 * the project dir's href, computed here with toFileHref.
 */
export function assetResolverSource(projectDir, { windows = IS_WIN } = {}) {
  if (!windows) {
    return `function resolveAsset(p) {
  if (!p) return p
  if (p.startsWith('http://') || p.startsWith('https://') || p.startsWith('data:')) return p
  if (p.startsWith('/')) return 'file://' + p
  return 'file://' + projectDir + '/' + p
}`
  }
  const projectHref = JSON.stringify(toFileHref(projectDir, { windows }).replace(/\/+$/, ''))
  return `function resolveAsset(p) {
  if (!p) return p
  if (p.startsWith('http://') || p.startsWith('https://') || p.startsWith('data:')) return p
  if (/^[A-Za-z]:[\\\\/]/.test(p)) return 'file:///' + p.replace(/\\\\/g, '/')
  if (p.startsWith('/')) return 'file://' + p
  return ${projectHref} + '/' + p.replace(/\\\\/g, '/')
}`
}
