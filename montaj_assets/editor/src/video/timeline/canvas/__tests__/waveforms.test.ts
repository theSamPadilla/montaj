/**
 * SP5 T6 — canvas waveform rendering: the ported DOM trim-alignment math, the
 * resample-to-pixel-columns algorithm, the bucketed fetch-state store, and
 * the draw hooks wired into `drawClipRect`/`drawAudioItem`/`drawTimelineContent`
 * (draw.ts).
 */
import { describe, it, expect, vi } from 'vitest'
import type { AudioTrack, VisualItem } from '../../../../schema'
import type { Project } from '../../../../types'
import type { PeaksData } from '../../../../types'
import {
  audioTrackSourceWindow,
  clipSourceWindow,
  clipWaveformBand,
  drawAudioLaneWaveform,
  drawClipWaveform,
  drawWaveformBars,
  FETCH_RETRY_COOLDOWN_MS,
  resamplePeaksToColumns,
  resolveBucket,
  sourceTimeToBarFraction,
  WaveformPeaksStore,
  WAVEFORM_COLORS,
  type WaveformColumn,
  type WaveformQueryContext,
} from '../waveforms'
import {
  computeTimelineLayout,
  drawAudioItem,
  drawClipRect,
  drawTimelineContent,
  type DrawContext,
  type Rect,
  type TimelineScene,
} from '../draw'
import type { Viewport } from '../viewport'

// ── Recording context (mirrors draw.test.ts's convention) ────────────────

interface RecordedCall { method: string; args: unknown[] }

function recordingContext() {
  const calls: RecordedCall[] = []
  const props: Record<string, unknown> = {}
  const proxy = new Proxy({}, {
    get(_t, prop: string) {
      if (prop in props) return props[prop]
      if (prop === 'createLinearGradient') {
        return (...args: unknown[]) => {
          calls.push({ method: 'createLinearGradient', args })
          return { addColorStop: (...s: unknown[]) => calls.push({ method: 'addColorStop', args: s }) } as unknown as CanvasGradient
        }
      }
      return (...args: unknown[]) => { calls.push({ method: prop, args }) }
    },
    set(_t, prop: string, value: unknown) {
      props[prop] = value
      calls.push({ method: `set:${prop}`, args: [value] })
      return true
    },
  }) as unknown as DrawContext
  return { ctx: proxy, calls, of: (m: string) => calls.filter(c => c.method === m) }
}

// ── Fixtures ─────────────────────────────────────────────────────────────

function clip(over: Partial<VisualItem> = {}): VisualItem {
  return { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 2, ...over }
}

function audio(over: Partial<AudioTrack> = {}): AudioTrack {
  return { id: 'a0', src: '/media/voice.mp3', start: 0, end: 2, ...over }
}

function rect(over: Partial<Rect> = {}): Rect {
  return { x: 0, y: 0, width: 100, height: 40, ...over }
}

function peaksFixture(over: Partial<PeaksData> = {}): PeaksData {
  return { samplesPerSecond: 50, start: 0, duration: 2, peaks: [-100, 100, -200, 200, -50, 50, -300, 300], ...over }
}

function queryCtx(over: Partial<WaveformQueryContext> = {}): WaveformQueryContext {
  return { projectId: 'p1', getWaveformPeaks: vi.fn().mockResolvedValue(peaksFixture()), pxPerSecond: 30, onReady: vi.fn(), ...over }
}

/** Flush the microtask queue so a mocked fetcher's `.then()`/`.catch()` runs. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

// ── Bucket selection ───────────────────────────────────────────────────────

describe('resolveBucket', () => {
  it('picks 50 up to and including 50 px/s', () => {
    expect(resolveBucket(1)).toBe(50)
    expect(resolveBucket(49.9)).toBe(50)
    expect(resolveBucket(50)).toBe(50)
  })

  it('picks 200 above 50 and up to 200 px/s', () => {
    expect(resolveBucket(50.1)).toBe(200)
    expect(resolveBucket(199.9)).toBe(200)
    expect(resolveBucket(200)).toBe(200)
  })

  it('picks 800 above 200 px/s, including up to the viewport max', () => {
    expect(resolveBucket(200.1)).toBe(800)
    expect(resolveBucket(800)).toBe(800)
    expect(resolveBucket(2000)).toBe(800)
  })
})

// ── Trim-alignment math (ported from AudioWaveformLayer.tsx:75-89) ───────

describe('audioTrackSourceWindow', () => {
  it('uses inPoint/outPoint when both are present', () => {
    expect(audioTrackSourceWindow(audio({ inPoint: 3, outPoint: 8 }))).toEqual({ start: 3, duration: 5 })
  })

  it('defaults outPoint to sourceDuration and inPoint to 0', () => {
    expect(audioTrackSourceWindow(audio({ sourceDuration: 12 }))).toEqual({ start: 0, duration: 12 })
  })

  it('falls back to end-start when neither sourceDuration nor outPoint is present (DOM fallback)', () => {
    expect(audioTrackSourceWindow(audio({ start: 5, end: 9 }))).toEqual({ start: 0, duration: 4 })
  })

  it('mixes a present inPoint with a defaulted outPoint', () => {
    expect(audioTrackSourceWindow(audio({ inPoint: 2, sourceDuration: 10 }))).toEqual({ start: 2, duration: 8 })
  })

  it('does not clamp a collapsed/inverted trim — callers check duration <= 0 (DOM PlainFallback case)', () => {
    const w = audioTrackSourceWindow(audio({ inPoint: 8, outPoint: 3 }))
    expect(w).toEqual({ start: 8, duration: -5 })
  })
})

describe('sourceTimeToBarFraction', () => {
  const window = { start: 5, duration: 10 }

  it('maps the window start to 0 and the window end to 1 (ported leftPct/widthPct math)', () => {
    expect(sourceTimeToBarFraction(5, window)).toBe(0)
    expect(sourceTimeToBarFraction(15, window)).toBe(1)
    expect(sourceTimeToBarFraction(10, window)).toBeCloseTo(0.5)
  })

  it('extrapolates outside [start, start+duration] the same linear way the DOM percent math does', () => {
    expect(sourceTimeToBarFraction(0, window)).toBeCloseTo(-0.5)
    expect(sourceTimeToBarFraction(20, window)).toBeCloseTo(1.5)
  })

  it('guards a non-positive duration to 0 rather than dividing by zero', () => {
    expect(sourceTimeToBarFraction(5, { start: 5, duration: 0 })).toBe(0)
    expect(sourceTimeToBarFraction(5, { start: 5, duration: -2 })).toBe(0)
  })
})

describe('clipSourceWindow', () => {
  it('returns undefined (fetch the whole proxy) when neither inPoint nor outPoint is set', () => {
    expect(clipSourceWindow(clip())).toBeUndefined()
  })

  it('uses inPoint/outPoint when both are present', () => {
    expect(clipSourceWindow(clip({ inPoint: 1, outPoint: 4 }))).toEqual({ start: 1, duration: 3 })
  })

  it('defaults outPoint to sourceDuration when only inPoint is set', () => {
    expect(clipSourceWindow(clip({ inPoint: 1, sourceDuration: 6 }))).toEqual({ start: 1, duration: 5 })
  })

  it('falls back to the clip′s own project-timeline duration when only inPoint is set and no sourceDuration', () => {
    // No outPoint/sourceDuration to anchor the end of the window, so it's
    // assumed to run for the clip's own on-timeline duration (3s) starting
    // at inPoint — i.e. outPoint = inPoint + (end - start) = 1 + 3 = 4.
    expect(clipSourceWindow(clip({ inPoint: 1, start: 0, end: 3 }))).toEqual({ start: 1, duration: 3 })
  })

  it('clamps a collapsed/inverted trim to duration 0 rather than going negative', () => {
    expect(clipSourceWindow(clip({ inPoint: 5, outPoint: 2 }))).toEqual({ start: 5, duration: 0 })
  })
})

// ── Resample: peaks → pixel columns ───────────────────────────────────────

describe('resamplePeaksToColumns', () => {
  it('aggregates min/max when there are more samples than columns', () => {
    // 8 samples, 4 columns → 2 samples/column.
    const peaks = [-10, 10, -20, 5, -5, 30, -40, 40, -1, 1, -2, 50, -60, 2, -3, 3]
    const cols = resamplePeaksToColumns(peaks, 4)
    expect(cols).toHaveLength(4)
    expect(cols[0]).toEqual({ min: -20 / 32768, max: 10 / 32768 })
    expect(cols[1]).toEqual({ min: -40 / 32768, max: 40 / 32768 })
    expect(cols[2]).toEqual({ min: -2 / 32768, max: 50 / 32768 })
    expect(cols[3]).toEqual({ min: -60 / 32768, max: 3 / 32768 })
  })

  it('repeats samples when there are more columns than samples (zoomed in past native resolution)', () => {
    // 2 samples, 5 columns → 0.4 samples/column.
    const peaks = [-100, 200, -300, 400]
    const cols = resamplePeaksToColumns(peaks, 5)
    expect(cols).toEqual([
      { min: -100 / 32768, max: 200 / 32768 },
      { min: -100 / 32768, max: 200 / 32768 },
      { min: -100 / 32768, max: 200 / 32768 },
      { min: -300 / 32768, max: 400 / 32768 },
      { min: -300 / 32768, max: 400 / 32768 },
    ])
  })

  it('maps 1:1 with no drift at the window edges when samples equal columns', () => {
    const peaks = [-1, 1, -2, 2, -3, 3]
    const cols = resamplePeaksToColumns(peaks, 3)
    expect(cols).toEqual([
      { min: -1 / 32768, max: 1 / 32768 },
      { min: -2 / 32768, max: 2 / 32768 },
      { min: -3 / 32768, max: 3 / 32768 },
    ])
  })

  it('returns an empty array for zero columns or empty peaks', () => {
    expect(resamplePeaksToColumns([1, 2, 3, 4], 0)).toEqual([])
    expect(resamplePeaksToColumns([], 4)).toEqual([])
  })
})

// ── Draw primitives ─────────────────────────────────────────────────────

describe('drawWaveformBars', () => {
  it('emits one fillRect per column, each within the rect′s x/y bounds', () => {
    const r = recordingContext()
    const bandRect = rect({ x: 10, y: 20, width: 40, height: 20 })
    const columns: WaveformColumn[] = [{ min: -1, max: 1 }, { min: -0.5, max: 0.5 }, { min: 0, max: 0 }, { min: -1, max: 0.2 }]
    drawWaveformBars(r.ctx, bandRect, columns, WAVEFORM_COLORS.clip)

    const fills = r.of('fillRect')
    expect(fills).toHaveLength(4)
    for (const call of fills) {
      const [x, y, w, h] = call.args as number[]
      expect(x).toBeGreaterThanOrEqual(bandRect.x)
      expect(x + w).toBeLessThanOrEqual(bandRect.x + bandRect.width + 0.001)
      expect(y).toBeGreaterThanOrEqual(bandRect.y - 0.001)
      expect(y + h).toBeLessThanOrEqual(bandRect.y + bandRect.height + 0.001)
    }
  })

  it('draws nothing for a degenerate rect or an empty column list', () => {
    const r = recordingContext()
    drawWaveformBars(r.ctx, rect({ width: 0 }), [{ min: -1, max: 1 }], WAVEFORM_COLORS.clip)
    drawWaveformBars(r.ctx, rect(), [], WAVEFORM_COLORS.clip)
    expect(r.of('fillRect')).toHaveLength(0)
  })
})

describe('clipWaveformBand', () => {
  it('sits as a thin strip at the bottom of the clip rect, inset from the edge', () => {
    const r = rect({ x: 0, y: 0, width: 80, height: 40 })
    const band = clipWaveformBand(r)
    expect(band.y + band.height).toBeLessThanOrEqual(r.y + r.height)
    expect(band.y + band.height).toBeGreaterThan(r.y + r.height - 4) // within the 2px inset + rounding
    expect(band.height).toBeLessThanOrEqual(10)
    expect(band.width).toBe(r.width)
  })

  it('shrinks (never grows past) a very short row so the band stays inside it', () => {
    const band = clipWaveformBand(rect({ height: 6 }))
    expect(band.height).toBeLessThanOrEqual(6)
    expect(band.height).toBeGreaterThanOrEqual(0)
  })
})

// ── drawClipRect / drawAudioItem content-layer hook ───────────────────────

describe('drawClipRect content hook', () => {
  it('calls drawContent between the fill/border and the label, and a waveform painted there stays within the clip rect', () => {
    const r = recordingContext()
    const columns: WaveformColumn[] = [{ min: -1, max: 1 }, { min: -1, max: 1 }]
    const clipRect = rect({ x: 5, y: 5, width: 60, height: 40 })
    drawClipRect(r.ctx, {
      rect: clipRect,
      palette: { fill: '#111', fillSelected: '#222', ring: '#333', border: '#444', text: '#fff' },
      selected: false,
      label: 'video',
      drawContent: (ctx, rc) => drawClipWaveform(ctx, rc, columns),
    })

    const fills = r.of('fillRect')
    // [0]=main fill, [1]=border, then N waveform bar fillRects.
    const waveformFills = fills.slice(2)
    expect(waveformFills.length).toBe(columns.length)
    for (const call of waveformFills) {
      const [x, , w] = call.args as number[]
      expect(x).toBeGreaterThanOrEqual(clipRect.x)
      expect(x + w).toBeLessThanOrEqual(clipRect.x + clipRect.width + 0.001)
    }
  })

  it('draws nothing extra when drawContent is absent', () => {
    const r = recordingContext()
    drawClipRect(r.ctx, {
      rect: rect(),
      palette: { fill: '#111', fillSelected: '#222', ring: '#333', border: '#444', text: '#fff' },
      selected: false,
      label: 'video',
    })
    // fill + border only.
    expect(r.of('fillRect')).toHaveLength(2)
  })
})

describe('drawAudioItem content hook', () => {
  it('clips drawContent to the bar the same way fades/label are clipped', () => {
    const r = recordingContext()
    const barRect = rect({ x: 5, y: 5, width: 60, height: 32 })
    const columns: WaveformColumn[] = [{ min: -1, max: 1 }, { min: -0.3, max: 0.3 }, { min: -1, max: 1 }]
    drawAudioItem(r.ctx, {
      rect: barRect,
      selected: false,
      muted: false,
      label: 'audio',
      drawContent: (ctx, rc) => drawAudioLaneWaveform(ctx, rc, columns),
    })

    // A clip() call must precede the waveform's fillRects so it's constrained
    // to the bar's bounds.
    const clipIdx = r.calls.findIndex(c => c.method === 'clip')
    const firstFillAfterClip = r.calls.findIndex((c, i) => i > clipIdx && c.method === 'fillRect')
    expect(clipIdx).toBeGreaterThanOrEqual(0)
    expect(firstFillAfterClip).toBeGreaterThan(clipIdx)
  })
})

// ── Fetch-state store ──────────────────────────────────────────────────────

describe('WaveformPeaksStore.clipColumns', () => {
  it('never fetches when the item has no proxySrc (graceful, no spinner)', () => {
    const store = new WaveformPeaksStore()
    const fetcher = vi.fn()
    const result = store.clipColumns(clip(), rect(), queryCtx({ getWaveformPeaks: fetcher }))
    expect(result).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('never fetches for a non-video item even with a src set', () => {
    const store = new WaveformPeaksStore()
    const fetcher = vi.fn()
    const result = store.clipColumns(clip({ type: 'image' } as Partial<VisualItem> as VisualItem), rect(), queryCtx({ getWaveformPeaks: fetcher }))
    expect(result).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('fires a fetch once a proxySrc arrives (SSE import completion), since the key changes', async () => {
    const store = new WaveformPeaksStore()
    const fetcher = vi.fn().mockResolvedValue(peaksFixture())
    const barRect = rect()

    const before = store.clipColumns(clip(), barRect, queryCtx({ getWaveformPeaks: fetcher }))
    expect(before).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()

    const after = store.clipColumns(clip({ proxySrc: 'proxy.mp4' }), barRect, queryCtx({ getWaveformPeaks: fetcher }))
    expect(after).toBeNull() // loading — not ready yet on this same call
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toMatchObject({ projectId: 'p1', src: 'proxy.mp4', samplesPerSecond: 50 })
  })

  it('returns resampled columns once the fetch resolves, and calls onReady exactly once', async () => {
    const store = new WaveformPeaksStore()
    const onReady = vi.fn()
    const fetcher = vi.fn().mockResolvedValue(peaksFixture())
    const item = clip({ proxySrc: 'proxy.mp4' })
    const barRect = rect({ width: 50 })

    store.clipColumns(item, barRect, queryCtx({ getWaveformPeaks: fetcher, onReady }))
    await flush()
    expect(onReady).toHaveBeenCalledTimes(1)

    const cols = store.clipColumns(item, barRect, queryCtx({ getWaveformPeaks: fetcher, onReady }))
    expect(cols).not.toBeNull()
    expect(cols!.length).toBe(50)
  })

  it('swallows a rejected fetch quietly (no throw) and retries on a later call once cooldown elapses', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0)
    const store = new WaveformPeaksStore()
    const onReady = vi.fn()
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(peaksFixture())
    const item = clip({ proxySrc: 'proxy.mp4' })
    const barRect = rect()

    expect(() => store.clipColumns(item, barRect, queryCtx({ getWaveformPeaks: fetcher, onReady }))).not.toThrow()
    await flush()
    expect(onReady).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)

    // Next call (e.g. the next redraw for an unrelated reason) retries once
    // cooldown has elapsed — an errored entry is neither ready nor loading.
    nowSpy.mockReturnValue(FETCH_RETRY_COOLDOWN_MS + 1)
    store.clipColumns(item, barRect, queryCtx({ getWaveformPeaks: fetcher, onReady }))
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(onReady).toHaveBeenCalledTimes(1)
    nowSpy.mockRestore()
  })

  it('does not retry a still-cooling-down error on the very next call (paint-rate request storm)', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0)
    const store = new WaveformPeaksStore()
    const onReady = vi.fn()
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('boom'))
    const item = clip({ proxySrc: 'proxy.mp4' })
    const barRect = rect()

    store.clipColumns(item, barRect, queryCtx({ getWaveformPeaks: fetcher, onReady }))
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)

    // Same mocked Date.now() as the error — still in cooldown, no refetch.
    store.clipColumns(item, barRect, queryCtx({ getWaveformPeaks: fetcher, onReady }))
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    nowSpy.mockRestore()
  })

  it('re-fetches when the trim window changes (start/duration are part of the key)', async () => {
    const store = new WaveformPeaksStore()
    const fetcher = vi.fn().mockResolvedValue(peaksFixture())
    const barRect = rect()

    store.clipColumns(clip({ proxySrc: 'proxy.mp4', inPoint: 0, outPoint: 2 }), barRect, queryCtx({ getWaveformPeaks: fetcher }))
    await flush()
    store.clipColumns(clip({ proxySrc: 'proxy.mp4', inPoint: 3, outPoint: 5 }), barRect, queryCtx({ getWaveformPeaks: fetcher }))
    await flush()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][0]).toMatchObject({ start: 3, duration: 2 })
  })

  it('does not re-fetch on zoom-out: a higher bucket already ready is reused', async () => {
    const store = new WaveformPeaksStore()
    const big = Array.from({ length: 800 * 2 }, (_, i) => (i % 2 === 0 ? -100 : 100))
    const fetcher = vi.fn().mockResolvedValue(peaksFixture({ samplesPerSecond: 800, duration: 1, peaks: big }))
    const item = clip({ proxySrc: 'proxy.mp4' })
    const barRect = rect()

    store.clipColumns(item, barRect, queryCtx({ getWaveformPeaks: fetcher, pxPerSecond: 1000 })) // bucket 800
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0].samplesPerSecond).toBe(800)

    const zoomedOut = store.clipColumns(item, barRect, queryCtx({ getWaveformPeaks: fetcher, pxPerSecond: 10 })) // bucket 50
    expect(fetcher).toHaveBeenCalledTimes(1) // unchanged — no new fetch
    expect(zoomedOut).not.toBeNull()
  })

  it('fetches the next bucket on zoom-in, keeping the old bucket′s data until it resolves', async () => {
    const store = new WaveformPeaksStore()
    const lowRes = peaksFixture({ samplesPerSecond: 50, duration: 1, peaks: [-1, 1, -1, 1] })
    const highRes = peaksFixture({ samplesPerSecond: 800, duration: 1, peaks: Array.from({ length: 800 * 2 }, () => 5) })
    let resolveHigh: (v: PeaksData) => void = () => {}
    const fetcher = vi.fn()
      .mockResolvedValueOnce(lowRes)
      .mockImplementationOnce(() => new Promise<PeaksData>(resolve => { resolveHigh = resolve }))
    const item = clip({ proxySrc: 'proxy.mp4' })
    const barRect = rect()

    store.clipColumns(item, barRect, queryCtx({ getWaveformPeaks: fetcher, pxPerSecond: 10 })) // bucket 50
    await flush()
    const beforeZoomIn = store.clipColumns(item, barRect, queryCtx({ getWaveformPeaks: fetcher, pxPerSecond: 10 }))
    expect(beforeZoomIn).not.toBeNull()

    // Zoom in past 200 → triggers an 800-bucket fetch that hasn't resolved yet.
    const midFlight = store.clipColumns(item, barRect, queryCtx({ getWaveformPeaks: fetcher, pxPerSecond: 1000 }))
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(midFlight).not.toBeNull() // still the old (50-bucket) data, not null

    resolveHigh(highRes)
    await flush()
    const afterResolve = store.clipColumns(item, barRect, queryCtx({ getWaveformPeaks: fetcher, pxPerSecond: 1000 }))
    expect(afterResolve).not.toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2) // no third fetch just from reading it again
  })
})

describe('WaveformPeaksStore.audioColumns', () => {
  it('never fetches when the adapter lacks getWaveformPeaks', () => {
    const store = new WaveformPeaksStore()
    const result = store.audioColumns(audio(), rect(), queryCtx({ getWaveformPeaks: undefined }))
    expect(result).toBeNull()
  })

  it('skips a fully collapsed/inverted trim without fetching (DOM PlainFallback case)', () => {
    const store = new WaveformPeaksStore()
    const fetcher = vi.fn()
    const result = store.audioColumns(audio({ inPoint: 8, outPoint: 3 }), rect(), queryCtx({ getWaveformPeaks: fetcher }))
    expect(result).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('positions the fetched window inside the bar via the ported fraction math, even when the returned window is clamped', async () => {
    const store = new WaveformPeaksStore()
    // Track window is [2, 12) (inPoint 2, outPoint 12); the step echoes back
    // a clamped [2, 10) — 80% of the window — same as a real end-of-file clamp.
    const fetcher = vi.fn().mockResolvedValue(peaksFixture({ start: 2, duration: 8, peaks: [-1, 1, -1, 1] }))
    const barRect = rect({ x: 0, width: 100 })

    store.audioColumns(audio({ inPoint: 2, outPoint: 12 }), barRect, queryCtx({ getWaveformPeaks: fetcher }))
    await flush()
    const result = store.audioColumns(audio({ inPoint: 2, outPoint: 12 }), barRect, queryCtx({ getWaveformPeaks: fetcher }))

    expect(result).not.toBeNull()
    // [2,10) is 80% of the [2,12) window → sub-rect covers the first 80px of a 100px bar.
    expect(result!.rect.x).toBeCloseTo(0)
    expect(result!.rect.width).toBeCloseTo(80)
  })
})

// ── Draw integration via drawTimelineContent (draw.ts) ────────────────────

function project(over: Partial<Project> = {}): Project {
  return { id: 'p1', ...over } as unknown as Project
}

function viewport(over: Partial<Viewport> = {}): Viewport {
  return { pxPerSecond: 20, scrollSeconds: 0, widthPx: 1000, ...over }
}

function scene(over: Partial<TimelineScene> = {}): TimelineScene {
  const p = over.project ?? project()
  return {
    project: p,
    viewport: viewport(),
    layout: computeTimelineLayout(p),
    selectedIds: [],
    markerSelection: null,
    markers: [null, null],
    surfaceWidth: 1000,
    surfaceHeight: 200,
    ...over,
  }
}

describe('drawTimelineContent waveform wiring', () => {
  it('emits waveform draw calls within a clip′s rect bounds when the lookup has ready columns', () => {
    const p = project({ tracks: [[clip({ id: 'c0', start: 0, end: 4 })]] })
    const r = recordingContext()
    const columns: WaveformColumn[] = [{ min: -1, max: 1 }, { min: -0.5, max: 0.5 }]
    const stats = drawTimelineContent(r.ctx, scene({
      project: p,
      layout: computeTimelineLayout(p),
      waveforms: {
        clipColumns: (item) => (item.id === 'c0' ? columns : null),
        audioColumns: () => null,
      },
    }))

    expect(stats.visualItemsDrawn).toBe(1)
    // fill + border + 2 waveform bars (no selection ring, label width < MIN? label drawn too — just assert bar count via last N fills).
    const fills = r.of('fillRect')
    expect(fills.length).toBeGreaterThanOrEqual(4) // fill, border, 2 waveform bars
    const expectedRectRight = 4 * 20 // (end-start)*pxPerSecond
    for (const call of fills.slice(2, 4)) {
      const [x, , w] = call.args as number[]
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x + w).toBeLessThanOrEqual(expectedRectRight + 0.001)
    }
  })

  it('emits no waveform draw calls when the lookup returns null (no proxy yet)', () => {
    const p = project({ tracks: [[clip({ id: 'c0', start: 0, end: 4 })]] })
    const withLookup = recordingContext()
    drawTimelineContent(withLookup.ctx, scene({
      project: p,
      layout: computeTimelineLayout(p),
      waveforms: { clipColumns: () => null, audioColumns: () => null },
    }))

    const withoutLookup = recordingContext()
    drawTimelineContent(withoutLookup.ctx, scene({ project: p, layout: computeTimelineLayout(p) }))

    // Absent lookup and a lookup that always returns null produce identical
    // draw-call counts — no waveform fills either way.
    expect(withLookup.calls.length).toBe(withoutLookup.calls.length)
  })

  it('draws an audio-lane waveform inside the bar via the lookup', () => {
    const p = project({ audio: { tracks: [audio({ id: 'a0', start: 0, end: 4 })] } })
    const r = recordingContext()
    const columns: WaveformColumn[] = [{ min: -1, max: 1 }, { min: -1, max: 1 }, { min: -1, max: 1 }]
    drawTimelineContent(r.ctx, scene({
      project: p,
      layout: computeTimelineLayout(p),
      waveforms: {
        clipColumns: () => null,
        audioColumns: (track, rc) => (track.id === 'a0' ? { rect: rc, columns } : null),
      },
    }))

    // The bar's own background is painted via fill() (roundRectPath), not
    // fillRect — the only fillRect calls left are the 3 waveform bars.
    const fills = r.of('fillRect')
    expect(fills).toHaveLength(3)
  })
})
