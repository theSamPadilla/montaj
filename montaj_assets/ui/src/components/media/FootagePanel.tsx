import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Film, Plus, ArrowUpDown, Check, RefreshCw } from 'lucide-react'
import {
  FilmstripScrubber,
  FOOTAGE_DND_MIME,
  type FootageDropPayload,
  type FilmstripIndex,
  type GetFilmstripArgs,
  type SourcePreviewStore,
} from '@bycrux/editor'
import { api } from '@/lib/api'
import { basename } from '@/lib/utils'
import type { VisualItem } from '@/lib/types/schema'

// Duplicated across upload/*UploadFields.tsx (no shared export exists) —
// matches that convention rather than introducing a new one.
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'mts', 'mpg', 'mpeg']

/** `sourceDuration` seconds -> `m:ss`, e.g. `0:10`. */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/**
 * True when a source can be placed on the timeline: it has a `src` and a
 * positive, finite `sourceDuration`. `project/init.py` can leave
 * `sourceDuration` unset when ffprobe fails or times out at import, and the
 * canvas drop handler (TimelineCanvas.tsx) rejects any payload that fails
 * this same check — gating drag on it here means a probe-less card can never
 * reach that dead end.
 */
function hasPlaceableDuration(source: { src?: string; sourceDuration?: number }): boolean {
  const d = source.sourceDuration
  return !!source.src && typeof d === 'number' && Number.isFinite(d) && d > 0
}

/** Lowercased extension without the dot, e.g. `mov`. Empty string if there is none. */
function extensionOf(src: string | undefined): string {
  if (!src) return ''
  const base = basename(src)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

type SortKey = 'name' | 'dateAdded' | 'type'

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'dateAdded', label: 'Date added' },
  { key: 'type', label: 'Type' },
]

interface InFlightImport {
  id: string
  name: string
  phase: string
  error?: string
}

export interface FootagePanelProps {
  sources: VisualItem[]
  /** Source `src` paths that appear on the timeline -> show the "Added" badge. */
  usedSrcs: Set<string>
  projectId: string
  getFilmstrip: (args: GetFilmstripArgs) => Promise<FilmstripIndex>
  fileUrl: (path: string) => string
  ingestSource: (input: { path: string } | File) => Promise<{ jobId: string }>
  /** Remove this source from the project. The parent handles project mutation; never deletes files. */
  onRemove: (sourceId: string) => void
  /** Drives the main preview's hover-scrub overlay; cleared on pointer leave. */
  sourcePreview: SourcePreviewStore
  emptyHint?: string
}

export default function FootagePanel({
  sources,
  usedSrcs,
  projectId,
  getFilmstrip,
  fileUrl,
  ingestSource,
  onRemove,
  sourcePreview,
  emptyHint,
}: FootagePanelProps) {
  const [inFlight, setInFlight] = useState<InFlightImport[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [picking, setPicking] = useState(false)
  const [hover, setHover] = useState<{ id: string; fraction: number } | null>(null)
  // Optimistic override for a source's sourceDuration once the backfill probe
  // succeeds, keyed by source id — makes the card draggable and shows its
  // duration immediately, without waiting on the SSE round-trip to re-render
  // `sources` from the saved project.
  const [probedDurations, setProbedDurations] = useState<Record<string, number>>({})
  // Per-source backfill-probe status, keyed by source id.
  const [probeState, setProbeState] = useState<Record<string, { pending: boolean; error?: string }>>({})
  const pollTimers = useRef(new Map<string, ReturnType<typeof setInterval>>())
  // No active sort = today's default order (whatever `sources` arrives in).
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const sortMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timers = pollTimers.current
    return () => {
      timers.forEach(t => clearInterval(t))
      timers.clear()
    }
  }, [])

  useEffect(() => {
    if (!sortMenuOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        setSortMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [sortMenuOpen])

  // Sorts a copy — never mutates the `sources` prop — and keeps ties in their
  // original relative order (stable) via the captured index tiebreak.
  const sortedSources = useMemo(() => {
    if (!sortKey) return sources
    const indexed = sources.map((s, i) => ({ s, i }))
    if (sortKey === 'name') {
      indexed.sort((a, b) => {
        const an = a.s.src ? basename(a.s.src) : 'Untitled'
        const bn = b.s.src ? basename(b.s.src) : 'Untitled'
        return an.localeCompare(bn, undefined, { numeric: true, sensitivity: 'base' }) || a.i - b.i
      })
    } else if (sortKey === 'type') {
      indexed.sort((a, b) => extensionOf(a.s.src).localeCompare(extensionOf(b.s.src)) || a.i - b.i)
    } else {
      // dateAdded: VisualItem carries no addedAt/createdAt timestamp, so the
      // array's insertion order IS the date-added order (the server appends
      // each new source — see serve/routes/projects.py). Newest-first reads
      // as the useful default for this sort.
      indexed.sort((a, b) => b.i - a.i)
    }
    return indexed.map(x => x.s)
  }, [sources, sortKey])

  function updateInFlight(id: string, patch: Partial<InFlightImport>) {
    setInFlight(prev => prev.map(item => (item.id === id ? { ...item, ...patch } : item)))
  }

  function stopPolling(id: string) {
    const timer = pollTimers.current.get(id)
    if (timer !== undefined) {
      clearInterval(timer)
      pollTimers.current.delete(id)
    }
  }

  function dismissInFlight(id: string) {
    stopPolling(id)
    setInFlight(prev => prev.filter(item => item.id !== id))
  }

  async function startImport(input: { path: string } | File) {
    const name = input instanceof File ? input.name : basename(input.path)
    const id = `import-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setInFlight(prev => [...prev, { id, name, phase: 'starting' }])

    try {
      const { jobId } = await ingestSource(input)
      const timer = setInterval(async () => {
        try {
          const status = await api.getSourceJobStatus(projectId, jobId)
          if (status.status === 'done') {
            stopPolling(id)
            // The finished clip arrives via the `sources` prop once the
            // parent re-renders from SSE; just drop the placeholder.
            setInFlight(prev => prev.filter(item => item.id !== id))
          } else if (status.status === 'error') {
            stopPolling(id)
            updateInFlight(id, { phase: 'error', error: status.error ?? 'Import failed' })
          } else {
            updateInFlight(id, { phase: status.phase ?? 'processing' })
          }
        } catch (e: unknown) {
          stopPolling(id)
          updateInFlight(id, { phase: 'error', error: e instanceof Error ? e.message : String(e) })
        }
      }, 1000)
      pollTimers.current.set(id, timer)
    } catch (e: unknown) {
      updateInFlight(id, { phase: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  }

  async function handlePick() {
    setPicking(true)
    try {
      const { paths } = await api.pickFiles({ extensions: VIDEO_EXTENSIONS, prompt: 'Select footage' })
      for (const path of paths) startImport({ path })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) console.error(msg)
    } finally {
      setPicking(false)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('video/'))
    for (const file of files) startImport(file)
  }

  /** `source` with a locally-probed `sourceDuration` override applied, but
   *  only while the prop itself still lacks a usable duration. Source ids
   *  are reusable (`_next_clip_id` reissues the highest-numbered id once
   *  that clip is removed), so once SSE delivers a real `sourceDuration` on
   *  this id the prop must win outright — an override keyed by a stale id
   *  must never shadow a different clip's real duration. */
  function withEffectiveDuration(source: VisualItem): VisualItem {
    if (hasPlaceableDuration(source)) return source
    const override = probedDurations[source.id]
    return override != null ? { ...source, sourceDuration: override } : source
  }

  /** Backfill a probe-less source's `sourceDuration` via the server. */
  async function handleProbeDuration(source: VisualItem) {
    const id = source.id
    setProbeState(prev => ({ ...prev, [id]: { pending: true } }))
    try {
      const result = await api.probeSourceDuration(projectId, id)
      setProbedDurations(prev => ({ ...prev, [id]: result.sourceDuration }))
      setProbeState(prev => ({ ...prev, [id]: { pending: false } }))
    } catch (e: unknown) {
      setProbeState(prev => ({ ...prev, [id]: { pending: false, error: e instanceof Error ? e.message : String(e) } }))
    }
  }

  function handleDragStart(e: React.DragEvent, source: VisualItem) {
    const effective = withEffectiveDuration(source)
    if (!hasPlaceableDuration(effective)) return
    const payload: FootageDropPayload = {
      src: effective.src!,
      proxySrc: effective.proxySrc,
      sourceDuration: effective.sourceDuration ?? 0,
      sourceWidth: effective.sourceWidth,
      sourceHeight: effective.sourceHeight,
      name: basename(effective.src!),
    }
    e.dataTransfer.setData(FOOTAGE_DND_MIME, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
  }

  /** Hover-scrub is reflected in the main preview, not on the card itself:
   *  drives `sourcePreview` and the card's own position line together. */
  function handleMediaPointerMove(e: React.PointerEvent<HTMLDivElement>, source: VisualItem) {
    if (!source.proxySrc) return
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const fraction = clamp((e.clientX - rect.left) / rect.width, 0, 1)
    setHover({ id: source.id, fraction })
    sourcePreview.set({ url: fileUrl(source.proxySrc), fraction })
  }

  function handleMediaPointerLeave(source: VisualItem) {
    setHover(prev => (prev?.id === source.id ? null : prev))
    sourcePreview.set(null)
  }

  const isEmpty = sources.length === 0 && inFlight.length === 0

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-800">
        <div className="relative" ref={sortMenuRef}>
          <button
            onClick={() => setSortMenuOpen(o => !o)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
            title="Sort footage"
          >
            <ArrowUpDown size={12} />
            {sortKey ? SORT_OPTIONS.find(o => o.key === sortKey)?.label : 'Sort'}
          </button>
          {sortMenuOpen && (
            <div className="absolute left-0 top-full mt-1 z-10 w-32 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-lg py-1">
              {SORT_OPTIONS.map(option => (
                <button
                  key={option.key}
                  onClick={() => { setSortKey(option.key); setSortMenuOpen(false) }}
                  className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  {option.label}
                  {sortKey === option.key && <Check size={12} className="text-blue-500" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={handlePick}
          disabled={picking}
          className="text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-50"
          title="Import footage"
        >
          <Plus size={14} />
        </button>
      </div>

      <div
        className={`flex-1 min-h-0 overflow-y-auto p-2 transition-colors ${dragOver ? 'bg-blue-50 dark:bg-blue-950/30' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false) }}
        onDrop={handleDrop}
      >
        {isEmpty && !dragOver && (
          <p className="text-xs text-gray-600 text-center mt-4 px-2 leading-relaxed">
            {emptyHint ?? 'No footage yet. Import video to get started.'}
          </p>
        )}
        {dragOver && (
          <div className="h-full flex items-center justify-center">
            <p className="text-xs text-blue-500 dark:text-blue-400 text-center">Drop to import</p>
          </div>
        )}
        {!dragOver && !isEmpty && (
          <div className="grid grid-cols-3 gap-2">
            {inFlight.map(item => (
              <div
                key={item.id}
                className="relative rounded overflow-hidden border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
              >
                <div className="w-full aspect-video bg-gray-800 flex items-center justify-center">
                  {item.phase === 'error' ? (
                    <span className="text-[10px] text-red-400 text-center px-2">{item.error}</span>
                  ) : (
                    <div className="w-5 h-5 rounded-full border-2 border-gray-700 border-t-gray-400 animate-spin" />
                  )}
                </div>
                <div className="flex items-center justify-between gap-1 px-1.5 py-1">
                  <p className="text-xs text-gray-600 dark:text-gray-400 truncate" title={item.name}>{item.name}</p>
                  {item.phase === 'error' && (
                    <button
                      onClick={() => dismissInFlight(item.id)}
                      className="shrink-0 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
                      title="Dismiss"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
                {item.phase !== 'error' && (
                  <p className="text-[10px] text-gray-500 px-1.5 pb-1 truncate">{item.phase}</p>
                )}
              </div>
            ))}
            {sortedSources.map(source => {
              const used = !!source.src && usedSrcs.has(source.src)
              const name = source.src ? basename(source.src) : 'Untitled'
              const effective = withEffectiveDuration(source)
              const placeable = hasPlaceableDuration(effective)
              const probe = probeState[source.id]
              const probing = !!probe?.pending
              return (
                <div
                  key={source.id}
                  draggable={placeable}
                  onDragStart={e => handleDragStart(e, source)}
                  className={`group relative rounded overflow-hidden border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 ${placeable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}`}
                >
                  <div
                    className="relative w-full aspect-video bg-gray-800"
                    onPointerMove={source.proxySrc ? e => handleMediaPointerMove(e, source) : undefined}
                    onPointerLeave={source.proxySrc ? () => handleMediaPointerLeave(source) : undefined}
                  >
                    <div className={placeable ? undefined : 'opacity-50'}>
                      {source.proxySrc ? (
                        <FilmstripScrubber
                          interactive={false}
                          fit="contain"
                          projectId={projectId}
                          proxySrc={source.proxySrc}
                          sourceDuration={effective.sourceDuration ?? 0}
                          getFilmstrip={getFilmstrip}
                          fileUrl={fileUrl}
                          className="absolute inset-0"
                          ariaLabel={name}
                        />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <Film size={16} className="text-gray-600" />
                        </div>
                      )}
                    </div>
                    {hover?.id === source.id && (
                      <div
                        className="pointer-events-none absolute inset-y-0 w-0.5 bg-blue-400 shadow-[0_0_2px_rgba(0,0,0,0.8)]"
                        style={{ left: `${hover.fraction * 100}%` }}
                      />
                    )}
                    {used && (
                      <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-medium leading-none">
                        Added
                      </span>
                    )}
                    {placeable && (
                      <span className="absolute top-1 right-1 px-1 py-0.5 rounded bg-black/70 text-white text-[10px] font-mono leading-none transition-opacity group-hover:opacity-0">
                        {formatDuration(effective.sourceDuration!)}
                      </span>
                    )}
                    <button
                      onClick={() => onRemove(source.id)}
                      className="absolute top-1 right-1 p-0.5 rounded bg-black/60 text-gray-400 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Remove from project"
                    >
                      <X size={11} />
                    </button>
                  </div>
                  <div className="px-1.5 py-1">
                    <p className="text-xs text-gray-600 dark:text-gray-400 truncate" title={name}>{name}</p>
                    {!placeable && (
                      <div className="mt-1 flex items-center justify-between gap-1">
                        <span
                          className="text-[10px] text-amber-600 dark:text-amber-400 font-medium"
                          title="Duration unknown, so this clip cannot be placed on the timeline yet. Get its duration to enable it."
                        >
                          Duration unknown
                        </span>
                        <button
                          onClick={() => handleProbeDuration(source)}
                          disabled={probing}
                          className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-700 text-[10px] text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white disabled:opacity-50 transition-colors"
                          title="Get duration"
                        >
                          {probing ? (
                            <RefreshCw size={10} className="animate-spin" />
                          ) : (
                            'Get duration'
                          )}
                        </button>
                      </div>
                    )}
                    {/* Gated on `placeable` alongside the badge and the button: a
                        failed probe leaves an error behind, and the source can still
                        acquire a duration another way (a concurrent backfill, an SSE
                        reload). Once it is placeable the card must read exactly as
                        it does on the agent path, stale error included. */}
                    {!placeable && probe?.error && (
                      <p className="text-[10px] text-red-400 truncate mt-0.5" title={probe.error}>{probe.error}</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
