import { useState } from 'react'
import { X, ImageIcon, Type, Film } from 'lucide-react'
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

// --- Generic multi-file drop zone ---

function MultiFileDropZone({ onBrowse, onDropFiles, uploading, icon, browseLabel, dropLabel, accentClass }: {
  onBrowse: () => void
  onDropFiles: (files: File[]) => void
  uploading: boolean
  icon: React.ReactNode
  browseLabel: string
  dropLabel: string
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
    const files = Array.from(e.dataTransfer.files)
    if (files.length) onDropFiles(files)
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`rounded-lg border-2 border-dashed px-4 py-5 transition-colors text-center ${
        dragOver
          ? accentClass
          : 'border-gray-300 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-600'
      } ${uploading ? 'opacity-60 pointer-events-none' : ''}`}
    >
      <div className="flex flex-col items-center gap-2">
        {icon}
        <div className="flex items-center gap-2">
          <button
            onClick={onBrowse}
            className="text-sm text-blue-500 hover:text-blue-600 font-medium"
          >
            {browseLabel}
          </button>
          <span className="text-xs text-gray-400 dark:text-gray-500">{dropLabel}</span>
        </div>
        {uploading && (
          <p className="text-xs text-blue-500 animate-pulse">Uploading…</p>
        )}
      </div>
    </div>
  )
}

// --- Uploaded file ref card (compact with thumbnail) ---

function UploadedRefCard({ path, label, onLabelChange, onRemove, onReplace, labelPlaceholder, showThumb }: {
  path?: string
  label: string
  onLabelChange: (label: string) => void
  onRemove: () => void
  onReplace: () => void
  labelPlaceholder: string
  showThumb: boolean
}) {
  const thumbUrl = path ? `/api/files?path=${encodeURIComponent(path)}` : undefined
  const isMedia = path && /\.(mp4|mov|avi|webm|mkv|mp3|wav|aac|flac|ogg)$/i.test(path)

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-2 flex items-center gap-3">
      {showThumb && thumbUrl && !isMedia ? (
        <div
          className="w-20 h-20 rounded-md bg-gray-100 dark:bg-gray-800 flex-shrink-0 overflow-hidden cursor-pointer"
          onClick={onReplace}
          title="Click to replace"
        >
          <img src={thumbUrl} alt="" className="w-full h-full object-cover" />
        </div>
      ) : (
        <div
          className="w-20 h-20 rounded-md bg-gray-100 dark:bg-gray-800 flex-shrink-0 flex items-center justify-center cursor-pointer"
          onClick={onReplace}
          title="Click to replace"
        >
          {isMedia ? <Film size={16} className="text-gray-400" /> : <ImageIcon size={16} className="text-gray-400" />}
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <input
          type="text"
          value={label}
          onChange={e => onLabelChange(e.target.value)}
          placeholder={labelPlaceholder}
          className="h-7 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <span className="text-[10px] text-gray-400 dark:text-gray-600 truncate font-mono">{path ? basename(path) : ''}</span>
      </div>
      <button
        onClick={onRemove}
        className="text-gray-400 hover:text-gray-600 dark:text-gray-600 dark:hover:text-gray-400 flex-shrink-0"
      >
        <X size={14} />
      </button>
    </div>
  )
}

// --- Text-describe ref card ---

function DescribeRefCard({ imgRef, onLabelChange, onTextChange, onRemove }: {
  imgRef: ImageRefDraft
  onLabelChange: (label: string) => void
  onTextChange: (text: string) => void
  onRemove: () => void
}) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={imgRef.label}
          onChange={e => onLabelChange(e.target.value)}
          placeholder="Label (e.g. Max)"
          className="flex-1 h-7 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          onClick={onRemove}
          className="text-gray-400 hover:text-gray-600 dark:text-gray-600 dark:hover:text-gray-400"
        >
          <X size={14} />
        </button>
      </div>
      <textarea
        value={imgRef.text ?? ''}
        onChange={e => onTextChange(e.target.value)}
        placeholder="Describe this character, object, or place..."
        rows={2}
        className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
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
  const [uploadingImages, setUploadingImages] = useState(false)
  const [uploadingStyles, setUploadingStyles] = useState(false)

  // --- Image refs ---

  function updateImageRef(index: number, partial: Partial<ImageRefDraft>) {
    onChange({ ...data, imageRefs: imageRefs.map((r, i) => i === index ? { ...r, ...partial } : r) })
  }

  function removeImageRef(index: number) {
    onChange({ ...data, imageRefs: imageRefs.filter((_, i) => i !== index) })
  }

  function addDescribeRef() {
    onChange({ ...data, imageRefs: [...imageRefs, { id: crypto.randomUUID(), label: '', mode: 'describe' }] })
  }

  async function browseMultipleImages() {
    onError(null)
    try {
      const { paths } = await api.pickFiles({ extensions: IMAGE_EXTENSIONS, prompt: 'Select images' })
      if (paths.length) {
        const newRefs: ImageRefDraft[] = paths.map(p => ({
          id: crypto.randomUUID(),
          label: '',
          mode: 'upload' as const,
          path: p,
        }))
        onChange({ ...data, imageRefs: [...imageRefs, ...newRefs] })
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) onError(msg)
    }
  }

  async function dropMultipleImages(files: File[]) {
    onError(null)
    const imageFiles = files.filter(f => f.type.startsWith('image/'))
    if (!imageFiles.length) return
    setUploadingImages(true)
    try {
      const paths = await Promise.all(imageFiles.map(f => api.uploadFile(f)))
      const newRefs: ImageRefDraft[] = paths.map(p => ({
        id: crypto.randomUUID(),
        label: '',
        mode: 'upload' as const,
        path: p,
      }))
      onChange({ ...data, imageRefs: [...imageRefs, ...newRefs] })
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadingImages(false)
    }
  }

  async function replaceImage(index: number) {
    onError(null)
    try {
      const { paths } = await api.pickFiles({ extensions: IMAGE_EXTENSIONS, prompt: 'Select replacement image' })
      if (paths.length) {
        onChange({ ...data, imageRefs: imageRefs.map((r, i) => i === index ? { ...r, path: paths[0] } : r) })
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) onError(msg)
    }
  }

  // --- Style refs ---

  function updateStyleRef(index: number, partial: Partial<StyleRefDraft>) {
    onChange({ ...data, styleRefs: styleRefs.map((r, i) => i === index ? { ...r, ...partial } : r) })
  }

  function removeStyleRef(index: number) {
    onChange({ ...data, styleRefs: styleRefs.filter((_, i) => i !== index) })
  }

  async function browseMultipleStyleRefs() {
    onError(null)
    try {
      const { paths } = await api.pickFiles({ prompt: 'Select style references (audio, video, or images)' })
      if (paths.length) {
        const newRefs: StyleRefDraft[] = paths.map(p => ({
          id: crypto.randomUUID(),
          label: '',
          path: p,
        }))
        onChange({ ...data, styleRefs: [...styleRefs, ...newRefs] })
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) onError(msg)
    }
  }

  async function dropMultipleStyleRefs(files: File[]) {
    onError(null)
    if (!files.length) return
    setUploadingStyles(true)
    try {
      const paths = await Promise.all(files.map(f => api.uploadFile(f)))
      const newRefs: StyleRefDraft[] = paths.map(p => ({
        id: crypto.randomUUID(),
        label: '',
        path: p,
      }))
      onChange({ ...data, styleRefs: [...styleRefs, ...newRefs] })
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadingStyles(false)
    }
  }

  async function replaceStyleRef(index: number) {
    onError(null)
    try {
      const { paths } = await api.pickFiles({ prompt: 'Select replacement file' })
      if (paths.length) {
        onChange({ ...data, styleRefs: styleRefs.map((r, i) => i === index ? { ...r, path: paths[0] } : r) })
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) onError(msg)
    }
  }

  const uploadRefs = imageRefs.filter(r => r.mode === 'upload')
  const describeRefs = imageRefs.filter(r => r.mode === 'describe')

  return (
    <div className="grid grid-cols-2 gap-6">
      {/* Image references — left column */}
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Image references</p>
          <p className="text-xs text-gray-500 mt-0.5">
            People, places, or objects that should appear in the video. Upload images or describe in text — the agent generates images for text-only refs. Use labels to reference them in the prompt.
          </p>
        </div>

        <MultiFileDropZone
          onBrowse={browseMultipleImages}
          onDropFiles={dropMultipleImages}
          uploading={uploadingImages}
          icon={<ImageIcon size={20} className="text-gray-400 dark:text-gray-500" />}
          browseLabel="Browse images"
          dropLabel="or drop images here"
          accentClass="border-blue-500 bg-blue-500/10"
        />

        {uploadRefs.length > 0 && (
          <div className="flex flex-col gap-2">
            {uploadRefs.map(imgRef => {
              const idx = imageRefs.indexOf(imgRef)
              return (
                <UploadedRefCard
                  key={imgRef.id}
                  path={imgRef.path}
                  label={imgRef.label}
                  onLabelChange={label => updateImageRef(idx, { label })}
                  onRemove={() => removeImageRef(idx)}
                  onReplace={() => replaceImage(idx)}
                  labelPlaceholder="Label (e.g. Max, the hero, city skyline)"
                  showThumb
                />
              )
            })}
          </div>
        )}

        {describeRefs.map(imgRef => {
          const idx = imageRefs.indexOf(imgRef)
          return (
            <DescribeRefCard
              key={imgRef.id}
              imgRef={imgRef}
              onLabelChange={label => updateImageRef(idx, { label })}
              onTextChange={text => updateImageRef(idx, { text })}
              onRemove={() => removeImageRef(idx)}
            />
          )
        })}

        {imageRefs.length > 6 && (
          <p className="text-xs text-amber-500">Lots of references — the agent may take longer to process all of them.</p>
        )}

        <button
          onClick={addDescribeRef}
          className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 w-fit"
        >
          <Type size={12} />
          Describe in text instead
        </button>
      </div>

      {/* Style references — right column */}
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Style references</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Audio, video, or images that capture the mood/aesthetic. The agent analyzes these; they don't appear in the final video. Short clips work best — under ~60 seconds.
          </p>
        </div>

        <MultiFileDropZone
          onBrowse={browseMultipleStyleRefs}
          onDropFiles={dropMultipleStyleRefs}
          uploading={uploadingStyles}
          icon={<Film size={20} className="text-gray-400 dark:text-gray-500" />}
          browseLabel="Browse files"
          dropLabel="or drop files here"
          accentClass="border-purple-500 bg-purple-500/10"
        />

        {styleRefs.length > 0 && (
          <div className="flex flex-col gap-2">
            {styleRefs.map((sRef, i) => (
              <UploadedRefCard
                key={sRef.id}
                path={sRef.path}
                label={sRef.label}
                onLabelChange={label => updateStyleRef(i, { label })}
                onRemove={() => removeStyleRef(i)}
                onReplace={() => replaceStyleRef(i)}
                labelPlaceholder="Label (e.g. mood, aesthetic)"
                showThumb
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
