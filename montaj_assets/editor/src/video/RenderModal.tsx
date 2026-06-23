import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { EditorAdapter, Project, RenderPhase, RenderStatus } from '../types'

interface RenderModalProps<P extends Project = Project> {
  projectId: string
  /** Adapter driving the render stream + file-URL resolution. */
  adapter: EditorAdapter<P>
  /** Fired when the modal closes from a finished or errored state (post-render).
   *  Callers can use this to navigate away or refresh project state. */
  onClose: () => void
  /** Fired when the user cancels an in-progress render via the Cancel button.
   *  Distinct from onClose so callers can dismiss the modal without navigating
   *  away from the editor — the project is unchanged and the user is likely
   *  about to keep editing. Defaults to onClose if not provided (back-compat). */
  onCancel?: () => void
  /** Host-supplied export controls (e.g. a "Download all (.zip)" link) rendered
   *  in the done state's action area, mirroring the carousel render modal. */
  exportActions?: ReactNode
}

/** Promoted render output (R2-presigned), as carried by `RenderStatus.media`. */
type RenderMedia = NonNullable<RenderStatus['media']>[number]

function basename(p: string) { return p.split('/').pop() ?? p }

// ── Phase model (pure, exported for tests + the stepper) ──────────────────────

/**
 * Ordered render phases, earliest → terminal. `phaseIndex` reads off this list
 * so the stepper can mark phases before the current one as complete.
 */
export const RENDER_PHASES: RenderPhase[] = [
  'preparing',
  'rendering',
  'captions',
  'encoding',
  'saving',
  'done',
]

/** User-facing label for a render phase. Honest, plain-English, no jargon. */
export function phaseLabel(phase: RenderPhase): string {
  switch (phase) {
    case 'preparing': return 'Preparing'
    case 'rendering': return 'Rendering graphics'
    case 'captions':  return 'Adding captions'
    case 'encoding':  return 'Encoding video'
    case 'saving':    return 'Saving to your library'
    case 'done':      return 'Done'
  }
}

/** Ordinal of a phase within {@link RENDER_PHASES}. */
export function phaseIndex(phase: RenderPhase): number {
  return RENDER_PHASES.indexOf(phase)
}

/** The five phases shown in the running stepper (terminal `done` excluded). */
const STEPPER_PHASES: RenderPhase[] = RENDER_PHASES.filter(p => p !== 'done')

const POLL_INTERVAL_MS = 2500

// ── Stepper ───────────────────────────────────────────────────────────────────

function PhaseStepper({ current }: { current: RenderPhase }) {
  const currentIdx = phaseIndex(current)
  return (
    <div className="flex flex-col gap-3">
      {STEPPER_PHASES.map((phase) => {
        const idx = phaseIndex(phase)
        // `done` sits past every stepper phase, so a done status marks them all complete.
        const complete = idx < currentIdx
        const active = idx === currentIdx
        return (
          <div key={phase} className="flex items-center gap-3">
            <span
              className={
                complete
                  ? 'w-5 h-5 shrink-0 rounded-full bg-green-500/90 text-black flex items-center justify-center text-[11px] font-bold'
                  : active
                    ? 'w-5 h-5 shrink-0 rounded-full border-2 border-amber-400 border-t-transparent animate-spin'
                    : 'w-5 h-5 shrink-0 rounded-full border border-[var(--editor-border)]'
              }
            >
              {complete ? '✓' : ''}
            </span>
            <span
              className={
                complete
                  ? 'text-sm text-[var(--editor-text)]/70'
                  : active
                    ? 'text-sm font-semibold text-[var(--editor-text)]'
                    : 'text-sm text-[var(--editor-text)]/35'
              }
            >
              {phaseLabel(phase)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export default function RenderModal<P extends Project = Project>({ projectId, adapter, onClose, onCancel, exportActions }: RenderModalProps<P>) {
  const [status, setStatus]     = useState<'running' | 'done' | 'error'>('running')
  const [phase, setPhase]       = useState<RenderPhase>('preparing')
  const [media, setMedia]       = useState<RenderMedia[] | null>(null)
  const [outputPath, setOutput] = useState<string | null>(null)
  const [errorMsg, setError]    = useState<string | null>(null)
  const cancelledRef            = useRef(false)
  const unmountedRef            = useRef(false)
  const cleanupTimerRef         = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollTimerRef            = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    // React StrictMode in dev fires mount → cleanup → mount synchronously to
    // catch effects that aren't idempotent. Triggering a render is the textbook
    // non-idempotent effect (spawns a subprocess), so we have to handle it
    // explicitly: defer the teardown in cleanup, and if the next mount fires
    // within the same tick, rescue the pending teardown.
    //
    // Without this, every render in dev would consume two render streams against
    // the same workspace, racing on segment files and producing corrupted output
    // — the bug we tracked down.
    if (cleanupTimerRef.current !== null) {
      clearTimeout(cleanupTimerRef.current)
      cleanupTimerRef.current = null
      unmountedRef.current = false
      cancelledRef.current = false
      return scheduleCleanup
    }

    unmountedRef.current = false
    cancelledRef.current = false

    const usePolling = !!(adapter.renderAsync && adapter.getRenderStatus)

    void (async () => {
      try {
        if (usePolling) {
          // Async, poll-based render: kick once, then poll status until terminal.
          await adapter.renderAsync!(projectId)
          if (unmountedRef.current || cancelledRef.current) return

          const tick = async () => {
            if (unmountedRef.current || cancelledRef.current) return
            let snap: RenderStatus
            try {
              snap = await adapter.getRenderStatus!(projectId)
            } catch (e) {
              if (unmountedRef.current || cancelledRef.current) return
              stopPolling()
              setError(e instanceof Error ? e.message : String(e))
              setStatus('error')
              return
            }
            if (unmountedRef.current || cancelledRef.current) return

            if (snap.phase) setPhase(snap.phase)
            if (snap.media) setMedia(snap.media)

            if (snap.status === 'done') {
              stopPolling()
              setMedia(snap.media ?? null)
              setStatus('done')
            } else if (snap.status === 'error') {
              stopPolling()
              setError(snap.error ?? 'Render failed.')
              setStatus('error')
            } else if (snap.status === 'idle') {
              // We just kicked the render, so a job exists server-side; an 'idle'
              // reply means the sidecar lost it (e.g. restarted mid-render).
              // Without this we'd poll forever with the stepper frozen.
              stopPolling()
              setError('The render was interrupted on the server. Please try again.')
              setStatus('error')
            }
          }

          // First poll immediately, then on the interval.
          await tick()
          if (unmountedRef.current || cancelledRef.current) return
          pollTimerRef.current = setInterval(() => { void tick() }, POLL_INTERVAL_MS)
        } else {
          // Fallback for older hosts: consume the SSE render stream.
          for await (const ev of adapter.render(projectId)) {
            if (unmountedRef.current || cancelledRef.current) break
            if (ev.type === 'log') {
              // Streaming hosts have no phase signal — keep the stepper on
              // "rendering" as an honest mid-pipeline indicator.
              setPhase('rendering')
            } else if (ev.type === 'done') {
              setOutput(ev.outputPath)
              setStatus('done')
            } else {
              setError(ev.message)
              setStatus('error')
            }
          }
        }
      } catch (e) {
        if (!unmountedRef.current && !cancelledRef.current) {
          setError(e instanceof Error ? e.message : String(e))
          setStatus('error')
        }
      }
    })()

    return scheduleCleanup

    function stopPolling() {
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }

    function scheduleCleanup() {
      // Defer the actual teardown. StrictMode's transient unmount fires before
      // the next mount; setTimeout(0) puts the teardown after both, giving the
      // next mount a chance to clearTimeout it. On real unmount the timer fires
      // and the render stream / poll loop is abandoned for real.
      cleanupTimerRef.current = setTimeout(() => {
        cleanupTimerRef.current = null
        unmountedRef.current = true
        stopPolling()
      }, 0)
    }
  }, [projectId, adapter])

  // Escape to close only when done/error
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && status !== 'running') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [status, onClose])

  function handleCancel() {
    cancelledRef.current = true
    // Use onCancel when provided so the host can dismiss without navigating
    // (cancelling an in-progress render shouldn't yank the user away from
    // their editor). Falls back to onClose for back-compat with callers that
    // haven't been updated.
    ;(onCancel ?? onClose)()
  }

  if (status === 'done') {
    // Prefer the promoted R2 media (poll path); fall back to a workspace path
    // resolved via fileUrl (SSE path); else show a graceful no-player view.
    const primary = media?.[0] ?? null
    const videoUrl = primary?.url ?? (outputPath ? adapter.fileUrl(outputPath) : null)
    const downloadName = primary?.filename ?? (outputPath ? basename(outputPath) : 'render')

    // Portal to document.body: a transformed/filtered host ancestor (e.g. the
    // Los Parceros app-shell wrapper) would otherwise become the containing
    // block for this `fixed` overlay, sizing it to the scrolled page height and
    // centering the panel off-screen below the fold.
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black">
        <div className="w-[96vw] h-[96vh] bg-[var(--editor-surface)] border border-[var(--editor-border)] rounded-2xl shadow-2xl flex overflow-hidden">

          {/* Left — video */}
          <div className="flex-1 bg-black flex items-center justify-center overflow-hidden">
            {videoUrl ? (
              <video
                src={videoUrl}
                controls
                autoPlay
                playsInline
                className="h-full w-full object-contain"
              />
            ) : (
              <p className="text-sm text-[var(--editor-text)]/60">Render complete.</p>
            )}
          </div>

          {/* Right — info panel */}
          <div className="w-72 shrink-0 flex flex-col border-l border-[var(--editor-border)]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--editor-border)]">
              <div className="flex items-center gap-2.5">
                <span className="w-2 h-2 rounded-full bg-green-400" />
                <div>
                  <p className="text-sm font-semibold text-[var(--editor-text)]">Render complete</p>
                  <p className="text-xs text-[var(--editor-text)]/60">Saved to your library.</p>
                </div>
              </div>
              <button onClick={onClose} className="text-[var(--editor-text)]/55 hover:text-[var(--editor-text)] transition-colors text-lg leading-none">×</button>
            </div>

            <div className="flex flex-col gap-3 p-5 flex-1">
              {/* Host-supplied export controls (e.g. download-all .zip). */}
              {exportActions}
              {videoUrl && (
                <a
                  href={videoUrl}
                  download={downloadName}
                  className="w-full text-center text-sm px-4 py-2.5 rounded-lg bg-green-800/60 border border-green-700 text-green-200 hover:bg-green-700/60 transition-colors font-medium"
                >
                  Download
                </a>
              )}
              <button
                onClick={onClose}
                className="w-full text-center text-sm px-4 py-2.5 rounded-lg bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)]/80 hover:opacity-90 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>,
      document.body,
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black">
      <div className="w-full max-w-md bg-[var(--editor-surface)] border border-[var(--editor-border)] rounded-xl shadow-2xl flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--editor-border)]">
          <div className="flex items-center gap-2.5">
            {status === 'running' && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
            {status === 'error'   && <span className="w-2 h-2 rounded-full bg-red-400" />}
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold text-[var(--editor-text)]">
                {status === 'running' ? 'Rendering…' : 'Render failed'}
              </h2>
            </div>
          </div>
          {status !== 'running' && (
            <button onClick={onClose} className="text-[var(--editor-text)]/55 hover:text-[var(--editor-text)] transition-colors text-lg leading-none">×</button>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-5">
          {status === 'running' ? (
            <>
              <PhaseStepper current={phase} />
              <p className="mt-5 text-xs text-[var(--editor-text)]/50">
                This can take a few minutes for longer videos.
              </p>
            </>
          ) : (
            <p className="text-sm text-red-400 whitespace-pre-wrap break-words">
              {errorMsg ?? 'Render failed.'}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--editor-border)]">
          {status === 'running' ? (
            <button
              onClick={handleCancel}
              className="text-sm px-4 py-1.5 rounded-md bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)]/80 hover:bg-red-900/40 hover:border-red-700 hover:text-red-300 transition-colors"
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={onClose}
              className="text-sm px-4 py-1.5 rounded-md bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)] hover:opacity-90 transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
