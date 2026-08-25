/**
 * How this stdio MCP server finds — and talks to — a running `montaj serve`.
 *
 * These are separate processes with no shared environment: `montaj serve` sets
 * MONTAJ_SERVE_PORT in its OWN os.environ, which never reaches an MCP server
 * launched independently by Claude Desktop. The handshake is a lockfile that
 * serve writes at startup (serve/lockfile.py).
 *
 * Every failure resolves to `{ ok: false, reason }` rather than throwing. A
 * resource read must degrade into a readable sentence — "the editor isn't
 * open" — not a stack trace or, worse, a hang.
 *
 * No dependencies: Node >= 18 (this package's declared engine) ships fetch.
 */
import { readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

/** How long to wait on a local HTTP call before calling serve unreachable.
 *  Localhost either answers immediately or is not there. */
const FETCH_TIMEOUT_MS = 2000

export function defaultLockfilePath() {
  return join(homedir(), ".montaj", "serve.json")
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === "EPERM"   // exists, owned by someone else
  }
}

/** The live serve's info, or null. Mirrors serve/lockfile.py's `read`. */
export function readServeInfo(lockfilePath = defaultLockfilePath()) {
  let info
  try {
    info = JSON.parse(readFileSync(lockfilePath, "utf8"))
  } catch {
    return null
  }
  if (!info || typeof info.port !== "number" || typeof info.pid !== "number") return null
  if (!pidAlive(info.pid)) return null
  return info
}

/**
 * GET /api/context from the running serve.
 * @returns {Promise<{ok: true, body: object} | {ok: false, reason: string}>}
 */
export async function fetchContext({ lockfilePath = defaultLockfilePath() } = {}) {
  const info = readServeInfo(lockfilePath)
  if (!info) {
    return { ok: false, reason: "montaj serve is not running (no live lockfile at " + lockfilePath + ")" }
  }
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/context`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      return { ok: false, reason: `montaj serve returned HTTP ${res.status}` }
    }
    return { ok: true, body: await res.json() }
  } catch (e) {
    return { ok: false, reason: `could not reach montaj serve on port ${info.port}: ${e.message}` }
  }
}
