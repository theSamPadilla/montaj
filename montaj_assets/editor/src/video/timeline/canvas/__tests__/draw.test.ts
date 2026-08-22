/**
 * SP5 T4 — the canvas painter. Every draw function is pure, so the tests drive
 * them with a context stub that records the calls and asserts on the list: the
 * rectangle a clip lands in IS the observable behaviour of a painter.
 *
 * The last block is the acceptance probe for the virtualization claim: with a
 * long project and a small window, the number of draw calls must be bounded by
 * what's visible, not by how many items exist.
 */
import { describe, it, expect } from 'vitest'
import type { AudioTrack, VisualItem } from '../../../../schema'
import type { Project } from '../../../../types'
import {
  AUDIO_ITEM_INSET_PX,
  CURSOR_WIDTH_PX,
  LABEL_TOP_OFFSET_PX,
  CLIP_GUTTER_PX,
  CLIP_SELECTED_BORDER_PX,
  MIN_LABEL_WIDTH_PX,
  PLAYHEAD_WIDTH_PX,
  TIMELINE_COLORS,
  TRACK_PALETTE,
  clampRectToSurface,
  computeTimelineLayout,
  drawAudioItem,
  drawClipRect,
  drawPlayhead,
  drawTimelineContent,
  drawTimelineOverlay,
  type DrawContext,
  type TimelineScene,
} from '../draw'
import {
  AUDIO_LANE_HEIGHT_PX,
  BASE_VISUAL_ROW_RENDER_HEIGHT_PX,
  ROW_GAP_PX,
  VISUAL_ROW_RENDER_HEIGHT_PX,
} from '../../timeline-model'
import type { Viewport } from '../viewport'

// ── Recording context ────────────────────────────────────────────────────

interface RecordedCall { method: string; args: unknown[] }

interface Recorder {
  ctx: DrawContext
  calls: RecordedCall[]
  of: (method: string) => RecordedCall[]
  count: (method: string) => number
}

function recordingContext(): Recorder {
  const calls: RecordedCall[] = []
  const props: Record<string, unknown> = {}

  const proxy = new Proxy({}, {
    get(_target, prop: string) {
      if (prop in props) return props[prop]
      if (prop === 'createLinearGradient') {
        return (...args: unknown[]) => {
          calls.push({ method: 'createLinearGradient', args })
          return {
            addColorStop: (...stop: unknown[]) => calls.push({ method: 'addColorStop', args: stop }),
          } as unknown as CanvasGradient
        }
      }
      return (...args: unknown[]) => { calls.push({ method: prop, args }) }
    },
    set(_target, prop: string, value: unknown) {
      props[prop] = value
      calls.push({ method: `set:${prop}`, args: [value] })
      return true
    },
  }) as unknown as DrawContext

  return {
    ctx: proxy,
    calls,
    of: (method: string) => calls.filter(c => c.method === method),
    count: (method: string) => calls.filter(c => c.method === method).length,
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────

function clip(over: Partial<VisualItem> = {}): VisualItem {
  return { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 2, ...over }
}

function audio(over: Partial<AudioTrack> = {}): AudioTrack {
  return { id: 'a0', src: '/media/voice.mp3', start: 0, end: 2, ...over }
}

function project(over: Partial<Project> = {}): Project {
  return { id: 'p1', ...over } as unknown as Project
}

function viewport(over: Partial<Viewport> = {}): Viewport {
  return { pxPerSecond: 10, scrollSeconds: 0, widthPx: 1000, ...over }
}

function scene(over: Partial<TimelineScene> = {}): TimelineScene {
  const p = over.project ?? project()
  return {
    project: p,
    viewport: viewport(),
    layout: computeTimelineLayout(p),
    selectedIds: [],
    surfaceWidth: 1000,
    surfaceHeight: 200,
    ...over,
  }
}

// ── Layout ───────────────────────────────────────────────────────────────

describe('computeTimelineLayout', () => {
  it('stacks visual tracks reversed, base track last and taller, audio lanes below', () => {
    const p = project({
      tracks: [[clip({ id: 'base' })], [clip({ id: 'ov1' })], [clip({ id: 'ov2' })]],
      audio: { tracks: [audio({ id: 'm', lane: 0 }), audio({ id: 'v', lane: 1 })] },
    } as unknown as Partial<Project>)

    const layout = computeTimelineLayout(p)

    // Draw order top→bottom mirrors the DOM's `[...allTracks].reverse()`.
    expect(layout.rows.map(r => r.trackIdx)).toEqual([2, 1, 0])
    expect(layout.rows[0]).toMatchObject({ y: 0, height: VISUAL_ROW_RENDER_HEIGHT_PX })
    expect(layout.rows[1]).toMatchObject({ y: VISUAL_ROW_RENDER_HEIGHT_PX + ROW_GAP_PX })
    // The base video track is the tall one (`trackRowTall`).
    expect(layout.rows[2].height).toBe(BASE_VISUAL_ROW_RENDER_HEIGHT_PX)

    expect(layout.lanes.map(l => l.laneIndex)).toEqual([0, 1])
    expect(layout.lanes[0].y).toBe(layout.rows[2].y + BASE_VISUAL_ROW_RENDER_HEIGHT_PX + ROW_GAP_PX)
    expect(layout.lanes[1].y).toBe(layout.lanes[0].y + AUDIO_LANE_HEIGHT_PX + ROW_GAP_PX)
    expect(layout.height).toBe(layout.lanes[1].y + AUDIO_LANE_HEIGHT_PX)
  })

  it('is empty for an empty project', () => {
    const layout = computeTimelineLayout(project())
    expect(layout).toEqual({ rows: [], lanes: [], height: 0 })
  })
})

describe('clampRectToSurface', () => {
  it('trims a clip that runs far past both edges', () => {
    expect(clampRectToSurface({ x: -50_000, y: 0, width: 100_000, height: 40 }, 1000))
      .toEqual({ x: -1, y: 0, width: 1002, height: 40 })
  })
})

// ── Element painters ─────────────────────────────────────────────────────

describe('drawClipRect', () => {
  it('insets the body from the clip\'s span, leaving a gutter between touching clips', () => {
    const r = recordingContext()
    drawClipRect(r.ctx, {
      rect: { x: 120, y: 40, width: 200, height: 40 },
      palette: TRACK_PALETTE[1],
      selected: false,
      label: '▪ video',
    })

    // Inset by CLIP_GUTTER_PX per side — two touching clips therefore show
    // twice that as dark row background, which is what makes a cut visible
    // once filmstrip frames run edge to edge.
    const fills = r.of('fillRect')
    expect(fills[0].args).toEqual([120 + CLIP_GUTTER_PX, 40, 200 - CLIP_GUTTER_PX * 2, 40])
    expect(r.calls.some(c => c.method === 'set:fillStyle' && c.args[0] === TRACK_PALETTE[1].fill)).toBe(true)
    // Top-left, not vertically centred: the centre of a clip is now the seam
    // between its frames band and its waveform band.
    expect(r.of('fillText')[0].args).toEqual(['▪ video', 120 + CLIP_GUTTER_PX + 6, 40 + LABEL_TOP_OFFSET_PX])
  })

  it('outlines every clip, and a selected one in thick white', () => {
    const plain = recordingContext()
    drawClipRect(plain.ctx, { rect: { x: 0, y: 0, width: 100, height: 40 }, palette: TRACK_PALETTE[0], selected: false, label: 'x' })
    expect(plain.calls.some(c => c.method === 'set:strokeStyle' && c.args[0] === TRACK_PALETTE[0].border)).toBe(true)
    expect(plain.calls.some(c => c.method === 'set:lineWidth' && c.args[0] === 1)).toBe(true)

    const picked = recordingContext()
    drawClipRect(picked.ctx, { rect: { x: 0, y: 0, width: 100, height: 40 }, palette: TRACK_PALETTE[0], selected: true, label: 'x' })
    // White, not the track's own hue — the only treatment that reads over an
    // arbitrary video frame.
    expect(picked.calls.some(c => c.method === 'set:strokeStyle' && c.args[0] === TIMELINE_COLORS.clipSelectedOutline)).toBe(true)
    expect(picked.calls.some(c => c.method === 'set:lineWidth' && c.args[0] === CLIP_SELECTED_BORDER_PX)).toBe(true)
    expect(picked.calls.some(c => c.method === 'set:fillStyle' && c.args[0] === TRACK_PALETTE[0].fillSelected)).toBe(true)
  })

  it('clips its content to the rounded body, so frames stop at the corners', () => {
    const r = recordingContext()
    drawClipRect(r.ctx, {
      rect: { x: 0, y: 0, width: 100, height: 40 },
      palette: TRACK_PALETTE[0], selected: false, label: 'x',
      drawContent: (c, body) => c.fillRect(body.x, body.y, body.width, body.height),
    })
    // A clip path is established before the content paints.
    const clipAt = r.calls.findIndex(c => c.method === 'clip')
    const contentAt = r.calls.findIndex(c => c.method === 'fillRect' && (c.args as number[])[2] === 100 - CLIP_GUTTER_PX * 2)
    expect(clipAt).toBeGreaterThanOrEqual(0)
    expect(clipAt).toBeLessThan(contentAt)
  })

  it('hands drawContent the inset body, not the full span', () => {
    let handed: { x: number; width: number } | null = null
    const r = recordingContext()
    drawClipRect(r.ctx, {
      rect: { x: 120, y: 40, width: 200, height: 40 },
      palette: TRACK_PALETTE[0], selected: false, label: 'x',
      drawContent: (_c, body) => { handed = { x: body.x, width: body.width } },
    })
    expect(handed).toEqual({ x: 120 + CLIP_GUTTER_PX, width: 200 - CLIP_GUTTER_PX * 2 })
  })

  it('skips the label on a clip too narrow to read it', () => {
    const r = recordingContext()
    drawClipRect(r.ctx, {
      rect: { x: 0, y: 0, width: MIN_LABEL_WIDTH_PX - 1, height: 40 },
      palette: TRACK_PALETTE[0], selected: false, label: '▪ video',
    })
    expect(r.count('fillText')).toBe(0)
  })

  it('draws nothing for a zero-width rect', () => {
    const r = recordingContext()
    drawClipRect(r.ctx, { rect: { x: 10, y: 0, width: 0, height: 40 }, palette: TRACK_PALETTE[0], selected: false, label: 'x' })
    expect(r.calls).toHaveLength(0)
  })

  it('dims a row unrelated to the primary selection', () => {
    const r = recordingContext()
    drawClipRect(r.ctx, { rect: { x: 0, y: 0, width: 80, height: 40 }, palette: TRACK_PALETTE[0], selected: false, label: 'x', dimmed: true })
    expect(r.calls.some(c => c.method === 'set:globalAlpha' && c.args[0] === 0.3)).toBe(true)
  })
})

describe('drawAudioItem', () => {
  it('fills emerald, labels the bar, and rings it when selected', () => {
    const r = recordingContext()
    drawAudioItem(r.ctx, { rect: { x: 10, y: 4, width: 300, height: 32 }, selected: true, muted: false, label: 'Voiceover' })
    expect(r.calls.some(c => c.method === 'set:fillStyle' && c.args[0] === TIMELINE_COLORS.audioFill)).toBe(true)
    expect(r.calls.some(c => c.method === 'set:strokeStyle' && c.args[0] === TIMELINE_COLORS.audioRing)).toBe(true)
    expect(r.of('fillText')[0].args).toEqual(['Voiceover', 16, 20])
  })

  it('uses the muted fill and drops the border', () => {
    const r = recordingContext()
    drawAudioItem(r.ctx, { rect: { x: 0, y: 0, width: 200, height: 32 }, selected: false, muted: true, label: 'Music' })
    expect(r.calls.some(c => c.method === 'set:fillStyle' && c.args[0] === TIMELINE_COLORS.audioMutedFill)).toBe(true)
    expect(r.calls.some(c => c.method === 'set:strokeStyle' && c.args[0] === TIMELINE_COLORS.audioBorder)).toBe(false)
  })

  it('paints fade gradients clipped to the bar', () => {
    const r = recordingContext()
    drawAudioItem(r.ctx, {
      rect: { x: 100, y: 0, width: 200, height: 32 },
      selected: false, muted: false, label: 'Music',
      fadeInPx: 40, fadeOutPx: 5000, // fade-out longer than the bar
    })
    const gradients = r.of('createLinearGradient')
    expect(gradients).toHaveLength(2)
    expect(gradients[0].args).toEqual([100, 0, 140, 0])
    const fadeFills = r.of('fillRect')
    expect(fadeFills[0].args).toEqual([100, 0, 40, 32])
    expect(fadeFills[1].args).toEqual([100, 0, 200, 32]) // clamped to the bar
  })
})

describe('drawPlayhead', () => {
  it('centres the playhead on its time', () => {
    const r = recordingContext()
    drawPlayhead(r.ctx, 400, 0, 160)
    expect(r.of('fillRect')[0].args).toEqual([400 - PLAYHEAD_WIDTH_PX / 2, 0, PLAYHEAD_WIDTH_PX, 160])
    expect(r.calls.some(c => c.method === 'set:fillStyle' && c.args[0] === TIMELINE_COLORS.playhead)).toBe(true)
  })
})

// ── Scene composition ────────────────────────────────────────────────────

describe('drawTimelineContent', () => {
  it('places clips from the viewport, not from a percentage of the project', () => {
    const p = project({ tracks: [[clip({ id: 'c0', start: 10, end: 14 })]] } as unknown as Partial<Project>)
    const r = recordingContext()
    drawTimelineContent(r.ctx, scene({
      project: p,
      layout: computeTimelineLayout(p),
      viewport: viewport({ pxPerSecond: 25, scrollSeconds: 8 }),
    }))

    // (10 - 8) * 25 = 50px from the left, 4s * 25 = 100px wide — then inset by
    // the gutter each side, which is paint only and does not move the clip in time.
    const clipFill = r.of('fillRect')[0]
    expect(clipFill.args).toEqual([50 + CLIP_GUTTER_PX, 0, 100 - CLIP_GUTTER_PX * 2, BASE_VISUAL_ROW_RENDER_HEIGHT_PX])
  })

  it('insets audio bars inside their lane', () => {
    const p = project({ audio: { tracks: [audio({ start: 0, end: 4 })] } } as unknown as Partial<Project>)
    const r = recordingContext()
    drawTimelineContent(r.ctx, scene({ project: p, layout: computeTimelineLayout(p), viewport: viewport({ pxPerSecond: 20 }) }))

    // Audio bars are rounded, so their box is a path, not a fillRect: the lane
    // background's path comes first, the bar's second, inset top and bottom.
    const barHeight = AUDIO_LANE_HEIGHT_PX - AUDIO_ITEM_INSET_PX * 2
    expect(r.of('moveTo')[1].args).toEqual([4, AUDIO_ITEM_INSET_PX])
    expect(r.of('arcTo').some(c =>
      JSON.stringify(c.args) === JSON.stringify([80, AUDIO_ITEM_INSET_PX, 80, AUDIO_ITEM_INSET_PX + barHeight, 4]),
    )).toBe(true)
    expect(r.of('fillText')[0].args).toEqual(['voice.mp3', 6, AUDIO_ITEM_INSET_PX + barHeight / 2])
  })

  it('marks the overlap between two audio bars as a crossfade band', () => {
    const p = project({
      audio: { tracks: [audio({ id: 'a', start: 0, end: 5, lane: 0 }), audio({ id: 'b', start: 4, end: 9, lane: 0 })] },
    } as unknown as Partial<Project>)
    const r = recordingContext()
    drawTimelineContent(r.ctx, scene({ project: p, layout: computeTimelineLayout(p), viewport: viewport({ pxPerSecond: 10 }) }))
    expect(r.calls.some(c => c.method === 'set:fillStyle' && c.args[0] === TIMELINE_COLORS.crossfadeFill)).toBe(true)
  })

  it('never draws the playhead — that is the overlay layer', () => {
    const p = project({ tracks: [[clip({ start: 0, end: 5 })]] } as unknown as Partial<Project>)
    const r = recordingContext()
    drawTimelineContent(r.ctx, scene({ project: p, layout: computeTimelineLayout(p) }))
    expect(r.calls.some(c => c.method === 'set:fillStyle' && c.args[0] === TIMELINE_COLORS.playhead)).toBe(false)
  })

  it('clears before it paints', () => {
    const r = recordingContext()
    drawTimelineContent(r.ctx, scene())
    expect(r.calls[0]).toEqual({ method: 'clearRect', args: [0, 0, 1000, 200] })
  })
})

describe('drawTimelineOverlay', () => {
  it('redraws only the playhead, at the viewport position', () => {
    const r = recordingContext()
    drawTimelineOverlay(r.ctx, {
      viewport: viewport({ pxPerSecond: 40, scrollSeconds: 2 }),
      currentTime: 5,
      surfaceWidth: 1000,
      surfaceHeight: 160,
    })
    expect(r.count('clearRect')).toBe(1)
    expect(r.of('fillRect')[0].args).toEqual([120 - PLAYHEAD_WIDTH_PX / 2, 0, PLAYHEAD_WIDTH_PX, 160])
  })

  it('clears but draws nothing when the playhead is off-screen', () => {
    const r = recordingContext()
    drawTimelineOverlay(r.ctx, {
      viewport: viewport({ pxPerSecond: 40, scrollSeconds: 200 }),
      currentTime: 5,
      surfaceWidth: 1000,
      surfaceHeight: 160,
    })
    expect(r.count('clearRect')).toBe(1)
    expect(r.count('fillRect')).toBe(0)
  })

  // ── The preview-axis cursor, on the same layer as the playhead ──

  it('draws nothing extra when the axis is off (no cursor time)', () => {
    const r = recordingContext()
    drawTimelineOverlay(r.ctx, {
      viewport: viewport({ pxPerSecond: 40, scrollSeconds: 0 }),
      currentTime: 5,
      cursorTime: null,
      surfaceWidth: 1000,
      surfaceHeight: 160,
    })
    expect(r.count('fillRect')).toBe(1)
  })

  it('draws the cursor in yellow, before the playhead', () => {
    const r = recordingContext()
    drawTimelineOverlay(r.ctx, {
      viewport: viewport({ pxPerSecond: 40, scrollSeconds: 0 }),
      currentTime: 5,
      cursorTime: 2,
      surfaceWidth: 1000,
      surfaceHeight: 160,
    })
    const rects = r.of('fillRect')
    expect(rects.length).toBe(2)
    // Cursor first (2s × 40px/s = 80), so the red playhead wins any overlap.
    expect(rects[0].args).toEqual([80 - CURSOR_WIDTH_PX / 2, 0, CURSOR_WIDTH_PX, 160])
    expect(rects[1].args).toEqual([200 - PLAYHEAD_WIDTH_PX / 2, 0, PLAYHEAD_WIDTH_PX, 160])
    const fills = r.of('set:fillStyle').map(c => c.args[0])
    expect(fills).toEqual([TIMELINE_COLORS.cursor, TIMELINE_COLORS.playhead])
  })

  it('culls the cursor when it scrolls off-screen, keeping the playhead', () => {
    const r = recordingContext()
    drawTimelineOverlay(r.ctx, {
      viewport: viewport({ pxPerSecond: 40, scrollSeconds: 0 }),
      currentTime: 5,
      cursorTime: 400,
      surfaceWidth: 1000,
      surfaceHeight: 160,
    })
    expect(r.count('fillRect')).toBe(1)
    expect(r.of('fillRect')[0].args).toEqual([200 - PLAYHEAD_WIDTH_PX / 2, 0, PLAYHEAD_WIDTH_PX, 160])
  })

  it('draws the cursor independently of the playhead — the two diverge by design', () => {
    // This is the whole feature: the pointer is at 3s, playback is still at 0.
    const r = recordingContext()
    drawTimelineOverlay(r.ctx, {
      viewport: viewport({ pxPerSecond: 40, scrollSeconds: 0 }),
      currentTime: 0,
      cursorTime: 3,
      surfaceWidth: 1000,
      surfaceHeight: 160,
    })
    const rects = r.of('fillRect')
    expect(rects[0].args[0]).toBe(120 - CURSOR_WIDTH_PX / 2)
    expect(rects[1].args[0]).toBe(0 - PLAYHEAD_WIDTH_PX / 2)
  })
})

// ── Culling: the virtualization acceptance probe ─────────────────────────

describe('draw culling', () => {
  /** 40 clips over two tracks and 60 audio segments, spanning ~400s. */
  function bigProject(): Project {
    const base: VisualItem[] = []
    const overlays: VisualItem[] = []
    for (let i = 0; i < 20; i++) {
      base.push(clip({ id: `base-${i}`, start: i * 20, end: i * 20 + 19 }))
      overlays.push(clip({ id: `ov-${i}`, type: 'overlay', start: i * 20 + 5, end: i * 20 + 12 }))
    }
    const audioTracks: AudioTrack[] = []
    for (let i = 0; i < 60; i++) {
      audioTracks.push(audio({ id: `au-${i}`, start: i * 6.5, end: i * 6.5 + 6, lane: i % 2 }))
    }
    return project({ tracks: [base, overlays], audio: { tracks: audioTracks } } as unknown as Partial<Project>)
  }

  it('draws only what intersects the visible window', () => {
    const p = bigProject()
    const layout = computeTimelineLayout(p)
    // 1000px surface at 100 px/s = a 10-second window at t=100.
    const zoomedIn = scene({ project: p, layout, viewport: viewport({ pxPerSecond: 100, scrollSeconds: 100 }) })

    const r = recordingContext()
    const stats = drawTimelineContent(r.ctx, zoomedIn)

    const totalItems = 40 + 60
    const drawn = stats.visualItemsDrawn + stats.audioItemsDrawn
    expect(drawn + stats.itemsCulled).toBe(totalItems)

    // A 10s window can hold at most 1 base clip + 1 overlay + 2 audio bars per
    // lane. Bound it generously and still be an order below the project size.
    expect(drawn).toBeLessThanOrEqual(8)
    expect(stats.itemsCulled).toBeGreaterThanOrEqual(totalItems - 8)

    // And the draw-call list is bounded by the viewport too — rows, the drawn
    // items and their labels, nothing per-culled-item.
    const rowCount = layout.rows.length + layout.lanes.length
    expect(r.count('fillText')).toBeLessThanOrEqual(drawn)
    expect(r.count('fillRect')).toBeLessThanOrEqual(rowCount + drawn * 4)
  })

  it('bounds draw calls by viewport size, not project size', () => {
    const small = bigProject()
    const huge = project({
      // Ten times the items over ten times the duration, same visible window.
      tracks: [Array.from({ length: 400 }, (_, i) => clip({ id: `c-${i}`, start: i * 10, end: i * 10 + 9 }))],
      audio: { tracks: Array.from({ length: 600 }, (_, i) => audio({ id: `a-${i}`, start: i * 6.5, end: i * 6.5 + 6, lane: i % 2 })) },
    } as unknown as Partial<Project>)

    const window = { pxPerSecond: 100, scrollSeconds: 100 }
    const a = recordingContext()
    drawTimelineContent(a.ctx, scene({ project: small, layout: computeTimelineLayout(small), viewport: viewport(window) }))
    const b = recordingContext()
    drawTimelineContent(b.ctx, scene({ project: huge, layout: computeTimelineLayout(huge), viewport: viewport(window) }))

    // 10× the project, the same handful of draw calls (within one row's worth).
    expect(Math.abs(b.calls.length - a.calls.length)).toBeLessThan(60)
    expect(b.calls.length).toBeLessThan(200)
  })

  it('draws more, but still only what fits, when zoomed out to the whole project', () => {
    const p = bigProject()
    const layout = computeTimelineLayout(p)
    const r = recordingContext()
    const stats = drawTimelineContent(r.ctx, scene({
      project: p, layout,
      viewport: viewport({ pxPerSecond: 2.5, scrollSeconds: 0 }), // 400s across 1000px
    }))
    expect(stats.visualItemsDrawn + stats.audioItemsDrawn).toBe(100)
    expect(stats.itemsCulled).toBe(0)
  })
})

describe('skipped tracks', () => {
  it('marks a disabled track\'s row so the painter dims it', () => {
    const p = {
      id: 'p',
      tracks: [
        { id: 't0', items: [clip({ id: 'c0' })] },
        { id: 't1', items: [clip({ id: 'o0', type: 'overlay' })], enabled: false },
      ],
    } as unknown as Project
    const layout = computeTimelineLayout(p)
    expect(layout.rows.find(r => r.trackIdx === 1)?.disabled).toBe(true)
    expect(layout.rows.find(r => r.trackIdx === 0)?.disabled).toBe(false)
  })

  it('keeps a skipped row at full height and in place — it stays editable', () => {
    // Dimmed, not collapsed: you have to be able to see a skipped track and
    // click its clips to turn it back on.
    const enabled = { id: 'p', tracks: [{ id: 't0', items: [clip({ id: 'c0' })] }] } as unknown as Project
    const skipped = { id: 'p', tracks: [{ id: 't0', items: [clip({ id: 'c0' })], enabled: false }] } as unknown as Project
    expect(computeTimelineLayout(skipped).rows[0].height).toBe(computeTimelineLayout(enabled).rows[0].height)
    expect(computeTimelineLayout(skipped).height).toBe(computeTimelineLayout(enabled).height)
  })

  it('draws a skipped row at reduced alpha', () => {
    const p = { id: 'p', tracks: [{ id: 't0', items: [clip({ id: 'c0', start: 0, end: 2 })], enabled: false }] } as unknown as Project
    const r = recordingContext()
    drawTimelineContent(r.ctx, scene({ project: p, layout: computeTimelineLayout(p) }))
    expect(r.calls.some(c => c.method === 'set:globalAlpha' && c.args[0] === 0.3)).toBe(true)
  })
})
