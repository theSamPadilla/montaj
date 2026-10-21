// render/nle/file-name.js
/**
 * The file name an editor export gives a clip's movie. One function, shared by
 * the graphics renderer (which writes `graphics/<name>.mov`) and the XML writer
 * (which links that path when it was not handed the rendered file), so the two
 * can never name the same movie differently.
 */

/**
 * A safe file name stem for a clip id (and the editor export's package name):
 * the id itself when it already is one, with any path separator, reserved or
 * control character (C0, DEL, C1) replaced, `.` or `..` made `_`, and trailing
 * dots and spaces dropped (Windows drops them on disk), so the name can never
 * step out of the folder it is joined to or become another name there.
 *
 * @param {unknown} id
 * @returns {string}
 */
export function cleanFileName(id) {
  return String(id).replace(/[\/\\:*?"<>|\x00-\x1f\x7f-\x9f]/g, '_').replace(/^\.+$/, '_').replace(/[.\s]+$/, '') || 'graphic'
}

/**
 * Project, script and preset files of the editors: imported, After Effects would open one as a project (expressions
 * and all) or run it, so the After Effects export leaves such a source out of its composition and its package.
 */
export const NOT_MEDIA_EXTENSIONS = new Set(['.aep', '.aepx', '.aet', '.prproj', '.jsx', '.jsxbin', '.jsxinc', '.ffx', '.mogrt'])

/** A path's extension as an editor reads it: lower case, trailing dots and spaces ignored, a dotfile's whole name. */
export function extOf(path) {
  const b = String(path).split(/[\\/]/).pop().replace(/[.\s]+$/, '').toLowerCase()
  const i = b.lastIndexOf('.')
  return i >= 0 ? b.slice(i) : ''
}

/** Whether a source is a project, script or preset file, not media (NOT_MEDIA_EXTENSIONS). */
export const isNotMedia = (path) => NOT_MEDIA_EXTENSIONS.has(extOf(path))

/** The one warning for a source left out by isNotMedia (the same text wherever it is left out, so it shows once). */
export const notMediaWarning = (path) => `${String(path).split(/[\\/]/).pop()} is a project, script or preset file, not media, so it is not in the composition`
