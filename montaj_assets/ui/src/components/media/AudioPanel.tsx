import { useRef } from 'react'
import { AudioLines, VolumeX } from 'lucide-react'
import type { GetWaveformPeaksArgs, PeaksData } from '@bycrux/editor'
import { basename } from '@/lib/utils'
import type { AudioTrack } from '@/lib/types/schema'
import {
  AudioWaveformPreview,
  KIND_LABEL,
  buildAudioFootageItems,
  isFootageInUse,
  type Voiceover,
} from './BrollAudioPanel'

/** `seconds` -> `m:ss`, e.g. `0:10`. Mirrors FootagePanel's/BrollAudioPanel's helper. */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Where an item in the pool came from. `'timeline'` is an `audio.tracks` entry;
 * the other three are `project.voiceover` files and reuse BrollAudioPanel's
 * existing labels.
 */
export type AudioItemKind = 'timeline' | 'take' | 'assembled' | 'cleaned'

const TIMELINE_LABEL = 'On the timeline'

export function kindLabel(kind: AudioItemKind): string {
  return kind === 'timeline' ? TIMELINE_LABEL : KIND_LABEL[kind]
}

export interface AudioItem {
  /** Stable React key: the track id for a timeline item, the path otherwise. */
  key: string
  path: string
  kind: AudioItemKind
  /** Display name — the track's `label` when it has one, else the basename. */
  name: string
  /** Is this on the timeline? Drives the Added / Not placed pill. */
  placed: boolean
  /** `0:00–0:15` — the track's span on the project timeline. Timeline items only. */
  placement?: string
  /** Intrinsic source duration when known, for the top-right badge. */
  duration?: number
  /** `music` / `sfx` / `voiceover` when the project set one. Timeline items only. */
  trackType?: string
  /** Muted on the timeline (the audition player below still plays it). */
  muted?: boolean
}

export interface BuildAudioItemsArgs {
  /** `project.audio.tracks` — already-placed audio. */
  tracks: AudioTrack[]
  /** `project.voiceover` — b-roll submissions, which may or may not be placed. */
  voiceover?: Voiceover
  /** Exact `src` values drawn from `audio.tracks`, for the voiceover match. */
  usedSrcs: Set<string>
}

/**
 * Build the unified pool the tab renders, mirroring how FootagePanel presents
 * `project.sources` — except that `sources` is video-only (`VisualItem.type` has
 * no audio member, and both writers — `project/init.py` and `lib/ingest.py` —
 * hardcode `"video"`), so there is no audio equivalent of the footage bin to
 * read. The pool is assembled from what does exist:
 *
 *  1. **Every `audio.tracks` entry**, ordered by `lane` then `start`. These are
 *     placed by definition. One item PER TRACK rather than per distinct `src`,
 *     deliberately: a narration split across many labelled segments shares one
 *     `src` (one real project has 40 tracks over a single file, every one of
 *     them separately labelled), and de-duplicating would collapse it to a
 *     single nameless card.
 *  2. **Every `voiceover` file** (takes, then assembled, then cleaned) that is
 *     not already claimed by a timeline item at the exact same path. These are
 *     the ONLY things in the pool that can genuinely be unplaced, which is what
 *     makes the placed/not-placed mark worth showing at all.
 *
 * The "is it placed?" question is answered differently per provenance, and that
 * is load-bearing rather than sloppy:
 *
 *  - Timeline items: placed by construction, no matching needed.
 *  - Voiceover items: `isFootageInUse`, which is stem-aware. The per-take wavs
 *    Montaj places are DIFFERENT FILES from the raw submissions
 *    (`vo_02_IMG_0979.wav` vs `IMG_0979.MOV`) — a real b-roll project here has
 *    12 voiceover files and 10 placed tracks with ZERO exact-path overlap, so an
 *    exact match would report every take as unused and regress today's shipped
 *    badge behaviour.
 *
 * Exact `src` membership is what the de-duplication in step 2 uses, and it is
 * what any non-voiceover audio would use — `isFootageInUse`'s substring pass is
 * tuned to b-roll's split-per-take filename convention and would mis-match a
 * music bed, so it is never applied outside the voiceover items.
 */
export function buildAudioItems({ tracks, voiceover, usedSrcs }: BuildAudioItemsArgs): AudioItem[] {
  const items: AudioItem[] = []
  const timelinePaths = new Set<string>()

  const ordered = [...tracks].sort((a, b) => (a.lane ?? 0) - (b.lane ?? 0) || a.start - b.start)
  for (const track of ordered) {
    if (!track.src) continue
    timelinePaths.add(track.src)
    items.push({
      key: track.id,
      path: track.src,
      kind: 'timeline',
      name: track.label || basename(track.src),
      placed: true,
      placement: `${formatDuration(track.start)}–${formatDuration(track.end)}`,
      duration: track.sourceDuration,
      trackType: track.type,
      muted: track.muted,
    })
  }

  for (const vo of buildAudioFootageItems(voiceover)) {
    if (timelinePaths.has(vo.path)) continue
    items.push({
      key: vo.path,
      path: vo.path,
      kind: vo.kind,
      name: basename(vo.path),
      placed: isFootageInUse(vo.path, usedSrcs),
    })
  }

  return items
}

export interface AudioPanelProps {
  /** `project.audio.tracks` — read defensively by the caller (carousel projects omit `audio`). */
  tracks: AudioTrack[]
  /** `project.voiceover` — a passthrough field, read defensively by the caller. */
  voiceover?: Voiceover
  /** Exact `src` values placed on the timeline, for the voiceover cards' mark. */
  usedSrcs: Set<string>
  /** Intrinsic durations by src, when known (from `audio.tracks[].sourceDuration`). */
  durationBySrc?: Map<string, number>
  /** Resolve a project-relative/absolute path to a fetchable URL, for the audition players. */
  fileUrl: (path: string) => string
  /** Scopes the peaks cache for the waveform thumbnails. Absent -> cards keep the AudioLines icon. */
  projectId?: string
  /** Fetches downsampled peaks for a card's waveform thumbnail. Absent -> icon fallback. */
  getWaveformPeaks?: (args: GetWaveformPeaksArgs) => Promise<PeaksData>
}

/**
 * The "Audio" tab body — the Footage tab's answer, for audio.
 *
 * One card per piece of the project's audio, built exactly like a FootagePanel
 * card: the same shell, the same `aspect-video` media box, the same top-LEFT
 * placement pill, the same top-RIGHT mono duration badge, the same truncating
 * filename footer. The thumbnail is a waveform instead of a filmstrip, and each
 * card carries a bare `<audio controls>` to audition it.
 *
 * **The one deliberate divergence from Footage is the column count.** Footage
 * uses `grid-cols-3`; the media panel defaults to 288px wide (min 200px, see
 * `VideoEditor.tsx`), which puts a three-up card at ~85px — far below the
 * ~200px a native `<audio controls>` needs to stay usable. Cards are therefore
 * one-up. Every other Footage convention is preserved.
 *
 * **Deliberately NOT mirrored from Footage:** the Import affordance (there is no
 * audio ingest path to call — `project.sources` is video-only at the schema and
 * at both writers), drag-to-timeline, and the sort menu (audio carries no
 * `sourceCreatedAt`, and lane/start order is already meaningful).
 *
 * **Playback is deliberately the boring path.** Each card is a plain
 * `<audio controls preload="none">`, exactly like the comparison players in the
 * editor's AudioPolishModal. It must stay that way: the editor's transport owns
 * its own media elements through a shared AudioContext, and
 * `createMediaElementSource()` can only be called once per element — routing
 * these cards through that machinery would break timeline sound outright.
 *
 * **Known, accepted behaviour:** starting a card's player does NOT pause the
 * editor's transport, so the two can overlap audibly. The editor package
 * exposes no transport handle across the `slots.mediaPanel` boundary (the
 * public `createPlaybackClock` is a playhead-time store with no play/pause, and
 * `useVideoPlayback` would mount a SECOND transport rather than drive the live
 * one), and inventing a new host->package seam for this panel is not worth it.
 * The same is already true of AudioPolishModal's players. Within this panel the
 * cards do cooperate: starting one pauses the others, via plain DOM.
 */
export default function AudioPanel({
  tracks,
  voiceover,
  usedSrcs,
  durationBySrc,
  fileUrl,
  projectId,
  getWaveformPeaks,
}: AudioPanelProps) {
  const gridRef = useRef<HTMLDivElement | null>(null)
  const items = buildAudioItems({ tracks, voiceover, usedSrcs })

  // One audition at a time inside this panel. Plain DOM over the cards we own —
  // no shared state, no Web Audio, and nothing that reaches the transport.
  const pauseOtherCards = (playing: EventTarget | null) => {
    const els = gridRef.current?.querySelectorAll('audio') ?? []
    for (const el of els) {
      if (el !== playing) el.pause()
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div ref={gridRef} className="flex-1 min-h-0 overflow-y-auto p-2">
        {items.length === 0 ? (
          <p className="text-xs text-gray-600 text-center mt-4 px-2 leading-relaxed">
            No audio in this project yet.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {items.map(item => {
              const duration = item.duration ?? durationBySrc?.get(item.path)
              return (
                <div
                  key={item.key}
                  className="group relative rounded overflow-hidden border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
                  data-testid="audio-card"
                  data-placed={item.placed ? 'true' : 'false'}
                  title={`${item.name} — ${kindLabel(item.kind)}`}
                >
                  <div className="relative w-full aspect-video bg-gray-800 flex items-center justify-center">
                    {projectId && getWaveformPeaks ? (
                      <AudioWaveformPreview
                        path={item.path}
                        projectId={projectId}
                        getWaveformPeaks={getWaveformPeaks}
                      />
                    ) : (
                      <AudioLines size={18} className="text-gray-400" />
                    )}
                    {item.placed ? (
                      <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-medium leading-none">
                        Added
                      </span>
                    ) : (
                      <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/40 text-gray-300 text-[10px] font-medium leading-none">
                        Not placed
                      </span>
                    )}
                    {duration != null && (
                      <span className="absolute top-1 right-1 px-1 py-0.5 rounded bg-black/70 text-white text-[10px] font-mono leading-none">
                        {formatDuration(duration)}
                      </span>
                    )}
                    {item.muted && (
                      <span
                        className="absolute bottom-1 left-1 inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-black/70 text-white text-[10px] font-medium leading-none"
                        title="Muted on the timeline — the player below still plays it"
                      >
                        <VolumeX size={9} aria-hidden="true" />
                        Muted
                      </span>
                    )}
                  </div>
                  <div className="px-1.5 py-1">
                    <p className="text-xs text-gray-600 dark:text-gray-400 truncate" title={item.name}>
                      {item.name}
                    </p>
                    <p className="text-[10px] text-gray-500 truncate">
                      {kindLabel(item.kind)}
                      {item.trackType ? ` · ${item.trackType}` : ''}
                      {item.placement ? ` · ${item.placement}` : ''}
                    </p>
                    <audio
                      controls
                      preload="none"
                      src={fileUrl(item.path)}
                      aria-label={`Audition ${item.name}`}
                      onPlay={e => pauseOtherCards(e.currentTarget)}
                      className="w-full h-7 mt-1"
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
