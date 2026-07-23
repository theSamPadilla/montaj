/**
 * Shared workspace-file watcher — ONE EventSource per tab, however many
 * files are being watched.
 *
 * Why: the editor previously opened one EventSource per watched overlay JSX
 * (two per active overlay item), and Chrome caps HTTP/1.1 connections at 6
 * per origin. Overlay-dense timelines pinned the whole pool and froze every
 * request to the server (docs/plans/2026-07-22-editor-connection-pool.md).
 *
 * Transport: GET /api/files/stream (no ?path=) — the server's global jsx:*
 * channel. Each frame is {"path": "<abs path>"}; we dispatch to callbacks
 * registered for exactly that path string. Exact string match is the same
 * contract the old per-path channel required (`jsx:{path}` was keyed on the
 * client-supplied string), so semantics are unchanged.
 *
 * Reconnects: EventSource auto-reconnects; the browser replays nothing, but
 * file-watch events are edge-triggered "something changed, recompile"
 * signals, so missed events during a reconnect are benign (the next save
 * fires again).
 */

type Callback = () => void

let es: EventSource | null = null
const listeners = new Map<string, Set<Callback>>()

function ensureStream(): void {
  if (es) return
  es = new EventSource('/api/files/stream')
  es.onmessage = (e) => {
    let path: unknown
    try {
      path = (JSON.parse(e.data) as { path?: unknown }).path
    } catch {
      return
    }
    if (typeof path !== 'string') return
    const cbs = listeners.get(path)
    if (!cbs) return
    // Copy before iterating: a callback may unsubscribe itself.
    for (const cb of [...cbs]) cb()
  }
  es.onerror = () => {
    // EventSource retries automatically; nothing to do.
  }
}

function teardownIfIdle(): void {
  if (listeners.size === 0 && es) {
    es.close()
    es = null
  }
}

/**
 * Watch an absolute workspace path for changes. Returns an unsubscribe.
 * Safe to call many times for the same path — all share one connection.
 */
export function watchWorkspaceFile(path: string, onChange: Callback): () => void {
  ensureStream()
  let set = listeners.get(path)
  if (!set) {
    set = new Set()
    listeners.set(path, set)
  }
  set.add(onChange)
  let active = true
  return () => {
    if (!active) return
    active = false
    const cbs = listeners.get(path)
    if (!cbs) return
    cbs.delete(onChange)
    if (cbs.size === 0) listeners.delete(path)
    teardownIfIdle()
  }
}

/** Test hook: drop all listeners and the connection. */
export function _resetFileWatchForTests(): void {
  es?.close()
  es = null
  listeners.clear()
}
