import { useCallback, useEffect, useState } from 'react'
import { Check, File, FileAudio, FileVideo, FolderOpen, Plus, RefreshCw, X } from 'lucide-react'
import { api, fileUrl, type ProfileAssetFile, type ProfileAssetsManifest } from '@/lib/api'

function MimeIcon({ mime }: { mime: string }) {
  if (mime.startsWith('video/')) return <FileVideo className="w-4 h-4 text-gray-500 shrink-0" />
  if (mime.startsWith('audio/')) return <FileAudio className="w-4 h-4 text-gray-500 shrink-0" />
  return <File className="w-4 h-4 text-gray-500 shrink-0" />
}

interface ProfileAssetPickerProps {
  profileName: string | undefined
  existingPaths: string[]
  onAdd: (file: ProfileAssetFile) => void
  /** Visual variant: full button or compact text link */
  variant?: 'button' | 'link'
}

export function ProfileAssetPicker({ profileName, existingPaths, onAdd, variant = 'button' }: ProfileAssetPickerProps) {
  const [open, setOpen]         = useState(false)
  const [files, setFiles]       = useState<ProfileAssetFile[]>([])
  const [manifest, setManifest] = useState<ProfileAssetsManifest | null>(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const includedPaths = new Set(existingPaths)

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

  useEffect(() => { if (open) load() }, [open, load])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const disabled = !profileName

  const trigger = variant === 'link' ? (
    <button
      type="button"
      onClick={() => !disabled && setOpen(true)}
      disabled={disabled}
      className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      title={disabled ? 'Select a profile to browse its asset library' : 'Add from profile asset library'}
    >
      <FolderOpen size={12} />
      From profile
    </button>
  ) : (
    <button
      type="button"
      onClick={() => !disabled && setOpen(true)}
      disabled={disabled}
      className="text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      title={disabled ? 'Select a profile to browse its asset library' : 'Add from profile asset library'}
    >
      <FolderOpen size={14} />
    </button>
  )

  return (
    <>
      {trigger}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative flex flex-col w-full max-w-lg max-h-[80vh] mx-6 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800">
              <div className="flex items-center gap-1.5 min-w-0">
                <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100 shrink-0">Profile assets</h2>
                <span className="text-sm text-gray-500 truncate">· {profileName}</span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={load}
                  disabled={loading}
                  className="p-1 rounded text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-40"
                  title="Refresh"
                  aria-label="Refresh"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="p-1 rounded text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  aria-label="Close"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3">
              {loading && files.length === 0 ? (
                <p className="text-xs text-gray-500 p-2">Loading…</p>
              ) : error ? (
                <div className="flex items-center gap-2 p-2">
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
                <p className="text-xs text-gray-500 italic p-2">
                  No assets in this profile yet. Add via Profiles → Assets tab.
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {files.map(file => {
                    const alreadyIncluded = includedPaths.has(file.path)
                    const isImage = file.mime.startsWith('image/')
                    const description = manifest?.files[file.filename]?.description
                    return (
                      <div
                        key={file.filename}
                        className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-800"
                      >
                        <div className="shrink-0">
                          {isImage ? (
                            <img
                              src={fileUrl(file.path)}
                              alt={file.filename}
                              className="w-8 h-8 object-cover rounded"
                            />
                          ) : (
                            <div className="w-8 h-8 flex items-center justify-center rounded border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-900">
                              <MimeIcon mime={file.mime} />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-gray-800 dark:text-gray-200 truncate" title={file.filename}>
                            {file.filename}
                          </p>
                          {description && (
                            <p className="text-[10px] text-gray-400 truncate">{description}</p>
                          )}
                        </div>
                        {alreadyIncluded ? (
                          <span className="flex items-center gap-1 text-[10px] text-gray-400 shrink-0">
                            <Check className="w-3 h-3 text-green-500" />
                            Included
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onAdd(file)}
                            className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:border-gray-400 dark:hover:border-gray-600 transition-colors shrink-0"
                            title={`Include ${file.filename}`}
                          >
                            <Plus className="w-3 h-3" />
                            Include
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
