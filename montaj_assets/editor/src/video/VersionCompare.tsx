import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

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
  /** Builds the `<img src>` for a rendered frame of `commit` (a version hash,
   *  or the sentinel `"working"` for the live on-disk state) at `t` seconds. */
  frameUrl: (id: string, commit: string, t: number) => string
  /** Slider max, in seconds. Defaults to 30 when the host can't cheaply
   *  compute the project's real duration. */
  durationSeconds?: number
  onClose: () => void
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
}: {
  label: string
  projectId: string
  commit: string
  t: number
  frameUrl: (id: string, commit: string, t: number) => string
}) {
  const src = frameUrl(projectId, commit, t)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  // A new src (different commit/time) resets the pane to its loading state —
  // `onLoadStart` doesn't fire reliably for every `<img>` src swap across
  // browsers, so gate on the src changing directly.
  useEffect(() => {
    setLoading(true)
    setError(false)
  }, [src])

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-[var(--editor-text)]/60 truncate" title={label}>
        {label}
      </span>
      <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-[var(--editor-border)] bg-[var(--editor-bg)] flex items-center justify-center">
        <img
          key={src}
          src={src}
          alt={`${label} frame at ${formatT(t)}`}
          onLoadStart={() => setLoading(true)}
          onLoad={() => setLoading(false)}
          onError={() => { setLoading(false); setError(true) }}
          className="max-w-full max-h-full object-contain"
          style={error ? { display: 'none' } : undefined}
        />
        {loading && !error && (
          <span className="absolute inset-0 flex items-center justify-center text-xs text-[var(--editor-text)]/50">
            Loading…
          </span>
        )}
        {error && (
          <span className="absolute inset-0 flex items-center justify-center text-xs text-red-400/90 px-3 text-center">
            Error rendering frame
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
      <div className="w-full max-w-5xl bg-[var(--editor-surface)] border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <h2 className="text-sm font-semibold text-[var(--editor-text)]">Compare versions</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--editor-text)]/55 hover:text-[var(--editor-text)] transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-4 px-5 py-4 max-h-[75vh] overflow-y-auto">

          {/* Picker row */}
          <div className="flex flex-col sm:flex-row gap-3">
            <label className="flex-1 min-w-0 flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--editor-text)]/50">Left</span>
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
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--editor-text)]/50">Right</span>
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
            />
            <VersionFramePane
              label={labelFor(rightHash, versions)}
              projectId={projectId}
              commit={rightHash}
              t={sampleT}
              frameUrl={frameUrl}
            />
          </div>

          {/* Time-scrub slider */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--editor-text)]/50">Time</span>
              <span className="text-xs text-[var(--editor-text)]/60 tabular-nums">{formatT(t)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={duration}
              step={0.1}
              value={t}
              onChange={(e) => setT(Number(e.target.value))}
              aria-label="Scrub time"
              className="w-full accent-[var(--editor-accent)]"
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
