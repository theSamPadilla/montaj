import { useEffect } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { basename } from '@/lib/utils'
import type { VisualItem } from '@/lib/types/schema'

export interface VideoPreviewModalProps {
  source: VisualItem
  fileUrl: (path: string) => string
  onClose: () => void
  /** Remove this source from the project. Mirrors the footage card's own
   *  Remove button, which calls this directly with no confirmation. */
  onRemove: (sourceId: string) => void
}

/**
 * Fullscreen-ish preview opened by double-clicking a footage card. Plays the
 * ORIGINAL source file when available, falling back to the editing proxy —
 * never the other way around, since the original is what actually ships.
 */
export default function VideoPreviewModal({ source, fileUrl, onClose, onRemove }: VideoPreviewModalProps) {
  const path = source.src ?? source.proxySrc
  const videoSrc = path ? fileUrl(path) : undefined
  const name = source.src ? basename(source.src) : 'Untitled'

  // Close on Escape — matches ProxyMigrationModal / RerunModal / MobileRenderModal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleDelete() {
    // The card's own Remove (×) button calls `onRemove` directly with no
    // `window.confirm` — mirror that here rather than inventing a new
    // confirmation step for the same action.
    onRemove(source.id)
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-5xl max-h-[90vh] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-sm font-medium text-gray-900 dark:text-white truncate" title={name}>{name}</h2>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="danger" size="sm" onClick={handleDelete}>Delete</Button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors p-1"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 flex items-center justify-center bg-black p-2">
          {videoSrc ? (
            <video
              key={videoSrc}
              src={videoSrc}
              controls
              autoPlay
              playsInline
              className="max-w-full max-h-[80vh] object-contain"
            />
          ) : (
            <p className="text-sm text-gray-400 py-12">No video source available.</p>
          )}
        </div>
      </div>
    </div>
  )
}
