import { useState } from 'react'
import { Film, Music, FileText } from 'lucide-react'
import { api } from '@/lib/api'
import { DropZone } from './DropZone'

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'mts', 'mpg', 'mpeg']

export interface LyricsUploadData {
  audio: string[]
  lyricsFile: string[]
  bgVideo: string[]
}

export function LyricsUploadFields({ data, onChange, onError }: {
  data: LyricsUploadData
  onChange: (data: LyricsUploadData) => void
  onError: (msg: string | null) => void
}) {
  const [pickingAudio, setPickingAudio] = useState(false)
  const [pickingLyrics, setPickingLyrics] = useState(false)
  const [pickingBgVideo, setPickingBgVideo] = useState(false)
  const [uploadingAudio, setUploadingAudio] = useState(false)
  const [uploadingLyrics, setUploadingLyrics] = useState(false)
  const [uploadingBgVideo, setUploadingBgVideo] = useState(false)

  async function browseAudio() {
    setPickingAudio(true)
    onError(null)
    try {
      const { paths } = await api.pickFiles({ extensions: ['mp3'], prompt: 'Select MP3 file' })
      if (paths.length) onChange({ ...data, audio: [paths[0]] })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) onError(msg)
    } finally {
      setPickingAudio(false)
    }
  }

  async function browseLyrics() {
    setPickingLyrics(true)
    onError(null)
    try {
      const { paths } = await api.pickFiles({ extensions: ['txt'], prompt: 'Select lyrics file' })
      if (paths.length) onChange({ ...data, lyricsFile: [paths[0]] })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) onError(msg)
    } finally {
      setPickingLyrics(false)
    }
  }

  async function browseBgVideo() {
    setPickingBgVideo(true)
    onError(null)
    try {
      const { paths } = await api.pickFiles({ extensions: VIDEO_EXTENSIONS, prompt: 'Select background video' })
      if (paths.length) onChange({ ...data, bgVideo: [paths[0]] })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('cancel')) onError(msg)
    } finally {
      setPickingBgVideo(false)
    }
  }

  async function handleDropAudio(files: File[]) {
    setUploadingAudio(true)
    onError(null)
    try {
      const path = await api.uploadFile(files[0])
      onChange({ ...data, audio: [path] })
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadingAudio(false)
    }
  }

  async function handleDropLyrics(files: File[]) {
    setUploadingLyrics(true)
    onError(null)
    try {
      const path = await api.uploadFile(files[0])
      onChange({ ...data, lyricsFile: [path] })
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadingLyrics(false)
    }
  }

  async function handleDropBgVideo(files: File[]) {
    setUploadingBgVideo(true)
    onError(null)
    try {
      const path = await api.uploadFile(files[0])
      onChange({ ...data, bgVideo: [path] })
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploadingBgVideo(false)
    }
  }

  return (
    <>
      <div className="flex gap-4">
        <div className="flex-1">
          <DropZone
            label="Audio"
            sublabel="MP3 file — the song to sync lyrics to."
            icon={<Music size={28} />}
            accept="audio/mpeg"
            dropLabel="Drop MP3 file here"
            files={data.audio}
            uploading={pickingAudio || uploadingAudio}
            onBrowse={browseAudio}
            onDrop={handleDropAudio}
            onRemove={() => onChange({ ...data, audio: [] })}
            browseLabel={data.audio.length === 0 ? 'Browse files' : 'Replace'}
            accentClass="border-green-500 bg-green-500/10"
            single
          />
        </div>

        <div className="flex-1">
          <DropZone
            label="Lyrics"
            sublabel="Plain text file — one phrase per line."
            icon={<FileText size={28} />}
            accept="text/"
            files={data.lyricsFile}
            uploading={pickingLyrics || uploadingLyrics}
            onBrowse={browseLyrics}
            onDrop={handleDropLyrics}
            onRemove={() => onChange({ ...data, lyricsFile: [] })}
            browseLabel={data.lyricsFile.length === 0 ? 'Browse files' : 'Replace'}
            accentClass="border-amber-500 bg-amber-500/10"
            single
          />
        </div>
      </div>

      <DropZone
        label="Background Video"
        sublabel="Optional looping video behind the lyrics. Short clips (10\u201330s) work best."
        icon={<Film size={28} />}
        accept="video/"
        files={data.bgVideo}
        uploading={pickingBgVideo || uploadingBgVideo}
        onBrowse={browseBgVideo}
        onDrop={handleDropBgVideo}
        onRemove={() => onChange({ ...data, bgVideo: [] })}
        browseLabel={data.bgVideo.length === 0 ? 'Browse files' : 'Replace'}
        accentClass="border-blue-500 bg-blue-500/10"
        dropLabel="Drop background video here"
        single
      />
    </>
  )
}
