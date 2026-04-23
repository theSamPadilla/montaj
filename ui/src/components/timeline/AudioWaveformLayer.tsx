import { useEffect, useState } from 'react'
import { fileUrl } from '@/lib/api'
import { ensureWaveformChunks, type WaveformChunk } from '@/lib/audio-waveform'
import type { AudioTrack } from '@/lib/types/schema'

interface Props {
  track: AudioTrack
  projectId: string
}

function LoadingBar() {
  return (
    <div className="relative w-full h-full overflow-hidden rounded bg-emerald-500/20">
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-pulse" />
    </div>
  )
}

function PlainFallback() {
  return <div className="w-full h-full rounded bg-emerald-500/40 border border-emerald-500/60" />
}

export default function AudioWaveformLayer({ track, projectId }: Props) {
  const [chunks, setChunks] = useState<WaveformChunk[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setChunks(null)
    setError(false)

    ensureWaveformChunks(track, projectId)
      .then((result) => {
        if (!cancelled) setChunks(result)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })

    return () => {
      cancelled = true
    }
  }, [track.id, track.src, projectId])

  const isMuted = track.muted ?? false

  const content = (() => {
    if (error) return <PlainFallback />
    if (!chunks) return <LoadingBar />

    const sourceDur = track.sourceDuration ?? (track.end - track.start)
    const inPt = track.inPoint ?? 0
    const outPt = track.outPoint ?? sourceDur
    const visibleSpan = outPt - inPt

    if (visibleSpan <= 0) return <PlainFallback />

    // Filter to chunks that overlap [inPt, outPt]
    const visible = chunks.filter((c) => c.end > inPt && c.start < outPt)

    return (
      <div className="relative w-full h-full overflow-hidden rounded">
        {visible.map((chunk) => {
          const leftPct = ((chunk.start - inPt) / visibleSpan) * 100
          const widthPct = ((chunk.end - chunk.start) / visibleSpan) * 100

          return (
            <img
              key={chunk.path}
              src={fileUrl(chunk.path)}
              alt=""
              draggable={false}
              className="absolute top-0 h-full object-fill"
              style={{
                left: `${leftPct}%`,
                width: `${widthPct}%`,
              }}
            />
          )
        })}
      </div>
    )
  })()

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{ opacity: isMuted ? 0.3 : 1 }}
    >
      {content}
    </div>
  )
}
