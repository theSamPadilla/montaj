import { useState } from 'react'
import { Film, Image } from 'lucide-react'
import { api } from '@/lib/api'
import { DropZone } from './DropZone'
import { ProfileAssetPicker } from './ProfileAssetPicker'

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'mts', 'mpg', 'mpeg']

export interface ClipUploadData {
  clips: string[]
  assets: string[]
}

export function ClipUploadFields({ data, onChange, onError, profileName }: {
  data: ClipUploadData
  onChange: (data: ClipUploadData) => void
  onError: (msg: string | null) => void
  profileName?: string
}) {
  const [pickingClips, setPickingClips] = useState(false)
  const [pickingAssets, setPickingAssets] = useState(false)
  const [uploadingClips, setUploadingClips] = useState(false)
  const [uploadingAssets, setUploadingAssets] = useState(false)

  function addUnique(prev: string[], paths: string[]) {
    return [...prev, ...paths.filter(p => !prev.includes(p))]
  }

  async function browseClips() {
    setPickingClips(true)
    onError(null)
    try {
      const { paths } = await api.pickFiles({ extensions: VIDEO_EXTENSIONS, prompt: 'Select video clips' })
      if (paths.length) onChange({ ...data, clips: addUnique(data.clips, paths) })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) onError(msg)
    } finally {
      setPickingClips(false)
    }
  }

  async function browseAssets() {
    setPickingAssets(true)
    onError(null)
    try {
      const { paths } = await api.pickFiles()
      if (paths.length) onChange({ ...data, assets: addUnique(data.assets, paths) })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) onError(msg)
    } finally {
      setPickingAssets(false)
    }
  }

  async function handleDropClips(files: File[]) {
    setUploadingClips(true)
    onError(null)
    try {
      const paths = await Promise.all(files.map(f => api.uploadFile(f)))
      onChange({ ...data, clips: addUnique(data.clips, paths) })
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadingClips(false)
    }
  }

  async function handleDropAssets(files: File[]) {
    setUploadingAssets(true)
    onError(null)
    try {
      const paths = await Promise.all(files.map(f => api.uploadFile(f)))
      onChange({ ...data, assets: addUnique(data.assets, paths) })
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadingAssets(false)
    }
  }

  return (
    <>
      <DropZone
        label="Clips"
        sublabel="Source video files to edit."
        icon={<Film size={28} />}
        accept="video/"
        files={data.clips}
        uploading={pickingClips || uploadingClips}
        onBrowse={browseClips}
        onDrop={handleDropClips}
        onRemove={path => onChange({ ...data, clips: data.clips.filter(p => p !== path) })}
        browseLabel={data.clips.length === 0 ? 'Browse files' : 'Add more'}
        accentClass="border-indigo-500 bg-indigo-500/10"
        thumbnails
      />

      <DropZone
        label="Assets"
        sublabel="Images the agent can use as overlays — logos, screenshots, graphics. Optional."
        icon={<Image size={28} />}
        accept="image/"
        files={data.assets}
        uploading={pickingAssets || uploadingAssets}
        onBrowse={browseAssets}
        onDrop={handleDropAssets}
        onRemove={path => onChange({ ...data, assets: data.assets.filter(p => p !== path) })}
        browseLabel={data.assets.length === 0 ? 'Browse files' : 'Add more'}
        accentClass="border-indigo-500 bg-indigo-500/10"
        thumbnails
        headerAction={
          <ProfileAssetPicker
            profileName={profileName}
            existingPaths={data.assets}
            onAdd={file => {
              if (data.assets.includes(file.path)) return
              onChange({ ...data, assets: [...data.assets, file.path] })
            }}
            variant="link"
          />
        }
      />
    </>
  )
}
