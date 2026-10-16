// render/nle/file-name.js
/**
 * The file name an editor export gives a clip's movie. One function, shared by
 * the graphics renderer (which writes `graphics/<name>.mov`) and the XML writer
 * (which links that path when it was not handed the rendered file), so the two
 * can never name the same movie differently.
 */

/**
 * A safe file name stem for a clip id: the id itself when it already is one,
 * with any path or reserved character replaced.
 *
 * @param {unknown} id
 * @returns {string}
 */
export function cleanFileName(id) {
  return String(id).replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+$/, '_') || 'graphic'
}
