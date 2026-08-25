import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { EditorAdapter, Project, RenderStatus } from '../types'
import { Loader } from '../ui/Loader'

interface CarouselRenderModalProps {
  projectId: string
  /** Adapter drives the render stream and path→URL resolution. */
  adapter: EditorAdapter<Project>
  /** Number of slides in the project — drives the gallery row count. */
  slidesCount: number
  /** Slide resolution [width, height] — drives thumbnail aspect ratio. */
  resolution: [number, number]
  /** Fired when the modal closes from a finished or errored state. */
  onClose: () => void
  /** Fired when the user cancels an in-progress render. Falls back to onClose. */
  onCancel?: () => void
  /**
   * Host-supplied export controls (e.g. a "Download all (.zip)" link). Rendered
   * in the done-state info panel. The package no longer hardcodes host URLs.
   */
  exportActions?: ReactNode
  /** Editor theme mode — light/dark. The panel and log box follow
   *  `--editor-surface`/`--editor-bg`, so log/status hues need to darken in
   *  light mode. Absent -> dark, matching every existing caller. */
  mode?: 'light' | 'dark'
}

/** Promoted render output (R2-presigned), as carried by `RenderStatus.media`. */
type RenderMedia = NonNullable<RenderStatus['media']>[number]

/** A rendered slide ready to display: a direct URL + its filename caption. */
interface SlideView { url: string; filename: string }

const POLL_INTERVAL_MS = 2500

/**
 * Consecutive status-poll failures tolerated before the modal declares the
 * render failed. A transient network blip (a Cloudflare-tunnel hiccup, a backend
 * redeploy, a flaky hop) must not be mistaken for a render failure — the render
 * keeps running server-side. ~12 × 2.5s ≈ 30s of continuous unreachability
 * before giving up. An explicit backend `error` status is still terminal.
 * Mirrors `video/RenderModal.tsx`.
 */
const MAX_POLL_FAILURES = 12

function slideFile(index: number): string {
  return `slide_${String(index + 1).padStart(2, '0')}.png`
}

/**
 * Order promoted media into slide order for the gallery. Hub's
 * `promoteRenderOutputs` returns media unordered and may include non-slide
 * outputs (e.g. `manifest.json`), so keep only `slide_NN.png` and sort by the
 * numeric index.
 */
function slidesFromMedia(media: RenderMedia[]): SlideView[] {
  return media
    .map((m) => ({ m, match: /^slide_0*(\d+)\.png$/i.exec(m.filename) }))
    .filter((x): x is { m: RenderMedia; match: RegExpExecArray } => x.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map(({ m }) => ({ url: m.url, filename: m.filename }))
}

function LogLine({ text, mode = 'dark' }: { text: string; mode?: 'light' | 'dark' }) {
  const t = text.replace(/^\[render\]\s*/, '')
  let color = 'text-[var(--editor-text)]/60'
  if (/done|complete|→/i.test(t))           color = mode === 'light' ? 'text-green-700' : 'text-green-400'
  else if (/rendering|launching|bundling/i.test(t)) color = mode === 'light' ? 'text-sky-700' : 'text-sky-400'
  else if (/error|fail/i.test(t))           color = mode === 'light' ? 'text-red-600' : 'text-red-400'

  const prefix = text.startsWith('[render]')
    ? <span className="text-[var(--editor-text)]/40">[render] </span>
    : null

  return (
    <span className={`leading-relaxed whitespace-pre-wrap break-all ${color}`}>
      {prefix}{t}
    </span>
  )
}

export default function CarouselRenderModal({ projectId, adapter, slidesCount, resolution, onClose, onCancel, exportActions, mode = 'dark' }: CarouselRenderModalProps) {
  const [logs, setLogs]         = useState<string[]>([])
  const [status, setStatus]     = useState<'running' | 'done' | 'error'>('running')
  const [media, setMedia]       = useState<RenderMedia[] | null>(null)
  const [outputDir, setOutDir]  = useState<string | null>(null)
  const [errorMsg, setError]    = useState<string | null>(null)
  const logRef                  = useRef<HTMLDivElement>(null)
  const cancelledRef            = useRef(false)
  const unmountedRef            = useRef(false)
  const cleanupTimerRef         = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollTimerRef            = useRef<ReturnType<typeof setInterval> | null>(null)

  // Data-transport decision: does this adapter expose the poll-based render API?
  // Hub clients (async-kick backend) do; the montaj-native desktop host doesn't
  // and falls back to the SSE `adapter.render()` stream below.
  const usePolling = !!(adapter.renderAsync && adapter.getRenderStatus)

  useEffect(() => {
    // StrictMode-safe render trigger — see RenderModal.tsx for the long-form
    // comment. Triggering a render is non-idempotent (spawns a subprocess), so
    // defer teardown and rescue it if the next mount fires within the same tick.
    if (cleanupTimerRef.current !== null) {
      clearTimeout(cleanupTimerRef.current)
      cleanupTimerRef.current = null
      unmountedRef.current = false
      cancelledRef.current = false
      return scheduleCleanup
    }

    unmountedRef.current = false
    cancelledRef.current = false

    void (async () => {
      try {
        if (usePolling) {
          // Async, poll-based render: kick once, then poll status until terminal.
          // The backend's POST render returns immediately ({status:'running'})
          // and the render runs detached — so we follow it via getRenderStatus
          // instead of a (now non-existent) SSE stream. This is the fix for the
          // modal hanging forever on "Starting render engine…".
          await adapter.renderAsync!(projectId)
          if (unmountedRef.current || cancelledRef.current) return

          let pollFailures = 0
          const tick = async () => {
            if (unmountedRef.current || cancelledRef.current) return
            let snap: RenderStatus
            try {
              snap = await adapter.getRenderStatus!(projectId)
              pollFailures = 0
            } catch (e) {
              if (unmountedRef.current || cancelledRef.current) return
              // Transient unreachability must NOT read as a render failure — the
              // render is still running server-side. Keep polling; only give up
              // after MAX_POLL_FAILURES consecutive failures. An explicit
              // { status: 'error' } reply is still terminal (handled below).
              pollFailures += 1
              if (pollFailures >= MAX_POLL_FAILURES) {
                stopPolling()
                setError(e instanceof Error ? e.message : String(e))
                setStatus('error')
              }
              return
            }
            if (unmountedRef.current || cancelledRef.current) return

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
              // Without this we'd poll forever with no progress.
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
          // Fallback for hosts without the poll API (montaj-native desktop):
          // consume the SSE render stream and accumulate log lines.
          for await (const ev of adapter.render(projectId)) {
            if (cancelledRef.current || unmountedRef.current) break
            if (ev.type === 'log') setLogs(l => [...l, ev.message])
            else if (ev.type === 'done') { setOutDir(ev.outputPath); setStatus('done') }
            else if (ev.type === 'error') { setError(ev.message); setStatus('error') }
          }
        }
      } catch (e) {
        if (!cancelledRef.current && !unmountedRef.current) {
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
      cleanupTimerRef.current = setTimeout(() => {
        cleanupTimerRef.current = null
        unmountedRef.current = true
        cancelledRef.current = true
        stopPolling()
      }, 0)
    }
  }, [projectId, adapter])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && status !== 'running') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [status, onClose])

  function handleCancel() {
    cancelledRef.current = true
    ;(onCancel ?? onClose)()
  }

  // ── Done state — gallery + zip download ─────────────────────────────────
  if (status === 'done') {
    // Prefer the promoted R2 media (poll path); fall back to workspace paths
    // resolved via fileUrl (SSE path).
    const slides: SlideView[] = media
      ? slidesFromMedia(media)
      : outputDir
        ? Array.from({ length: slidesCount }).map((_, i) => {
            const file = slideFile(i)
            return { url: adapter.fileUrl(`${outputDir}/${file}`), filename: file }
          })
        : []

    // Portal to document.body (see RenderModal): a transformed host ancestor
    // would otherwise trap this `fixed` overlay and center the panel off-screen.
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black">
        <div className="w-[96vw] h-[96vh] bg-[var(--editor-bg)] border border-[var(--editor-border)] rounded-2xl shadow-2xl flex overflow-hidden">

          {/* Left — slide gallery */}
          <div className="flex-1 bg-black flex items-center justify-center overflow-auto p-8">
            {slides.length > 0 ? (
              <div
                className="grid gap-4 w-full max-w-6xl"
                style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}
              >
                {slides.map((slide, i) => (
                  <a
                    key={slide.filename}
                    href={slide.url}
                    target="_blank"
                    rel="noreferrer"
                    className="group relative block rounded-lg overflow-hidden border border-[var(--editor-border)] hover:border-[var(--editor-accent)] transition-colors bg-[var(--editor-surface)]"
                  >
                    <img
                      src={slide.url}
                      alt={slide.filename}
                      className="block w-full h-auto"
                      style={{ aspectRatio: `${resolution[0]} / ${resolution[1]}` }}
                    />
                    <div className="absolute bottom-0 left-0 right-0 px-2 py-1.5 bg-black text-[11px] text-[var(--editor-text)] font-mono flex justify-between">
                      <span>#{String(i + 1).padStart(2, '0')}</span>
                      <span className="text-[var(--editor-text)]/60">{slide.filename}</span>
                    </div>
                  </a>
                ))}
              </div>
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
                  <p className="text-xs text-[var(--editor-text)]/60">
                    {slides.length || slidesCount} slide{(slides.length || slidesCount) === 1 ? '' : 's'} ready.
                  </p>
                </div>
              </div>
              <button onClick={onClose} className="text-[var(--editor-text)]/60 hover:text-[var(--editor-text)] transition-colors text-lg leading-none">×</button>
            </div>

            <div className="flex flex-col gap-3 p-5 flex-1">
              {exportActions}
              <button
                onClick={onClose}
                className="w-full text-center text-sm px-4 py-2.5 rounded-lg bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)] hover:opacity-90 transition-colors"
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

  // ── Running / error state ───────────────────────────────────────────────
  // Poll transport carries no per-line logs, so show a spinner + status text;
  // the SSE transport (montaj-native) streams logs into the log panel.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black">
      <div className="w-full max-w-3xl bg-[var(--editor-surface)] border border-[var(--editor-border)] rounded-xl shadow-2xl flex flex-col overflow-hidden">

        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--editor-border)]">
          <div className="flex items-center gap-2.5">
            {status === 'running' && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
            {status === 'error'   && <span className="w-2 h-2 rounded-full bg-red-400" />}
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold text-[var(--editor-text)]">
                {status === 'running' ? 'Rendering slides…' : 'Render failed'}
              </h2>
            </div>
          </div>
          {status !== 'running' && (
            <button onClick={onClose} className="text-[var(--editor-text)]/60 hover:text-[var(--editor-text)] transition-colors text-lg leading-none">×</button>
          )}
        </div>

        {usePolling ? (
          <div className="px-5 py-8 flex flex-col items-center justify-center gap-4 min-h-[12rem]">
            {status === 'running' ? (
              <>
                <Loader size="lg" />
                <p className="text-sm text-[var(--editor-text)]/70">Rendering slides…</p>
                <p className="text-xs text-[var(--editor-text)]/50">This can take a moment.</p>
              </>
            ) : (
              <p className={`text-sm whitespace-pre-wrap break-words text-center ${mode === 'light' ? 'text-red-600' : 'text-red-400'}`}>
                {errorMsg ?? 'Render failed.'}
              </p>
            )}
          </div>
        ) : (
          <div className="relative">
            <button
              onClick={() => navigator.clipboard.writeText(logs.join('\n') + (errorMsg ? '\n' + errorMsg : ''))}
              className="absolute top-2 right-2 z-10 text-[10px] px-2 py-0.5 rounded bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)]/60 hover:text-[var(--editor-text)] hover:border-[var(--editor-accent)] transition-colors"
              title="Copy logs"
            >
              Copy
            </button>
            <div
              ref={logRef}
              className="h-96 overflow-y-auto px-4 py-3 font-mono text-[11px] text-[var(--editor-text)] bg-[var(--editor-bg)] flex flex-col gap-0.5"
            >
              {logs.length === 0 && status === 'running' && (
                <span className="text-[var(--editor-text)]/40 italic">Starting render engine…</span>
              )}
              {logs.map((line, i) => (
                <LogLine key={i} text={line} mode={mode} />
              ))}
              {status === 'error' && errorMsg && (
                <span className={`mt-1 ${mode === 'light' ? 'text-red-600' : 'text-red-400'}`}>{errorMsg}</span>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--editor-border)]">
          {status === 'running' ? (
            <button
              onClick={handleCancel}
              className={`text-sm px-4 py-1.5 rounded-md bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)] transition-colors ${mode === 'light' ? 'hover:bg-red-50 hover:border-red-300 hover:text-red-700' : 'hover:bg-red-900/40 hover:border-red-700 hover:text-red-300'}`}
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
