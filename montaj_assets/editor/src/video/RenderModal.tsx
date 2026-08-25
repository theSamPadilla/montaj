import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight, ChevronLeft, Maximize2 } from 'lucide-react'
import type {
  EditorAdapter,
  Project,
  RenderExport,
  RenderOptions,
  RenderPhase,
  RenderStatus,
} from '../types'
import { IMAGE_TONES, DEFAULT_IMAGE_TONE, type ImageTone } from './imageTone'
import { TONE_EXAMPLES } from './imageToneExamples'
import { SDR_CURVES, DEFAULT_SDR_CURVE, honestyLine, type SdrCurve } from './sdrCurves'
import { Loader } from '../ui/Loader'

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
   * Current HDR image color mapping plus its setter, so the export dialog can
   * surface the same `ImageToneMenu` the toolbar shows. The setter is the
   * host's normal persistence path (an editor mutation that saves and undoes).
   * Absent → the menu is not rendered.
   */
  imageTone?: { value: ImageTone; set: (tone: ImageTone) => void }
  /**
   * Suggested output filename (no extension), seeding the dialog's Name field.
   * Absent → the field defaults to `export`.
   */
  name?: string
  /**
   * Total project-timeline length in seconds — the render's duration. Seeds the
   * dialog's duration footer and bounds the cover-frame slider (0..durationSec).
   * Absent → treated as 0 (footer/slider fall back gracefully).
   */
  durationSec?: number
  /**
   * Output aspect ratio (width / height), so the cover preview matches the
   * project's shape — a vertical project gets a vertical cover. Absent → 16/9.
   */
  aspectRatio?: number
  /**
   * Export resolution control — source-capped tier picker.
   * `value`  — the currently-selected [w, h] (initial = the project's current settings.resolution).
   * `available` — the tiers the dialog may offer, each as [w, h] preserving aspect; ordered ascending by short-side.
   * `set` — the host's persistence setter (mutates settings.resolution + saves). Absent → no dropdown rendered.
   */
  resolution?: {
    value: [number, number]
    available: Array<[number, number]>
    set: (r: [number, number]) => void
  }
  /**
   * Export fps control — source-capped tier picker. `value` is the currently-selected fps
   * (initial = settings.fps ?? 30). `available` is the fps tiers offerable (asc). `set` persists.
   */
  fps?: {
    value: number
    available: number[]
    set: (f: number) => void
  }
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
  /** Fired exactly once, the moment the render transitions to 'done' (either
   *  transport — the poll loop or the SSE stream) — NOT on modal close, and
   *  not on error. Callers use this to refresh state that a finished render
   *  affects (e.g. re-fetching version history), independent of when/whether
   *  the operator dismisses the modal. */
  onRenderComplete?: () => void
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
  /** Editor theme mode — light/dark. The export dialog and progress/error
   *  panels follow `--editor-surface`, so warning/error hues need to darken
   *  in light mode. The render-log terminal boxes stay dark by design and so
   *  take no mode: they are painted an OPAQUE near-black (`#0a0e17`/`#0e131f`)
   *  rather than a translucent `bg-black/40`, which would have composited to
   *  mid-grey over a light surface instead of staying a terminal. Those two
   *  values are exactly what the old translucent blacks composited to over the
   *  dark `--editor-surface`, so dark mode is unchanged. Absent -> dark,
   *  matching every existing caller. */
  mode?: 'light' | 'dark'
}

/** Promoted render output (R2-presigned), as carried by `RenderStatus.media`. */
type RenderMedia = NonNullable<RenderStatus['media']>[number]

function basename(p: string) { return p.split('/').pop() ?? p }

/**
 * Client mirror of the server's output-name sanitizer
 * (`serve/routes/projects.py` `_sanitize_output_name`): basename, drop the
 * extension and `..`, keep a conservative whitelist, trim leading/trailing
 * space/dot. Falls back to `export` so an empty field is deterministic and the
 * "Save to" line always shows the real filename the render will produce (the
 * server re-sanitizes, so this only needs to match for the common cases).
 */
export function sanitizeOutputName(name: string): string {
  const base = (name.split(/[/\\]/).pop() ?? '')
    .replace(/\.[^.]*$/, '')
    .replace(/\.\./g, '')
    .replace(/[^A-Za-z0-9 _.-]+/g, '')
    .replace(/^[ .]+|[ .]+$/g, '')
  return base || 'export'
}


/** mm:ss for a duration/timecode in seconds. Clamps negatives to 0:00. */
function formatTimecode(sec: number): string {
  const total = Math.max(0, Math.floor(sec))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

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

/** Friendly tier name for a resolution, keyed off the short side (e.g. 1080
 *  for both 1080x1920 and 1920x1080). Falls back to "<n>p" for non-standard
 *  short sides so an odd source resolution still reads sensibly. */
export function resLabel([w, h]: [number, number]): string {
  const short = Math.min(w, h)
  switch (short) {
    case 720:  return '720p'
    case 1080: return '1080p (HD)'
    case 1440: return '1440p (2K)'
    case 2160: return '2160p (4K)'
    default:   return `${short}p`
  }
}

/** Short helper line under an fps tier button — a plain-English hint, empty
 *  for the neutral default (30). */
function fpsHint(fps: number): string {
  if (fps === 24) return 'cinema'
  if (fps === 60) return 'smooth'
  return ''
}

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

// ── Progress ────────────────────────────────────────────────────────────────

/**
 * Best-effort render progress (0..1) for the SSE/log transport, where the phase
 * is pinned to 'rendering' and only log lines arrive. It reads the two phases
 * that carry a real running counter, so the bar tracks TOTAL work rather than
 * leaping on a keyword:
 *
 *   • Frame-baking (renderer.js): `encoded <job> (jobsDone/jobs.length done)` —
 *     every overlay/caption element (chunked) is one job; jobsDone/total drives
 *     0.05 → 0.55. The "done" in "(N/M done)" is a per-JOB counter, NOT the
 *     render finishing — matching it as completion is what pinned the bar at
 *     ~98% for the entire render.
 *   • Composition (compose.js): `[montaj compose] segment i/N` — drives
 *     0.55 → 0.90.
 *
 * Counter-less markers (composition start, concat, SDR derive, cleanup) nudge
 * the bar between those bands. Monotonic (`Math.max`), so a counter resetting
 * between phases never walks it backward. Returns null before any line lands.
 */
export function parseLogProgress(logs: string[]): number | null {
  if (logs.length === 0) return null
  let p = 0.02  // a line exists, so the engine has started
  for (const line of logs) {
    // Frame-baking overall counter: "encoded <job> (jobsDone/total done)".
    const baked = line.match(/\((\d+)\s*\/\s*(\d+)\s+done\)/i)
    if (baked) {
      const n = Number(baked[1]), d = Number(baked[2])
      if (d > 0 && n <= d) p = Math.max(p, 0.05 + 0.50 * (n / d))
      continue
    }
    // Composition per-segment counter: "[montaj compose] segment i/N".
    const comp = line.match(/segment\s+(\d+)\s*\/\s*(\d+)/i)
    if (comp && /compos/i.test(line)) {
      const n = Number(comp[1]), d = Number(comp[2])
      if (d > 0 && n <= d) p = Math.max(p, 0.55 + 0.35 * (n / d))
      continue
    }
    // Counter-less phase markers.
    if (/composing final video/i.test(line)) p = Math.max(p, 0.55)
    else if (/concatenat/i.test(line)) p = Math.max(p, 0.90)
    else if (/deriving|\bsdr\b/i.test(line)) p = Math.max(p, 0.92)
    else if (/intermediate files cleaned/i.test(line)) p = Math.max(p, 0.96)
    else if (/rendering .*\bframes\)/i.test(line)) p = Math.max(p, 0.05)  // baking started
  }
  return p
}

/**
 * A slim progress bar. A number 0..1 draws a determinate fill; `null` draws an
 * indeterminate sweep (keyframes inlined so the bar is self-contained in any
 * host, no Tailwind config dependency).
 */
function ProgressBar({ value }: { value: number | null }) {
  const pct = value === null ? null : Math.max(0, Math.min(1, value)) * 100
  return (
    <div className="w-full max-w-xs" role="progressbar" aria-label="Render progress"
      aria-valuenow={pct === null ? undefined : Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--editor-text)]/10">
        {pct === null ? (
          <>
            <style>{'@keyframes montajRenderIndet{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}'}</style>
            <div className="h-full w-1/3 rounded-full bg-[var(--editor-accent)]"
              style={{ animation: 'montajRenderIndet 1.2s ease-in-out infinite' }} />
          </>
        ) : (
          <div className="h-full rounded-full bg-[var(--editor-accent)] transition-[width] duration-500 ease-out"
            style={{ width: `${pct}%` }} />
        )}
      </div>
    </div>
  )
}

export default function RenderModal<P extends Project = Project>({ projectId, adapter, onClose, onCancel, onRenderComplete, exportActions, progressView, preRenderOptions, mode = 'dark' }: RenderModalProps<P>) {
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
  // Guards onRenderComplete so it fires exactly once per render attempt even
  // though the poll loop can tick again after 'done' (see the note at
  // `pollTimerRef.current = setInterval(...)` below) and even across both
  // completion transports (poll vs. SSE).
  const renderCompleteFiredRef  = useRef(false)

  // ── Pre-render options (the Export dialog) ─────────────────────────────────
  // `started` gates the render effect. Hosts that pass `preRenderOptions` open
  // on the dialog (montaj always does — for HDR and SDR alike); hosts that omit
  // it keep the historical fire-on-mount behavior exactly. The HDR-only controls
  // (Format / Image color / SDR curve) stay gated on `isHdr` inside the dialog.
  const showOptions = !!preRenderOptions
  const isHdr = !!preRenderOptions?.isHdr
  const durationSec = preRenderOptions?.durationSec ?? 0
  // Cover preview follows the project's shape. Portrait projects constrain by
  // height (so a tall cover can't overrun the dialog); landscape fills the column.
  const coverAspect = preRenderOptions?.aspectRatio && preRenderOptions.aspectRatio > 0
    ? preRenderOptions.aspectRatio
    : 16 / 9
  const coverPortrait = coverAspect < 1
  const [started, setStarted]         = useState(!showOptions)
  const [exportChoice, setExport]     = useState<RenderExport>('auto')
  const [sdrCurve, setSdrCurve]       = useState<SdrCurve>(DEFAULT_SDR_CURVE)
  const [advancedOpen, setAdvanced]   = useState(false)
  const [imageColorOpen, setImageColor] = useState(false)
  const [showLog, setShowLog]         = useState(false)
  const [thumbs, setThumbs]           = useState<Record<string, string>>({})
  const [thumbsPending, setPending]   = useState(false)
  // The SDR curve whose thumbnail is opened full-size in the lightbox (see
  // below), so the small grid preview can be inspected at detail and paged
  // between. Null = closed.
  const [expandedCurveId, setExpandedCurveId] = useState<string | null>(null)
  // Chosen once per mount so both curves are sampled on the same frame. HDR-only
  // — the curve compare (and thus this sample) doesn't exist for SDR projects.
  const [sampleAt] = useState<number | null>(() =>
    isHdr ? pickSampleTime(preRenderOptions?.keeps) : null)
  const thumbsRequestedRef = useRef(false)

  // ── Name + cover (every project) ────────────────────────────────────────────
  // Name seeds the output filename; cover is the poster-frame timecode (project
  // seconds). Cover defaults to a sampled keep frame, or the timeline midpoint.
  const [name, setName]               = useState<string>(preRenderOptions?.name ?? 'export')
  const [coverTime, setCoverTime]     = useState<number>(() => {
    const picked = pickSampleTime(preRenderOptions?.keeps)
    return picked ?? (durationSec > 0 ? durationSec / 2 : 0)
  })
  const [coverEditing, setCoverEditing] = useState(false)
  const [coverUrl, setCoverUrl]       = useState<string | null>(null)
  const [coverLoading, setCoverLoading] = useState(false)
  // "Edit cover" frame picker: evenly-spaced sample times (roughly one per 4s,
  // clamped — each tile is a full composited sample_frame render, so the grid is
  // bounded and loaded lazily). `coverTiles` maps tile index → resolved URL.
  const [coverTiles, setCoverTiles]   = useState<Record<number, string>>({})
  const coverTileTimes = useMemo<number[]>(() => {
    if (durationSec <= 0) return []
    const n = 10  // fixed grid of 10 evenly-spaced frames (was ~one per 4s)
    return Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * durationSec)
  }, [durationSec])
  const coverTilesRequestedRef = useRef<string>('')

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
    // Deferred until Advanced is actually open: the curve thumbnails only show
    // inside that (collapsed-by-default) disclosure, so sampling them on mount
    // spent two full frame renders on previews most exports never look at. Now
    // the modal opens sampling just the cover; the curves sample the first time
    // Advanced is expanded (once — `thumbsRequestedRef` dedups).
    if (started || sampleAt === null || !advancedOpen) return
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
  }, [started, sampleAt, adapter, projectId, advancedOpen])

  // Cover preview: sample the poster frame at `coverTime`, DEBOUNCED so dragging
  // the slider doesn't spam the sampler. Fire-and-forget like the curve
  // thumbnails — an absent `getSampleFrame` or a failed call just leaves the
  // placeholder, and nothing here can block or fail the render. The `alive`
  // flag + clearTimeout drop a stale drag's in-flight request (and make the
  // debounce naturally StrictMode-safe: the first mount's timer is cleared
  // before it can fire).
  useEffect(() => {
    if (started) return
    const getSampleFrame = adapter.getSampleFrame
    if (!getSampleFrame) return
    let alive = true
    setCoverLoading(true)
    const timer = setTimeout(() => {
      // Sample from the SDR proxy — the cover is a poster preview, not a
      // colour-graded frame, so it doesn't need the master or a per-curve tone
      // map (the real poster is made from the master at export). Much faster,
      // and it means dragging the cover slider no longer re-samples on curve.
      getSampleFrame(projectId, coverTime, { preferProxy: true })
        .then(({ url }) => { if (alive) setCoverUrl(url) })
        .catch(() => {})
        .finally(() => { if (alive) setCoverLoading(false) })
    }, 200)
    return () => { alive = false; clearTimeout(timer) }
  }, [started, coverTime, adapter, projectId])

  // Cover frame grid: sampled lazily once the picker opens, one composited frame
  // per tile from the SDR proxy (fast; these are only for picking a timestamp),
  // folded in as each lands. Keyed by tile count so re-opening the picker reuses
  // what's cached. Fire-and-forget — a failed/absent sampler just leaves that
  // tile on its loader.
  useEffect(() => {
    if (started || !coverEditing) return
    const getSampleFrame = adapter.getSampleFrame
    if (!getSampleFrame || coverTileTimes.length === 0) return
    const key = `${coverTileTimes.length}`
    if (coverTilesRequestedRef.current === key) return
    coverTilesRequestedRef.current = key
    setCoverTiles({})
    let alive = true
    coverTileTimes.forEach((t, i) => {
      getSampleFrame(projectId, t, { preferProxy: true })
        .then(({ url }) => { if (alive) setCoverTiles(prev => ({ ...prev, [i]: url })) })
        .catch(() => {})
    })
    return () => { alive = false }
  }, [started, coverEditing, coverTileTimes, adapter, projectId])

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
    renderCompleteFiredRef.current = false

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
              fireRenderComplete()
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
              fireRenderComplete()
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

    // See `renderCompleteFiredRef`'s declaration: guards against firing more
    // than once for a single render attempt — both because the poll loop can
    // tick again after 'done' (a stray `setInterval` re-arm right after the
    // immediate first tick already resolved) and because callers only care
    // about the transition into 'done', not every render that reaches it.
    function fireRenderComplete() {
      if (renderCompleteFiredRef.current) return
      renderCompleteFiredRef.current = true
      onRenderComplete?.()
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
      // Lightbox open: Escape closes it, arrows page between the loaded curve
      // previews. It captures these keys so they don't also close the dialog.
      if (expandedCurveId) {
        if (e.key === 'Escape') { setExpandedCurveId(null); return }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          const avail = SDR_CURVES.filter(c => thumbs[c.id])
          if (avail.length > 1) {
            const cur = avail.findIndex(c => c.id === expandedCurveId)
            const step = e.key === 'ArrowRight' ? 1 : -1
            setExpandedCurveId(avail[(cur + step + avail.length) % avail.length].id)
          }
        }
        return
      }
      if (e.key !== 'Escape') return
      if (!started) (onCancel ?? onClose)()
      else if (status !== 'running') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [status, started, onClose, onCancel, expandedCurveId, thumbs])

  function handleCancel() {
    cancelledRef.current = true
    // Use onCancel when provided so the host can dismiss without navigating
    // (cancelling an in-progress render shouldn't yank the user away from
    // their editor). Falls back to onClose for back-compat with callers that
    // haven't been updated.
    ;(onCancel ?? onClose)()
  }

  function handleStart() {
    const opts: RenderOptions = {
      export: exportChoice,
      sdrCurve,
      name: sanitizeOutputName(name),
      cover: coverTime,
    }
    // The ref is what the render effect reads (it must not re-fire on unrelated
    // state); the state copy drives the stepper's phase list.
    renderOptsRef.current = opts
    setRenderOpts(opts)
    setStarted(true)
  }

  // ── Export dialog ───────────────────────────────────────────────────────────
  if (!started) {
    const curveInfo = SDR_CURVES.find(c => c.id === sdrCurve) ?? SDR_CURVES[0]
    const outputName = sanitizeOutputName(name)
    // Lightbox nav: only curves whose thumbnail has loaded are pageable.
    const expandedCurve = expandedCurveId ? SDR_CURVES.find(c => c.id === expandedCurveId) ?? null : null
    const expandedUrl = expandedCurveId ? thumbs[expandedCurveId] : undefined
    const navCurves = SDR_CURVES.filter(c => thumbs[c.id])
    const canNavCurves = navCurves.length > 1
    const goCurve = (step: number) => {
      const cur = navCurves.findIndex(c => c.id === expandedCurveId)
      if (cur >= 0) setExpandedCurveId(navCurves[(cur + step + navCurves.length) % navCurves.length].id)
    }
    return (<>
      {createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
        <div className="w-full max-w-3xl bg-[var(--editor-surface)] border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden">

          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
            <h2 className="text-sm font-semibold text-[var(--editor-text)]">Export</h2>
            <button
              onClick={handleCancel}
              aria-label="Close"
              className="text-[var(--editor-text)]/55 hover:text-[var(--editor-text)] transition-colors text-lg leading-none"
            >
              ×
            </button>
          </div>

          {/* Two-column body: cover on the left, settings on the right. */}
          <div className="flex flex-col md:flex-row gap-5 px-5 py-4 max-h-[70vh] overflow-y-auto">

            {/* Left — cover preview + editor */}
            <div className="md:w-64 shrink-0 flex flex-col gap-2">
              <div
                className="relative mx-auto max-w-full overflow-hidden rounded-lg border border-white/10 bg-black/40 flex items-center justify-center"
                style={coverPortrait
                  ? { aspectRatio: coverAspect, height: 'min(46vh, 22rem)' }
                  : { aspectRatio: coverAspect, width: '100%' }}
              >
                {coverUrl ? (
                  <img
                    src={coverUrl}
                    alt="Cover frame"
                    className="w-full h-full object-cover"
                  />
                ) : coverLoading ? (
                  <Loader size="md" label="Loading cover" />
                ) : (
                  <span className="text-[11px] text-[var(--editor-text)]/40">No preview</span>
                )}
              </div>
              {adapter.getSampleFrame && (
                <>
                  <button
                    onClick={() => setCoverEditing(o => !o)}
                    aria-expanded={coverEditing}
                    className="self-start text-xs text-[var(--editor-text)]/70 hover:text-[var(--editor-text)] transition-colors"
                  >
                    {coverEditing ? 'Done' : 'Edit cover'}
                  </button>
                  {coverEditing && (
                    coverTileTimes.length > 0 ? (
                      <div className="flex gap-1.5 overflow-x-auto pb-1" role="radiogroup" aria-label="Cover frame">
                        {coverTileTimes.map((t, i) => {
                          const url = coverTiles[i]
                          const nearest = coverTileTimes.reduce((best, tt, j) =>
                            Math.abs(tt - coverTime) < Math.abs(coverTileTimes[best] - coverTime) ? j : best, 0)
                          const active = i === nearest
                          return (
                            <button
                              key={i}
                              role="radio"
                              aria-checked={active}
                              onClick={() => setCoverTime(t)}
                              title={formatTimecode(t)}
                              className={`relative shrink-0 overflow-hidden rounded border transition-colors ${
                                active
                                  ? 'border-[var(--editor-accent)] ring-1 ring-[var(--editor-accent)]'
                                  : 'border-white/10 hover:border-white/40'
                              }`}
                              style={{ aspectRatio: coverAspect, height: 72 }}
                            >
                              {url
                                ? <img src={url} alt="" className="h-full w-full object-cover" />
                                : <span className="flex h-full w-full items-center justify-center bg-black/40"><Loader size="sm" /></span>}
                            </button>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="text-[11px] text-[var(--editor-text)]/40">No frames to pick from.</p>
                    )
                  )}
                </>
              )}
            </div>

            {/* Right — settings */}
            <div className="flex-1 min-w-0 flex flex-col gap-4">
              {/* Name */}
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--editor-text)]/50">Name</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="export"
                  className="text-sm px-3 py-1.5 rounded-md bg-[var(--editor-surface)] border border-[var(--editor-border)] text-[var(--editor-text)] focus:outline-none focus:border-[var(--editor-accent)] transition-colors"
                />
              </label>

              {/* Save to */}
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--editor-text)]/50">Save to</span>
                <span className="text-xs font-mono text-[var(--editor-text)]/70 truncate">output/{outputName}.mp4</span>
                <span className="text-[11px] text-[var(--editor-text)]/45">Download after export.</span>
              </div>

              {/* Resolution — source-capped tier picker. Only rendered when the
                  host supplies a `resolution` control; the tile whose short
                  side equals the CURRENT project resolution is pre-selected.
                  That selected state is the only affordance — no "recommended"
                  badge (per operator: the pre-selection is enough, and the
                  badge overflowed the tile). */}
              {preRenderOptions?.resolution && (() => {
                const res = preRenderOptions.resolution
                const currentShort = Math.min(...res.value)
                return (
                  <div className="flex flex-col gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--editor-text)]/50">Resolution</p>
                    <div role="radiogroup" aria-label="Resolution" className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {res.available.map(([w, h]) => {
                        const short = Math.min(w, h)
                        const active = short === currentShort
                        return (
                          <button
                            key={`${w}x${h}`}
                            role="radio"
                            aria-checked={active}
                            onClick={() => res.set([w, h])}
                            className={`flex flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors ${
                              active
                                ? 'border-violet-400/60 bg-violet-400/10'
                                : 'border-[var(--editor-border)] hover:bg-[var(--editor-text)]/5'
                            }`}
                          >
                            <span className="text-xs font-semibold text-[var(--editor-text)]">{resLabel([w, h])}</span>
                            <span className="text-[10px] leading-snug text-[var(--editor-text)]/55">{w} × {h}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}

              {/* Frame rate — source-capped tier picker, same idiom as Resolution. */}
              {preRenderOptions?.fps && (() => {
                const fps = preRenderOptions.fps
                return (
                  <div className="flex flex-col gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--editor-text)]/50">Frame rate</p>
                    <div role="radiogroup" aria-label="Frame rate" className="grid grid-cols-3 gap-2">
                      {fps.available.map(f => {
                        const active = f === fps.value
                        const hint = fpsHint(f)
                        return (
                          <button
                            key={f}
                            role="radio"
                            aria-checked={active}
                            onClick={() => fps.set(f)}
                            className={`flex flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors ${
                              active
                                ? 'border-violet-400/60 bg-violet-400/10'
                                : 'border-[var(--editor-border)] hover:bg-[var(--editor-text)]/5'
                            }`}
                          >
                            <span className="text-xs font-semibold text-[var(--editor-text)]">{f} fps</span>
                            <span className="text-[10px] leading-snug text-[var(--editor-text)]/55">{hint}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}

              {/* HDR-only controls: export format, image color, tone-curve compare. */}
              {isHdr && (
                <>
                  {/* Format */}
                  <div className="flex flex-col gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--editor-text)]/50">Format</p>
                    <div role="radiogroup" aria-label="Format" className="grid grid-cols-3 gap-2">
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

                  {/* Image color — a disclosure matching the Advanced one below: a
                      plain chevron toggle opening a 2-col grid of tones, each with a
                      per-tone example image. Persists through the host's normal
                      settings path (an editor mutation that saves + undoes). */}
                  {(() => {
                    const it = preRenderOptions?.imageTone
                    if (!it) return null
                    const tone = it.value ?? DEFAULT_IMAGE_TONE
                    const toneInfo = IMAGE_TONES.find(t => t.id === tone) ?? IMAGE_TONES[0]
                    return (
                      <div className="flex flex-col gap-3 border-t border-[var(--editor-border)] pt-3">
                        <button
                          onClick={() => setImageColor(o => !o)}
                          aria-expanded={imageColorOpen}
                          className="flex items-center gap-1.5 self-start text-xs text-[var(--editor-text)]/70 hover:text-[var(--editor-text)] transition-colors"
                        >
                          {imageColorOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          Image color
                        </button>

                        {imageColorOpen ? (
                          <div className="flex flex-col gap-2">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--editor-text)]/50">
                              How photos and logos convert for HDR
                            </p>
                            <div role="radiogroup" aria-label="Image color" className="grid grid-cols-2 gap-2">
                              {IMAGE_TONES.map(t => {
                                const active = t.id === tone
                                return (
                                  <button
                                    key={t.id}
                                    role="radio"
                                    aria-checked={active}
                                    onClick={() => it.set(t.id)}
                                    className={`flex flex-col gap-1.5 rounded-lg border p-2 text-left transition-colors ${
                                      active
                                        ? 'border-violet-400/60 bg-violet-400/10'
                                        : 'border-[var(--editor-border)] hover:bg-[var(--editor-text)]/5'
                                    }`}
                                  >
                                    <img
                                      src={TONE_EXAMPLES[t.id]}
                                      alt={`${t.label} example`}
                                      className="w-full aspect-video rounded object-cover border border-[var(--editor-border)]"
                                    />
                                    <span className="text-xs font-semibold text-[var(--editor-text)] flex items-center gap-1.5">
                                      {t.label}
                                      {t.id === DEFAULT_IMAGE_TONE && (
                                        <span className="text-[9px] font-normal px-1 py-px rounded bg-[var(--editor-text)]/10 text-[var(--editor-text)]/55">default</span>
                                      )}
                                    </span>
                                    <span className="text-[10px] leading-snug text-[var(--editor-text)]/60">{t.summary}</span>
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        ) : (
                          <p className="text-[11px] text-[var(--editor-text)]/45">
                            Photos and logos use the {toneInfo.label} conversion. Open to change.
                          </p>
                        )}
                      </div>
                    )
                  })()}

                  {/* Advanced disclosure — SDR tone-curve compare. */}
                  <div className="flex flex-col gap-3 border-t border-[var(--editor-border)] pt-3">
                    <button
                      onClick={() => setAdvanced(o => !o)}
                      aria-expanded={advancedOpen}
                      className="flex items-center gap-1.5 self-start text-xs text-[var(--editor-text)]/70 hover:text-[var(--editor-text)] transition-colors"
                    >
                      {advancedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      Advanced
                    </button>

                    {advancedOpen ? (
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
                                  // Shown at the SOURCE aspect ratio (not a fixed
                                  // 16:9) so a vertical project reads as vertical.
                                  // The hover "expand" control opens it full-size
                                  // in the lightbox; it stops propagation so a
                                  // click on it inspects rather than selects the
                                  // curve.
                                  <span className="relative block w-full">
                                    <img
                                      src={thumb}
                                      alt={`${curve.label} sample frame`}
                                      style={{ aspectRatio: coverAspect }}
                                      className="w-full rounded object-cover border border-[var(--editor-border)]"
                                    />
                                    <span
                                      role="button"
                                      tabIndex={0}
                                      aria-label={`Expand ${curve.label} preview`}
                                      onClick={(e) => { e.stopPropagation(); setExpandedCurveId(curve.id) }}
                                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setExpandedCurveId(curve.id) } }}
                                      className="absolute top-1 right-1 flex items-center justify-center rounded bg-black/55 p-1 text-white/85 hover:text-white cursor-pointer transition-colors"
                                    >
                                      <Maximize2 size={12} />
                                    </span>
                                  </span>
                                ) : thumbsPending ? (
                                  <span style={{ aspectRatio: coverAspect }} className="w-full rounded border border-[var(--editor-border)] bg-[var(--editor-text)]/5 flex items-center justify-center">
                                    <Loader size="sm" />
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
                              : (mode === 'light' ? 'text-amber-700' : 'text-amber-400/90')
                          }`}
                        >
                          {honestyLine(sdrCurve)}
                        </p>
                      </div>
                    ) : (
                      <p className="text-[11px] text-[var(--editor-text)]/45">
                        SDR files use the {curveInfo.label} look. Open Advanced to compare curves.
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Footer — duration on the left, actions on the right. */}
          <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[var(--editor-border)]">
            <span className="text-xs text-[var(--editor-text)]/50 tabular-nums">
              {durationSec > 0 ? formatTimecode(durationSec) : ''}
            </span>
            <div className="flex items-center gap-2">
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
                Export
              </button>
            </div>
          </div>
        </div>
      </div>,
      document.body,
      )}
      {expandedCurve && expandedUrl && createPortal(
        <div
          className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/90 p-6"
          onClick={() => setExpandedCurveId(null)}
          role="dialog"
          aria-label={`${expandedCurve.label} preview`}
        >
          <div className="relative flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
            {canNavCurves && (
              <button
                onClick={() => goCurve(-1)}
                aria-label="Previous curve"
                className="absolute -left-3 sm:-left-14 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white/80 hover:text-white transition-colors"
              >
                <ChevronLeft size={22} />
              </button>
            )}
            {/* Clicking the image itself pages to the next curve (wraps) — the
                quickest A/B compare; the backdrop or Esc closes. */}
            <img
              src={expandedUrl}
              alt={`${expandedCurve.label} sample frame`}
              onClick={() => { if (canNavCurves) goCurve(1) }}
              className={`max-h-[82vh] max-w-[88vw] rounded-lg object-contain shadow-2xl ${canNavCurves ? 'cursor-pointer' : ''}`}
            />
            {canNavCurves && (
              <button
                onClick={() => goCurve(1)}
                aria-label="Next curve"
                className="absolute -right-3 sm:-right-14 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white/80 hover:text-white transition-colors"
              >
                <ChevronRight size={22} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs" onClick={(e) => e.stopPropagation()}>
            <span className="font-semibold text-white/90">{expandedCurve.label}</span>
            {expandedCurve.id === DEFAULT_SDR_CURVE && (
              <span className="text-[10px] px-1 py-px rounded bg-white/15 text-white/70">default</span>
            )}
          </div>
          <p className="text-[11px] text-white/40">
            {canNavCurves ? 'Click the image or press ← → to compare · Esc or click outside to close' : 'Esc or click outside to close'}
          </p>
        </div>,
        document.body,
      )}
    </>)
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
      <div className="w-full max-w-md bg-[var(--editor-surface)] border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            {status === 'running' && <span className="w-2 h-2 rounded-full bg-[var(--editor-accent)] animate-pulse" />}
            {status === 'error'   && <span className="w-2 h-2 rounded-full bg-red-400" />}
            <h2 className="text-sm font-semibold text-[var(--editor-text)]">
              {status === 'running' ? 'Rendering…' : 'Render failed'}
            </h2>
          </div>
          {status !== 'running' && (
            <button onClick={onClose} className="text-[var(--editor-text)]/55 hover:text-[var(--editor-text)] transition-colors text-lg leading-none">×</button>
          )}
        </div>

        {status === 'running' ? (
          /* Stylized loading state: equalizer + phase + progress sweep. */
          <div className="flex flex-col items-center gap-6 px-6 py-9">
            <Loader size="lg" />

            <div className="flex flex-col items-center gap-1 text-center">
              <h3 className="text-base font-semibold text-[var(--editor-text)]">Exporting your video</h3>
              <p className="text-xs text-[var(--editor-text)]/50">This can take a few minutes for longer videos.</p>
            </div>

            {/* Progress bar — always visible while rendering, above the stepper
                (poll hosts) or the render-log disclosure (SSE hosts). Poll hosts
                have a real `phase`; the SSE log transport pins phase to
                'rendering', so there we infer progress from the log stream. */}
            <ProgressBar value={
              view === 'logs'
                ? parseLogProgress(logs)
                : (() => {
                    const ph = stepperPhases(renderOpts)
                    const i = ph.indexOf(phase)
                    return i >= 0 ? i / ph.length : (phase === 'done' ? 1 : null)
                  })()
            } />

            {/* Granular phase progress (poll hosts advance through phases). */}
            {view !== 'logs' && (
              <div className="w-full max-w-xs rounded-xl border border-white/10 bg-[#0e131f] px-4 py-3">
                <PhaseStepper current={phase} phases={stepperPhases(renderOpts)} />
              </div>
            )}

            {/* Raw render log, collapsed by default (montaj-native / SSE). */}
            {view === 'logs' && (
              <div className="w-full">
                <button
                  onClick={() => setShowLog(o => !o)}
                  aria-expanded={showLog}
                  className="mx-auto flex items-center gap-1 text-[11px] text-[var(--editor-text)]/50 hover:text-[var(--editor-text)]/80 transition-colors"
                >
                  {showLog ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {showLog ? 'Hide render log' : 'Show render log'}
                </button>
                {showLog && (
                  <div className="relative mt-2">
                    <button
                      onClick={() => navigator.clipboard.writeText(logs.join('\n'))}
                      className="absolute top-2 right-2 z-10 rounded border border-white/10 bg-[#0a0e17] px-2 py-0.5 text-[10px] text-[var(--editor-text)]/60 hover:text-[var(--editor-text)] transition-colors"
                      title="Copy logs"
                    >
                      Copy
                    </button>
                    <div
                      ref={logRef}
                      className="flex h-52 flex-col gap-0.5 overflow-y-auto rounded-lg border border-white/10 bg-[#0a0e17] px-3 py-2 font-mono text-[11px] text-[var(--editor-text)]/80"
                    >
                      {logs.length === 0
                        ? <span className="italic text-[var(--editor-text)]/40">Starting render engine…</span>
                        : logs.map((line, i) => <LogLine key={i} text={line} />)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          /* Error state. */
          <div className="px-5 py-5">
            {view === 'logs' ? (
              <div className="relative">
                <button
                  onClick={() => navigator.clipboard.writeText(logs.join('\n') + (errorMsg ? '\n' + errorMsg : ''))}
                  className="absolute top-2 right-2 z-10 rounded border border-white/10 bg-[#0a0e17] px-2 py-0.5 text-[10px] text-[var(--editor-text)]/60 hover:text-[var(--editor-text)] transition-colors"
                  title="Copy logs"
                >
                  Copy
                </button>
                <div
                  ref={logRef}
                  className="flex h-72 flex-col gap-0.5 overflow-y-auto rounded-lg border border-white/10 bg-[#0a0e17] px-3 py-2 font-mono text-[11px] text-[var(--editor-text)]/80"
                >
                  {logs.map((line, i) => <LogLine key={i} text={line} />)}
                  {errorMsg && <span className="mt-1 text-red-400">{errorMsg}</span>}
                </div>
              </div>
            ) : (
              <p className={`text-sm whitespace-pre-wrap break-words ${mode === 'light' ? 'text-red-600' : 'text-red-400'}`}>
                {errorMsg ?? 'Render failed.'}
              </p>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/10">
          {status === 'running' ? (
            <button
              onClick={handleCancel}
              className={`text-sm px-4 py-1.5 rounded-md bg-[#0e131f] border border-white/10 text-[var(--editor-text)]/80 transition-colors ${mode === 'light' ? 'hover:bg-red-50 hover:border-red-300 hover:text-red-700' : 'hover:bg-red-900/40 hover:border-red-700 hover:text-red-300'}`}
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={onClose}
              className="text-sm px-4 py-1.5 rounded-md bg-[#0e131f] border border-white/10 text-[var(--editor-text)] hover:opacity-90 transition-colors"
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
