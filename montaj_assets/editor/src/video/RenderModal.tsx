import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type {
  EditorAdapter,
  Project,
  RenderExport,
  RenderOptions,
  RenderPhase,
  RenderStatus,
} from '../types'
import type { ImageTone } from './imageTone'
import ImageToneMenu from './ImageToneMenu'
import { SDR_CURVES, DEFAULT_SDR_CURVE, honestyLine, type SdrCurve } from './sdrCurves'

/**
 * Host-supplied inputs for the pre-render options state. Absent (or `isHdr:
 * false`) → the modal keeps its zero-friction behavior: it fires the render on
 * mount with no inputs at all. Present with `isHdr: true` → it opens on the
 * options panel instead and only renders once the user hits Start render,
 * because an HDR project now has an export decision to make.
 */
export interface PreRenderOptions {
  /** True when this project renders HDR, which is the only case with a choice. */
  isHdr: boolean
  /**
   * Windows on the project timeline (seconds) the curve thumbnails may sample
   * from — the kept segments of track 0. The modal picks one at random and
   * samples a single timestamp inside it, so both curves are compared on the
   * same frame. Empty/absent → no thumbnails, just labels.
   */
  keeps?: Array<{ start: number; end: number }>
  /**
   * Current HDR image color mapping plus its setter, so the Advanced section
   * can surface the same `ImageToneMenu` the toolbar shows. The setter is the
   * host's normal persistence path (an editor mutation that saves and undoes).
   * Absent → the menu is not rendered.
   */
  imageTone?: { value: ImageTone; set: (tone: ImageTone) => void }
}

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
  /**
   * Which progress UI to show while the render runs:
   *   'phases' — the compact phase stepper (Preparing → … → Saving). Works on
   *              any transport; the default when omitted.
   *   'logs'   — the full scrolling render-log panel. Requires the SSE
   *              `adapter.render()` transport (which streams per-line logs);
   *              on a poll-based host it would sit empty.
   * Threaded down from the host as a flag (montaj-native → 'logs', Hub clients
   * → 'phases'), mirroring `VideoEditorProps.renderProgressView`. */
  progressView?: 'phases' | 'logs'
  /**
   * Opens the modal on a pre-render options panel instead of firing the render
   * on mount. Only HDR projects have anything to choose, so hosts pass this
   * with `isHdr: true` for those and omit it (or pass `isHdr: false`)
   * everywhere else, which preserves the fire-on-mount behavior exactly. */
  preRenderOptions?: PreRenderOptions
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
  'sdr_derive',
  'saving',
  'done',
]

/** User-facing label for a render phase. Honest, plain-English, no jargon. */
export function phaseLabel(phase: RenderPhase): string {
  switch (phase) {
    case 'preparing':  return 'Preparing'
    case 'rendering':  return 'Rendering graphics'
    case 'captions':   return 'Adding captions'
    case 'encoding':   return 'Encoding video'
    case 'sdr_derive': return 'Deriving SDR'
    case 'saving':     return 'Saving to your library'
    case 'done':       return 'Done'
  }
}

/** Ordinal of a phase within {@link RENDER_PHASES}. */
export function phaseIndex(phase: RenderPhase): number {
  return RENDER_PHASES.indexOf(phase)
}

/** The phases shown in the running stepper (terminal `done` excluded). */
const STEPPER_PHASES: RenderPhase[] = RENDER_PHASES.filter(p => p !== 'done')

/**
 * The stepper rows for a given render. `sdr_derive` only runs when an HDR
 * project asked for an SDR file, so listing it on every render would promise a
 * step that never happens.
 */
export function stepperPhases(opts?: RenderOptions): RenderPhase[] {
  const derives = opts?.export === 'sdr' || opts?.export === 'both'
  return derives ? STEPPER_PHASES : STEPPER_PHASES.filter(p => p !== 'sdr_derive')
}

/**
 * Pick one timestamp (project-timeline seconds) to sample the curve thumbnails
 * at: a random point inside a random keep, kept away from the segment edges so
 * the frame doesn't land on a transition or a black first frame. Returns null
 * when there is nothing worth sampling, which is the caller's signal to render
 * the picker without thumbnails. `rand` is injectable for tests.
 */
export function pickSampleTime(
  keeps: Array<{ start: number; end: number }> | undefined,
  rand: () => number = Math.random,
): number | null {
  const usable = (keeps ?? []).filter(k => k.end - k.start > 0.2)
  if (usable.length === 0) return null
  const keep = usable[Math.min(usable.length - 1, Math.floor(rand() * usable.length))]
  const span = keep.end - keep.start
  // Middle 60% of the keep.
  return keep.start + span * (0.2 + rand() * 0.6)
}

/** The three export choices, in the order they read best: safest first. */
const EXPORT_CHOICES: Array<{ id: RenderExport; label: string; blurb: string }> = [
  { id: 'auto', label: 'Match footage (HDR)', blurb: 'One HDR file, the way it was shot.' },
  { id: 'sdr',  label: 'SDR',                 blurb: 'One standard file. Plays the same everywhere.' },
  { id: 'both', label: 'Both',                blurb: 'The HDR file plus an SDR copy beside it.' },
]

const POLL_INTERVAL_MS = 2500

/**
 * Consecutive status-poll failures tolerated before the modal declares the
 * render failed. A multi-minute 4K render polls many times; a transient network
 * blip (a Cloudflare-tunnel hiccup, a backend redeploy, a flaky hop) must not be
 * mistaken for a render failure — the render keeps running server-side. ~12 ×
 * 2.5s ≈ 30s of continuous unreachability before giving up. An explicit backend
 * `error` status is still terminal immediately.
 */
const MAX_POLL_FAILURES = 12

// ── Stepper ───────────────────────────────────────────────────────────────────

function PhaseStepper({ current, phases }: { current: RenderPhase; phases: RenderPhase[] }) {
  const currentIdx = phaseIndex(current)
  return (
    <div className="flex flex-col gap-3">
      {phases.map((phase) => {
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

// ── Log line (SSE / log-panel view) ───────────────────────────────────────────

function LogLine({ text }: { text: string }) {
  const t = text.replace(/^\[montaj render\]\s*/, '')
  let color = 'text-[var(--editor-text)]/60'
  if (/ready|complete|done|encoded|assembled/i.test(t))  color = 'text-green-400'
  else if (/rendering|bundling|launching|browsers/i.test(t)) color = 'text-sky-400'
  else if (/trimming|building|composing/i.test(t))       color = 'text-amber-400'
  else if (/frame\s+\d+\/\d+/i.test(t))                  color = 'text-[var(--editor-text)]/55'
  else if (/error|fail|warn/i.test(t))                   color = 'text-red-400'

  const prefix = text.startsWith('[montaj render]')
    ? <span className="text-[var(--editor-text)]/40">[render] </span>
    : null

  return (
    <span className={`leading-relaxed whitespace-pre-wrap break-all ${color}`}>
      {prefix}{t}
    </span>
  )
}

export default function RenderModal<P extends Project = Project>({ projectId, adapter, onClose, onCancel, exportActions, progressView, preRenderOptions }: RenderModalProps<P>) {
  const [status, setStatus]     = useState<'running' | 'done' | 'error'>('running')
  const [phase, setPhase]       = useState<RenderPhase>('preparing')
  const [logs, setLogs]         = useState<string[]>([])
  const [media, setMedia]       = useState<RenderMedia[] | null>(null)
  const [outputPath, setOutput] = useState<string | null>(null)
  // Extra files beyond the primary (a `both` export's derived SDR sibling).
  const [extraOutputs, setExtraOutputs] = useState<string[]>([])
  const [errorMsg, setError]    = useState<string | null>(null)
  const logRef                  = useRef<HTMLDivElement>(null)
  const cancelledRef            = useRef(false)
  const unmountedRef            = useRef(false)
  const cleanupTimerRef         = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollTimerRef            = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Pre-render options (HDR projects only) ─────────────────────────────────
  // `started` gates the render effect. SDR projects (no preRenderOptions, or
  // isHdr: false) start true, so the render still fires on mount exactly as it
  // always has; HDR projects start false and wait for "Start render".
  const showOptions = !!preRenderOptions?.isHdr
  const [started, setStarted]         = useState(!showOptions)
  const [exportChoice, setExport]     = useState<RenderExport>('auto')
  const [sdrCurve, setSdrCurve]       = useState<SdrCurve>(DEFAULT_SDR_CURVE)
  const [advancedOpen, setAdvanced]   = useState(false)
  const [thumbs, setThumbs]           = useState<Record<string, string>>({})
  const [thumbsPending, setPending]   = useState(false)
  // Chosen once per mount so both curves are sampled on the same frame.
  const [sampleAt] = useState<number | null>(() =>
    showOptions ? pickSampleTime(preRenderOptions?.keeps) : null)
  const thumbsRequestedRef = useRef(false)

  // The options the render was started with. Read through a ref inside the
  // render effect (which must not re-fire when unrelated state changes) and
  // held in state for the stepper, which needs to re-render on it.
  const [renderOpts, setRenderOpts] = useState<RenderOptions | undefined>(undefined)
  const renderOptsRef = useRef<RenderOptions | undefined>(undefined)

  // `usePolling` is the data-transport decision (does this adapter expose the
  // poll-based render API?) — independent of which progress UI we show.
  const usePolling = !!(adapter.renderAsync && adapter.getRenderStatus)
  // `view` is the host's UI choice, threaded down as a flag (montaj-native →
  // 'logs', Hub clients → 'phases'). Defaults to the universally-safe stepper;
  // 'logs' only renders content on the SSE transport, which streams log lines.
  const view = progressView ?? 'phases'

  // Curve thumbnails: one sample of the SAME frame per curve, fetched in
  // parallel and folded in as they land. Deliberately fire-and-forget — the
  // options UI is already on screen, an absent `getSampleFrame` or a failed
  // call just leaves the picker showing labels, and nothing here can block or
  // fail the render.
  useEffect(() => {
    if (started || sampleAt === null) return
    const getSampleFrame = adapter.getSampleFrame
    if (!getSampleFrame) return
    // Fetch each curve's thumbnail once. The ref guard dedups StrictMode's
    // mount→cleanup→mount so dev doesn't sample every frame twice.
    //
    // Delivery is deliberately NOT gated on a per-invocation `alive` flag. Under
    // StrictMode mount #1 fires the fetches and its cleanup would flip that flag
    // to false, while mount #2 hits this dedup guard and returns without ever
    // re-arming it — so the in-flight results land in a dead closure and no
    // thumbnail ever paints (dev-only; production has no double-invoke). Because
    // setThumbs/setPending are functional-merge updates they are safe to call
    // from whichever mount owns the fetches; on a genuine unmount React 18 makes
    // the setState a harmless no-op. So we just deliver.
    if (thumbsRequestedRef.current) return
    thumbsRequestedRef.current = true

    let outstanding = SDR_CURVES.length
    setPending(true)
    const settle = () => { if (--outstanding === 0) setPending(false) }

    for (const curve of SDR_CURVES) {
      getSampleFrame(projectId, sampleAt, { sdrCurve: curve.id })
        .then(({ url }) => setThumbs(t => ({ ...t, [curve.id]: url })))
        .catch(() => {})
        .finally(settle)
    }
  }, [started, sampleAt, adapter, projectId])

  useEffect(() => {
    if (!started) return

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

    void (async () => {
      try {
        if (usePolling) {
          // Async, poll-based render: kick once, then poll status until terminal.
          await adapter.renderAsync!(projectId, renderOptsRef.current)
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
              // A transient network blip (Cloudflare-tunnel hiccup, a backend
              // redeploy, a flaky hop) must NOT be mistaken for a render
              // failure — the render is still running server-side. This is what
              // surfaced as "Render failed: Failed to fetch" while the render
              // actually completed and was delivered. Keep polling; only give
              // up after MAX_POLL_FAILURES consecutive failures. An explicit
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
          for await (const ev of adapter.render(projectId, renderOptsRef.current)) {
            if (unmountedRef.current || cancelledRef.current) break
            if (ev.type === 'log') {
              // Streaming hosts have no phase signal. Accumulate the line for
              // the log panel, and keep the stepper (if shown) on "rendering"
              // as an honest mid-pipeline indicator.
              setLogs(l => [...l, ev.message])
              setPhase('rendering')
            } else if (ev.type === 'done') {
              setOutput(ev.outputPath)
              setExtraOutputs(ev.outputPaths?.slice(1) ?? [])
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
  }, [projectId, adapter, started])

  // Auto-scroll the log panel as lines stream in.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  // Escape to close when done/error, and from the options panel — nothing has
  // been started there, so backing out is free.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (!started) (onCancel ?? onClose)()
      else if (status !== 'running') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [status, started, onClose, onCancel])

  function handleCancel() {
    cancelledRef.current = true
    // Use onCancel when provided so the host can dismiss without navigating
    // (cancelling an in-progress render shouldn't yank the user away from
    // their editor). Falls back to onClose for back-compat with callers that
    // haven't been updated.
    ;(onCancel ?? onClose)()
  }

  function handleStart() {
    const opts: RenderOptions = { export: exportChoice, sdrCurve }
    // The ref is what the render effect reads (it must not re-fire on unrelated
    // state); the state copy drives the stepper's phase list.
    renderOptsRef.current = opts
    setRenderOpts(opts)
    setStarted(true)
  }

  // ── Pre-render options panel ────────────────────────────────────────────────
  if (!started) {
    const curveInfo = SDR_CURVES.find(c => c.id === sdrCurve) ?? SDR_CURVES[0]
    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black">
        <div className="w-full max-w-lg bg-[var(--editor-surface)] border border-[var(--editor-border)] rounded-xl shadow-2xl flex flex-col overflow-hidden">

          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--editor-border)]">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold text-[var(--editor-text)]">Render options</h2>
              <p className="text-xs text-[var(--editor-text)]/55">
                This project renders in HDR, so you have an export choice to make.
              </p>
            </div>
            <button
              onClick={handleCancel}
              aria-label="Close"
              className="text-[var(--editor-text)]/55 hover:text-[var(--editor-text)] transition-colors text-lg leading-none"
            >
              ×
            </button>
          </div>

          <div className="px-5 py-4 flex flex-col gap-4 max-h-[70vh] overflow-y-auto">
            {/* Export choice */}
            <div className="flex flex-col gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--editor-text)]/50">Export</p>
              <div role="radiogroup" aria-label="Export" className="grid grid-cols-3 gap-2">
                {EXPORT_CHOICES.map(choice => {
                  const active = choice.id === exportChoice
                  return (
                    <button
                      key={choice.id}
                      role="radio"
                      aria-checked={active}
                      onClick={() => setExport(choice.id)}
                      className={`flex flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors ${
                        active
                          ? 'border-violet-400/60 bg-violet-400/10'
                          : 'border-[var(--editor-border)] hover:bg-[var(--editor-text)]/5'
                      }`}
                    >
                      <span className="text-xs font-semibold text-[var(--editor-text)]">{choice.label}</span>
                      <span className="text-[10px] leading-snug text-[var(--editor-text)]/55">{choice.blurb}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Advanced disclosure */}
            <div className="flex flex-col gap-3 border-t border-[var(--editor-border)] pt-3">
              <button
                onClick={() => setAdvanced(o => !o)}
                aria-expanded={advancedOpen}
                className="flex items-center gap-1.5 self-start text-xs text-[var(--editor-text)]/70 hover:text-[var(--editor-text)] transition-colors"
              >
                {advancedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                Advanced
              </button>

              {advancedOpen && (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--editor-text)]/50">
                      Tone curve for SDR
                    </p>
                    <div role="radiogroup" aria-label="Tone curve for SDR" className="grid grid-cols-2 gap-2">
                      {SDR_CURVES.map(curve => {
                        const active = curve.id === sdrCurve
                        const thumb = thumbs[curve.id]
                        return (
                          <button
                            key={curve.id}
                            role="radio"
                            aria-checked={active}
                            onClick={() => setSdrCurve(curve.id)}
                            className={`flex flex-col gap-1.5 rounded-lg border p-2 text-left transition-colors ${
                              active
                                ? 'border-violet-400/60 bg-violet-400/10'
                                : 'border-[var(--editor-border)] hover:bg-[var(--editor-text)]/5'
                            }`}
                          >
                            {thumb ? (
                              <img
                                src={thumb}
                                alt={`${curve.label} sample frame`}
                                className="w-full aspect-video rounded object-cover border border-[var(--editor-border)]"
                              />
                            ) : thumbsPending ? (
                              <span className="w-full aspect-video rounded border border-[var(--editor-border)] bg-[var(--editor-text)]/5 flex items-center justify-center text-[10px] text-[var(--editor-text)]/40">
                                Sampling a frame…
                              </span>
                            ) : null}
                            <span className="text-xs font-semibold text-[var(--editor-text)] flex items-center gap-1.5">
                              {curve.label}
                              {curve.id === DEFAULT_SDR_CURVE && (
                                <span className="text-[9px] font-normal px-1 py-px rounded bg-[var(--editor-text)]/10 text-[var(--editor-text)]/55">default</span>
                              )}
                            </span>
                            <span className="text-[10px] leading-snug text-[var(--editor-text)]/60">{curve.blurb}</span>
                          </button>
                        )
                      })}
                    </div>
                    <p
                      data-testid="sdr-honesty-line"
                      className={`text-[11px] leading-snug ${
                        sdrCurve === DEFAULT_SDR_CURVE
                          ? 'text-[var(--editor-text)]/55'
                          : 'text-amber-400/90'
                      }`}
                    >
                      {honestyLine(sdrCurve)}
                    </p>
                  </div>

                  {/* Image color mapping — the same control the toolbar shows,
                      persisting through the host's normal settings path. */}
                  {preRenderOptions?.imageTone && (
                    <div className="flex items-center justify-between gap-3 border-t border-[var(--editor-border)] pt-3">
                      <span className="text-[11px] text-[var(--editor-text)]/55">
                        How photos and logos are converted for the HDR render.
                      </span>
                      <ImageToneMenu
                        variant="header"
                        value={preRenderOptions.imageTone.value}
                        onChange={preRenderOptions.imageTone.set}
                      />
                    </div>
                  )}
                </div>
              )}

              {!advancedOpen && (
                <p className="text-[11px] text-[var(--editor-text)]/45">
                  SDR files use the {curveInfo.label} look. Open Advanced to compare curves.
                </p>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--editor-border)]">
            <button
              onClick={handleCancel}
              className="text-sm px-4 py-1.5 rounded-md bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)]/80 hover:opacity-90 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleStart}
              className="text-sm px-4 py-1.5 rounded-md bg-[var(--editor-accent)] text-[var(--editor-accent-foreground)] font-medium hover:opacity-90 transition-colors"
            >
              Start render
            </button>
          </div>
        </div>
      </div>,
      document.body,
    )
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
                  {extraOutputs.length > 0 ? 'Download HDR master' : 'Download'}
                </a>
              )}
              {/* A `both` export's extra files (the derived SDR sibling). */}
              {extraOutputs.map((p) => (
                <a
                  key={p}
                  href={adapter.fileUrl(p)}
                  download={basename(p)}
                  className="w-full text-center text-sm px-4 py-2.5 rounded-lg bg-[var(--editor-surface)] border border-green-800 text-green-200/90 hover:bg-green-900/40 transition-colors font-medium"
                >
                  Download SDR version
                </a>
              ))}
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
      <div className={`w-full ${view === 'logs' ? 'max-w-3xl' : 'max-w-md'} bg-[var(--editor-surface)] border border-[var(--editor-border)] rounded-xl shadow-2xl flex flex-col overflow-hidden`}>

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

        {/* Body — full log panel (montaj-native / SSE) or phase stepper (Hub) */}
        {view === 'logs' ? (
          <div className="relative">
            <button
              onClick={() => navigator.clipboard.writeText(logs.join('\n') + (errorMsg ? '\n' + errorMsg : ''))}
              className="absolute top-2 right-2 z-10 text-[10px] px-2 py-0.5 rounded bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)]/60 hover:text-[var(--editor-text)] hover:border-[var(--editor-border)] transition-colors"
              title="Copy logs"
            >
              Copy
            </button>
            <div
              ref={logRef}
              className="h-96 overflow-y-auto px-4 py-3 font-mono text-[11px] text-[var(--editor-text)]/80 bg-[var(--editor-surface)] flex flex-col gap-0.5"
            >
              {logs.length === 0 && status === 'running' && (
                <span className="text-[var(--editor-text)]/40 italic">Starting render engine…</span>
              )}
              {logs.map((line, i) => (
                <LogLine key={i} text={line} />
              ))}
              {status === 'error' && errorMsg && (
                <span className="text-red-400 mt-1">{errorMsg}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="px-5 py-5">
            {status === 'running' ? (
              <>
                <PhaseStepper current={phase} phases={stepperPhases(renderOpts)} />
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
        )}

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
