import { useEffect, useState } from 'react'
import { FileVideo, AudioLines } from 'lucide-react'
import {
  FilmstripScrubber,
  type FilmstripIndex,
  type GetFilmstripArgs,
  type GetWaveformPeaksArgs,
  type PeaksData,
} from '@bycrux/editor'
import { basename } from '@/lib/utils'
import type { VisualItem } from '@/lib/types/schema'

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
 * Extension-stripped basename — `"IMG_0979.MOV"` -> `"IMG_0979"`. Used only
 * for the stem/substring comparisons in `isFootageInUse` below; kept local
 * (not `lib/utils`) since nothing else in the app needs it yet, matching this
 * file's existing duplicate-small-helpers convention (see VIDEO_EXTENSIONS
 * above).
 */
function stem(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * Is this audio-footage item already placed on the timeline? `usedSrcs` is
 * `project.audio.tracks[].src` — for a b-roll edit those are the PER-TAKE
 * files split out of the cleaned narration (see `skills/broll/SKILL.md`'s
 * "audio.tracks" section), named however the authoring agent chose to
 * (e.g. `vo_02_IMG_0979.wav`), never the raw submitted take or the
 * assembled/cleaned narration path verbatim. A plain `usedSrcs.has(path)`
 * only ever matches by coincidence — this is the stem-aware fix:
 *
 *  - The exact-path case is checked first and still wins outright, for any
 *    workflow that writes a used src straight through.
 *  - A submitted take (`IMG_0979.MOV`) is in use if ANY used src's basename
 *    CONTAINS the take's stem (`IMG_0979`) — the split-file naming convention
 *    embeds the source stem, so a substring check is the reliable link back
 *    to the take that produced it.
 *  - The assembled/cleaned narration (`voiceover_full_cut.wav`) is in use if
 *    a used src matches it by exact basename OR stem — covering a verbatim
 *    reference and one that differs only by extension.
 */
export function isFootageInUse(itemPath: string, usedSrcs: Set<string>): boolean {
  if (usedSrcs.has(itemPath)) return true
  const itemName = basename(itemPath)
  const itemStem = stem(itemPath)
  if (!itemStem) return false
  for (const used of usedSrcs) {
    const usedName = basename(used)
    if (usedName === itemName) return true
    if (stem(used) === itemStem) return true
    if (usedName.includes(itemStem)) return true
  }
  return false
}

/**
 * A submitted take's editing proxy, looked up by exact `src` match against
 * `project.sources` — the footage bin (b-roll clips), which is a SEPARATE
 * list from `voiceover.takes` (`project/init.py` stages takes under a
 * "voiceover" workspace category, never into `sources`). Most takes
 * therefore have no entry here and the card falls back to the FileVideo
 * icon; a match only happens when the same file was also imported as
 * footage.
 */
function findTakeProxy(
  path: string,
  sources: VisualItem[] | undefined,
): { proxySrc: string; sourceDuration: number } | null {
  const match = sources?.find(s => s.src === path)
  if (!match?.proxySrc) return null
  return { proxySrc: match.proxySrc, sourceDuration: match.sourceDuration ?? 0 }
}

// ── Waveform preview (audio-kind cards) ─────────────────────────────────────

/** `PeaksData.peaks` values are in int16 range (see `@bycrux/editor`'s PeaksData doc). */
const INT16_SCALE = 32768

/** Number of bars drawn in a card's mini waveform preview. */
const WAVEFORM_BAR_COUNT = 28

export interface WaveformBar {
  /** Normalized to roughly [-1, 1] (int16 value / 32768). */
  min: number
  max: number
}

/**
 * Downsample an interleaved `[min, max, min, max, ...]` peaks array (int16
 * range) into exactly `count` bar min/max pairs. A local, thumbnail-scale
 * reimplementation of editor-core's `resamplePeaksToColumns`
 * (`video/timeline/canvas/waveforms.ts`) — that module isn't part of
 * `@bycrux/editor`'s public API, and this package owns no waveform-rendering
 * code elsewhere to share it with.
 */
export function resamplePeaksToBars(peaks: number[], count: number): WaveformBar[] {
  const totalSamples = Math.floor(peaks.length / 2)
  if (count <= 0 || totalSamples <= 0) return []

  const samplesPerBar = totalSamples / count
  const bars: WaveformBar[] = []
  for (let i = 0; i < count; i++) {
    let start = Math.floor(i * samplesPerBar)
    if (start >= totalSamples) start = totalSamples - 1
    let end = Math.floor((i + 1) * samplesPerBar)
    if (end <= start) end = start + 1
    if (end > totalSamples) end = totalSamples

    let min = Infinity
    let max = -Infinity
    for (let s = start; s < end; s++) {
      const mn = peaks[s * 2]
      const mx = peaks[s * 2 + 1]
      if (mn < min) min = mn
      if (mx > max) max = mx
    }
    bars.push({ min: min / INT16_SCALE, max: max / INT16_SCALE })
  }
  return bars
}

type PeaksFetcher = (args: GetWaveformPeaksArgs) => Promise<PeaksData>

/**
 * Small waveform preview for a non-video audio card: fetches the whole
 * file's peaks at the cheapest bucket (50 samples/sec — the lowest of
 * `PeaksResolution`'s three) via the host adapter's `getWaveformPeaks`
 * (Montaj's `waveform_peaks` step; see `montajAdapter.ts`, which also
 * dedupes/caches this exact call by `projectId:src:...:samplesPerSecond`),
 * resamples to a fixed bar count, and renders them as a row of divs. Loading
 * keeps a dim AudioLines icon rather than a blank box; a rejected fetch
 * degrades to the same icon at full opacity, matching the pre-preview
 * fallback.
 */
function AudioWaveformPreview({
  path,
  projectId,
  getWaveformPeaks,
}: {
  path: string
  projectId: string
  getWaveformPeaks: PeaksFetcher
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [bars, setBars] = useState<WaveformBar[]>([])

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    getWaveformPeaks({ projectId, src: path, samplesPerSecond: 50 })
      .then(data => {
        if (cancelled) return
        setBars(resamplePeaksToBars(data.peaks, WAVEFORM_BAR_COUNT))
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [path, projectId, getWaveformPeaks])

  if (status === 'error') return <AudioLines size={18} className="text-gray-400" />
  if (status === 'loading' || bars.length === 0) {
    return <AudioLines size={18} className="text-gray-600 opacity-40" />
  }

  return (
    <div className="flex items-center justify-center gap-px w-full h-full px-2" data-testid="waveform-preview" aria-hidden="true">
      {bars.map((bar, i) => {
        const amplitude = Math.min(1, Math.max(Math.abs(bar.min), Math.abs(bar.max)))
        return (
          <div
            key={i}
            className="flex-1 min-w-px bg-gray-400 dark:bg-gray-500 rounded-sm"
            style={{ height: `${Math.max(8, amplitude * 100)}%` }}
          />
        )
      })}
    </div>
  )
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
  /** Audio `src` paths placed on the timeline (`project.audio.tracks[].src`) -> "Added" badge (stem-aware, see `isFootageInUse`). */
  usedSrcs: Set<string>
  /** Intrinsic durations by src, when known (from `audio.tracks[].sourceDuration`). */
  durationBySrc?: Map<string, number>
  /** Resolve a project-relative/absolute path to a fetchable URL, for the "open" affordance. */
  fileUrl: (path: string) => string
  /** Scopes the peaks/filmstrip caches for the preview fetches below. Required for either preview to render; absent leaves both kinds of card on their icon fallback. */
  projectId?: string
  /** Fetches downsampled waveform peaks for a small preview on non-video cards. Absent -> those cards keep the AudioLines icon. */
  getWaveformPeaks?: PeaksFetcher
  /** The project's footage-bin sources — used to find a submitted video take's proxy for a poster-frame thumbnail (matched by exact `src`). Absent -> takes keep the FileVideo icon. */
  sources?: VisualItem[]
  /** Fetches filmstrip tiles for the take poster thumbnail. Required alongside `sources` for video-take previews. */
  getFilmstrip?: (args: GetFilmstripArgs) => Promise<FilmstripIndex>
}

/**
 * The "Broll Audio" tab body: the audio footage behind a b-roll edit — the
 * files submitted for the voiceover plus the assembled/cleaned narration. Cards
 * mirror FootagePanel's shell and "Added" badge; display-only (no drag to the
 * timeline yet — the visual footage DND payload doesn't target the audio lane).
 * Audio-kind cards get a small waveform preview and video-take cards get a
 * poster-frame thumbnail when the underlying data is reachable (see
 * `AudioWaveformPreview` / `findTakeProxy`); otherwise they keep their icon.
 */
export default function BrollAudioPanel({
  voiceover,
  usedSrcs,
  durationBySrc,
  fileUrl,
  projectId,
  getWaveformPeaks,
  sources,
  getFilmstrip,
}: BrollAudioPanelProps) {
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
              const used = isFootageInUse(item.path, usedSrcs)
              const duration = durationBySrc?.get(item.path)
              const isVideo = item.kind === 'take' && isVideoPath(item.path)
              const takeProxy = isVideo ? findTakeProxy(item.path, sources) : null
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
                    {isVideo ? (
                      takeProxy && projectId && getFilmstrip ? (
                        <FilmstripScrubber
                          interactive={false}
                          fit="contain"
                          projectId={projectId}
                          proxySrc={takeProxy.proxySrc}
                          sourceDuration={takeProxy.sourceDuration}
                          getFilmstrip={getFilmstrip}
                          fileUrl={fileUrl}
                          className="absolute inset-0"
                          ariaLabel={name}
                        />
                      ) : (
                        <FileVideo size={18} className="text-gray-400" />
                      )
                    ) : projectId && getWaveformPeaks ? (
                      <AudioWaveformPreview path={item.path} projectId={projectId} getWaveformPeaks={getWaveformPeaks} />
                    ) : (
                      <AudioLines size={18} className="text-gray-400" />
                    )}
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
