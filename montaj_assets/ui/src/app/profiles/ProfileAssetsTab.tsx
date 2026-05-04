import { useCallback, useEffect, useRef, useState } from 'react'
import { File, FileAudio, FileVideo, Trash2, Upload } from 'lucide-react'
import {
  api,
  fileUrl,
  type ProfileAssetFile,
  type ProfileAssetsManifest,
  type ProfileAssetsDrift,
} from '@/lib/api'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function MimeIcon({ mime }: { mime: string }) {
  if (mime.startsWith('video/')) return <FileVideo size={18} className="text-gray-400 shrink-0" />
  if (mime.startsWith('audio/')) return <FileAudio size={18} className="text-gray-400 shrink-0" />
  return <File size={18} className="text-gray-400 shrink-0" />
}

// ---------------------------------------------------------------------------
// Notes textarea (debounced save)
// ---------------------------------------------------------------------------

function NotesSection({ profileName, initialNotes }: { profileName: string; initialNotes: string }) {
  const [notes, setNotes] = useState(initialNotes)
  const [saving, setSaving] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync if parent re-fetches and gives us a new initial value
  useEffect(() => { setNotes(initialNotes) }, [initialNotes])

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value
    setNotes(value)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setSaving(true)
      api.updateProfileAssetsNotes(profileName, value)
        .catch(console.error)
        .finally(() => setSaving(false))
    }, 500)
  }

  // Cleanup on unmount
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Profile-wide creative notes
        </label>
        {saving && <span className="text-xs text-gray-400">Saving…</span>}
      </div>
      <textarea
        value={notes}
        onChange={handleChange}
        rows={5}
        className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 placeholder-gray-400 resize-y focus:outline-none focus:ring-2 focus:ring-blue-500/40"
        placeholder={`Profile-wide rules that don't belong on any single asset.\n\ne.g.\n• All videos open with 2 seconds of black\n• Voiceover always first-person\n• Never use vertical aspect ratios`}
      />
      <p className="text-xs text-gray-400 mt-1">
        Cross-cutting creative rules surfaced to the agent at project init. For rules tied to a specific file (&ldquo;use this as the end-card&rdquo;), put them in that file&apos;s description below instead.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Upload progress state
// ---------------------------------------------------------------------------

interface UploadEntry {
  name: string
  progress: number   // 0–100
  done: boolean
  error: string | null
}

// ---------------------------------------------------------------------------
// Drop zone
// ---------------------------------------------------------------------------

function DropZone({ profileName, onUploadsDone }: { profileName: string; onUploadsDone: () => void }) {
  const [dragging, setDragging] = useState(false)
  const [uploads, setUploads]   = useState<UploadEntry[]>([])
  const [error, setError]       = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showError(msg: string) {
    setError(msg)
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    errorTimerRef.current = setTimeout(() => setError(null), 5000)
  }

  useEffect(() => () => { if (errorTimerRef.current) clearTimeout(errorTimerRef.current) }, [])

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files)
    if (list.length === 0) return

    // Seed progress entries
    setUploads(list.map(f => ({ name: f.name, progress: 0, done: false, error: null })))

    for (let i = 0; i < list.length; i++) {
      const file = list[i]
      try {
        await api.uploadProfileAsset(profileName, file, (loaded, total) => {
          const pct = total > 0 ? Math.round((loaded / total) * 100) : 0
          setUploads(prev => prev.map((u, idx) => idx === i ? { ...u, progress: pct } : u))
        })
        setUploads(prev => prev.map((u, idx) => idx === i ? { ...u, progress: 100, done: true } : u))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setUploads(prev => prev.map((u, idx) => idx === i ? { ...u, error: msg } : u))
        showError(`Failed to upload "${file.name}": ${msg}`)
      }
    }

    onUploadsDone()
    // Fade out progress entries after a beat
    setTimeout(() => setUploads([]), 1500)
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragging(true)
  }

  function onDragLeave() {
    setDragging(false)
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files)
  }

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) {
      uploadFiles(e.target.files)
      e.target.value = ''
    }
  }

  return (
    <div className="mb-6">
      <div
        role="button"
        tabIndex={0}
        aria-label="Choose files to upload"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            fileInputRef.current?.click()
          }
        }}
        className={`relative flex flex-col items-center justify-center gap-2 px-6 py-10 rounded-lg border-2 border-dashed cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/40
          ${dragging
            ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/20'
            : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800/50'
          }`}
      >
        <Upload size={20} className="text-gray-400" />
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Drag and drop files here, or <span className="text-blue-500 dark:text-blue-400">click to browse</span>
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onInputChange}
          onClick={e => e.stopPropagation()}
        />
      </div>

      {/* Per-file progress */}
      {uploads.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {uploads.map((u, i) => (
            <div key={i} className="text-xs">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-gray-600 dark:text-gray-400 truncate max-w-[70%]">{u.name}</span>
                <span className={u.error ? 'text-red-500' : u.done ? 'text-green-500' : 'text-gray-400'}>
                  {u.error ? 'Error' : u.done ? 'Done' : `${u.progress}%`}
                </span>
              </div>
              <div className="h-1 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${u.error ? 'bg-red-400' : u.done ? 'bg-green-400' : 'bg-blue-400'}`}
                  style={{ width: `${u.error ? 100 : u.progress}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded px-3 py-2">
          {error}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Description cell (inline-editable, debounced)
// ---------------------------------------------------------------------------

function DescriptionCell({
  profileName,
  filename,
  initialValue,
  placeholder,
  placeholderItalic,
}: {
  profileName: string
  filename: string
  initialValue: string
  placeholder: string
  placeholderItalic?: boolean
}) {
  const [value, setValue] = useState(initialValue)
  const [saving, setSaving] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { setValue(initialValue) }, [initialValue])
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value
    setValue(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setSaving(true)
      api.updateProfileAssetEntry(profileName, filename, { description: v })
        .catch(console.error)
        .finally(() => setSaving(false))
    }, 500)
  }

  return (
    <div className="relative flex items-center min-w-0">
      <input
        type="text"
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        className={`w-full bg-transparent text-sm text-gray-700 dark:text-gray-300 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500/40 rounded px-1 py-0.5 -mx-1
          ${placeholderItalic && !value ? 'italic placeholder:italic' : ''}`}
      />
      {saving && <span className="ml-1 text-xs text-gray-400 shrink-0">…</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// File row
// ---------------------------------------------------------------------------

function FileRow({
  profileName,
  file,
  description,
  hasEntry,
  onDelete,
}: {
  profileName: string
  file: ProfileAssetFile
  description: string
  hasEntry: boolean
  onDelete: () => void
}) {
  const isImage = file.mime.startsWith('image/')

  function handleDelete() {
    if (window.confirm(`Delete "${file.filename}"?`)) {
      api.deleteProfileAsset(profileName, file.filename)
        .then(onDelete)
        .catch(err => console.error('Delete failed', err))
    }
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-colors">
      {/* Type icon or thumbnail */}
      <div className="shrink-0">
        {isImage ? (
          <img
            src={fileUrl(file.path)}
            alt={file.filename}
            className="w-12 h-12 object-cover rounded border border-gray-200 dark:border-gray-700"
          />
        ) : (
          <div className="w-12 h-12 flex items-center justify-center rounded border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800">
            <MimeIcon mime={file.mime} />
          </div>
        )}
      </div>

      {/* Filename */}
      <div className="w-40 shrink-0 min-w-0">
        <p className="text-sm text-gray-800 dark:text-gray-200 truncate" title={file.filename}>
          {file.filename}
        </p>
        <p className="text-xs text-gray-400">{fmtBytes(file.size)}</p>
      </div>

      {/* Description */}
      <div className="flex-1 min-w-0">
        <DescriptionCell
          profileName={profileName}
          filename={file.filename}
          initialValue={description}
          placeholder={hasEntry ? '' : 'Describe this asset'}
          placeholderItalic={!hasEntry}
        />
      </div>

      {/* Delete */}
      <button
        onClick={handleDelete}
        className="shrink-0 p-1.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors rounded"
        title={`Delete ${file.filename}`}
        aria-label={`Delete ${file.filename}`}
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Orphaned (entriesWithoutFile) row
// ---------------------------------------------------------------------------

function OrphanRow({
  profileName,
  filename,
  description,
  onDelete,
}: {
  profileName: string
  filename: string
  description: string
  onDelete: () => void
}) {
  function handleRemove() {
    if (window.confirm(`Remove orphaned entry for "${filename}"?`)) {
      api.deleteProfileAsset(profileName, filename)
        .then(onDelete)
        .catch(err => console.error('Remove orphan failed', err))
    }
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 opacity-50">
      {/* Placeholder icon space */}
      <div className="w-12 h-12 shrink-0 flex items-center justify-center rounded border border-dashed border-gray-300 dark:border-gray-700">
        <File size={18} className="text-gray-300 dark:text-gray-600" />
      </div>

      {/* Filename with strikethrough */}
      <div className="w-40 shrink-0 min-w-0">
        <p className="text-sm text-gray-500 dark:text-gray-500 truncate line-through" title={filename}>
          {filename}
        </p>
        <p className="text-xs text-gray-400">File missing</p>
      </div>

      {/* Description (read-only for orphans) */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-400 italic truncate">{description || '—'}</p>
      </div>

      {/* Remove orphan */}
      <button
        onClick={handleRemove}
        className="shrink-0 text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:border-red-300 dark:hover:border-red-600 transition-colors"
      >
        Orphaned — remove
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// File table
// ---------------------------------------------------------------------------

function FileTable({
  profileName,
  files,
  manifest,
  drift,
  onRefresh,
}: {
  profileName: string
  files: ProfileAssetFile[]
  manifest: ProfileAssetsManifest
  drift: ProfileAssetsDrift
  onRefresh: () => void
}) {
  const hasContent = files.length > 0 || drift.entriesWithoutFile.length > 0

  if (!hasContent) {
    return (
      <div className="px-3 py-8 text-center text-sm text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-gray-800 rounded-lg bg-gray-50 dark:bg-gray-900">
        No assets yet. Drop files into the area above to get started.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      {files.map(f => (
        <FileRow
          key={f.filename}
          profileName={profileName}
          file={f}
          description={manifest.files[f.filename]?.description ?? ''}
          hasEntry={!(drift.filesWithoutEntry.includes(f.filename))}
          onDelete={onRefresh}
        />
      ))}
      {drift.entriesWithoutFile.map(filename => (
        <OrphanRow
          key={filename}
          profileName={profileName}
          filename={filename}
          description={manifest.files[filename]?.description ?? ''}
          onDelete={onRefresh}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ProfileAssetsTab
// ---------------------------------------------------------------------------

export function ProfileAssetsTab({ name }: { name: string }) {
  const [data, setData]       = useState<{
    files: ProfileAssetFile[]
    manifest: ProfileAssetsManifest
    drift: ProfileAssetsDrift
  } | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    api.listProfileAssets(name)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [name])

  useEffect(() => { load() }, [load])

  return (
    <div>
      {/* Section 1 — Notes */}
      {data && (
        <NotesSection
          profileName={name}
          initialNotes={data.manifest.notes}
        />
      )}
      {!data && !loading && (
        <NotesSection
          profileName={name}
          initialNotes=""
        />
      )}

      {/* Section 2 — Drop zone */}
      <DropZone profileName={name} onUploadsDone={load} />

      {/* Section 3 — File table */}
      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : data ? (
        <FileTable
          profileName={name}
          files={data.files}
          manifest={data.manifest}
          drift={data.drift}
          onRefresh={load}
        />
      ) : (
        <p className="text-sm text-red-400">Failed to load assets.</p>
      )}
    </div>
  )
}
