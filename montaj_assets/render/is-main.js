/**
 * is-main.js — is the module at `importMetaUrl` this process's entry point?
 *
 * Node builds the main module's URL from the REAL path of argv[1]
 * (fs.realpathSync(resolve(argv[1]))), so the comparison has to resolve argv[1]
 * the same way. Comparing an unresolved argv[1] fails whenever a symlink or a
 * Windows junction sits in its chain (macOS /var -> /private/var), and the
 * script then exits 0 having done nothing. Same form as mcp/server.js's
 * isEntryPoint. fs.realpathSync, not .native: that is the one Node uses.
 */
import { realpathSync } from 'fs'
import { pathToFileURL } from 'url'

export function isMain(importMetaUrl, argv1, { realpath = realpathSync } = {}) {
  if (!argv1) return false
  try {
    return pathToFileURL(realpath(argv1)).href === importMetaUrl
  } catch {
    return false
  }
}
