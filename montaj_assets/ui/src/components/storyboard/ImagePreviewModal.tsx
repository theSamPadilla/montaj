import { useEffect } from 'react'
import { fileUrl } from '@/lib/api'

interface Props {
  src: string
  alt: string
  onClose: () => void
}

export function ImagePreviewModal({ src, alt, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center">
        <button
          onClick={onClose}
          className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-gray-800 border border-gray-600 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors flex items-center justify-center text-lg leading-none z-10"
        >
          &times;
        </button>
        <img
          src={fileUrl(src)}
          alt={alt}
          className="max-w-[90vw] max-h-[85vh] rounded-lg object-contain"
        />
        {alt && (
          <p className="mt-3 text-sm text-gray-400 text-center max-w-lg truncate">{alt}</p>
        )}
      </div>
    </div>
  )
}
