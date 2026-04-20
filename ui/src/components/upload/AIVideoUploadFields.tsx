import { useState } from 'react'
import { X, FolderOpen, Plus } from 'lucide-react'
import { api } from '@/lib/api'
import { basename } from '@/lib/utils'

// --- Types ---

export interface ImageRefDraft {
  id: string
  label: string
  mode: 'upload' | 'describe'
  path?: string
  text?: string
}

export interface StyleRefDraft {
  id: string
  label: string
  path: string
}

export interface AIVideoUploadData {
  imageRefs: ImageRefDraft[]
  styleRefs: StyleRefDraft[]
}

// --- File picker slot (drag-and-drop + browse) ---

function FilePickerSlot({ path, onPick, onDrop: onDropFile, accept, browseLabel, accentClass }: {
  path?: string
  onPick: () => void
  onDrop: (file: File) => void
  accept?: string
  browseLabel: string
  accentClass: string
}) {
  const [dragOver, setDragOver] = useState(false)

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = Array.from(e.dataTransfer.files).find(f => !accept || f.type.startsWith(accept))
    if (file) onDropFile(file)
  }

  if (path) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-700 dark:text-gray-300 truncate font-mono flex-1">{basename(path)}</span>
        <button onClick={onPick} className="text-xs text-blue-500 hover:text-blue-600">Replace</button>
      </div>
    )
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`rounded-md border border-dashed px-3 py-2 transition-colors ${
        dragOver ? `${accentClass}` : 'border-gray-300 dark:border-gray-700'
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          onClick={onPick}
          className="text-xs text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 flex items-center gap-1"
        >
          <FolderOpen size={12} />
          {browseLabel}
        </button>
        <span className="text-xs text-gray-400 dark:text-gray-600">or drop file</span>
      </div>
    </div>
  )
}

// --- Image reference entry ---

function ImageRefEntry({ imgRef, index, onChange, onRemove, onBrowse, onDropFile }: {
  imgRef: ImageRefDraft
  index: number
  onChange: (index: number, ref: ImageRefDraft) => void
  onRemove: (index: number) => void
  onBrowse: (index: number) => void
  onDropFile: (index: number, file: File) => void
}) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={imgRef.label}
          onChange={e => onChange(index, { ...imgRef, label: e.target.value })}
          placeholder="Label (e.g. Max)"
          className="flex-1 h-7 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          onClick={() => onRemove(index)}
          className="text-gray-400 hover:text-gray-600 dark:text-gray-600 dark:hover:text-gray-400"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
          <input
            type="radio"
            name={`imageref-mode-${index}`}
            checked={imgRef.mode === 'upload'}
            onChange={() => onChange(index, { ...imgRef, mode: 'upload', text: undefined })}
            className="accent-blue-500"
          />
          Upload image
        </label>
        <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
          <input
            type="radio"
            name={`imageref-mode-${index}`}
            checked={imgRef.mode === 'describe'}
            onChange={() => onChange(index, { ...imgRef, mode: 'describe', path: undefined })}
            className="accent-blue-500"
          />
          Describe
        </label>
      </div>

      {imgRef.mode === 'upload' ? (
        <FilePickerSlot
          path={imgRef.path}
          onPick={() => onBrowse(index)}
          onDrop={file => onDropFile(index, file)}
          accept="image/"
          browseLabel="Choose image..."
          accentClass="border-blue-500 bg-blue-500/10"
        />
      ) : (
        <textarea
          value={imgRef.text ?? ''}
          onChange={e => onChange(index, { ...imgRef, text: e.target.value })}
          placeholder="Describe this character, object, or place..."
          rows={2}
          className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
        />
      )}
    </div>
  )
}

// --- Style reference entry ---

function StyleRefEntry({ styleRef, index, onChange, onRemove, onBrowse, onDropFile }: {
  styleRef: StyleRefDraft
  index: number
  onChange: (index: number, ref: StyleRefDraft) => void
  onRemove: (index: number) => void
  onBrowse: (index: number) => void
  onDropFile: (index: number, file: File) => void
}) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={styleRef.label}
          onChange={e => onChange(index, { ...styleRef, label: e.target.value })}
          placeholder="Label (e.g. mood)"
          className="flex-1 h-7 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          onClick={() => onRemove(index)}
          className="text-gray-400 hover:text-gray-600 dark:text-gray-600 dark:hover:text-gray-400"
        >
          <X size={14} />
        </button>
      </div>

      <FilePickerSlot
        path={styleRef.path}
        onPick={() => onBrowse(index)}
        onDrop={file => onDropFile(index, file)}
        browseLabel="Choose file..."
        accentClass="border-purple-500 bg-purple-500/10"
      />
    </div>
  )
}

// --- Main component ---

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff']

export function AIVideoUploadFields({ data, onChange, onError }: {
  data: AIVideoUploadData
  onChange: (data: AIVideoUploadData) => void
  onError: (msg: string | null) => void
}) {
  const { imageRefs, styleRefs } = data

  function updateImageRef(index: number, ref: ImageRefDraft) {
    onChange({ ...data, imageRefs: imageRefs.map((r, i) => i === index ? ref : r) })
  }

  function addImageRef() {
    onChange({ ...data, imageRefs: [...imageRefs, { id: crypto.randomUUID(), label: '', mode: 'describe' }] })
  }

  function removeImageRef(index: number) {
    onChange({ ...data, imageRefs: imageRefs.filter((_, i) => i !== index) })
  }

  async function browseImageRef(index: number) {
    onError(null)
    try {
      const { paths } = await api.pickFiles({ extensions: IMAGE_EXTENSIONS, prompt: 'Select image' })
      if (paths.length) {
        onChange({ ...data, imageRefs: imageRefs.map((r, i) => i === index ? { ...r, path: paths[0] } : r) })
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) onError(msg)
    }
  }

  async function dropImageRef(index: number, file: File) {
    onError(null)
    try {
      const path = await api.uploadFile(file)
      onChange({ ...data, imageRefs: imageRefs.map((r, i) => i === index ? { ...r, path } : r) })
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  function updateStyleRef(index: number, ref: StyleRefDraft) {
    onChange({ ...data, styleRefs: styleRefs.map((r, i) => i === index ? ref : r) })
  }

  function addStyleRef() {
    if (styleRefs.length >= 2) return
    onChange({ ...data, styleRefs: [...styleRefs, { id: crypto.randomUUID(), label: '', path: '' }] })
  }

  function removeStyleRef(index: number) {
    onChange({ ...data, styleRefs: styleRefs.filter((_, i) => i !== index) })
  }

  async function browseStyleRef(index: number) {
    onError(null)
    try {
      const { paths } = await api.pickFiles({ prompt: 'Select style reference (audio, video, or image)' })
      if (paths.length) {
        onChange({ ...data, styleRefs: styleRefs.map((r, i) => i === index ? { ...r, path: paths[0] } : r) })
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) onError(msg)
    }
  }

  async function dropStyleRef(index: number, file: File) {
    onError(null)
    try {
      const path = await api.uploadFile(file)
      onChange({ ...data, styleRefs: styleRefs.map((r, i) => i === index ? { ...r, path } : r) })
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      {/* Image references */}
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Image references</p>
          <p className="text-xs text-gray-500 mt-0.5">
            People, places, or objects that should appear in the video. Upload an image or describe in text — the agent generates images for text-only refs. Use labels to reference them in the prompt.
          </p>
        </div>

        {imageRefs.map((imgRef, i) => (
          <ImageRefEntry
            key={imgRef.id}
            imgRef={imgRef}
            index={i}
            onChange={updateImageRef}
            onRemove={removeImageRef}
            onBrowse={browseImageRef}
            onDropFile={dropImageRef}
          />
        ))}

        {imageRefs.length > 6 && (
          <p className="text-xs text-amber-500">Lots of references — the agent may take longer to process all of them.</p>
        )}

        <button
          onClick={addImageRef}
          className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 w-fit"
        >
          <Plus size={12} />
          Add image reference
        </button>
      </div>

      {/* Style references */}
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Style references</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Audio, video, or images that capture the mood/aesthetic. The agent analyzes these; they don't appear in the final video. Short clips work best — under ~60 seconds.
          </p>
        </div>

        {styleRefs.map((sRef, i) => (
          <StyleRefEntry
            key={sRef.id}
            styleRef={sRef}
            index={i}
            onChange={updateStyleRef}
            onRemove={removeStyleRef}
            onBrowse={browseStyleRef}
            onDropFile={dropStyleRef}
          />
        ))}

        <button
          onClick={addStyleRef}
          disabled={styleRefs.length >= 2}
          className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 w-fit disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus size={12} />
          Add style reference{styleRefs.length >= 2 ? ' (max 2)' : ''}
        </button>
      </div>
    </>
  )
}
