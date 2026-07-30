import { useState } from 'react'
import { Film, Image, Mic, FolderOpen, X } from 'lucide-react'
import { api } from '@/lib/api'
import { basename } from '@/lib/utils'
import { DropZone } from './DropZone'

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'mts', 'mpg', 'mpeg']
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg']

export interface VoiceoverFile {
  name: string
  path: string
}

// A single-file zone accepting both audio and video (only the audio track is
// used downstream). Built as a bespoke block rather than the shared DropZone
// because DropZone filters drops by one type prefix and displays the file's
// basename — here we need audio+video together and need to preserve the
// original filename, which can differ from the staged upload path's basename.
function VoiceoverZone({ voiceover, uploading, onBrowse, onDropFiles, onRemove }: {
  voiceover: VoiceoverFile | null
  uploading: boolean
  onBrowse: () => void
  onDropFiles: (files: File[]) => void
  onRemove: () => void
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
    const dropped = Array.from(e.dataTransfer.files).filter(
      f => f.type.startsWith('audio/') || f.type.startsWith('video/'),
    )
    if (dropped.length) onDropFiles(dropped.slice(0, 1))
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Voiceover</p>
        <p className="text-xs text-gray-500 mt-0.5">
          Narration track — audio or video file. Only the audio is used.
        </p>
      </div>

      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`relative rounded-lg border-2 border-dashed transition-colors ${
          dragOver
            ? 'border-amber-500 bg-amber-500/10 border-opacity-100'
            : 'border-gray-300 hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-600'
        }`}
      >
        <div className="flex flex-col items-center justify-center gap-3 py-10 px-4 text-center">
          <div className={`${dragOver ? 'text-white' : 'text-gray-400 dark:text-gray-600'} transition-colors`}>
            <Mic size={28} />
          </div>
          <p className={`text-sm transition-colors ${dragOver ? 'text-white' : 'text-gray-500 dark:text-gray-500'}`}>
            {dragOver ? 'Drop to add' : 'Drop an audio or video file here'}
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
            {uploading ? 'Opening…' : voiceover ? 'Replace' : 'Browse files'}
          </button>
        </div>
      </div>

      {voiceover && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-900/20 group">
          <span className="text-green-500 dark:text-green-500 shrink-0">
            <Mic size={12} />
          </span>
          <span className="flex-1 text-xs text-green-800 dark:text-green-300 truncate font-mono">
            {voiceover.name}
          </span>
          <button
            onClick={onRemove}
            aria-label="Remove voiceover"
            className="shrink-0 text-green-500/60 hover:text-green-700 dark:text-green-700 dark:hover:text-green-400 transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  )
}

export default function BrollUploadFields({ clips, setClips, assets, setAssets, voiceover, setVoiceover, onError }: {
  clips: string[]; setClips: (v: string[]) => void
  assets: string[]; setAssets: (v: string[]) => void
  voiceover: VoiceoverFile | null; setVoiceover: (v: VoiceoverFile | null) => void
  onError?: (msg: string | null) => void
}) {
  const [pickingClips, setPickingClips] = useState(false)
  const [pickingAssets, setPickingAssets] = useState(false)
  const [pickingVoiceover, setPickingVoiceover] = useState(false)
  const [uploadingClips, setUploadingClips] = useState(false)
  const [uploadingAssets, setUploadingAssets] = useState(false)
  const [uploadingVoiceover, setUploadingVoiceover] = useState(false)

  function addUnique(prev: string[], paths: string[]) {
    return [...prev, ...paths.filter(p => !prev.includes(p))]
  }

  async function browseClips() {
    setPickingClips(true)
    onError?.(null)
    try {
      const { paths } = await api.pickFiles({ extensions: VIDEO_EXTENSIONS, prompt: 'Select footage' })
      if (paths.length) setClips(addUnique(clips, paths))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) onError?.(msg)
    } finally {
      setPickingClips(false)
    }
  }

  async function browseAssets() {
    setPickingAssets(true)
    onError?.(null)
    try {
      const { paths } = await api.pickFiles()
      if (paths.length) setAssets(addUnique(assets, paths))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) onError?.(msg)
    } finally {
      setPickingAssets(false)
    }
  }

  async function browseVoiceover() {
    setPickingVoiceover(true)
    onError?.(null)
    try {
      const { paths } = await api.pickFiles({
        extensions: [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS],
        prompt: 'Select voiceover file',
      })
      if (paths.length) setVoiceover({ name: basename(paths[0]), path: paths[0] })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) onError?.(msg)
    } finally {
      setPickingVoiceover(false)
    }
  }

  async function handleDropClips(files: File[]) {
    setUploadingClips(true)
    onError?.(null)
    try {
      const paths = await Promise.all(files.map(f => api.uploadFile(f)))
      setClips(addUnique(clips, paths))
    } catch (e: unknown) {
      onError?.(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadingClips(false)
    }
  }

  async function handleDropAssets(files: File[]) {
    setUploadingAssets(true)
    onError?.(null)
    try {
      const paths = await Promise.all(files.map(f => api.uploadFile(f)))
      setAssets(addUnique(assets, paths))
    } catch (e: unknown) {
      onError?.(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadingAssets(false)
    }
  }

  async function handleDropVoiceover(files: File[]) {
    const file = files[0]
    setUploadingVoiceover(true)
    onError?.(null)
    try {
      const path = await api.uploadFile(file)
      setVoiceover({ name: file.name, path })
    } catch (e: unknown) {
      onError?.(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadingVoiceover(false)
    }
  }

  return (
    <>
      <DropZone
        label="Footage"
        sublabel="Raw video the agent selects shots from."
        icon={<Film size={28} />}
        accept="video/"
        files={clips}
        uploading={pickingClips || uploadingClips}
        onBrowse={browseClips}
        onDrop={handleDropClips}
        onRemove={path => setClips(clips.filter(p => p !== path))}
        browseLabel={clips.length === 0 ? 'Browse files' : 'Add more'}
        accentClass="border-blue-500 bg-blue-500/10"
      />

      <DropZone
        label="Assets"
        sublabel="Images and screenshots the agent can use as shots. Optional."
        icon={<Image size={28} />}
        accept="image/"
        files={assets}
        uploading={pickingAssets || uploadingAssets}
        onBrowse={browseAssets}
        onDrop={handleDropAssets}
        onRemove={path => setAssets(assets.filter(p => p !== path))}
        browseLabel={assets.length === 0 ? 'Browse files' : 'Add more'}
        accentClass="border-purple-500 bg-purple-500/10"
      />

      <VoiceoverZone
        voiceover={voiceover}
        uploading={pickingVoiceover || uploadingVoiceover}
        onBrowse={browseVoiceover}
        onDropFiles={handleDropVoiceover}
        onRemove={() => setVoiceover(null)}
      />
    </>
  )
}
