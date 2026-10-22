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
 * full project.json frame; the named 'log' event carries an agent status message;
 * the named 'writer' event (`<writer>[;origin=<origin>]`, serve sends it only for
 * a Studio sync pull) stamps the project frame that immediately follows it.
 * Reconnects are handled by EventSource automatically. Serve sends its current
 * state as the first frame on every connection, so the first frame after a
 * reconnect is marked `{ gap: true }`: a stamp sent while the stream was down
 * reached no listener, and that frame may hold the write it stamped.
 */

/** Who wrote a project frame (the editor's `FrameWriter`, same shape). */
export interface FrameWriter {
  writer: string
  origin?: string
}

/** What the pool knows about a project frame besides its writer (the editor's
 *  `FrameInfo`, same shape). `gap`: the first frame delivered on a connection
 *  that replaced a dropped one, so frames may have been missed just before it. */
export interface FrameInfo {
  gap?: boolean
}

type FrameCallback = (project: Project, writer?: FrameWriter, info?: FrameInfo) => void
type LogCallback = (message: string) => void

interface StreamEntry {
  es: EventSource
  frameListeners: Set<FrameCallback>
  logListeners: Set<LogCallback>
  /** The stamp waiting for the next project frame; spent by that frame. */
  pendingWriter: FrameWriter | undefined
  /** The connection errored and has not reopened yet. */
  dropped: boolean
  /** The next delivered frame is the first since a reopen; spent by that frame. */
  gap: boolean
}

/** A `writer` event's data, `<writer>[;<key>=<value>]...`: the writer and its
 *  `origin` (unknown keys ignored, an empty origin absent). Empty data is no stamp. */
export function parseWriterStamp(data: string): FrameWriter | undefined {
  const [head = '', ...params] = data.split(';')
  const writer = head.trim()
  if (!writer) return undefined
  const stamp: FrameWriter = { writer }
  for (const param of params) {
    const eq = param.indexOf('=')
    if (eq < 0) continue
    const value = param.slice(eq + 1).trim()
    if (param.slice(0, eq).trim() === 'origin' && value) stamp.origin = value
  }
  return stamp
}

const streams = new Map<string, StreamEntry>()

function ensureStream(projectId: string): StreamEntry {
  const existing = streams.get(projectId)
  if (existing) return existing

  const entry: StreamEntry = {
    es: new EventSource(`/api/projects/${projectId}/stream`),
    frameListeners: new Set(),
    logListeners: new Set(),
    pendingWriter: undefined,
    dropped: false,
    gap: false,
  }

  // Default (unnamed) events → project.json updates. The stamp that came just
  // before is this frame's alone: taken here even when the frame is malformed,
  // so it can never reach a later frame. The gap mark is spent only by a frame
  // that is delivered: after a malformed one, frames were still missed before
  // the next good one.
  entry.es.onmessage = (e) => {
    const writer = entry.pendingWriter
    entry.pendingWriter = undefined
    let p: Project
    try {
      p = JSON.parse(e.data) as Project
    } catch {
      console.warn('[sse] malformed project frame:', e.data)
      return
    }
    const info: FrameInfo | undefined = entry.gap ? { gap: true } : undefined
    entry.gap = false
    // Copy before iterating: a callback may unsubscribe itself.
    for (const cb of [...entry.frameListeners]) cb(p, writer, info)
  }

  // Named 'writer' events → the stamp for the next project frame. No listener
  // hears the event itself.
  entry.es.addEventListener('writer', (e) => {
    entry.pendingWriter = parseWriterStamp((e as MessageEvent).data ?? '')
  })

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

  // Connection dropped or (re)opened: EventSource retries automatically. A
  // stamp whose frame never came is dropped, so it never reaches a frame sent
  // on the new connection. An open that follows an error is a reconnect: its
  // first frame is marked as a gap. The first open of a stream is not.
  entry.es.onerror = () => {
    entry.pendingWriter = undefined
    entry.dropped = true
  }
  entry.es.onopen = () => {
    entry.pendingWriter = undefined
    if (entry.dropped) entry.gap = true
    entry.dropped = false
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
