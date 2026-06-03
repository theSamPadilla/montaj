import { useState } from 'react'
import { X, Image, Plus, Copy } from 'lucide-react'
import { api, fileUrl } from '@/lib/api'
import type { Asset } from '@/lib/types/schema'
import { ProfileAssetPicker } from '@/components/upload/ProfileAssetPicker'

function basename(path: string) {
  return path.split('/').pop() ?? path
}

interface AssetsPanelProps {
  assets: Asset[]
  onChange: (next: Asset[]) => Promise<void>
  profileName?: string
  /** When set, dropped assets are uploaded into the project's own directory instead of _uploads/. */
  projectId?: string
}

export default function AssetsPanel({ assets, onChange, profileName, projectId }: AssetsPanelProps) {
  const [pickingAssets, setPickingAssets]     = useState(false)
  const [uploadingAssets, setUploadingAssets] = useState(false)
  const [dragOverAssets, setDragOverAssets]   = useState(false)
  const [previewAsset, setPreviewAsset]       = useState<Asset | null>(null)
  const [pathCopied, setPathCopied]           = useState(false)

  async function handleAddAssets() {
    setPickingAssets(true)
    try {
      const { paths } = await api.pickFiles()
      if (!paths.length) return
      const existing = new Set(assets.map(a => a.src))
      const newAssets: Asset[] = paths
        .filter(p => !existing.has(p))
        .map((p, i) => ({
          id: `asset-${Date.now()}-${i}`,
          src: p,
          type: 'image' as const,
          name: basename(p),
        }))
      if (!newAssets.length) return
      const next = [...assets, ...newAssets]
      await onChange(next)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) console.error(msg)
    } finally {
      setPickingAssets(false)
    }
  }

  async function handleRemoveAsset(id: string) {
    const next = assets.filter(a => a.id !== id)
    await onChange(next)
  }

  async function handleAssetDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOverAssets(false)
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'))
    if (!files.length) return
    setUploadingAssets(true)
    try {
      const paths = await Promise.all(files.map(f => api.uploadFile(f, projectId)))
      const existing = new Set(assets.map(a => a.src))
      const newAssets: Asset[] = paths
        .filter(p => !existing.has(p))
        .map((p, i) => ({
          id: `asset-${Date.now()}-${i}`,
          src: p,
          type: 'image' as const,
          name: basename(p),
        }))
      if (!newAssets.length) return
      const next = [...assets, ...newAssets]
      await onChange(next)
    } catch (e: unknown) {
      console.error(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadingAssets(false)
    }
  }

  return (
    <>
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-800">
          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Assets</span>
          <div className="flex items-center gap-2">
            <ProfileAssetPicker
              profileName={profileName}
              existingPaths={assets.map(a => a.src)}
              onAdd={async file => {
                if (assets.some(a => a.src === file.path)) return
                const next: Asset[] = [
                  ...assets,
                  {
                    id: `asset-${Date.now()}`,
                    src: file.path,
                    type: 'image' as const,
                    name: file.filename,
                  },
                ]
                await onChange(next)
              }}
              variant="button"
            />
            <button
              onClick={handleAddAssets}
              disabled={pickingAssets}
              className="text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
              title="Add assets"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        <div
          className={`flex-1 overflow-y-auto p-2 transition-colors ${dragOverAssets ? 'bg-blue-50 dark:bg-blue-950/30' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragOverAssets(true) }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverAssets(false) }}
          onDrop={handleAssetDrop}
        >
          {assets.length === 0 && !dragOverAssets && !uploadingAssets && (
            <p className="text-xs text-gray-600 text-center mt-4 px-2 leading-relaxed">
              No assets yet.<br />Drop images the agent can use as backgrounds or references.
            </p>
          )}
          {dragOverAssets && (
            <div className="h-full flex items-center justify-center">
              <p className="text-xs text-blue-500 dark:text-blue-400 text-center">Drop to add</p>
            </div>
          )}
          {uploadingAssets && !dragOverAssets && assets.length === 0 && (
            <p className="text-xs text-gray-500 text-center mt-4">Uploading…</p>
          )}
          {!dragOverAssets && assets.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {assets.map(asset => (
                <div
                  key={asset.id}
                  className="group relative rounded overflow-hidden border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
                >
                  <div
                    className="w-full aspect-square bg-gray-800 relative flex items-center justify-center cursor-pointer overflow-hidden"
                    onClick={() => { setPreviewAsset(asset); setPathCopied(false) }}
                    title={asset.name ?? basename(asset.src)}
                  >
                    <Image size={16} className="text-gray-600 absolute" />
                    <img
                      src={fileUrl(asset.src)}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                  </div>
                  <button
                    onClick={() => handleRemoveAsset(asset.id)}
                    className="absolute top-1 right-1 p-0.5 rounded bg-black/60 text-gray-400 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {previewAsset && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setPreviewAsset(null)}
        >
          <div
            className="relative flex flex-col bg-gray-900 border border-gray-700 rounded-xl overflow-hidden max-w-3xl w-full mx-6 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setPreviewAsset(null)}
              className="absolute top-2 right-2 p-1 rounded bg-black/60 text-gray-400 hover:text-white transition-colors z-10"
            >
              <X size={14} />
            </button>
            <img
              src={fileUrl(previewAsset.src)}
              alt={previewAsset.name ?? basename(previewAsset.src)}
              className="w-full object-contain max-h-[70vh]"
            />
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-gray-800">
              <code className="text-xs text-gray-400 font-mono truncate flex-1">{previewAsset.src}</code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(previewAsset.src)
                  setPathCopied(true)
                  setTimeout(() => setPathCopied(false), 1500)
                }}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors shrink-0"
              >
                <Copy size={12} />
                {pathCopied ? 'Copied!' : 'Copy path'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
