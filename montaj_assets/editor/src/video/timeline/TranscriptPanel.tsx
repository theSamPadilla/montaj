import { useEffect, useRef, useState } from 'react'
import type { Project } from '../../types'
import { formatTime } from './utils'
import { EditableSegment } from './EditableSegment'
import { makeCaptionEdit, type CaptionEditPatch } from './makeCaptionEdit'
import { SwatchInput } from '../../ui'

// Each caption style reads a different accent-color prop in its render template
// (see render/templates/captions/*.jsx). The color control writes whichever field
// the active style uses; `clean` and `word-by-word` have no accent (omitted here).
type CaptionStyle = NonNullable<Project['captions']>['style']
type AccentField = 'accentColor' | 'highlightColor' | 'activeColor' | 'backgroundColor'
const ACCENT: Partial<Record<CaptionStyle, { field: AccentField; label: string; def: string }>> = {
  karaoke:         { field: 'highlightColor',  label: 'Highlight', def: '#ffffff' },
  pop:             { field: 'activeColor',     label: 'Active',    def: '#ffe600' },
  'highlight-box': { field: 'accentColor',     label: 'Accent',    def: '#fbbf24' },
  outline:         { field: 'accentColor',     label: 'Accent',    def: '#fbbf24' },
  subtitle:        { field: 'backgroundColor', label: 'Box',       def: '#000000' },
}

// The native <input type="color"> only accepts #rrggbb. Stored values are always
// hex once picked; fall back to the style default for unset / non-hex (e.g. an
// rgba() template default) so the swatch never gets an invalid value.
const HEX = /^#[0-9a-f]{6}$/i
const toHex = (v: unknown, fallback: string): string =>
  typeof v === 'string' && HEX.test(v) ? v : fallback

interface TranscriptPanelProps {
  project: Project
  captionTrack: Project['captions'] | undefined
  currentTime: number
  onCaptionEdit?: (project: Project) => void
  onProjectChange?: (project: Project) => void
  onExpand: () => void
  /** Opens the caption-regeneration modal. Provided only when the host adapter
   *  supports `generateCaptions`; absent → the "Regenerate" button is hidden. */
  onRegenerateCaptions?: () => void
  /** Selected caption segment id (shared with the preview's selection box —
   *  see CaptionPreview/CaptionTrackRow). When set and it resolves to a real
   *  segment, the base color swatch below targets that segment's `color`
   *  instead of the track-level `color`. */
  selectedCaptionId?: string | null
  /** Commit a single-segment patch — the same channel CaptionTrackRow's
   *  edge-drag and text edits use (see makeCaptionEdit.ts). Used here as the
   *  per-segment color swatch's commit path. */
  onCaptionSegmentChange?: (segmentId: string, patch: CaptionEditPatch) => void
}

export default function TranscriptPanel({ project, captionTrack, currentTime, onCaptionEdit, onProjectChange, onExpand, onRegenerateCaptions, selectedCaptionId, onCaptionSegmentChange }: TranscriptPanelProps) {
  const segs = captionTrack?.segments ?? []
  const [confirmRemove, setConfirmRemove] = useState(false)
  const removeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Live slider value during a drag — only committed (persisted) on
  // pointer-up/key-up so mid-drag ticks don't each trigger a server PUT.
  const [fontsize, setFontsize] = useState(captionTrack?.fontsize ?? 46)

  useEffect(() => {
    setFontsize(captionTrack?.fontsize ?? 46)
  }, [captionTrack?.fontsize])

  useEffect(() => {
    return () => {
      if (removeTimeoutRef.current) clearTimeout(removeTimeoutRef.current)
    }
  }, [])
  // Find active segment index
  const activeIdx = segs.findIndex(s => currentTime >= s.start && currentTime < s.end)
  const nearIdx   = activeIdx !== -1 ? activeIdx
    : segs.reduce((best, s, i) => s.start <= currentTime ? i : best, -1)
  // Vicinity: active ± 2 segments; track start offset for O(1) global index
  const vicinityStart = nearIdx !== -1 ? Math.max(0, nearIdx - 2) : 0
  const vicinitySegs = nearIdx !== -1
    ? segs.slice(vicinityStart, nearIdx + 3)
    : segs.slice(0, 3)

  return (
    <div className="rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-3 py-2.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-gray-500 uppercase tracking-wider">Captions</span>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {captionTrack && (['word-by-word', 'pop', 'karaoke', 'subtitle', 'highlight-box', 'outline', 'clean'] as const).map(style => {
            const active = captionTrack.style === style
            return (
              <button
                key={style}
                className={`text-[10px] rounded px-2 py-0.5 transition-all border ${
                  active
                    ? 'bg-purple-600/30 border-purple-500/60 text-purple-300'
                    : 'bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500'
                }`}
                onClick={() => {
                  if (!project.captions) return
                  const updated = { ...project, captions: { ...project.captions, style } }
                  onCaptionEdit?.(updated)
                }}
              >
                {style}
              </button>
            )
          })}
          {captionTrack && (
            <div className="flex items-center gap-1">
              <input
                type="range"
                min={28}
                max={120}
                step={2}
                value={fontsize}
                className="w-20 sm:w-24 accent-purple-500"
                onChange={e => {
                  if (!project.captions) return
                  const v = Number(e.target.value)
                  setFontsize(v)
                  // Live preview only — cheap local-state update, no save.
                  onProjectChange?.({ ...project, captions: { ...project.captions, fontsize: v } })
                }}
                onPointerUp={e => {
                  if (!project.captions) return
                  const v = Number((e.target as HTMLInputElement).value)
                  onCaptionEdit?.({ ...project, captions: { ...project.captions, fontsize: v } })
                }}
                onKeyUp={e => {
                  if (!project.captions) return
                  const v = Number((e.target as HTMLInputElement).value)
                  onCaptionEdit?.({ ...project, captions: { ...project.captions, fontsize: v } })
                }}
              />
              <span className="text-[10px] text-gray-500 dark:text-gray-400 font-mono w-9 text-right">
                {fontsize}px
              </span>
            </div>
          )}
          {captionTrack && (() => {
            const accent = ACCENT[captionTrack.style]
            // onChange = live preview only (cheap, no PUT); onBlur commits one save.
            const live = (patch: Record<string, string>) => {
              if (!project.captions) return
              onProjectChange?.({ ...project, captions: { ...project.captions, ...patch } })
            }
            const commit = (patch: Record<string, string>) => {
              if (!project.captions) return
              onCaptionEdit?.({ ...project, captions: { ...project.captions, ...patch } })
            }

            // Per-segment color: when a real segment is selected, the base
            // swatch below targets ITS color instead of the track's. Live
            // preview still flows through `onProjectChange` — a locally
            // patched project, exactly the channel every other control on
            // this panel already uses for live preview — but the commit
            // goes through `onCaptionSegmentChange`, the single-segment
            // patch channel (see makeCaptionEdit.ts), instead of rewriting
            // the whole captions object through `onCaptionEdit`. Each is
            // fired from exactly one of SwatchInput's onChange/onCommit, so
            // (as with the track-level swatch above) one gesture produces
            // exactly one commit — never both channels for the same value.
            const selectedSeg = selectedCaptionId
              ? segs.find(s => s.id === selectedCaptionId)
              : undefined
            const liveSegColor = (v: string) => {
              if (!project.captions || !selectedSeg) return
              onProjectChange?.({
                ...project,
                captions: {
                  ...project.captions,
                  segments: project.captions.segments.map(s =>
                    s.id === selectedSeg.id ? { ...s, color: v } : s,
                  ),
                },
              })
            }
            const commitSegColor = (v: string) => {
              if (!selectedSeg) return
              onCaptionSegmentChange?.(selectedSeg.id!, { color: v })
            }

            return (
              <div className="flex items-center gap-1.5">
                <SwatchInput
                  size="sm"
                  showValue={false}
                  title={selectedSeg ? 'Selected segment text color' : 'Caption text color'}
                  ariaLabel={selectedSeg ? 'Selected segment text color' : 'Caption text color'}
                  value={toHex(selectedSeg ? (selectedSeg.color ?? captionTrack.color) : captionTrack.color, '#ffffff')}
                  onChange={v => selectedSeg ? liveSegColor(v) : live({ color: v })}
                  onCommit={v => selectedSeg ? commitSegColor(v) : commit({ color: v })}
                />
                {accent && (
                  <SwatchInput
                    size="sm"
                    showValue={false}
                    title={`Caption ${accent.label.toLowerCase()} color`}
                    ariaLabel={`Caption ${accent.label.toLowerCase()} color`}
                    value={toHex(captionTrack[accent.field], accent.def)}
                    onChange={v => live({ [accent.field]: v })}
                    onCommit={v => commit({ [accent.field]: v })}
                  />
                )}
              </div>
            )
          })()}
          {onRegenerateCaptions && (
            <button
              className="text-[10px] text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white border border-gray-300 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded px-2 py-0.5 transition-all"
              onClick={() => onRegenerateCaptions?.()}
            >
              Regenerate
            </button>
          )}
          {captionTrack && (
            <button
              className={`text-[10px] rounded px-2 py-0.5 transition-all border ${
                confirmRemove
                  ? 'bg-red-500/20 border-red-500/60 text-red-400'
                  : 'bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500'
              }`}
              onClick={() => {
                if (!confirmRemove) {
                  setConfirmRemove(true)
                  if (removeTimeoutRef.current) clearTimeout(removeTimeoutRef.current)
                  removeTimeoutRef.current = setTimeout(() => setConfirmRemove(false), 3000)
                  return
                }
                if (removeTimeoutRef.current) clearTimeout(removeTimeoutRef.current)
                setConfirmRemove(false)
                // Persistence needs an explicit `null` to clear the field server-side
                // (a live PUT test confirmed `undefined` is dropped from the JSON body).
                onCaptionEdit?.({ ...project, captions: null as unknown as undefined })
              }}
            >
              {confirmRemove ? 'Really remove?' : 'Remove'}
            </button>
          )}
          {segs.length > 0 && (
            <button
              className="text-[10px] text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white border border-gray-300 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded px-2 py-0.5 transition-all"
              onClick={onExpand}
            >
              Expand ↑
            </button>
          )}
        </div>
      </div>

      <div className="h-10 overflow-y-auto">
      {segs.length === 0 ? (
        <p className="text-xs text-gray-600 italic">No transcript — captions are generated during the agent pass</p>
      ) : (
        <p className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed">
          {vicinitySegs.map((seg, vi) => {
            const i = vicinityStart + vi
            const isActive = currentTime >= seg.start && currentTime < seg.end
            return (
              <span key={seg.id ?? i}>
                {vi > 0 && ' '}
                <span className="text-gray-500 text-[10px] font-mono mr-1">{formatTime(seg.start)}</span>
                <span className={isActive ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}>
                  {/* Commit-only: `onProjectChange` is this component's LIVE-preview
                      channel (see the fontsize/color controls above) — but a text
                      edit fires once, on blur, and is already a complete, discrete
                      change, not a continuous gesture. Passing both callbacks here
                      would double-fire `sync.mutate` for one edit (two undo entries,
                      two queued saves); `onCaptionEdit` is the single commit path. */}
                  <EditableSegment seg={seg} onEdit={makeCaptionEdit(i, project, undefined, onCaptionEdit)} />
                </span>
              </span>
            )
          })}
        </p>
      )}
      </div>
    </div>
  )
}
