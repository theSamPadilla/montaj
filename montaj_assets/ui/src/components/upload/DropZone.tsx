import { useState } from 'react'
import { X, FolderOpen, Film, Image, Music, FileText } from 'lucide-react'
import { basename } from '@/lib/utils'

export interface DropZoneProps {
  label: string
  sublabel: string
  icon: React.ReactNode
  accept: string
  files: string[]
  uploading: boolean
  onBrowse: () => void
  onDrop: (files: File[]) => void
  onRemove: (path: string) => void
  browseLabel: string
  accentClass: string
  dropLabel?: string
  fileIcon?: React.ReactNode
  single?: boolean
  headerAction?: React.ReactNode
  /** Render added files as a grid of visual thumbnails (image/video preview
   *  frames) instead of a plain filename list. */
  thumbnails?: boolean
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i
const VIDEO_RE = /\.(mp4|mov|avi|mkv|webm|m4v|mts|mpe?g)$/i

/** One added file as a square thumbnail tile: an image preview, a video's first
 *  frame, or a type icon, with the name over a gradient and a hover remove. */
function FileThumb({ path, accept, fileIcon, onRemove }: {
  path: string
  accept: string
  fileIcon?: React.ReactNode
  onRemove: () => void
}) {
  const url = `/api/files?path=${encodeURIComponent(path)}`
  const isImage = accept === 'image/' || IMAGE_RE.test(path)
  const isVideo = accept === 'video/' || VIDEO_RE.test(path)
  return (
    <div className="group relative aspect-square overflow-hidden rounded-md border border-gray-200 bg-gray-100 dark:border-gray-800 dark:bg-gray-800">
      {isImage ? (
        <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : isVideo ? (
        <video src={`${url}#t=0.1`} muted preload="metadata" playsInline className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-gray-400 dark:text-gray-500">
          {fileIcon ?? <FileText size={20} />}
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-1.5 pb-1 pt-3">
        <span className="block truncate font-mono text-[10px] text-white/90">{basename(path)}</span>
      </div>
      <button
        onClick={onRemove}
        title="Remove"
        className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white/80 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
      >
        <X size={11} />
      </button>
    </div>
  )
}

export function DropZone({ label, sublabel, icon, accept, files, uploading, onBrowse, onDrop, onRemove, browseLabel, accentClass, dropLabel, fileIcon, single, headerAction, thumbnails }: DropZoneProps) {
  const [dragOver, setDragOver] = useState(false)

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const dropped = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith(accept))
    if (dropped.length) onDrop(single ? dropped.slice(0, 1) : dropped)
  }

  const defaultDropLabel =
    accept === 'video/' ? 'Drop video files here' :
    accept === 'audio/' ? 'Drop audio file here' :
    accept === 'text/'  ? 'Drop lyrics file here' :
                          'Drop files here'

  const defaultFileIcon =
    accept === 'video/' ? <Film size={12} /> :
    accept === 'audio/' ? <Music size={12} /> :
    accept === 'text/'  ? <FileText size={12} /> :
                          <Image size={12} />

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{label}</p>
          <p className="text-xs text-gray-500 mt-0.5">{sublabel}</p>
        </div>
        {headerAction && <div className="shrink-0 pt-1">{headerAction}</div>}
      </div>

      {/* Drop zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`relative rounded-lg border-2 border-dashed transition-colors ${
          dragOver
            ? `${accentClass} border-opacity-100`
            : 'border-gray-300 hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-600'
        }`}
      >
        <div className="flex flex-col items-center justify-center gap-3 py-10 px-4 text-center">
          <div className={`${dragOver ? 'text-white' : 'text-gray-400 dark:text-gray-600'} transition-colors`}>
            {icon}
          </div>
          <p className={`text-sm transition-colors ${dragOver ? 'text-white' : 'text-gray-500 dark:text-gray-500'}`}>
            {dragOver ? 'Drop to add' : (dropLabel ?? defaultDropLabel)}
          </p>
          <div className="flex items-center gap-2 mt-1">
            <div className="h-px w-8 bg-gray-200 dark:bg-gray-800" />
            <span className="text-xs text-gray-400 dark:text-gray-700">or</span>
            <div className="h-px w-8 bg-gray-200 dark:bg-gray-800" />
          </div>
          <button
            onClick={onBrowse}
            disabled={uploading}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-sm text-gray-700 hover:text-gray-900 dark:text-gray-200 dark:hover:text-white transition-colors disabled:opacity-50 border border-gray-300 dark:border-gray-700"
          >
            <FolderOpen size={14} />
            {uploading ? 'Opening\u2026' : browseLabel}
          </button>
        </div>
      </div>

      {/* Added files — thumbnail grid or a plain filename list */}
      {files.length > 0 && (
        thumbnails ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {files.map(path => (
              <FileThumb key={path} path={path} accept={accept} fileIcon={fileIcon} onRemove={() => onRemove(path)} />
            ))}
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {files.map(path => (
              <li
                key={path}
                className="flex items-center gap-2 px-3 py-2 rounded-md border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-900/20 group"
              >
                <span className="text-green-500 dark:text-green-500 shrink-0">
                  {fileIcon ?? defaultFileIcon}
                </span>
                <span className="flex-1 text-xs text-green-800 dark:text-green-300 truncate font-mono">
                  {basename(path)}
                </span>
                <button
                  onClick={() => onRemove(path)}
                  className="shrink-0 text-green-500/60 hover:text-green-700 dark:text-green-700 dark:hover:text-green-400 transition-colors opacity-0 group-hover:opacity-100"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  )
}
