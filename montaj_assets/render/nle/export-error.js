// render/nle/export-error.js
/**
 * The Export for editor's coded error: `code` is what export-editor.js prints as `{"error": code}` (lower case
 * and underscores, such as `invalid_project`), `message` says what is wrong. Shared by export-editor.js and the
 * writers that check what they are handed (aejsx.js).
 */
export class ExportError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
