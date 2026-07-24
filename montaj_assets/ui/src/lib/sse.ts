import { useEffect } from 'react'
import type { Project } from './types/schema'

/**
 * Shared per-project SSE stream — ONE EventSource per projectId per tab, however
 * many consumers subscribe.
 *
 * Why: the host page (`useProjectStream`, for the status pill + agent log line)
 * and the package editor (its own frame subscription, via the montaj adapter's
 * `subscribe`) each used to open their OWN unpooled EventSource to the same
 * `/api/projects/:id/stream` URL — two to three connections per project page.
 * Chrome caps HTTP/1.1 connections at 6 per origin, and this editor already
 * shipped a connection-pool-exhaustion freeze (CHANGELOG v3.6.2, fixed for
 * file-watch in file-watch.ts). All project-stream consumers now multiplex over
 * one connection per project, mirroring that file-watch pool.
 *
 * Transport: GET /api/projects/:id/stream. The default (unnamed) event carries a
 * full project.json frame; the named 'log' event carries an agent status message.
 * Reconnects are handled by EventSource automatically.
 */

type FrameCallback = (project: Project) => void
type LogCallback = (message: string) => void

interface StreamEntry {
  es: EventSource
  frameListeners: Set<FrameCallback>
  logListeners: Set<LogCallback>
}

const streams = new Map<string, StreamEntry>()

function ensureStream(projectId: string): StreamEntry {
  const existing = streams.get(projectId)
  if (existing) return existing

  const entry: StreamEntry = {
    es: new EventSource(`/api/projects/${projectId}/stream`),
    frameListeners: new Set(),
    logListeners: new Set(),
  }

  // Default (unnamed) events → project.json updates.
  entry.es.onmessage = (e) => {
    let p: Project
    try {
      p = JSON.parse(e.data) as Project
    } catch {
      console.warn('[sse] malformed project frame:', e.data)
      return
    }
    // Copy before iterating: a callback may unsubscribe itself.
    for (const cb of [...entry.frameListeners]) cb(p)
  }

  // Named 'log' events → agent status messages.
  entry.es.addEventListener('log', (e) => {
    let message: string
    try {
      message = (JSON.parse((e as MessageEvent).data) as { message: string }).message
    } catch {
      console.warn('[sse] malformed log frame:', (e as MessageEvent).data)
      return
    }
    for (const cb of [...entry.logListeners]) cb(message)
  })

  entry.es.onerror = () => {
    // Connection dropped — EventSource retries automatically; nothing to do.
  }

  streams.set(projectId, entry)
  return entry
}

function teardownIfIdle(projectId: string): void {
  const entry = streams.get(projectId)
  if (!entry) return
  if (entry.frameListeners.size === 0 && entry.logListeners.size === 0) {
    entry.es.close()
    streams.delete(projectId)
  }
}

/**
 * Subscribe to a project's SSE stream through the shared per-project pool.
 * Register a frame handler, a log handler, or both. Returns an unsubscribe.
 * Safe to call many times for the same id — all share one connection.
 */
export function subscribeProjectStream(
  projectId: string,
  handlers: { onFrame?: FrameCallback; onLog?: LogCallback },
): () => void {
  const entry = ensureStream(projectId)
  const { onFrame, onLog } = handlers
  if (onFrame) entry.frameListeners.add(onFrame)
  if (onLog) entry.logListeners.add(onLog)
  let active = true
  return () => {
    if (!active) return
    active = false
    const e = streams.get(projectId)
    if (!e) return
    if (onFrame) e.frameListeners.delete(onFrame)
    if (onLog) e.logListeners.delete(onLog)
    teardownIfIdle(projectId)
  }
}

/** Test hook: drop all listeners and connections. */
export function _resetProjectStreamForTests(): void {
  for (const entry of streams.values()) entry.es.close()
  streams.clear()
}

/**
 * Subscribe to the SSE stream for a project.
 * - onUpdate: called with parsed project on project change events
 * - onLog: called with a status message string when the agent posts a log
 *
 * Multiplexes over the shared per-project connection (see above) rather than
 * opening a dedicated EventSource.
 *
 * IMPORTANT: callers must memoize callbacks with useCallback to avoid
 * creating new function references on every render — callbacks are intentionally
 * excluded from the effect deps to prevent reconnect loops.
 */
export function useProjectStream(
  projectId: string | undefined,
  onUpdate: (p: Project) => void,
  onLog?: (message: string) => void,
) {
  useEffect(() => {
    if (!projectId) return
    return subscribeProjectStream(projectId, { onFrame: onUpdate, onLog })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]) // callbacks intentionally omitted — see jsdoc above
}
