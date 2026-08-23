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
 * `track.src` (audio tracks have no proxies), windowed to the track's own
 * trim.
 *
 * Clips are NOT windowed at fetch time. The editing proxy is the WHOLE
 * source, never trimmed server-side, so it is shared, unwindowed data every
 * clip pointing at that `proxySrc` can reuse regardless of which clip, or
 * which trim, is asking — `clipColumns` fetches (and caches) it ONCE, keyed
 * by src alone, and slices the clip's own [inPoint, outPoint] window out of
 * it locally. Before this, the fetch itself was windowed and keyed by
 * `(item.id, window)`, so splitting a clip (new ids) or trimming it (a new
 * window) changed the key, forced a re-decode, and flashed the waveform
 * blank for a frame — even though the underlying proxy data hadn't changed
 * at all.
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
import { timeToX, type Viewport } from './viewport'

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
 * against. `duration <= 0` is the fully-collapsed-trim case — callers skip
 * drawing rather than fetch/render a degenerate window.
 */
export function audioTrackSourceWindow(track: AudioTrack): { start: number; duration: number } {
  const start = track.inPoint ?? 0
  // outPoint present → exact window. Absent → for 1:1 audio the clip's timeline
  // span IS its source-window duration; using end-start avoids treating
  // sourceDuration (a length) as an absolute out-point, which goes negative for
  // a split clip whose right half has inPoint>0 and no outPoint (blank waveform).
  const duration = track.outPoint != null
    ? Math.max(0, track.outPoint - start)
    : Math.max(0, track.end - track.start)
  return { start, duration }
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
  /** Muted video-track clip bars: dimmer than `clip`, but still readable so
   *  the waveform shape survives on top of the darker muted scrim below. */
  clipMuted: 'rgba(255,255,255,0.3)',
  /** Muted band: a distinctly DARKER scrim than `clipBand` (not the old faint
   *  lighten, which read almost identical to an unmuted clip), so a muted
   *  clip's audio region visibly dims and reads as "off" at a glance. */
  clipBandMuted: 'rgba(0,0,0,0.45)',
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
 *  reads as "no audio here" rather than as missing data. `muted` swaps in the
 *  grayed `clipMuted`/`clipBandMuted` pair — the same mute cue `drawAudioItem`
 *  already gives audio-lane bars, extended to video-track clip waveforms. */
export function drawClipWaveform(ctx: DrawContext, rect: Rect, columns: WaveformColumn[], muted = false): void {
  const band = clipWaveformBand(rect)
  if (band.height <= 0 || band.width <= 0) return
  ctx.fillStyle = muted ? WAVEFORM_COLORS.clipBandMuted : WAVEFORM_COLORS.clipBand
  ctx.fillRect(band.x, band.y, band.width, band.height)
  drawWaveformBars(ctx, band, columns, muted ? WAVEFORM_COLORS.clipMuted : WAVEFORM_COLORS.clip)
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
  /** Needed by `clipColumns` to recover a clip's FULL on-screen span
   *  (`item.start`..`item.end` mapped through this, unclamped) — the `rect`
   *  it's handed is already clamped to the visible surface and inset by the
   *  clip-body gutter (see `visibleClipSampleRange`), so `pxPerSecond` alone
   *  isn't enough; `scrollSeconds` is what says WHICH slice of a long clip is
   *  currently on screen. Not consulted by `audioColumns`, which positions
   *  its fetched window within the bar rect it's handed directly rather than
   *  against the clip's own full span. */
  viewport: Viewport
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
 * The on-screen [left, left+width) span of a start..end timeline range,
 * unclamped — a clip's or audio track's own true screen extent, NOT the
 * surface-clamped rect the row/lane painter actually draws into. Shared by
 * `visibleSpanFraction` below and (for audio bars) `audioColumns` directly,
 * which needs it a second time to POSITION the visible slice it draws.
 *
 * `null` for a degenerate (non-positive) span — nothing to divide by.
 */
function fullSpanX(start: number, end: number, viewport: Viewport): { left: number; width: number } | null {
  const left = timeToX(start, viewport)
  const width = timeToX(end, viewport) - left
  return width > 0 ? { left, width } : null
}

/**
 * Fraction [f0, f1] of a start..end timeline range's own FULL on-screen span
 * (see `fullSpanX`) that the CLAMPED `rect` it was actually handed to draw
 * into covers. Shared by `visibleClipSampleRange` (where this fraction maps
 * directly onto the fetched peaks array) and `audioColumns` (where it maps
 * onto the trim WINDOW first — one step further removed from the sample
 * array, because the fetched data can itself be a clamped sub-range of that
 * window; see `sourceTimeToBarFraction`).
 *
 * Before either caller accounted for this, they resampled/positioned using
 * the WHOLE clip/track's data against whatever width `rect` happened to be —
 * correct only while the whole clip/track fit on screen, and pinned to "the
 * whole thing" at every scroll position once it didn't (long clip or track:
 * the waveform never changed as you scrolled through it, only the filmstrip
 * or ruler above it did).
 *
 * `null` for a degenerate (zero-width) full span — nothing to divide by.
 */
function visibleSpanFraction(start: number, end: number, rect: Rect, viewport: Viewport): { f0: number; f1: number } | null {
  const span = fullSpanX(start, end, viewport)
  if (!span) return null
  // Clamped to [0, 1]: `rect` is the drawn body, which can only ever be a
  // sub-span of the full extent, but float rounding at the very edges could
  // otherwise nudge a fraction a hair outside that range.
  const f0 = Math.max(0, Math.min(1, (rect.x - span.left) / span.width))
  const f1 = Math.max(0, Math.min(1, (rect.x + rect.width - span.left) / span.width))
  return { f0, f1 }
}

/**
 * The [s0, s1) sample-index sub-range of a clip's peaks that the CLAMPED,
 * gutter-inset `rect` actually shows on screen. Mirrors `filmstrips.ts`'s
 * `clipTiles`, which derives its tile positions from the clip's full
 * on-screen span rather than from whatever clamped rect the row painter
 * happened to hand it.
 *
 * `null` for a degenerate (zero-width) full span or empty peaks — nothing to
 * divide by; the caller falls back to treating the whole array as visible.
 */
export function visibleClipSampleRange(
  item: VisualItem,
  rect: Rect,
  viewport: Viewport,
  totalSamples: number,
): { s0: number; s1: number } | null {
  if (totalSamples <= 0) return null
  const frac = visibleSpanFraction(item.start, item.end, rect, viewport)
  if (!frac) return null

  const s0 = Math.min(totalSamples, Math.floor(frac.f0 * totalSamples))
  const s1 = Math.max(s0, Math.min(totalSamples, Math.ceil(frac.f1 * totalSamples)))
  return { s0, s1 }
}

/**
 * Slice a WHOLE-proxy peaks array down to a clip's own trim window —
 * `[window.start, window.start + window.duration]` expressed as a fraction
 * of the proxy's own total duration — before any viewport slicing happens.
 * `clipColumns` applies two nested fractions in sequence: proxy → clip trim
 * window (this function) → visible viewport slice (`visibleClipSampleRange`,
 * applied afterward, on the RESULT of this one).
 *
 * `null` when `proxyDuration` isn't usable (`<= 0`) — nothing to divide by,
 * and the caller falls back to fetching this clip's own windowed peaks
 * rather than guess a fraction against an unknown total.
 */
function sliceToSourceWindow(
  peaks: number[],
  proxyDuration: number,
  window: { start: number; duration: number },
): number[] | null {
  if (!(proxyDuration > 0)) return null
  const totalSamples = Math.floor(peaks.length / 2)
  if (totalSamples <= 0) return peaks
  const f0 = Math.max(0, Math.min(1, window.start / proxyDuration))
  const f1 = Math.max(0, Math.min(1, (window.start + window.duration) / proxyDuration))
  const s0 = Math.min(totalSamples, Math.floor(f0 * totalSamples))
  const s1 = Math.max(s0, Math.min(totalSamples, Math.ceil(f1 * totalSamples)))
  return peaks.slice(s0 * 2, s1 * 2)
}

/**
 * Fetch state, keyed as `projectId|ownerId|src|start|duration|bucket` — the
 * same shape the montaj adapter's own peaks cache uses
 * (`projectId:src:start:duration:bucket`, see `montajAdapter.ts`'s
 * `getWaveformPeaks`), plus an owner id since one store instance serves
 * every clip and audio track on the surface.
 *
 * `ownerId`/`start`/`duration` are OMITTED from a CLIP's key — see
 * `clipColumns` — because the editing proxy is shared, unwindowed data every
 * clip pointing at that `proxySrc` can reuse regardless of which clip or
 * which trim is asking; splitting or trimming a clip must not change its
 * key. Audio-lane fetches keep the FULL key (owner + window): audio tracks
 * have their own per-take sources, never a shared proxy, so there is nothing
 * to gain by dropping either field there and doing so would only make an
 * audio track's own trim stop invalidating its own cache entry.
 *
 * One instance lives for the lifetime of a mounted `TimelineCanvas` (held in
 * a ref), so fetches already in flight or resolved survive across redraws.
 *
 * Rendering always prefers the highest-resolution READY entry across ALL
 * three buckets for a key, not just the one matching the current zoom's
 * target bucket — that is what makes zoom-OUT free (a previously-fetched
 * 800-bucket entry renders fine downsampled by `resamplePeaksToColumns`, no
 * new fetch) while zoom-IN still fetches the next bucket up exactly once.
 */
export class WaveformPeaksStore {
  private entries = new Map<string, Entry>()

  /**
   * Clip waveforms fetch from `item.proxySrc` ONLY (never `item.src`) and
   * only for `type: 'video'` items — images/overlays have no audio. Absent
   * proxy, absent adapter method, or a non-positive window all resolve to
   * `null` (no waveform yet), never an error.
   *
   * The fetch itself is UNWINDOWED — the whole proxy — and keyed by src
   * alone (see `WaveformPeaksStore`'s own doc), so every clip, and every
   * split/trim of every clip, sharing one `proxySrc` resolves from the SAME
   * cache entry: no re-decode, no blank-frame flash when a clip is split or
   * trimmed. The clip's own [inPoint, outPoint] window is then sliced out of
   * that shared data LOCALLY (`sliceToSourceWindow`), and the existing
   * viewport slice (`visibleClipSampleRange`) applied on top of THAT — two
   * nested fractions, proxy → clip window → visible span.
   */
  clipColumns(item: VisualItem, rect: Rect, ctx: WaveformQueryContext): WaveformColumn[] | null {
    if (item.type !== 'video' || !item.proxySrc || !ctx.getWaveformPeaks) return null
    if (rect.width <= 0) return null
    const window = clipSourceWindow(item)
    if (window && window.duration <= 0) return null

    const whole = this.resolve({ src: item.proxySrc }, ctx)
    if (!whole) return null

    const columns = Math.max(1, Math.round(rect.width))
    let peaks = whole.peaks
    if (window) {
      // Prefer the fetch's OWN duration — since this is an unwindowed
      // request, it should already be the proxy's true total length —
      // falling back to the item's own record of it only if that's
      // unusable (e.g. a step that doesn't report duration on an
      // unwindowed fetch).
      const proxyDuration = whole.duration > 0 ? whole.duration : (item.sourceDuration ?? 0)
      const sliced = sliceToSourceWindow(whole.peaks, proxyDuration, window)
      if (sliced) {
        peaks = sliced
      } else {
        // Duration unknowable from either the fetch or the item — no way to
        // map the trim window onto the whole-proxy peaks reliably. Falls
        // back to the pre-fix behaviour: fetch (and cache) this clip's OWN
        // windowed peaks, keyed by id + window. No cross-clip sharing in
        // this rare case, but still the correct picture rather than a
        // guess.
        const windowed = this.resolve({ ownerId: item.id, src: item.proxySrc, start: window.start, duration: window.duration }, ctx)
        if (!windowed) return null
        peaks = windowed.peaks
      }
    }

    const totalSamples = Math.floor(peaks.length / 2)
    const span = visibleClipSampleRange(item, rect, ctx.viewport, totalSamples)
    // No full span to divide by (e.g. zero pxPerSecond) — fall back to the
    // pre-fix behaviour, the whole (already window-sliced) clip resampled
    // into `columns`, rather than drawing nothing.
    if (!span) return resamplePeaksToColumns(peaks, columns)
    const slice = peaks.slice(span.s0 * 2, span.s1 * 2)
    return resamplePeaksToColumns(slice, columns)
  }

  /**
   * Audio-lane waveforms fetch from `track.src` (audio tracks have no
   * proxies), windowed to the track's own trim (`audioTrackSourceWindow`) —
   * NOT to whatever is currently visible, so scrolling never re-fetches.
   * Returns the VISIBLE slice's own bar-relative sub-rect alongside its
   * columns, so it draws in the right place rather than stretched across
   * whatever rect the caller happened to hand in.
   *
   * Two things had to be reconciled to get there, both expressed as
   * fractions of the track's trim WINDOW so they compose with one `Math.max`/
   * `Math.min`:
   *  - `dataX0..dataX1` (ported from before this fix): the fraction of the
   *    window the FETCHED data actually covers — the step can return less
   *    than requested (e.g. clamped near the end of a source file).
   *  - `visible.f0..f1` (new): the fraction of the track's own FULL
   *    on-screen span (`track.start`..`track.end` through `viewport`,
   *    unclamped) that the CLAMPED `rect` we were handed to draw into
   *    actually shows. Before this existed, `rect` was taken at face value
   *    as "the whole bar" — fine while the bar fit on screen, but once a
   *    long track ran off both edges, the ENTIRE window got squeezed into
   *    whatever sliver was visible, unchanged as you scrolled through it
   *    (the same bug `visibleClipSampleRange` fixed for clip waveforms).
   * Only their overlap is fetched data AND currently visible — anything else
   * is either data we don't have or off screen, neither worth drawing.
   */
  audioColumns(track: AudioTrack, rect: Rect, ctx: WaveformQueryContext): { rect: Rect; columns: WaveformColumn[] } | null {
    if (!ctx.getWaveformPeaks || rect.width <= 0) return null
    const window = audioTrackSourceWindow(track)
    if (window.duration <= 0) return null

    const data = this.resolve({ ownerId: track.id, src: track.src, start: window.start, duration: window.duration }, ctx)
    if (!data) return null

    const dataX0 = sourceTimeToBarFraction(data.start, window)
    const dataX1 = sourceTimeToBarFraction(data.start + data.duration, window)
    // A degenerate/absent full span (e.g. `track.end <= track.start`) falls
    // back to "the whole window is visible" — the pre-fix assumption — rather
    // than drawing nothing over what may still be a perfectly good `rect`.
    const visible = visibleSpanFraction(track.start, track.end, rect, ctx.viewport) ?? { f0: 0, f1: 1 }

    const f0 = Math.max(dataX0, visible.f0)
    const f1 = Math.min(dataX1, visible.f1)
    if (f1 <= f0) return null

    // Position the visible slice against the bar's TRUE full on-screen span,
    // not the clamped `rect` — that's what lets it land at the right x once
    // the bar runs off an edge. Falls back to `rect` itself alongside the
    // same fallback `visible` used above.
    const full = fullSpanX(track.start, track.end, ctx.viewport)
    const subRect: Rect = full
      ? { x: full.left + f0 * full.width, y: rect.y, width: Math.max(0, (f1 - f0) * full.width), height: rect.height }
      : { x: rect.x + f0 * rect.width, y: rect.y, width: Math.max(0, (f1 - f0) * rect.width), height: rect.height }
    if (subRect.width <= 0) return null

    // Slice the fetched peaks down to just the visible fraction of the
    // fetched span (`f0..f1` relative to `dataX0..dataX1`) before resampling
    // — only ever the columns actually drawn get computed, mirroring
    // `visibleClipSampleRange`.
    const totalSamples = Math.floor(data.peaks.length / 2)
    const dataSpan = dataX1 - dataX0
    const df0 = dataSpan > 0 ? (f0 - dataX0) / dataSpan : 0
    const df1 = dataSpan > 0 ? (f1 - dataX0) / dataSpan : 1
    const s0 = Math.max(0, Math.min(totalSamples, Math.floor(df0 * totalSamples)))
    const s1 = Math.max(s0, Math.min(totalSamples, Math.ceil(df1 * totalSamples)))
    const slice = data.peaks.slice(s0 * 2, s1 * 2)

    const columns = resamplePeaksToColumns(slice, Math.max(1, Math.round(subRect.width)))
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
    key: { ownerId?: string; src: string; start?: number; duration?: number },
    ctx: WaveformQueryContext,
  ): PeaksData | null {
    const bucket = resolveBucket(ctx.pxPerSecond)
    const base = `${ctx.projectId}|${key.ownerId ?? ''}|${key.src}|${key.start ?? ''}|${key.duration ?? ''}`

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
