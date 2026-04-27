import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { Project } from '@/lib/types/schema'
import { formatTime } from './utils'
import { EditableSegment } from './EditableSegment'
import { makeCaptionEdit } from './makeCaptionEdit'

interface TranscriptModalProps {
  captionTrack: Project['captions'] | undefined
  currentTime: number
  project: Project
  onProjectChange?: (project: Project) => void
  onCaptionEdit?: (project: Project) => void
  onClose: () => void
}

export default function TranscriptModal({ captionTrack, currentTime, project, onProjectChange, onCaptionEdit, onClose }: TranscriptModalProps) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-xl max-h-[70vh] flex flex-col bg-gray-950 border border-gray-800 rounded-lg shadow-2xl mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 shrink-0">
          <span className="text-sm font-medium text-gray-200">Transcript</span>
          <button
            className="text-gray-500 hover:text-white transition-colors text-lg leading-none"
            onClick={onClose}
          >×</button>
        </div>

        {/* Segment list */}
        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-1.5">
          {(captionTrack?.segments ?? []).map((seg, i) => {
            const isActive = currentTime >= seg.start && currentTime < seg.end
            return (
              <div
                key={seg.id ?? i}
                className={`flex gap-3 items-baseline px-2 py-1 rounded transition-colors ${isActive ? 'bg-white/5' : ''}`}
              >
                <span className="text-gray-600 text-[10px] font-mono shrink-0 w-12 pt-px">{formatTime(seg.start)}</span>
                <span className={`text-sm leading-snug ${isActive ? 'text-white' : 'text-gray-300'}`}>
                  <EditableSegment seg={seg} onEdit={makeCaptionEdit(i, project, onProjectChange, onCaptionEdit)} />
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body
  )
}
