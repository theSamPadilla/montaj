/**
 * SP4 T5 — the facade: the rAF loop, the canvas painter, and the surface T6
 * builds on.
 *
 * The transport itself is covered by `scheduler.test.ts` over fakes; what is
 * left here is the wiring only `index.ts` owns. A CANVAS project is the vehicle
 * for the loop tests on purpose: it has no track-0 video, so nothing ever
 * reaches `loadBytes`/`demux`/WebCodecs and the whole thing runs in jsdom with
 * a real `EngineSourceHost` rather than a stand-in for one.
 */
import { describe, expect, it, vi } from 'vitest'
import type { EditorProject as Project } from '../../schema'
import { createCanvasPainter, createEngine, fpsFromPaintTimes, pruneOlderThan } from '../index'
import type { DrawPlan } from '../scheduler'

/** `Array.prototype.at` is ES2022; this package targets ES2020. */
const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1]

function canvasProject(overlayEnd = 4): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [
      { id: 'trk-0', items: [{ id: 'img', type: 'image', src: '/bg.png', start: 0, end: overlayEnd }] },
      { id: 'trk-1', items: [{ id: 'o', type: 'overlay', src: '/o.jsx', start: 0, end: overlayEnd }] },
    ],
  } as Project
}

/** A hand-pumped rAF, so no test depends on a real frame callback firing. */
function fakeRaf() {
  const queue = new Map<number, () => void>()
  let nextHandle = 1
  const cancelFrame = vi.fn((handle: number) => {
    queue.delete(handle)
  })
  return {
    requestFrame: (cb: () => void) => {
      const handle = nextHandle++
      queue.set(handle, cb)
      return handle
    },
    cancelFrame,
    /** Run every callback queued so far (each may enqueue the next). */
    flush(times = 1) {
      for (let i = 0; i < times; i++) {
        const pending = [...queue.values()]
        queue.clear()
        for (const cb of pending) cb()
      }
    },
    get pending() {
      return queue.size
    },
  }
}

describe('createEngine — transport over the rAF loop', () => {
  it('runs the loop only while playing and stops at the project end', () => {
    const raf = fakeRaf()
    let now = 0
    const times: number[] = []
    const engine = createEngine(canvasProject(4), {
      fileUrl: (p) => p,
      onTime: (t) => times.push(t),
      requestFrame: raf.requestFrame,
      cancelFrame: raf.cancelFrame,
      nowMs: () => now,
    })

    // Nothing runs until asked to.
    expect(raf.pending).toBe(0)
    engine.play()
    expect(raf.pending).toBe(1)

    now = 1000
    raf.flush()
    expect(last(times)).toBeCloseTo(1, 6)
    expect(engine.status().transport).toBe('playing')
    expect(raf.pending).toBe(1)

    // Past the ceiling: clamped to it exactly, transport ends, loop stops.
    now = 5000
    raf.flush()
    expect(last(times)).toBe(4)
    expect(engine.status().transport).toBe('ended')
    expect(raf.pending).toBe(0)

    engine.dispose()
  })

  it('pause stops the loop; play restarts it', () => {
    const raf = fakeRaf()
    let now = 0
    const engine = createEngine(canvasProject(10), {
      fileUrl: (p) => p,
      requestFrame: raf.requestFrame,
      cancelFrame: raf.cancelFrame,
      nowMs: () => now,
    })
    engine.play()
    now = 500
    raf.flush()
    engine.pause()
    expect(raf.cancelFrame).toHaveBeenCalled()
    expect(engine.status().transport).toBe('paused')

    // The playhead froze where it was, and does not drift while paused.
    const frozen = engine.clock.now()
    now = 4000
    expect(engine.clock.now()).toBe(frozen)

    engine.play()
    expect(raf.pending).toBe(1)
    engine.dispose()
  })

  it('a canvas project runs on the wall clock', () => {
    const engine = createEngine(canvasProject(4), { fileUrl: (p) => p, nowMs: () => 0 })
    engine.seek(1)
    expect(engine.clock.kind).toBe('fallback')
    expect(engine.clock.now()).toBe(1)
    expect(engine.status()).toMatchObject({ picture: 'black', clipId: null })
    engine.dispose()
  })

  it('seek past the end stops the loop', () => {
    const raf = fakeRaf()
    const engine = createEngine(canvasProject(4), {
      fileUrl: (p) => p,
      requestFrame: raf.requestFrame,
      cancelFrame: raf.cancelFrame,
      nowMs: () => 0,
    })
    engine.play()
    engine.seek(9)
    expect(engine.status().transport).toBe('ended')
    expect(raf.cancelFrame).toHaveBeenCalled()
    engine.dispose()
  })

  it('dispose is idempotent and stops everything', () => {
    const raf = fakeRaf()
    const engine = createEngine(canvasProject(4), {
      fileUrl: (p) => p,
      requestFrame: raf.requestFrame,
      cancelFrame: raf.cancelFrame,
      nowMs: () => 0,
    })
    engine.play()
    engine.dispose()
    engine.dispose()
    expect(raf.pending).toBe(0)
  })
})

describe('createEngine — canvas attachment', () => {
  it('sizes the backing store to the project design canvas', () => {
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue(null)
    const engine = createEngine(canvasProject(4), { fileUrl: (p) => p, nowMs: () => 0 })
    engine.attach(canvas)
    expect([canvas.width, canvas.height]).toEqual([1080, 1920])
    engine.dispose()
  })

  it('re-sizes when the project resolution changes', () => {
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue(null)
    const engine = createEngine(canvasProject(4), { fileUrl: (p) => p, nowMs: () => 0 })
    engine.attach(canvas)
    const landscape = { ...canvasProject(4), settings: { resolution: [1920, 1080] as [number, number] } }
    engine.updateProject(landscape as Project)
    expect([canvas.width, canvas.height]).toEqual([1920, 1080])
    engine.dispose()
  })

  it('unbinds cleanly on attach(null)', () => {
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue(null)
    const engine = createEngine(canvasProject(4), { fileUrl: (p) => p, nowMs: () => 0 })
    engine.attach(canvas)
    expect(() => engine.attach(null)).not.toThrow()
    engine.dispose()
  })
})

describe('createEngine — stats()', () => {
  it('reports zeroed defaults with no active clip and no paints', () => {
    const engine = createEngine(canvasProject(4), { fileUrl: (p) => p, nowMs: () => 0 })
    // A canvas project's picture is always 'black' (no track-0 video), so
    // there is never a clip clock to derive from — `stats().clock` matches
    // `engine.clock.kind`.
    expect(engine.stats()).toEqual({ fps: 0, dropped: 0, buffered: 0, clock: 'fallback' })
    expect(engine.clock.kind).toBe('fallback')
    engine.dispose()
  })

  it('attach(null) leaves stats() safe to call — no dangling painter reference', () => {
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue(null)
    const engine = createEngine(canvasProject(4), { fileUrl: (p) => p, nowMs: () => 0 })
    engine.attach(canvas)
    engine.attach(null)
    expect(() => engine.stats()).not.toThrow()
    engine.dispose()
  })
})

// `stats().fps`'s rolling-window math is exercised directly below
// (`pruneOlderThan`/`fpsFromPaintTimes`) rather than through a canvas and an
// attached painter: a canvas PROJECT (this file's fixture) never reaches
// `picture === 'video'`, so nothing here ever calls the wrapped painter's
// `paint` — that would need a real track-0 clip behind a live decode session,
// which is `scheduler.test.ts`/`frame-server.test.ts` territory, not this
// file's.

describe('pruneOlderThan', () => {
  it('drops everything at or before the cutoff, keeps the rest, in place', () => {
    const times = [0, 500, 1000, 1500, 1900]
    pruneOlderThan(times, 2000, 1000) // cutoff = 1000: drop < 1000
    expect(times).toEqual([1000, 1500, 1900])
  })

  it('is a no-op when nothing is old enough to drop', () => {
    const times = [1900, 1950]
    pruneOlderThan(times, 2000, 1000)
    expect(times).toEqual([1900, 1950])
  })

  it('empties the array when everything is older than the window', () => {
    const times = [0, 100, 200]
    pruneOlderThan(times, 5000, 1000)
    expect(times).toEqual([])
  })
})

describe('fpsFromPaintTimes', () => {
  it('is 0 for an empty list', () => {
    expect(fpsFromPaintTimes([], 1000, 2000)).toBe(0)
  })

  it('reads 30fps from paints spaced exactly 1000/30 ms apart', () => {
    // 30 paints over one second (0, 33.3, 66.6, … 966.7), read at t=1000 with
    // a 2000ms window — the window covers the whole run, so this is exactly
    // "how many paints in the last second", i.e. fps.
    const times: number[] = []
    for (let i = 0; i < 30; i++) times.push((i * 1000) / 30)
    expect(fpsFromPaintTimes(times, 1000, 2000)).toBeCloseTo(30, 0)
  })

  it('clamps the span to the window even when the buffer spans longer', () => {
    // First paint 5s ago, but the window is only 2s — span must clamp to
    // 2000ms, not the full 5000ms, or a long-lived low-rate buffer would
    // under-report fps.
    const times = [0, 4000, 4500, 5000]
    expect(fpsFromPaintTimes(times, 5000, 2000)).toBeCloseTo((4 / 2000) * 1000, 6)
  })
})

describe('createCanvasPainter', () => {
  interface Recorded {
    fills: Array<[number, number, number, number]>
    draws: unknown[][]
  }

  function stubCanvas(width = 1080, height = 1920): { canvas: HTMLCanvasElement; rec: Recorded } {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const rec: Recorded = { fills: [], draws: [] }
    const ctx = {
      fillStyle: '',
      fillRect: (...args: [number, number, number, number]) => rec.fills.push(args),
      drawImage: (...args: unknown[]) => rec.draws.push(args),
    }
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    return { canvas, rec }
  }

  const plan: DrawPlan = { sx: 10, sy: 20, sw: 30, sh: 40, dx: 1, dy: 2, dw: 3, dh: 4 }
  const frame = { close() {} } as unknown as VideoFrame

  it('fills black before every paint so letterbox bars never keep a stale edge', () => {
    const { canvas, rec } = stubCanvas()
    const painter = createCanvasPainter(canvas)
    painter.paint(frame, plan)
    expect(rec.fills).toEqual([[0, 0, 1080, 1920]])
    expect(rec.draws).toEqual([[frame, 10, 20, 30, 40, 1, 2, 3, 4]])
  })

  it('clears to black without drawing', () => {
    const { canvas, rec } = stubCanvas()
    createCanvasPainter(canvas).clear()
    expect(rec.fills).toEqual([[0, 0, 1080, 1920]])
    expect(rec.draws).toEqual([])
  })

  it('skips a degenerate rect rather than throwing at drawImage', () => {
    const { canvas, rec } = stubCanvas()
    createCanvasPainter(canvas).paint(frame, { ...plan, sw: 0 })
    expect(rec.draws).toEqual([])
  })

  it('re-reads the backing-store size on every paint, so a host resize is picked up', () => {
    const { canvas, rec } = stubCanvas()
    const painter = createCanvasPainter(canvas)
    expect(painter.size()).toEqual({ width: 1080, height: 1920 })
    canvas.width = 540
    canvas.height = 960
    expect(painter.size()).toEqual({ width: 540, height: 960 })
    painter.clear()
    expect(last(rec.fills)).toEqual([0, 0, 540, 960])
  })

  it('is inert when the canvas gives no 2D context', () => {
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue(null)
    const painter = createCanvasPainter(canvas)
    expect(() => {
      painter.clear()
      painter.paint(frame, plan)
    }).not.toThrow()
  })
})
