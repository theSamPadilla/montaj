import { useEffect } from 'react'
import type { Project } from './project'

/**
 * Subscribe to the SSE stream for a project.
 * - onUpdate: called with parsed project on project change events
 * - onLog: called with a status message string when the agent posts a log
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
    const es = new EventSource(`/api/projects/${projectId}/stream`)

    // Default (unnamed) events → project.json updates
    es.onmessage = (e) => {
      try {
        const p = JSON.parse(e.data) as Project
        console.log('[sse] project update received, visual item count:', (p.tracks ?? []).flat().length)
        onUpdate(p)
      } catch {
        console.warn('[sse] malformed project frame:', e.data)
      }
    }

    // Named 'log' events → agent status messages
    es.addEventListener('log', (e) => {
      try {
        const { message } = JSON.parse((e as MessageEvent).data) as { message: string }
        onLog?.(message)
      } catch {
        console.warn('[sse] malformed log frame:', (e as MessageEvent).data)
      }
    })

    es.onerror = () => {
      // Connection dropped — EventSource retries automatically
    }

    return () => es.close()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]) // callbacks intentionally omitted — see jsdoc above
}
