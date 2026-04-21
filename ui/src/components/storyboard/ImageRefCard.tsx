import { RefreshCw } from 'lucide-react'
import { fileUrl } from '@/lib/api'
import type { ImageRef } from '@/lib/types/schema'

interface Props {
  imageRef: ImageRef
  onRegenerate: () => void
}

export function ImageRefCard({ imageRef, onRegenerate }: Props) {
  const thumbnail = imageRef.refImages?.[0]

  return (
    <article className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 flex gap-3 items-start">
      <div className="w-16 h-16 rounded-md border border-gray-700 overflow-hidden flex-shrink-0 flex items-center justify-center bg-gray-800">
        {thumbnail ? (
          <img src={fileUrl(thumbnail)} alt={imageRef.label} className="w-full h-full object-cover" />
        ) : imageRef.status === 'generating' ? (
          <span className="text-[10px] text-gray-500 text-center px-1">Generating…</span>
        ) : (
          <span className="text-[10px] text-gray-500 text-center px-1">No image yet</span>
        )}
      </div>
      <div className="flex flex-col gap-1 flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-gray-300 truncate">{imageRef.label}</h3>
          {imageRef.source === 'upload' && (
            <span className="text-[10px] text-gray-500 border border-gray-700 rounded px-1">your upload</span>
          )}
        </div>
        {imageRef.anchor && <p className="text-xs text-gray-500 line-clamp-2">{imageRef.anchor}</p>}
        <button
          type="button"
          onClick={onRegenerate}
          className="mt-1 inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors self-start"
        >
          <RefreshCw className="w-3 h-3" />
          Regenerate image
        </button>
      </div>
    </article>
  )
}
