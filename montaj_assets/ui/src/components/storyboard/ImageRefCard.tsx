import { useState } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import { fileUrl } from '@/lib/api'
import type { ImageRef } from '@/lib/types/schema'
import { ImagePreviewModal } from './ImagePreviewModal'

interface Props {
  imageRef: ImageRef
  onRegenerate: () => void
  onDelete?: () => void
}

export function ImageRefCard({ imageRef, onRegenerate, onDelete }: Props) {
  const thumbnail = imageRef.refImages?.[0]
  const [preview, setPreview] = useState(false)

  return (
    <article className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 flex gap-3 items-start">
      <div
        className={`w-16 h-16 rounded-md border border-gray-700 overflow-hidden flex-shrink-0 flex items-center justify-center bg-gray-800${thumbnail ? ' cursor-pointer hover:border-gray-500 transition-colors' : ''}`}
        onClick={() => thumbnail && setPreview(true)}
      >
        {thumbnail ? (
          <img src={fileUrl(thumbnail)} alt={imageRef.label} className="w-full h-full object-cover" />
        ) : imageRef.status === 'generating' ? (
          <span className="text-[10px] text-gray-500 text-center px-1">Generating…</span>
        ) : (
          <span className="text-[10px] text-gray-500 text-center px-1">No image yet</span>
        )}
      </div>
      {preview && thumbnail && (
        <ImagePreviewModal src={thumbnail} alt={imageRef.anchor || imageRef.label} onClose={() => setPreview(false)} />
      )}
      <div className="flex flex-col gap-1 flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-gray-300 truncate">{imageRef.label}</h3>
          {imageRef.source === 'upload' && (
            <span className="text-[10px] text-gray-500 border border-gray-700 rounded px-1">your upload</span>
          )}
        </div>
        {imageRef.anchor && <p className="text-xs text-gray-500 line-clamp-2">{imageRef.anchor}</p>}
        <div className="mt-1 flex items-center gap-3">
          <button
            type="button"
            onClick={onRegenerate}
            className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            Regenerate
          </button>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="p-1 rounded text-red-400/40 hover:text-red-400 hover:bg-red-900/20 transition-colors"
              title="Remove image reference"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </article>
  )
}
