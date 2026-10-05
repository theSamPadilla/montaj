import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Slider } from '../ui'
import { Loader } from '../ui/Loader'

/**
 * The editor-relevant slice of a version — matches `VersionEntry` in
 * ../types, kept structural here so this file has no dependency direction on
 * the caller's exact type (mirrors VersionPanel's own `ProjectVersion`).
 */
interface CompareVersionEntry {
  hash: string
  message: string
  timestamp: string
}

export interface VersionCompareProps {
  projectId: string
  /** Dedup'd list from the panel (the same entries VersionPanel renders). */
  versions: CompareVersionEntry[]
  /** The version the user clicked "Compare" on — seeds the LEFT picker. */
  initialLeftHash: string
  /** Builds the URL fetched for a rendered frame of `commit` (a version hash,
   *  or the sentinel `"working"` for the live on-disk state) at `t` seconds. */
  frameUrl: (id: string, commit: string, t: number) => string
  /** Slider max, in seconds. Defaults to 30 when the host can't cheaply
   *  compute the project's real duration. */
  durationSeconds?: number
  onClose: () => void
  /** Editor theme mode — light/dark. Only affects the frame panes' load-error
   *  text (red-400 is sub-AA on the light `--editor-bg` placeholder box).
   *  Absent -> dark, matching every existing caller. */
  mode?: 'light' | 'dark'
}

/** Sentinel commit id for "the live on-disk state", matching the backend's
 *  `GET .../versions/:commit/frame` contract (T8a). Not a real git hash. */
const WORKING = 'working'

/** Slider ceiling when the host doesn't pass a real project duration. */
const DEFAULT_DURATION_SECONDS = 30

/** Debounce (ms) between the slider's raw drag value and the value that
 *  actually drives the `<img src>` — mirrors RenderModal's cover-frame
 *  slider debounce so dragging doesn't fire a frame render per pixel. */
const SCRUB_DEBOUNCE_MS = 200

const FRAME_ERROR_FALLBACK = "Couldn't render this frame"

/** Human label for a picker option / pane header: "Current (working)" for the
 *  sentinel, else the version's message (falling back to a short hash). */
function labelFor(hash: string, versions: CompareVersionEntry[]): string {
  if (hash === WORKING) return 'Current (working)'
  const v = versions.find(v => v.hash === hash)
  return v?.message?.trim() || hash.slice(0, 8)
}

/** mm:ss.d for the scrub readout. */
function formatT(sec: number): string {
  return `${sec.toFixed(1)}s`
}

function VersionFramePane({
  label,
  projectId,
  commit,
  t,
  frameUrl,
  mode = 'dark',
}: {
  label: string
  projectId: string
  commit: string
  t: number
  frameUrl: (id: string, commit: string, t: number) => string
  mode?: 'light' | 'dark'
}) {
  const src = frameUrl(projectId, commit, t)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [frameEnd, setFrameEnd] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const currentUrl = useRef<string | null>(null)

  // Fetch (not a bare <img src>) so the server's message and the clamp header
  // are readable. A new src aborts the in-flight request, so a fast scrub can
  // never land a stale frame; the previous frame stays up (dimmed) meanwhile.
  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res = await fetch(src, { signal: ctrl.signal })
        if (!res.ok) {
          let msg = ''
          try {
            const body = await res.json()
            const m = body?.detail?.message ?? body?.message
            if (typeof m === 'string') msg = m.trim()
          } catch { /* not JSON */ }
          if (ctrl.signal.aborted) return
          setError(msg || FRAME_ERROR_FALLBACK)
          setLoading(false)
          return
        }
        const blob = await res.blob()
        if (ctrl.signal.aborted) return
        const end = parseFloat(res.headers.get('X-Montaj-Frame-End') ?? '')
        const next = URL.createObjectURL(blob)
        if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
        currentUrl.current = next
        setObjectUrl(next)
        setFrameEnd(Number.isFinite(end) && end > 0 ? end : null)
        setLoading(false)
      } catch {
        if (ctrl.signal.aborted) return
        setError(FRAME_ERROR_FALLBACK)
        setLoading(false)
      }
    })()
    return () => ctrl.abort()
  }, [src])

  useEffect(() => () => {
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
    currentUrl.current = null
  }, [])

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)] truncate" title={label}>
        {label}
      </span>
      <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-[var(--editor-border)] bg-[var(--editor-bg)] flex items-center justify-center">
        {objectUrl && !error && (
          <img
            src={objectUrl}
            alt={`${label} frame at ${formatT(t)}`}
            className={`max-w-full max-h-full object-contain transition-opacity ${loading ? 'opacity-40' : ''}`}
          />
        )}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader size="sm" label="Rendering frame" />
          </div>
        )}
        {!loading && !error && frameEnd != null && (
          <span className="absolute top-1.5 right-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white tabular-nums">
            Ends at {formatT(frameEnd)}
          </span>
        )}
        {error && !loading && (
          <span className={`absolute inset-0 flex items-center justify-center text-xs px-3 text-center ${mode === 'light' ? 'text-red-600' : 'text-red-400/90'}`}>
            {error}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Visual A/B compare for project versions — two rendered-frame panes, a
 * shared time-scrub slider, and LEFT/RIGHT version pickers. Deliberately has
 * NO textual diff/summary: comparison is purely "what does this frame look
 * like" between two commits (or a commit and the live working state).
 */
export default function VersionCompare({
  projectId,
  versions,
  initialLeftHash,
  frameUrl,
  durationSeconds,
  onClose,
  mode = 'dark',
}: VersionCompareProps) {
  const duration = durationSeconds && durationSeconds > 0 ? durationSeconds : DEFAULT_DURATION_SECONDS

  // "Current (working)" always heads the list — it's a synthetic sentinel,
  // not a real entry in `versions`.
  const options = useMemo<CompareVersionEntry[]>(
    () => [{ hash: WORKING, message: 'Current (working)', timestamp: '' }, ...versions],
    [versions],
  )

  const [leftHash, setLeftHash] = useState(initialLeftHash)
  const [rightHash, setRightHash] = useState<string>(() => {
    // The common case: compare the clicked version against the live state.
    // The only way `initialLeftHash` could already BE "working" is a future
    // caller wiring Compare from somewhere other than a version-list entry —
    // guard it anyway so RIGHT never silently mirrors LEFT.
    if (initialLeftHash !== WORKING) return WORKING
    const idx = versions.findIndex(v => v.hash === initialLeftHash)
    return versions[idx + 1]?.hash ?? versions[0]?.hash ?? WORKING
  })

  // Slider value updates immediately for the readout; the value that drives
  // the `<img src>` (and thus a frame render) is debounced so a drag doesn't
  // fire one render per pixel.
  const [t, setT] = useState(duration / 2)
  const [sampleT, setSampleT] = useState(t)
  useEffect(() => {
    const id = setTimeout(() => setSampleT(t), SCRUB_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [t])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 text-[var(--editor-text)]">
      <div className="w-full max-w-5xl bg-[var(--editor-surface)] border border-[var(--editor-border)] rounded-2xl shadow-2xl flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--editor-border)]">
          <h2 className="text-sm font-semibold text-[var(--editor-text)]">Compare versions</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[color-mix(in_srgb,var(--editor-text)_55%,transparent)] hover:text-[var(--editor-text)] transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-4 px-5 py-4 max-h-[75vh] overflow-y-auto">

          {/* Picker row */}
          <div className="flex flex-col sm:flex-row gap-3">
            <label className="flex-1 min-w-0 flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[color-mix(in_srgb,var(--editor-text)_50%,transparent)]">Left</span>
              <select
                value={leftHash}
                onChange={(e) => setLeftHash(e.target.value)}
                className="text-sm px-3 py-1.5 rounded-md bg-[var(--editor-bg)] border border-[var(--editor-border)] text-[var(--editor-text)] focus:outline-none focus:border-[var(--editor-accent)] transition-colors"
              >
                {options.map(o => (
                  <option key={o.hash} value={o.hash}>{labelFor(o.hash, versions)}</option>
                ))}
              </select>
            </label>
            <label className="flex-1 min-w-0 flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[color-mix(in_srgb,var(--editor-text)_50%,transparent)]">Right</span>
              <select
                value={rightHash}
                onChange={(e) => setRightHash(e.target.value)}
                className="text-sm px-3 py-1.5 rounded-md bg-[var(--editor-bg)] border border-[var(--editor-border)] text-[var(--editor-text)] focus:outline-none focus:border-[var(--editor-accent)] transition-colors"
              >
                {options.map(o => (
                  <option key={o.hash} value={o.hash}>{labelFor(o.hash, versions)}</option>
                ))}
              </select>
            </label>
          </div>

          {/* Frame panes */}
          <div className="flex flex-col sm:flex-row gap-3">
            <VersionFramePane
              label={labelFor(leftHash, versions)}
              projectId={projectId}
              commit={leftHash}
              t={sampleT}
              frameUrl={frameUrl}
              mode={mode}
            />
            <VersionFramePane
              label={labelFor(rightHash, versions)}
              projectId={projectId}
              commit={rightHash}
              t={sampleT}
              frameUrl={frameUrl}
              mode={mode}
            />
          </div>

          {/* Time-scrub slider */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[color-mix(in_srgb,var(--editor-text)_50%,transparent)]">Time</span>
              <span className="text-xs text-[color-mix(in_srgb,var(--editor-text)_60%,transparent)] tabular-nums">{formatT(t)}</span>
            </div>
            <Slider
              min={0}
              max={duration}
              step={0.1}
              value={t}
              onChange={setT}
              aria-label="Scrub time"
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
