import { useCallback, useEffect, useState } from 'react'
import { Check, File, FileAudio, FileVideo, Plus, RefreshCw } from 'lucide-react'
import { api, fileUrl, type ProfileAssetFile, type ProfileAssetsManifest } from '@/lib/api'
import type { Project } from '@/lib/types/schema'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function MimeIcon({ mime }: { mime: string }) {
  if (mime.startsWith('video/')) return <FileVideo className="w-4 h-4 text-gray-500 shrink-0" />
  if (mime.startsWith('audio/')) return <FileAudio className="w-4 h-4 text-gray-500 shrink-0" />
  return <File className="w-4 h-4 text-gray-500 shrink-0" />
}

// ---------------------------------------------------------------------------
// Asset row
// ---------------------------------------------------------------------------

function AssetRow({
  file,
  description,
  alreadyIncluded,
  onInclude,
}: {
  file: ProfileAssetFile
  description?: string
  alreadyIncluded: boolean
  onInclude: () => Promise<void>
}) {
  const [including, setIncluding] = useState(false)
  const [justCopied, setJustCopied] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const isImage = file.mime.startsWith('image/')

  async function handleInclude() {
    setIncluding(true)
    setErrorMsg(null)
    try {
      await onInclude()
      setJustCopied(true)
      setTimeout(() => setJustCopied(false), 2000)
    } catch (err) {
      // Use the same precedence as the rest of the codebase:
      // err.detail?.message ?? err.message ?? String(err)
      const e = err as { detail?: { message?: string }; message?: string }
      const msg = e.detail?.message ?? e.message ?? String(err)
      setErrorMsg(msg)
      setTimeout(() => setErrorMsg(null), 3000)
    } finally {
      setIncluding(false)
    }
  }

  return (
    <div className="flex flex-col gap-1 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
      <div className="flex items-center gap-2.5">
        {/* Thumbnail or icon */}
        <div className="shrink-0">
          {isImage ? (
            <img
              src={fileUrl(file.path)}
              alt={file.filename}
              className="w-8 h-8 object-cover rounded"
            />
          ) : (
            <div className="w-8 h-8 flex items-center justify-center rounded border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800">
              <MimeIcon mime={file.mime} />
            </div>
          )}
        </div>

        {/* Name + description */}
        <div className="flex-1 min-w-0">
          <p className="text-xs text-gray-800 dark:text-gray-200 truncate" title={file.filename}>
            {file.filename}
          </p>
          {description && (
            <p className="text-[10px] text-gray-400 truncate">{description}</p>
          )}
        </div>

        {/* Action */}
        {alreadyIncluded || justCopied ? (
          <span className="flex items-center gap-1 text-[10px] text-gray-400 shrink-0">
            <Check className="w-3 h-3 text-green-500" />
            Included
          </span>
        ) : (
          <button
            type="button"
            disabled={including}
            onClick={handleInclude}
            className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:border-gray-400 dark:hover:border-gray-600 transition-colors disabled:opacity-50 shrink-0"
            title={`Include ${file.filename} in project`}
          >
            {including ? (
              <span className="w-3 h-3 rounded-full border border-current border-t-transparent animate-spin" />
            ) : (
              <Plus className="w-3 h-3" />
            )}
            Include
          </button>
        )}
      </div>

      {/* Inline error (auto-dismisses after 3s) */}
      {errorMsg && (
        <p className="text-[10px] text-red-400 pl-[42px] truncate" title={errorMsg}>
          {errorMsg}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ProfileAssetsPanel
// ---------------------------------------------------------------------------

interface Props {
  project: Project
  onProjectChange: (p: Project) => void
}

export function ProfileAssetsPanel({ project, onProjectChange }: Props) {
  const profileName = project.profile

  const [files, setFiles]       = useState<ProfileAssetFile[]>([])
  const [manifest, setManifest] = useState<ProfileAssetsManifest | null>(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  // Set of asset names already in the project (for "Included" detection)
  const includedNames = new Set((project.assets ?? []).map(a => a.name).filter(Boolean) as string[])

  const load = useCallback(() => {
    if (!profileName) return
    setLoading(true)
    setError(null)
    api.listProfileAssets(profileName)
      .then(data => {
        setFiles(data.files)
        setManifest(data.manifest)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [profileName])

  useEffect(() => { load() }, [load])

  // Not visible when no profile is set
  if (!profileName) return null

  async function handleInclude(filename: string) {
    const updated = await api.addProfileAssetToProject(project.id, profileName!, filename)
    onProjectChange(updated)
  }

  return (
    <section className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <h2 className="text-sm font-medium text-gray-300 shrink-0">Profile assets</h2>
          <span className="text-sm text-gray-600 truncate">· {profileName}</span>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors disabled:opacity-40"
          title="Refresh"
          aria-label="Refresh assets"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Body */}
      {loading && files.length === 0 ? (
        <p className="text-xs text-gray-500">Loading…</p>
      ) : error ? (
        <div className="flex items-center gap-2">
          <p className="text-xs text-red-400 flex-1">Failed to load assets — {error}</p>
          <button
            type="button"
            onClick={load}
            className="text-xs text-blue-400 hover:text-blue-300 shrink-0"
          >
            Retry
          </button>
        </div>
      ) : files.length === 0 ? (
        <p className="text-xs text-gray-500 italic">
          No assets in this profile yet. Add via Profiles → Assets tab.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {files.map(file => (
            <AssetRow
              key={file.filename}
              file={file}
              description={manifest?.files[file.filename]?.description}
              alreadyIncluded={includedNames.has(file.filename)}
              onInclude={() => handleInclude(file.filename)}
            />
          ))}
        </div>
      )}
    </section>
  )
}
