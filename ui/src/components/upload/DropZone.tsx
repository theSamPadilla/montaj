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
}

export function DropZone({ label, sublabel, icon, accept, files, uploading, onBrowse, onDrop, onRemove, browseLabel, accentClass, dropLabel, fileIcon, single }: DropZoneProps) {
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
      <div>
        <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">{sublabel}</p>
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

      {/* File list */}
      {files.length > 0 && (
        <ul className="flex flex-col gap-1">
          {files.map(path => (
            <li
              key={path}
              className="flex items-center gap-2 px-3 py-2 rounded-md border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 group"
            >
              <span className="text-gray-400 dark:text-gray-600 shrink-0">
                {fileIcon ?? defaultFileIcon}
              </span>
              <span className="flex-1 text-xs text-gray-700 dark:text-gray-300 truncate font-mono">
                {basename(path)}
              </span>
              <button
                onClick={() => onRemove(path)}
                className="shrink-0 text-gray-400 hover:text-gray-600 dark:text-gray-700 dark:hover:text-gray-400 transition-colors opacity-0 group-hover:opacity-100"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
