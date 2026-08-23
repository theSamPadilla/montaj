import { FileVideo, AudioLines } from 'lucide-react'
import { basename } from '@/lib/utils'

// Duplicated across FootagePanel/upload fields (no shared export exists) —
// matches that convention rather than introducing a new one. Used to pick a
// film icon for a submitted take that is a video vs an audio waveform icon for
// an audio-only file.
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'mts', 'mpg', 'mpeg']

function isVideoPath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_EXTENSIONS.includes(ext)
}

/** `seconds` -> `m:ss`, e.g. `0:10`. Mirrors FootagePanel's helper. */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * The passthrough `project.voiceover` object. It is an index-signature field on
 * EditorProject (Montaj owns it, the editor package does not type it), so the
 * caller reads it defensively and hands this shape in. `src` is the assembled
 * narration, `takes` the raw submissions that produced it (may be video .MOV or
 * audio .mp3/.wav), `cleanedSrc` the de-silenced/cut version.
 */
export interface Voiceover {
  src?: string
  takes?: string[]
  cleanedSrc?: string
}

type AudioKind = 'take' | 'assembled' | 'cleaned'

const KIND_LABEL: Record<AudioKind, string> = {
  take: 'Submitted take',
  assembled: 'Assembled voiceover',
  cleaned: 'Cleaned voiceover',
}

interface AudioFootageItem {
  path: string
  kind: AudioKind
}

/**
 * Build the display list from a voiceover object: every submitted take first
 * (script order), then the assembled `src`, then `cleanedSrc`. De-duplicated by
 * path so a single-take project (where `src` IS the one take, and `takes` is
 * omitted) or a project where two fields point at the same file shows one card.
 * The FIRST kind that claims a path wins, so a take stays labelled "take" even
 * if it also happens to be the assembled src.
 */
export function buildAudioFootageItems(voiceover: Voiceover | undefined): AudioFootageItem[] {
  if (!voiceover) return []
  const items: AudioFootageItem[] = []
  const seen = new Set<string>()
  const push = (path: string | undefined, kind: AudioKind) => {
    if (!path || seen.has(path)) return
    seen.add(path)
    items.push({ path, kind })
  }
  for (const take of voiceover.takes ?? []) push(take, 'take')
  push(voiceover.src, 'assembled')
  push(voiceover.cleanedSrc, 'cleaned')
  return items
}

export interface BrollAudioPanelProps {
  /** The project's `voiceover` object (read defensively by the caller). */
  voiceover: Voiceover | undefined
  /** Audio `src` paths placed on the timeline (`project.audio.tracks[].src`) -> "Added" badge. */
  usedSrcs: Set<string>
  /** Intrinsic durations by src, when known (from `audio.tracks[].sourceDuration`). */
  durationBySrc?: Map<string, number>
  /** Resolve a project-relative/absolute path to a fetchable URL, for the "open" affordance. */
  fileUrl: (path: string) => string
}

/**
 * The "Broll Audio" tab body: the audio footage behind a b-roll edit — the
 * files submitted for the voiceover plus the assembled/cleaned narration. Cards
 * mirror FootagePanel's shell and "Added" badge; display-only (no drag to the
 * timeline yet — the visual footage DND payload doesn't target the audio lane).
 */
export default function BrollAudioPanel({ voiceover, usedSrcs, durationBySrc, fileUrl }: BrollAudioPanelProps) {
  const items = buildAudioFootageItems(voiceover)

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {items.length === 0 ? (
          <p className="text-xs text-gray-600 text-center mt-4 px-2 leading-relaxed">
            No voiceover audio yet.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {items.map(item => {
              const name = basename(item.path)
              const used = usedSrcs.has(item.path)
              const duration = durationBySrc?.get(item.path)
              const isVideo = item.kind === 'take' && isVideoPath(item.path)
              const Icon = isVideo ? FileVideo : AudioLines
              return (
                <a
                  key={item.path}
                  href={fileUrl(item.path)}
                  target="_blank"
                  rel="noreferrer"
                  className="group relative rounded overflow-hidden border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 no-underline"
                  title={`${name} — ${KIND_LABEL[item.kind]}`}
                >
                  <div className="relative w-full aspect-video bg-gray-800 flex items-center justify-center">
                    <Icon size={18} className="text-gray-400" />
                    {used && (
                      <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-medium leading-none">
                        Added
                      </span>
                    )}
                    {duration != null && (
                      <span className="absolute top-1 right-1 px-1 py-0.5 rounded bg-black/70 text-white text-[10px] font-mono leading-none">
                        {formatDuration(duration)}
                      </span>
                    )}
                  </div>
                  <div className="px-1.5 py-1">
                    <p className="text-xs text-gray-600 dark:text-gray-400 truncate" title={name}>{name}</p>
                    <p className="text-[10px] text-gray-500 truncate">{KIND_LABEL[item.kind]}</p>
                  </div>
                </a>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
