/**
 * montajAdapter — the Montaj-native implementation of editor-core's
 * `EditorAdapter`.
 *
 * All transport is Montaj's existing surface:
 *   - loadProject     → `api.getProject` (GET /api/projects/:id)
 *   - saveProject     → `api.saveProject` (PUT /api/projects/:id)
 *   - subscribe       → the EventSource at `/api/projects/:id/stream`
 *                       (same stream `useProjectStream` opens)
 *   - render          → `api.renderProject` (POST /api/projects/:id/render SSE),
 *                       adapted from its callback shape into an
 *                       `AsyncIterable<RenderEvent>`.
 *   - resolveImageSrc → Montaj's workspace/files URL rule, replicated from
 *                       SlideCanvas's `resolveAsset`: absolute/data URLs pass
 *                       through; workspace paths route via `/api/files?path=`.
 *
 * `listMedia` is intentionally omitted — Montaj has no media-library endpoint
 * the editor consumes; image sources are workspace paths added via upload /
 * AI-generation, not a queryable library. The editor feature-detects its
 * absence.
 */
import { api } from '@/lib/api'
import { compileOverlay as hostCompileOverlay } from '@/lib/overlay-eval'
import type {
  EditorAdapter,
  OverlayFactory,
  ImageElement,
  RenderEvent,
  RenderOptions,
} from '@bycrux/editor'
// Montaj instantiates the editor's generic adapter with its full project type,
// so loaded/saved/streamed frames keep Montaj's pipeline fields end-to-end.
import type { Project } from '@/lib/types/schema'

/** Replicates SlideCanvas's `resolveAsset` so the editor displays the same URL. */
export function resolveMontajImageSrc(element: ImageElement): string {
  const src = element.src
  if (!src) return src
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
    return src
  }
  return `/api/files?path=${encodeURIComponent(src)}`
}

export function createMontajAdapter(): EditorAdapter<Project> {
  return {
    loadProject: (id: string): Promise<Project> => api.getProject(id),

    saveProject: async (id: string, project: Project): Promise<void> => {
      await api.saveProject(id, project)
    },

    subscribe: (id: string, onFrame: (project: Project) => void): (() => void) => {
      // Mirrors `useProjectStream`'s default-event parsing — the unnamed SSE
      // event carries the full project.json frame. 'log' events are ignored
      // here; CarouselEditor surfaces those via its own useProjectStream.
      const es = new EventSource(`/api/projects/${id}/stream`)
      es.onmessage = (e) => {
        try {
          onFrame(JSON.parse(e.data) as Project)
        } catch {
          console.warn('[montajAdapter] malformed project frame:', e.data)
        }
      }
      es.onerror = () => {
        // EventSource retries automatically; nothing to do.
      }
      return () => es.close()
    },

    render: (id: string, _opts?: RenderOptions): AsyncIterable<RenderEvent> => {
      // Bridge api.renderProject's callback SSE into an async iterable. Events
      // are buffered and handed off through a promise-resolver queue so the
      // consumer's `for await` paces naturally.
      return {
        [Symbol.asyncIterator](): AsyncIterator<RenderEvent> {
          const queue: RenderEvent[] = []
          let resolveNext: ((r: IteratorResult<RenderEvent>) => void) | null = null
          let done = false
          let cancel: (() => void) | null = null

          const push = (ev: RenderEvent) => {
            // Terminal events end the stream after delivery.
            if (resolveNext) {
              const r = resolveNext
              resolveNext = null
              r({ value: ev, done: false })
            } else {
              queue.push(ev)
            }
            if (ev.type === 'done' || ev.type === 'error') finish()
          }

          const finish = () => {
            done = true
            if (resolveNext) {
              const r = resolveNext
              resolveNext = null
              r({ value: undefined, done: true })
            }
          }

          api
            .renderProject(
              id,
              (line) => push({ type: 'log', message: line }),
              (outputPath) => push({ type: 'done', outputPath }),
              (message) => push({ type: 'error', message }),
            )
            .then((c) => { cancel = c })
            .catch((err) => {
              push({ type: 'error', message: err instanceof Error ? err.message : String(err) })
            })

          return {
            next(): Promise<IteratorResult<RenderEvent>> {
              if (queue.length > 0) {
                return Promise.resolve({ value: queue.shift()!, done: false })
              }
              if (done) return Promise.resolve({ value: undefined, done: true })
              return new Promise((resolve) => { resolveNext = resolve })
            },
            return(): Promise<IteratorResult<RenderEvent>> {
              done = true
              cancel?.()
              return Promise.resolve({ value: undefined, done: true })
            },
          }
        },
      }
    },

    resolveImageSrc: resolveMontajImageSrc,

    compileOverlay: (template: string): Promise<OverlayFactory> =>
      hostCompileOverlay(template),
  }
}
