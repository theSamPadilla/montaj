import type { Project } from '@/lib/types/schema'
import { formatTime } from './utils'
import { EditableSegment } from './EditableSegment'
import { makeCaptionEdit } from './makeCaptionEdit'

interface TranscriptPanelProps {
  project: Project
  captionTrack: Project['captions'] | undefined
  currentTime: number
  onCaptionEdit?: (project: Project) => void
  onProjectChange?: (project: Project) => void
  onExpand: () => void
}

export default function TranscriptPanel({ project, captionTrack, currentTime, onCaptionEdit, onProjectChange, onExpand }: TranscriptPanelProps) {
  const segs = captionTrack?.segments ?? []
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
        <div className="flex items-center gap-2">
          {captionTrack && (['word-by-word', 'pop', 'karaoke', 'subtitle'] as const).map(style => {
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
                  <EditableSegment seg={seg} onEdit={makeCaptionEdit(i, project, onProjectChange, onCaptionEdit)} />
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
