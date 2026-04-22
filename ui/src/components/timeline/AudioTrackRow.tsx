// AudioTrackRow — one audio track row rendered on the timeline.
//
// Current scope: display-only (colored bar, label, mute-dimmed styling).
//
// Future extensions:
// - interactive drag/trim via useItemDragDrop
// - inline mute/volume/delete controls
// - waveform layer (tiled chunk <img>s from waveform_image step)
// - double-click → track inspector modal

import { Music2 } from 'lucide-react'
import type { AudioTrack } from '@/lib/types/schema'
import { pct } from './utils'
import { useTimelineContext } from './TimelineContext'

interface AudioTrackRowProps {
  track: AudioTrack
}

export default function AudioTrackRow({ track }: AudioTrackRowProps) {
  const { totalDuration } = useTimelineContext()
  const left  = pct(track.start, totalDuration)
  const width = pct(track.end - track.start, totalDuration)
  const label = track.label ?? track.src.split('/').pop() ?? 'audio'
  return (
    <div className="relative flex items-center h-8 border-b border-white/5">
      <div className="absolute left-0 flex items-center gap-1 px-2 z-10 w-24 shrink-0">
        <Music2 className={`w-3 h-3 ${track.muted ? 'text-white/20' : 'text-emerald-400'}`} />
        <span className="text-[10px] text-white/40 truncate">{label}</span>
      </div>
      <div className="relative flex-1 h-full" style={{ marginLeft: '6rem' }}>
        <div
          className={`absolute top-1 bottom-1 rounded ${track.muted ? 'bg-white/10' : 'bg-emerald-500/40 border border-emerald-500/60'}`}
          style={{ left: `${left}%`, width: `${width}%` }}
          title={label}
        />
      </div>
    </div>
  )
}
