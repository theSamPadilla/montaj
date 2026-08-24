import { useCaptionJob } from '@/app/editor/captionJob'
import { Loader2 } from 'lucide-react'

// The pipeline labels its stderr lines with one of three subprocess names
// (see serve/routes/projects.py's `_run_caption_pipeline` steps list and its
// `on_log(label, text)` → `f"[{label}] {text}"` framing). Mapped to a short
// human phase for the readout below.
const PHASE_LABELS: Record<string, string> = {
  mix_timeline: 'Mixing audio',
  transcribe: 'Transcribing',
  caption: 'Formatting captions',
}

/**
 * Collapses one raw `[label] text` pipeline log line into a short human
 * phrase for the top-bar readout.
 *
 * The old blocking `CaptionRegenModal` showed every line verbatim in a
 * scrolling console — that console is deliberately gone now that this is a
 * passive, small readout, and the raw lines were never written for an end
 * user anyway: whisper in particular emits raw JSON progress frames on some
 * lines (e.g. `[transcribe] {"progress": "42%"}`). So this shows the phase
 * name plus whatever human-readable detail follows it, and drops the detail
 * entirely (falls back to just the phase name) whenever it looks like a
 * JSON/array blob rather than prose — stringifying `{"progress": "42%"}`
 * next to a spinner reads as noise, not progress, to a non-technical viewer.
 */
function friendlyLogLine(line: string): string {
  const m = /^\[(\w+)\]\s*(.*)$/.exec(line)
  if (!m) return line
  const [, label, rest] = m
  const phase = PHASE_LABELS[label] ?? label
  const trimmed = rest.trim()
  if (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('[')) return `${phase}…`
  return `${phase}: ${trimmed}`
}

interface Props {
  /** The mobile top nav has far less width than the desktop header. In
   *  compact mode the log line is dropped entirely — it's the most
   *  expendable part (the spinner + "Captions" already say "something is
   *  happening"; Cancel is what a mobile user would actually reach for) —
   *  and the running label shortens so the whole readout survives next to
   *  the tab strip and theme toggle. See MobileTopNav.tsx's usage. */
  compact?: boolean
}

export default function CaptionActivityIndicator({ compact = false }: Props) {
  const { status, logs, error, cancel, dismiss } = useCaptionJob()

  if (status === 'idle' || status === 'done') return null

  // `pointer-events-auto` on every branch's root below is deliberate, not
  // decorative: both App.tsx and MobileTopNav.tsx center this indicator
  // (alongside ProxyActivityIndicator) inside a `pointer-events-none`
  // wrapper, so the empty space around the centered cluster doesn't swallow
  // clicks meant for the nav/tabs behind it. ProxyActivityIndicator never had
  // to care because it has no interactive elements. This component DOES
  // (Cancel / dismiss), so without re-enabling pointer events on its own
  // root, those buttons would render correctly and even satisfy a
  // `fireEvent.click` test (jsdom doesn't apply CSS pointer-events at all)
  // while being genuinely dead to a real click in the browser.
  if (status === 'error') {
    const message = error ?? 'Caption regeneration failed'
    return (
      <div
        className="flex items-center gap-1.5 text-xs text-red-500 dark:text-red-400 shrink-0 pointer-events-auto"
        title={message}
      >
        <span className={compact ? 'max-w-[120px] truncate' : 'max-w-[240px] truncate'}>{message}</span>
        <button
          onClick={dismiss}
          aria-label="Dismiss caption error"
          className="text-red-400 hover:text-red-600 dark:hover:text-red-300 transition-colors leading-none shrink-0"
        >
          ×
        </button>
      </div>
    )
  }

  const rawLatest = logs.length > 0 ? logs[logs.length - 1] : undefined
  const latest = rawLatest !== undefined ? friendlyLogLine(rawLatest) : undefined

  return (
    <div
      className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 shrink-0 pointer-events-auto"
      title="Montaj is regenerating your captions from the timeline's audio. You can keep editing while this finishes."
    >
      <Loader2 size={12} className="animate-spin" />
      <span>{compact ? 'Captions' : 'Generating captions'}</span>
      {!compact && latest && (
        // Log lines arrive fast and can be long — truncated with a fixed max
        // width so the top bar's layout never jumps, with the friendly
        // (already-shortened) text repeated in `title` so it's reachable in
        // full on hover rather than only mid-truncation.
        <span className="text-gray-400 dark:text-gray-500 max-w-[160px] truncate" title={latest}>
          · {latest}
        </span>
      )}
      <button
        onClick={cancel}
        aria-label="Cancel caption generation"
        className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors leading-none shrink-0"
      >
        Cancel
      </button>
    </div>
  )
}
