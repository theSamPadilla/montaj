/**
 * Canvas waveform rendering (SP5 T6) — turns fetched `PeaksData` into pixel
 * columns and paints them as the content layer `drawClipRect`/`drawAudioItem`
 * (draw.ts) call between the fill/border and the label.
 *
 * ── Two render targets, one pipeline ─────────────────────────────────────
 * - Audio lanes: a full-bar waveform, replacing the DOM path's fixed PNG
 *   chunks (`AudioWaveformLayer.tsx`) in canvas mode only — legacy DOM mode
 *   is untouched. `audioTrackSourceWindow` / `sourceTimeToBarFraction` below
 *   are ports of that component's trim-alignment math (lines 75–89): same
 *   inputs, same positioning, just expressed as 0–1 fractions instead of CSS
 *   percentages so the canvas painter can multiply by `rect.width` directly.
 * - Visual-track clips: the LOWER HALF of the clip rect (`clip-bands.ts`),
 *   with the filmstrip taking the upper half. This began as a 10px strip
 *   under a "new UI, stay understated" brief; it grew because the strip was
 *   too small to cut against — at half a clip the waveform is the primary
 *   thing you read on the base track, so it gets a darkened band and enough
 *   alpha to be legible rather than merely present.
 *
 * ── Input-selection + fetch policy (SP5 plan decision) ───────────────────
 * Clips fetch from `item.proxySrc` ONLY — no fallback to `item.src` — so a
 * clip with no proxy yet simply renders no waveform (graceful, no spinner,
 * no error) until the import pipeline delivers one. Audio lanes fetch from
 * `track.src` (audio tracks have no proxies). Both are windowed to the
 * item's/track's trimmed source range.
 *
 * ── Zoom-crisp resolution (bucket scheme) ─────────────────────────────────
 * `resolveBucket` picks 50/200/800 from the current px/second. `resolve()`
 * (private, on `WaveformPeaksStore`) fetches the needed bucket only when
 * nothing at that bucket-or-higher is already ready/loading — so zooming
 * OUT never re-fetches (a higher bucket already cached renders fine
 * downsampled; see `resamplePeaksToColumns`), and zooming IN fetches exactly
 * once per bucket crossed, keeping the previous bucket on screen until the
 * new one resolves.
 */
import type { AudioTrack, VisualItem } from '../../../schema'
import type { GetWaveformPeaksArgs, PeaksData, PeaksResolution } from '../../../types'
import { clipBands } from './clip-bands'
import type { DrawContext, Rect } from './draw'

// ── Resolution buckets ───────────────────────────────────────────────────

export const PEAKS_BUCKETS: PeaksResolution[] = [50, 200, 800]

/**
 * Resolution bucket for the current zoom: 50 while `pxPerSecond` ≤ 50, 200
 * while ≤ 200, 800 above that. Blockiness stays ≤1px up to 800px/s; beyond
 * that — up to the viewport's `MAX_PX_PER_SECOND` (2000) — mild blockiness
 * is accepted since there is no higher bucket to fetch.
 */
export function resolveBucket(pxPerSecond: number): PeaksResolution {
  if (pxPerSecond <= 50) return 50
  if (pxPerSecond <= 200) return 200
  return 800
}

// ── Trim-alignment math (ported from AudioWaveformLayer.tsx:75-89) ───────

/**
 * The source-time window `getWaveformPeaks` should fetch for an audio
 * track's lane waveform, and the window `sourceTimeToBarFraction` positions
 * against. Ported verbatim from `AudioWaveformLayer.tsx`'s
 * `sourceDur`/`inPt`/`outPt`/`visibleSpan` (lines 75–78): same defaulting,
 * same result, so a trimmed/offset audio track shows the same source-time
 * span on canvas that it shows in the DOM path. `duration <= 0` is that
 * component's `PlainFallback` case (a fully collapsed trim) — callers skip
 * drawing rather than fetch/render a degenerate window.
 */
export function audioTrackSourceWindow(track: AudioTrack): { start: number; duration: number } {
  const sourceDuration = track.sourceDuration ?? (track.end - track.start)
  const inPoint = track.inPoint ?? 0
  const outPoint = track.outPoint ?? sourceDuration
  return { start: inPoint, duration: outPoint - inPoint }
}

/**
 * Fraction of the bar [0,1] a source-time point maps to, given the track's
 * trim window. Ported from `AudioWaveformLayer.tsx`'s `leftPct` (lines
 * 88–89: `(chunk.start - inPt) / visibleSpan`) — identical formula, just
 * returned as a 0–1 fraction instead of `${...}%` so the canvas painter
 * multiplies by `rect.width` instead of writing `element.style.left`.
 */
export function sourceTimeToBarFraction(sourceTime: number, window: { start: number; duration: number }): number {
  if (window.duration <= 0) return 0
  return (sourceTime - window.start) / window.duration
}

/**
 * The source-time window to fetch for a clip's per-item waveform.
 * `undefined` means "no windowing — fetch the whole proxy": with neither
 * `inPoint` nor `outPoint` set there is no trim to narrow to, and the clip's
 * own project-timeline duration is not a reliable stand-in for the proxy's
 * source duration, so the request omits `start`/`duration` entirely rather
 * than guess. Present `inPoint`/`outPoint` narrow it exactly, mirroring the
 * audio-lane window above. A degenerate `outPoint <= inPoint` yields
 * `duration: 0`; callers skip drawing on that, same as the audio path.
 */
export function clipSourceWindow(item: VisualItem): { start: number; duration: number } | undefined {
  if (item.inPoint == null && item.outPoint == null) return undefined
  const start = item.inPoint ?? 0
  const outPoint = item.outPoint ?? item.sourceDuration ?? start + Math.max(0, item.end - item.start)
  return { start, duration: Math.max(0, outPoint - start) }
}

// ── Resample: peaks → pixel columns ───────────────────────────────────────

export interface WaveformColumn {
  /** Normalized to roughly [-1, 1] (int16 value / 32768). */
  min: number
  max: number
}

/** `PeaksData.peaks` values are in int16 range. */
const INT16_SCALE = 32768

/**
 * Resample an interleaved `[min, max, min, max, ...]` peaks array to exactly
 * `columns` pixel-column min/max pairs. One formula covers both zoom
 * regimes the bucket scheme describes:
 *
 *   samples-per-px > 1 (zoomed out relative to the data): each column
 *   aggregates (min of mins, max of maxes) over more than one source sample.
 *
 *   samples-per-px < 1 (zoomed in past the data's resolution): consecutive
 *   columns share the same source sample (`Math.floor` repeats it), giving
 *   the accepted "mild blockiness" at the top of the zoom range rather than
 *   a smoothed/interpolated curve — matching the bucket scheme's own
 *   blockiness language rather than inventing a shape the data doesn't have.
 *
 * Pure: no knowledge of seconds, buckets, or DOM — just an array and a
 * column count, so it is trivial to hand known fixtures in tests.
 */
export function resamplePeaksToColumns(peaks: number[], columns: number): WaveformColumn[] {
  const totalSamples = Math.floor(peaks.length / 2)
  if (columns <= 0 || totalSamples <= 0) return []

  const samplesPerColumn = totalSamples / columns
  const result: WaveformColumn[] = []
  for (let i = 0; i < columns; i++) {
    let startIdx = Math.floor(i * samplesPerColumn)
    if (startIdx >= totalSamples) startIdx = totalSamples - 1
    let endIdx = Math.floor((i + 1) * samplesPerColumn)
    if (endIdx <= startIdx) endIdx = startIdx + 1
    if (endIdx > totalSamples) endIdx = totalSamples

    let min = Infinity
    let max = -Infinity
    for (let s = startIdx; s < endIdx; s++) {
      const mn = peaks[s * 2]
      const mx = peaks[s * 2 + 1]
      if (mn < min) min = mn
      if (mx > max) max = mx
    }
    result.push({ min: min / INT16_SCALE, max: max / INT16_SCALE })
  }
  return result
}

// ── Drawing primitives ───────────────────────────────────────────────────

export const WAVEFORM_COLORS = {
  /** Translucent white so the bars read over any of `TRACK_PALETTE`'s six clip
   *  hues without needing a per-palette variant. Raised from the original
   *  0.35: at 10px the strip was a texture and low alpha kept it from
   *  competing with the label, but across half a clip it is the thing you cut
   *  against and needs to read as a waveform. */
  clip: 'rgba(255,255,255,0.6)',
  /** Darkens the waveform band relative to the clip fill so the lower half
   *  reads as its own lane rather than bars floating on the clip — the
   *  separation CapCut gets from a distinct band colour. */
  clipBand: 'rgba(0,0,0,0.22)',
  /** Sits inside `AudioTrackRow`'s emerald bar; brighter than the fill so it
   *  reads as drawn "on top of" it, echoing `TIMELINE_COLORS.audioRing`. */
  audioLane: 'rgba(167,243,208,0.75)',
} as const

/** Paint one row of min/max columns as vertical bars centered in `rect`,
 *  amplitude scaled to `rect.height / 2`. The shared primitive both
 *  `drawClipWaveform` and `drawAudioLaneWaveform` style differently. */
export function drawWaveformBars(ctx: DrawContext, rect: Rect, columns: WaveformColumn[], color: string): void {
  if (rect.width <= 0 || rect.height <= 0 || columns.length === 0) return
  const centerY = rect.y + rect.height / 2
  const halfHeight = rect.height / 2
  const colWidth = rect.width / columns.length

  ctx.fillStyle = color
  for (let i = 0; i < columns.length; i++) {
    const { min, max } = columns[i]
    const hi = Math.max(min, max)
    const lo = Math.min(min, max)
    const top = centerY - hi * halfHeight
    const bottom = centerY - lo * halfHeight
    const x = rect.x + i * colWidth
    ctx.fillRect(x, top, Math.max(1, colWidth), Math.max(1, bottom - top))
  }
}

/** The lower half of a clip rect the waveform draws into — `clip-bands.ts` owns
 *  the split, so this is a pass-through kept as the name the painter and its
 *  tests already reach for. */
export function clipWaveformBand(rect: Rect): Rect {
  return clipBands(rect).waveform
}

/** Paint the clip's waveform half: a darkened band, then the bars centered in
 *  it. The band is painted even where the bars are silent, so a quiet passage
 *  reads as "no audio here" rather than as missing data. */
export function drawClipWaveform(ctx: DrawContext, rect: Rect, columns: WaveformColumn[]): void {
  const band = clipWaveformBand(rect)
  if (band.height <= 0 || band.width <= 0) return
  ctx.fillStyle = WAVEFORM_COLORS.clipBand
  ctx.fillRect(band.x, band.y, band.width, band.height)
  drawWaveformBars(ctx, band, columns, WAVEFORM_COLORS.clip)
}

/** Full-bar audio-lane waveform. `rect` is already the fetched window's
 *  bar-relative sub-rect (see `WaveformPeaksStore.audioColumns`), so this
 *  paints edge-to-edge of whatever span the data actually covers. */
export function drawAudioLaneWaveform(ctx: DrawContext, rect: Rect, columns: WaveformColumn[]): void {
  drawWaveformBars(ctx, rect, columns, WAVEFORM_COLORS.audioLane)
}

// ── Fetch-state store ────────────────────────────────────────────────────

/** How long an errored fetch stays in cooldown before the next call may retry
 *  it. Both canvas stores are polled from paint (the overlay layer repaints at
 *  ~60Hz during playback; the content layer once per pointer move during a
 *  drag), so retry-on-next-call alone turns a persistent failure into a
 *  request storm. Shared with filmstrips.ts. */
export const FETCH_RETRY_COOLDOWN_MS = 5000

type EntryStatus = 'loading' | 'ready' | 'error'

interface Entry {
  status: EntryStatus
  data: PeaksData | null
  erroredAt?: number
}

export interface WaveformQueryContext {
  projectId: string
  /** Absent → no waveforms anywhere (host adapter doesn't implement it). */
  getWaveformPeaks?: (args: GetWaveformPeaksArgs) => Promise<PeaksData>
  pxPerSecond: number
  /** Called once when new data lands for a key that was previously
   *  loading/absent — the caller's cue to `requestRedraw('content')`. */
  onReady: () => void
}

/** What `drawTimelineContent` (draw.ts) needs from T6, kept as an interface
 *  so draw.ts only takes a type-only dependency on this module. */
export interface WaveformSceneLookup {
  clipColumns(item: VisualItem, rect: Rect): WaveformColumn[] | null
  audioColumns(track: AudioTrack, rect: Rect): { rect: Rect; columns: WaveformColumn[] } | null
}

/**
 * Per-(owner, src, window, bucket) fetch state, keyed exactly as the
 * montaj adapter's own peaks cache is (`projectId:src:start:duration:bucket`,
 * see `montajAdapter.ts`'s `getWaveformPeaks`), plus the owner id since one
 * store instance serves every clip and audio track on the surface. One
 * instance lives for the lifetime of a mounted `TimelineCanvas` (held in a
 * ref), so fetches already in flight or resolved survive across redraws.
 *
 * Rendering always prefers the highest-resolution READY entry across ALL
 * three buckets for a key, not just the one matching the current zoom's
 * target bucket — that is what makes zoom-OUT free (a previously-fetched
 * 800-bucket entry renders fine downsampled by `resamplePeaksToColumns`, no
 * new fetch) while zoom-IN still fetches the next bucket up exactly once.
 */
export class WaveformPeaksStore {
  private entries = new Map<string, Entry>()

  /** Clip waveforms fetch from `item.proxySrc` ONLY (never `item.src`) and
   *  only for `type: 'video'` items — images/overlays have no audio. Absent
   *  proxy, absent adapter method, or a non-positive window all resolve to
   *  `null` (no waveform yet), never an error. */
  clipColumns(item: VisualItem, rect: Rect, ctx: WaveformQueryContext): WaveformColumn[] | null {
    if (item.type !== 'video' || !item.proxySrc || !ctx.getWaveformPeaks) return null
    if (rect.width <= 0) return null
    const window = clipSourceWindow(item)
    if (window && window.duration <= 0) return null

    const data = this.resolve({ ownerId: item.id, src: item.proxySrc, start: window?.start, duration: window?.duration }, ctx)
    if (!data) return null
    return resamplePeaksToColumns(data.peaks, Math.max(1, Math.round(rect.width)))
  }

  /** Audio-lane waveforms fetch from `track.src` (audio tracks have no
   *  proxies). Returns the fetched window's own bar-relative sub-rect
   *  (via `sourceTimeToBarFraction`) alongside its columns, so a returned
   *  window that doesn't exactly match the request (e.g. clamped near the
   *  end of a source) still draws in the right place rather than stretched
   *  across the whole bar. */
  audioColumns(track: AudioTrack, rect: Rect, ctx: WaveformQueryContext): { rect: Rect; columns: WaveformColumn[] } | null {
    if (!ctx.getWaveformPeaks || rect.width <= 0) return null
    const window = audioTrackSourceWindow(track)
    if (window.duration <= 0) return null

    const data = this.resolve({ ownerId: track.id, src: track.src, start: window.start, duration: window.duration }, ctx)
    if (!data) return null

    const x0 = sourceTimeToBarFraction(data.start, window)
    const x1 = sourceTimeToBarFraction(data.start + data.duration, window)
    const subRect: Rect = {
      x: rect.x + x0 * rect.width,
      y: rect.y,
      width: Math.max(0, (x1 - x0) * rect.width),
      height: rect.height,
    }
    if (subRect.width <= 0) return null
    const columns = resamplePeaksToColumns(data.peaks, Math.max(1, Math.round(subRect.width)))
    return { rect: subRect, columns }
  }

  /**
   * Look up the best already-fetched data for `key` and, if nothing at the
   * needed bucket or higher is ready/loading, kick off a fetch for it.
   * Errors are swallowed onto the entry (`status: 'error'`) — no throw, no
   * console noise, no retry loop of our own; because an errored entry is
   * neither `ready` nor `loading`, the NEXT call that still needs this key
   * (e.g. the next redraw for an unrelated reason) will attempt the fetch
   * again, same as the adapter's own evict-on-reject cache does one layer
   * down.
   */
  private resolve(
    key: { ownerId: string; src: string; start?: number; duration?: number },
    ctx: WaveformQueryContext,
  ): PeaksData | null {
    const bucket = resolveBucket(ctx.pxPerSecond)
    const base = `${ctx.projectId}|${key.ownerId}|${key.src}|${key.start ?? ''}|${key.duration ?? ''}`

    let best: PeaksData | null = null
    let covered = false
    for (const b of PEAKS_BUCKETS) {
      const entry = this.entries.get(`${base}|${b}`)
      if (entry?.status === 'ready' && entry.data) {
        // Compare by the DATA's actual samplesPerSecond, not the requested
        // bucket label — the step's total-samples clamp can step a request
        // down, and the clamp amount depends on window length, not which
        // bucket was asked for, so the requested label alone isn't a
        // reliable resolution ordering.
        if (!best || entry.data.samplesPerSecond > best.samplesPerSecond) best = entry.data
      }
      if (b >= bucket && (entry?.status === 'ready' || entry?.status === 'loading')) covered = true
      if (b >= bucket && entry?.status === 'error'
          && Date.now() - (entry.erroredAt ?? 0) < FETCH_RETRY_COOLDOWN_MS) covered = true
    }

    if (!covered) {
      const fetchKey = `${base}|${bucket}`
      const fetcher = ctx.getWaveformPeaks
      if (fetcher) {
        this.entries.set(fetchKey, { status: 'loading', data: null })
        fetcher({ projectId: ctx.projectId, src: key.src, samplesPerSecond: bucket, start: key.start, duration: key.duration })
          .then(data => {
            this.entries.set(fetchKey, { status: 'ready', data })
            ctx.onReady()
          })
          .catch(() => {
            this.entries.set(fetchKey, { status: 'error', data: null, erroredAt: Date.now() })
          })
      }
    }

    return best
  }
}
