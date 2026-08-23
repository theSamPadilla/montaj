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
import type { AudioTrack, CaptionSegment, VisualItem } from '../../../../schema'
import type { Project } from '../../../../types'
import {
  AUDIO_HANDLE_WIDTH_PX,
  AUDIO_ITEM_INSET_PX,
  AUDIO_ITEM_RADIUS_PX,
  CAPTION_PALETTE,
  CLIP_HANDLE_WIDTH_PX,
  CURSOR_WIDTH_PX,
  LABEL_PAD_PX,
  LABEL_TOP_OFFSET_PX,
  CLIP_GUTTER_PX,
  CLIP_SELECTED_BORDER_PX,
  MIN_LABEL_WIDTH_PX,
  PLAYHEAD_WIDTH_PX,
  ROW_RADIUS_PX,
  TIMELINE_COLORS,
  TRACK_PALETTE,
  clampRectToSurface,
  computeTimelineLayout,
  overlapBands,
  drawAudioItem,
  drawCaptionBlock,
  drawClipRect,
  drawTrimHandle,
  RULER_HEIGHT_PX,
  SNAP_GUIDE_CAP_HALF_WIDTH_PX,
  SNAP_GUIDE_WEAK_WIDTH_PX,
  SNAP_GUIDE_WIDTH_PX,
  OVERLAP_EDGE_WIDTH_PX,
  OVERLAP_HATCH_SHADOW_WIDTH_PX,
  OVERLAP_HATCH_WIDTH_PX,
  drawItemHandles,
  drawOverlapBand,
  drawPlayhead,
  drawSnapGuide,
  drawTimelineContent,
  drawTimelineOverlay,
  type DrawContext,
  type TimelineScene,
} from '../draw'
import {
  AUDIO_LANE_HEIGHT_PX,
  BASE_VISUAL_ROW_RENDER_HEIGHT_PX,
  CAPTION_ROW_HEIGHT_PX,
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

function captionSegment(over: Partial<CaptionSegment> = {}): CaptionSegment {
  return { id: 'seg0', text: 'hello world', start: 0, end: 2, ...over }
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

/** What the ruler alone draws at this viewport — an empty project draws the
 *  ruler and nothing else. Content-volume assertions subtract this so they keep
 *  measuring the thing they are about (items, rows) rather than the fixed cost
 *  of the chrome above them. */
function rulerBaseline(vp: Viewport) {
  const empty = project()
  const r = recordingContext()
  drawTimelineContent(r.ctx, scene({ project: empty, layout: computeTimelineLayout(empty), viewport: vp }))
  return { calls: r.calls.length, fillRect: r.count('fillRect'), fillText: r.count('fillText') }
}

// ── Layout ───────────────────────────────────────────────────────────────

describe('computeTimelineLayout', () => {
  it('stacks visual tracks reversed, base track last and taller, audio lanes below', () => {
    const p = project({
      // ov1/ov2 are overlay-typed (not video), so they stay the short row —
      // isolates "base track is tall" from the separate "a VIDEO track is
      // tall" rule below.
      tracks: [[clip({ id: 'base' })], [clip({ id: 'ov1', type: 'overlay' })], [clip({ id: 'ov2', type: 'overlay' })]],
      audio: { tracks: [audio({ id: 'm', lane: 0 }), audio({ id: 'v', lane: 1 })] },
    } as unknown as Partial<Project>)

    const layout = computeTimelineLayout(p)

    // Draw order top→bottom mirrors the DOM's `[...allTracks].reverse()`.
    expect(layout.rows.map(r => r.trackIdx)).toEqual([2, 1, 0])
    // Rows start below the ruler strip, which owns the top of the surface.
    const contentTop = RULER_HEIGHT_PX + ROW_GAP_PX
    expect(layout.ruler).toEqual({ y: 0, height: RULER_HEIGHT_PX })
    expect(layout.rows[0]).toMatchObject({ y: contentTop, height: VISUAL_ROW_RENDER_HEIGHT_PX })
    expect(layout.rows[1]).toMatchObject({ y: contentTop + VISUAL_ROW_RENDER_HEIGHT_PX + ROW_GAP_PX })
    // The base video track is the tall one (`trackRowTall`).
    expect(layout.rows[2].height).toBe(BASE_VISUAL_ROW_RENDER_HEIGHT_PX)

    expect(layout.lanes.map(l => l.laneIndex)).toEqual([0, 1])
    expect(layout.lanes[0].y).toBe(layout.rows[2].y + BASE_VISUAL_ROW_RENDER_HEIGHT_PX + ROW_GAP_PX)
    expect(layout.lanes[1].y).toBe(layout.lanes[0].y + AUDIO_LANE_HEIGHT_PX + ROW_GAP_PX)
    expect(layout.height).toBe(layout.lanes[1].y + AUDIO_LANE_HEIGHT_PX)
  })

  it('gives every VIDEO-kind track the tall base row height, not just trackIdx 0 — an overlay track stays short', () => {
    // A second video track carries the same filmstrip+waveform content as
    // the base track and needs the same room; an overlay/image track has
    // neither and keeps the short row.
    const p = project({
      tracks: [
        [clip({ id: 'base', type: 'video' })],
        [clip({ id: 'video2', type: 'video' })],
        [clip({ id: 'ov', type: 'overlay' })],
      ],
    } as unknown as Partial<Project>)

    const layout = computeTimelineLayout(p)
    expect(layout.rows.find(r => r.trackIdx === 0)!.height).toBe(BASE_VISUAL_ROW_RENDER_HEIGHT_PX)
    expect(layout.rows.find(r => r.trackIdx === 1)!.height).toBe(BASE_VISUAL_ROW_RENDER_HEIGHT_PX)
    expect(layout.rows.find(r => r.trackIdx === 2)!.height).toBe(VISUAL_ROW_RENDER_HEIGHT_PX)
  })

  it('keeps the base track (trackIdx 0) tall even when it has no items yet', () => {
    // trackIdx 0 is always tall regardless of content, so a blank base row
    // doesn't jump size the moment footage lands on it.
    const p = project({ tracks: [[]] } as unknown as Partial<Project>)
    const layout = computeTimelineLayout(p)
    expect(layout.rows.find(r => r.trackIdx === 0)!.height).toBe(BASE_VISUAL_ROW_RENDER_HEIGHT_PX)
  })

  it('reorders a scrambled-input project so the video track is trackIdx 0, even when it was written second on disk (Part B)', () => {
    // Raw/on-disk order: overlay first, video second — `allTracks` here
    // comes from `trackItems`, which funnels through `normalizeTracks`
    // (now order-canonicalizing too), so `computeTimelineLayout` never sees
    // the raw order — the video track lands at trackIdx 0 regardless of
    // where it sat in the stored array.
    const p = project({
      tracks: [
        [{ id: 'ov', type: 'overlay', start: 0, end: 1 }],
        [{ id: 'v0', type: 'video', src: 'v0.mp4', start: 0, end: 1 }],
      ],
    } as unknown as Partial<Project>)

    const layout = computeTimelineLayout(p)
    const baseRow = layout.rows.find(r => r.trackIdx === 0)!
    expect(baseRow.items.map(i => i.id)).toEqual(['v0'])
    expect(baseRow.height).toBe(BASE_VISUAL_ROW_RENDER_HEIGHT_PX)
    const overlayRow = layout.rows.find(r => r.trackIdx === 1)!
    expect(overlayRow.items.map(i => i.id)).toEqual(['ov'])
  })

  it('is empty for an empty project, but still reserves the ruler', () => {
    const layout = computeTimelineLayout(project())
    expect(layout).toEqual({
      ruler: { y: 0, height: RULER_HEIGHT_PX },
      rows: [],
      lanes: [],
      height: RULER_HEIGHT_PX,
    })
  })

  // ── Captions in the canvas layout (Phase 1: one band. Phase 3: N bands) ──

  describe('the caption band(s)', () => {
    it('sits strictly between the last overlay row and the base video row', () => {
      const p = project({
        // Overlay-typed, not `clip()`'s default video — this test is
        // specifically about an OVERLAY row above the base, per its own name.
        tracks: [[clip({ id: 'base' })], [clip({ id: 'ov1', type: 'overlay' })]],
        captions: { style: 'clean', segments: [captionSegment()] },
      } as unknown as Partial<Project>)

      const layout = computeTimelineLayout(p)
      const overlayRow = layout.rows.find(r => r.trackIdx === 1)!
      const baseRow = layout.rows.find(r => r.trackIdx === 0)!

      expect(layout.captions).toHaveLength(1)
      expect(layout.captions![0].lane).toBe(0)
      expect(layout.captions![0].height).toBe(CAPTION_ROW_HEIGHT_PX)
      expect(layout.captions![0].y).toBeGreaterThan(overlayRow.y + overlayRow.height)
      expect(layout.captions![0].y).toBeLessThan(baseRow.y)
      expect(layout.captions![0].segments).toEqual([captionSegment()])
    })

    it('is absent — not an empty array — with no captions, and every other row is unchanged', () => {
      const tracks = [[clip({ id: 'base' })], [clip({ id: 'ov1' })]]
      const noCaptionsAtAll = project({ tracks } as unknown as Partial<Project>)
      const emptySegments = project({
        tracks,
        captions: { style: 'clean', segments: [] },
      } as unknown as Partial<Project>)

      const baseline = computeTimelineLayout(noCaptionsAtAll)
      for (const p of [noCaptionsAtAll, emptySegments]) {
        const layout = computeTimelineLayout(p)
        expect(layout.captions).toBeUndefined()
        expect(layout.rows).toEqual(baseline.rows)
        expect(layout.lanes).toEqual(baseline.lanes)
        expect(layout.height).toBe(baseline.height)
      }
    })

    it('still appears, above where the video row would be, on a project with captions but no visual tracks', () => {
      const p = project({
        captions: { style: 'clean', segments: [captionSegment()] },
      } as unknown as Partial<Project>)
      const layout = computeTimelineLayout(p)

      expect(layout.rows).toEqual([])
      expect(layout.captions).toHaveLength(1)
      expect(layout.captions![0].y).toBe(RULER_HEIGHT_PX + ROW_GAP_PX)
      expect(layout.height).toBe(layout.captions![0].y + CAPTION_ROW_HEIGHT_PX)
    })

    // ── Regression guard (Phase 3) ──
    // Multi-lane captions must not move a single-lane project's band by even
    // one pixel: the exact geometry a lane-0-only project got in Phase 1 is
    // reproduced here, numeral for numeral, rather than compared loosely.
    it('keeps a lane-0-only layout — band y, band height, and total surface height — byte-for-byte identical to before N-lane captions', () => {
      const p = project({
        // Overlay-typed, not `clip()`'s default video: this is the SINGLE
        // -video-track case (only `base` is video) the byte-identical
        // guarantee is about — the caption band still sits directly above
        // the base row, exactly where it always has.
        tracks: [[clip({ id: 'base' })], [clip({ id: 'ov1', type: 'overlay' })]],
        captions: { style: 'clean', segments: [captionSegment()] },
      } as unknown as Partial<Project>)

      const layout = computeTimelineLayout(p)
      // Re-derived from the layout's own rows rather than pinned to a height
      // constant, so this regression guard survives future height changes.
      const upperRow = layout.rows.find(r => r.trackIdx === 1)!
      const baseRow = layout.rows.find(r => r.trackIdx === 0)!
      const band = layout.captions![0]

      expect(layout.captions).toHaveLength(1)
      expect(band).toMatchObject({ lane: 0, height: CAPTION_ROW_HEIGHT_PX })
      expect(band.y).toBe(upperRow.y + upperRow.height + ROW_GAP_PX)
      expect(baseRow.y).toBe(band.y + band.height + ROW_GAP_PX)
      expect(layout.height).toBe(baseRow.y + baseRow.height)
    })

    it('emits N bands in descending lane order, lane 0 landing exactly where the single band sits today', () => {
      const p = project({
        // Overlay-typed, not `clip()`'s default video — single-video-track
        // case, so lane 0 lands directly above `base` with nothing between.
        tracks: [[clip({ id: 'base' })], [clip({ id: 'ov1', type: 'overlay' })]],
        captions: {
          style: 'clean',
          segments: [
            captionSegment({ id: 's0', lane: 0 }),
            captionSegment({ id: 's1', lane: 1, start: 2, end: 4 }),
            captionSegment({ id: 's2', lane: 2, start: 4, end: 6 }),
          ],
        },
      } as unknown as Partial<Project>)

      const layout = computeTimelineLayout(p)
      const baseRow = layout.rows.find(r => r.trackIdx === 0)!

      expect(layout.captions).toHaveLength(3)
      // Index 0 is the HIGHEST lane; the last entry is lane 0.
      expect(layout.captions!.map(c => c.lane)).toEqual([2, 1, 0])

      const [lane2, lane1, lane0] = layout.captions!
      // Lane 0 sits immediately above the base row — the exact position a
      // lane-0-only project's single band has always occupied.
      expect(lane0.y + lane0.height + ROW_GAP_PX).toBe(baseRow.y)
      // Higher lanes stack upward (smaller y) toward the overlays.
      expect(lane1.y).toBeLessThan(lane0.y)
      expect(lane2.y).toBeLessThan(lane1.y)
    })

    // ── Part B: track grouping — the caption band sits above the WHOLE
    // video block, not squeezed between two video tracks ──────────────────

    it('with two video tracks and one overlay track, stacks overlay(top) → captions → video block (topmost video, then base)', () => {
      const p = project({
        tracks: [
          [clip({ id: 'base' })],                      // video, base
          [clip({ id: 'video2', type: 'video' })],      // video, second track
          [clip({ id: 'ov1', type: 'overlay' })],       // overlay
        ],
        captions: { style: 'clean', segments: [captionSegment()] },
      } as unknown as Partial<Project>)

      const layout = computeTimelineLayout(p)
      // Already in canonical order in this fixture (video tracks precede the
      // overlay track), so trackIdx assignment is unchanged from array order
      // — but the DRAW order (top of screen first) is still the reverse.
      expect(layout.rows.map(r => r.trackIdx)).toEqual([2, 1, 0])
      const overlayRow = layout.rows.find(r => r.trackIdx === 2)!
      const video2Row = layout.rows.find(r => r.trackIdx === 1)!
      const baseRow = layout.rows.find(r => r.trackIdx === 0)!

      expect(layout.captions).toHaveLength(1)
      const band = layout.captions![0]
      // Captions sit directly above the TOPMOST video track (video2) — NOT
      // between video2 and base — and directly below the overlay row.
      expect(band.y).toBe(overlayRow.y + overlayRow.height + ROW_GAP_PX)
      expect(video2Row.y).toBe(band.y + band.height + ROW_GAP_PX)
      expect(video2Row.y + video2Row.height + ROW_GAP_PX).toBe(baseRow.y)
    })

    it('a hole lane still gets its own band, empty of segments, rather than being skipped', () => {
      const p = project({
        tracks: [[clip({ id: 'base' })]],
        captions: {
          style: 'clean',
          // Lanes 0 and 2 occupied; lane 1 is a hole.
          segments: [
            captionSegment({ id: 's0', lane: 0 }),
            captionSegment({ id: 's2', lane: 2, start: 4, end: 6 }),
          ],
        },
      } as unknown as Partial<Project>)

      const layout = computeTimelineLayout(p)
      expect(layout.captions).toHaveLength(3)
      expect(layout.captions!.map(c => c.lane)).toEqual([2, 1, 0])
      const holeBand = layout.captions!.find(c => c.lane === 1)!
      expect(holeBand.segments).toEqual([])
      expect(holeBand.height).toBe(CAPTION_ROW_HEIGHT_PX)
    })
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

  // ── Trim handles: the affordance selection is FOR ──
  //
  // The handles themselves are the row painter's job now (a clip stacked on
  // top of this one would bury them), so `drawClipRect` must NOT draw them —
  // only leave room for them.

  it('leaves the handles to the row painter', () => {
    const r = recordingContext()
    drawClipRect(r.ctx, { rect: { x: 0, y: 0, width: 200, height: 40 }, palette: TRACK_PALETTE[0], selected: true, label: '' })
    expect(r.of('set:fillStyle').some(c => c.args[0] === TIMELINE_COLORS.handleFill)).toBe(false)
  })

  it('indents a selected clip\'s label past its in handle', () => {
    const free = recordingContext()
    drawClipRect(free.ctx, { rect: { x: 0, y: 0, width: 200, height: 40 }, palette: TRACK_PALETTE[0], selected: false, label: 'title' })
    const picked = recordingContext()
    drawClipRect(picked.ctx, { rect: { x: 0, y: 0, width: 200, height: 40 }, palette: TRACK_PALETTE[0], selected: true, label: 'title' })
    // Without the indent the pill would sit on top of the first glyph.
    expect(Number(picked.of('fillText')[0].args[1]) - Number(free.of('fillText')[0].args[1]))
      .toBe(CLIP_HANDLE_WIDTH_PX)
  })

  it('dims a row unrelated to the primary selection', () => {
    const r = recordingContext()
    drawClipRect(r.ctx, { rect: { x: 0, y: 0, width: 80, height: 40 }, palette: TRACK_PALETTE[0], selected: false, label: 'x', dimmed: true })
    expect(r.calls.some(c => c.method === 'set:globalAlpha' && c.args[0] === 0.3)).toBe(true)
  })
})

describe('drawTrimHandle', () => {
  // 2 ticks of 1.5px with a 2.5px gap; a 40px-tall row gives the capped 16px
  // tick height, centred, so the grip sits at y=12.
  const GRIP_SPAN = 5.5

  it('pins the in handle to the left edge and the out handle to the right', () => {
    const left = recordingContext()
    drawTrimHandle(left.ctx, { rect: { x: 0, y: 0, width: 100, height: 40 }, edge: 'in', width: 10 })
    expect(left.of('fillRect').map(c => c.args)).toEqual([
      [(10 - GRIP_SPAN) / 2, 12, 1.5, 16],
      [(10 - GRIP_SPAN) / 2 + 4, 12, 1.5, 16],
    ])

    const right = recordingContext()
    drawTrimHandle(right.ctx, { rect: { x: 0, y: 0, width: 100, height: 40 }, edge: 'out', width: 10 })
    // 100 - 10 = 90 is the pill's left edge; the grip is centred in it.
    expect(right.of('fillRect')[0].args[0]).toBe(90 + (10 - GRIP_SPAN) / 2)
  })

  it('draws the pill in the handle white, and its grip dark', () => {
    const r = recordingContext()
    drawTrimHandle(r.ctx, { rect: { x: 0, y: 0, width: 100, height: 40 }, edge: 'in', width: 10 })
    expect(r.of('set:fillStyle').map(c => c.args[0])).toEqual([
      TIMELINE_COLORS.handleFill,
      TIMELINE_COLORS.handleGrip,
    ])
  })

  it('goes opaque under the pointer, so the grabbable edge is unambiguous', () => {
    const r = recordingContext()
    drawTrimHandle(r.ctx, { rect: { x: 0, y: 0, width: 100, height: 40 }, edge: 'in', width: 10, hovered: true })
    expect(r.of('set:fillStyle').map(c => c.args[0])).toEqual([
      TIMELINE_COLORS.handleFillHovered,
      TIMELINE_COLORS.handleGripHovered,
    ])
  })

  it('halves itself on a short clip, so two handles can never meet', () => {
    const r = recordingContext()
    // 12px of clip, 10px of nominal handle: each takes 6 and the grip, which
    // no longer fits with a margin, drops out rather than filling the pill.
    drawTrimHandle(r.ctx, { rect: { x: 0, y: 0, width: 12, height: 40 }, edge: 'out', width: 10 })
    expect(r.count('fill')).toBe(1)
    expect(r.count('fillRect')).toBe(0)
    // The pill starts halfway across, not 10px from the right edge.
    expect(r.of('moveTo')[0].args[0]).toBeGreaterThanOrEqual(6)
  })

  it('draws nothing at all once the pill is thinner than its own outline', () => {
    const r = recordingContext()
    drawTrimHandle(r.ctx, { rect: { x: 0, y: 0, width: 5, height: 40 }, edge: 'in', width: 10 })
    expect(r.calls).toHaveLength(0)
  })

  it('draws nothing for an empty rect', () => {
    const r = recordingContext()
    drawTrimHandle(r.ctx, { rect: { x: 0, y: 0, width: 0, height: 0 }, edge: 'in', width: 10 })
    expect(r.calls).toHaveLength(0)
  })
})

describe('drawAudioItem', () => {
  it('fills emerald, labels the bar, and rings it when selected', () => {
    const r = recordingContext()
    drawAudioItem(r.ctx, { rect: { x: 10, y: 4, width: 300, height: 32 }, selected: true, muted: false, label: 'Voiceover' })
    expect(r.calls.some(c => c.method === 'set:fillStyle' && c.args[0] === TIMELINE_COLORS.audioFill)).toBe(true)
    expect(r.calls.some(c => c.method === 'set:strokeStyle' && c.args[0] === TIMELINE_COLORS.audioRing)).toBe(true)
    // Indented past the in-handle: a selected bar grows a 6px pill on each
    // end, and a label starting under one would lose its first glyph.
    expect(r.of('fillText')[0].args).toEqual(['Voiceover', 16 + AUDIO_HANDLE_WIDTH_PX, 20])
  })

  it('leaves its handles to the lane painter too', () => {
    const r = recordingContext()
    drawAudioItem(r.ctx, { rect: { x: 0, y: 0, width: 300, height: 32 }, selected: true, muted: false, label: '' })
    expect(r.of('set:fillStyle').some(c => c.args[0] === TIMELINE_COLORS.handleFill)).toBe(false)
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

describe('drawCaptionBlock', () => {
  it('fills and borders in the unselected purple, and centres the label', () => {
    const r = recordingContext()
    drawCaptionBlock(r.ctx, { rect: { x: 10, y: 4, width: 200, height: 32 }, selected: false, label: 'hello' })
    expect(r.calls.some(c => c.method === 'set:fillStyle' && c.args[0] === CAPTION_PALETTE.fill)).toBe(true)
    expect(r.calls.some(c => c.method === 'set:strokeStyle' && c.args[0] === CAPTION_PALETTE.border)).toBe(true)
    // Vertically centred (no frames/waveform split to clear, unlike a clip),
    // clipped and unindented since nothing is selected.
    expect(r.of('fillText')[0].args).toEqual(['hello', 10 + LABEL_PAD_PX, 4 + 16])
  })

  it('swaps fill AND border-for-ring on selection, mirroring the retired DOM row', () => {
    const r = recordingContext()
    drawCaptionBlock(r.ctx, { rect: { x: 0, y: 0, width: 200, height: 32 }, selected: true, label: 'x' })
    expect(r.calls.some(c => c.method === 'set:fillStyle' && c.args[0] === CAPTION_PALETTE.fillSelected)).toBe(true)
    expect(r.calls.some(c => c.method === 'set:strokeStyle' && c.args[0] === CAPTION_PALETTE.ring)).toBe(true)
    // Mutually exclusive with the unselected border — the DOM classes were
    // never both at once.
    expect(r.calls.some(c => c.method === 'set:strokeStyle' && c.args[0] === CAPTION_PALETTE.border)).toBe(false)
  })

  it('indents a selected block\'s label past its handle', () => {
    const free = recordingContext()
    drawCaptionBlock(free.ctx, { rect: { x: 0, y: 0, width: 200, height: 32 }, selected: false, label: 'title' })
    const picked = recordingContext()
    drawCaptionBlock(picked.ctx, { rect: { x: 0, y: 0, width: 200, height: 32 }, selected: true, label: 'title' })
    expect(Number(picked.of('fillText')[0].args[1]) - Number(free.of('fillText')[0].args[1]))
      .toBe(AUDIO_HANDLE_WIDTH_PX)
  })

  it('leaves the handles to the row painter, like drawAudioItem', () => {
    const r = recordingContext()
    drawCaptionBlock(r.ctx, { rect: { x: 0, y: 0, width: 200, height: 32 }, selected: true, label: '' })
    expect(r.of('set:fillStyle').some(c => c.args[0] === TIMELINE_COLORS.handleFill)).toBe(false)
  })

  it('skips the label on a block too narrow to read it', () => {
    const r = recordingContext()
    drawCaptionBlock(r.ctx, { rect: { x: 0, y: 0, width: MIN_LABEL_WIDTH_PX - 1, height: 32 }, selected: false, label: 'hello' })
    expect(r.count('fillText')).toBe(0)
  })

  it('draws nothing for a zero-width rect', () => {
    const r = recordingContext()
    drawCaptionBlock(r.ctx, { rect: { x: 0, y: 0, width: 0, height: 32 }, selected: false, label: 'x' })
    expect(r.calls).toHaveLength(0)
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

describe('drawSnapGuide', () => {
  it('centres the line on its x and points both caps inward', () => {
    const r = recordingContext()
    drawSnapGuide(r.ctx, 300, 0, 120)
    expect(r.of('fillRect')[0].args).toEqual([300 - SNAP_GUIDE_WIDTH_PX / 2, 0, SNAP_GUIDE_WIDTH_PX, 120])
    // Each cap's apex sits INSIDE the span — an arrowhead aimed at the
    // boundary, not away from it.
    const apexes = r.of('lineTo').filter((_, i) => i % 2 === 1).map(c => c.args)
    expect(apexes).toEqual([[300, 7], [300, 113]])
  })
})

describe('drawItemHandles', () => {
  it('draws one handle on each end', () => {
    const r = recordingContext()
    drawItemHandles(r.ctx, { x: 0, y: 0, width: 200, height: 40 }, CLIP_HANDLE_WIDTH_PX)
    expect(r.of('set:fillStyle').filter(c => c.args[0] === TIMELINE_COLORS.handleFill)).toHaveLength(2)
  })

  it('lights only the handle the pointer is on', () => {
    const r = recordingContext()
    drawItemHandles(r.ctx, { x: 0, y: 0, width: 200, height: 40 }, CLIP_HANDLE_WIDTH_PX, 'out')
    const fills = r.of('set:fillStyle').map(c => c.args[0])
    expect(fills.filter(f => f === TIMELINE_COLORS.handleFill)).toHaveLength(1)
    expect(fills.filter(f => f === TIMELINE_COLORS.handleFillHovered)).toHaveLength(1)
  })
})

describe('overlapBands', () => {
  it('returns the intersection of each overlapping consecutive pair', () => {
    expect(overlapBands([{ start: 0, end: 5 }, { start: 4, end: 9 }])).toEqual([{ start: 4, end: 5 }])
  })

  it('sorts by start first, so array order cannot hide an overlap', () => {
    expect(overlapBands([{ start: 4, end: 9 }, { start: 0, end: 5 }])).toEqual([{ start: 4, end: 5 }])
  })

  it('clamps to the shorter item when one is contained in the other', () => {
    expect(overlapBands([{ start: 0, end: 9 }, { start: 2, end: 4 }])).toEqual([{ start: 2, end: 4 }])
  })

  it('ignores items that only touch, and gaps', () => {
    expect(overlapBands([{ start: 0, end: 5 }, { start: 5, end: 9 }])).toEqual([])
    expect(overlapBands([{ start: 0, end: 4 }, { start: 5, end: 9 }])).toEqual([])
  })

  it('finds every overlap in a run, not just the first', () => {
    expect(overlapBands([{ start: 0, end: 3 }, { start: 2, end: 6 }, { start: 5, end: 8 }]))
      .toEqual([{ start: 2, end: 3 }, { start: 5, end: 6 }])
  })

  it('has nothing to say about zero or one item', () => {
    expect(overlapBands([])).toEqual([])
    expect(overlapBands([{ start: 0, end: 5 }])).toEqual([])
  })
})

describe('drawOverlapBand', () => {
  it('does not share a literal with the muted-audio fill', () => {
    // Both are near-transparent white. If they ever converge, a muted bar and
    // an overlap band become indistinguishable by colour, and every test that
    // keys on one of them starts matching the other.
    expect(TIMELINE_COLORS.overlapFill).not.toBe(TIMELINE_COLORS.audioMutedFill)
  })

  it('washes, hatches and rules both edges', () => {
    const r = recordingContext()
    drawOverlapBand(r.ctx, { x: 100, y: 0, width: 60, height: 40 })
    const fills = r.of('set:fillStyle').map(c => c.args[0])
    expect(fills).toEqual([TIMELINE_COLORS.overlapFill, TIMELINE_COLORS.overlapEdge])
    // The wash, then a hard rule down each side.
    const rects = r.of('fillRect').map(c => c.args)
    expect(rects[0]).toEqual([100, 0, 60, 40])
    expect(rects[1]).toEqual([100, 0, OVERLAP_EDGE_WIDTH_PX, 40])
    expect(rects[2]).toEqual([100 + 60 - OVERLAP_EDGE_WIDTH_PX, 0, OVERLAP_EDGE_WIDTH_PX, 40])
    // The hatch is stroked twice off one path: a wide dark pass, then amber
    // inside it, so it reads over a bright frame and a dark one alike.
    expect(r.of('set:strokeStyle').map(c => c.args[0])).toEqual([
      TIMELINE_COLORS.overlapHatchShadow,
      TIMELINE_COLORS.overlapHatch,
    ])
    expect(r.of('set:lineWidth').map(c => c.args[0])).toEqual([
      OVERLAP_HATCH_SHADOW_WIDTH_PX,
      OVERLAP_HATCH_WIDTH_PX,
    ])
    expect(r.count('stroke')).toBe(2)
    expect(r.count('beginPath')).toBe(2)   // the clip rect, then the one hatch path
  })

  it('clips the hatching so the diagonals stop at the band', () => {
    const r = recordingContext()
    drawOverlapBand(r.ctx, { x: 100, y: 0, width: 60, height: 40 })
    const clipAt = r.calls.findIndex(c => c.method === 'clip')
    const strokeAt = r.calls.findIndex(c => c.method === 'stroke')
    expect(clipAt).toBeGreaterThanOrEqual(0)
    expect(clipAt).toBeLessThan(strokeAt)
    // …and the edges are painted after the clip is released, so they stay full
    // weight right up to the band's boundary.
    expect(r.calls.findIndex(c => c.method === 'restore')).toBeLessThan(
      r.calls.map(c => c.method === 'set:fillStyle' ? c.args[0] : null).indexOf(TIMELINE_COLORS.overlapEdge),
    )
  })

  it('leans its hatching one way, evenly spaced', () => {
    const r = recordingContext()
    drawOverlapBand(r.ctx, { x: 0, y: 0, width: 18, height: 10 })
    // Bottom-left to top-right, every OVERLAP_HATCH_SPACING_PX across a span
    // of width + height.
    expect(r.of('moveTo').map(c => c.args)).toEqual([[0, 10], [9, 10], [18, 10], [27, 10]])
    expect(r.of('lineTo').map(c => c.args)).toEqual([[-10, 0], [-1, 0], [8, 0], [17, 0]])
  })

  it('never lets the two edge rules cross on a hairline overlap', () => {
    const r = recordingContext()
    drawOverlapBand(r.ctx, { x: 100, y: 0, width: 3, height: 40 })
    const rects = r.of('fillRect').map(c => c.args as number[])
    expect(rects[1][2]).toBe(1.5)
    expect(rects[2][0]).toBe(101.5)
  })

  it('draws nothing for an empty band', () => {
    const r = recordingContext()
    drawOverlapBand(r.ctx, { x: 10, y: 0, width: 0, height: 40 })
    expect(r.calls).toHaveLength(0)
  })
})

describe('drawSnapGuide — weak', () => {
  it('draws a capless hairline for a cross-track boundary', () => {
    const r = recordingContext()
    drawSnapGuide(r.ctx, 300, 0, 120, 'weak')
    expect(r.of('fillRect')[0].args).toEqual([300 - SNAP_GUIDE_WEAK_WIDTH_PX / 2, 0, SNAP_GUIDE_WEAK_WIDTH_PX, 120])
    expect(r.of('set:fillStyle')[0].args[0]).toBe(TIMELINE_COLORS.snapGuideWeak)
    // No arrowheads: the caps are what make the strong guide shout, and this
    // one is meant to be barely there.
    expect(r.count('closePath')).toBe(0)
  })

  it('is thinner than the strong guide it sits alongside', () => {
    expect(SNAP_GUIDE_WEAK_WIDTH_PX).toBeLessThan(SNAP_GUIDE_WIDTH_PX)
  })
})

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
    // Located by its width rather than by call order: the ruler and the row
    // background both fillRect before the clip does.
    const rowY = computeTimelineLayout(p).rows[0].y
    const clipFill = r.of('fillRect').find(c => c.args[2] === 100 - CLIP_GUTTER_PX * 2)
    expect(clipFill?.args).toEqual([50 + CLIP_GUTTER_PX, rowY, 100 - CLIP_GUTTER_PX * 2, BASE_VISUAL_ROW_RENDER_HEIGHT_PX])
  })

  it('insets audio bars inside their lane, left/right AND top/bottom', () => {
    const p = project({ audio: { tracks: [audio({ start: 0, end: 4 })] } } as unknown as Partial<Project>)
    const r = recordingContext()
    drawTimelineContent(r.ctx, scene({ project: p, layout: computeTimelineLayout(p), viewport: viewport({ pxPerSecond: 20 }) }))

    // Audio bars are rounded, so their box is a path, not a fillRect: the lane
    // background's path comes first, the bar's second, inset top and bottom
    // by AUDIO_ITEM_INSET_PX, AND left/right by CLIP_GUTTER_PX — the same
    // horizontal gutter a video clip gets, so two touching audio bars show
    // the same uniform gap two touching video clips do.
    const barHeight = AUDIO_LANE_HEIGHT_PX - AUDIO_ITEM_INSET_PX * 2
    // Lane y, not 0: the ruler owns the top of the surface and everything below
    // it is offset by that strip.
    const barTop = computeTimelineLayout(p).lanes[0].y + AUDIO_ITEM_INSET_PX
    // 4s @ 20px/s = 80px span, inset by CLIP_GUTTER_PX on each side.
    const barLeft = CLIP_GUTTER_PX
    const barRight = 80 - CLIP_GUTTER_PX
    expect(r.of('moveTo')[1].args).toEqual([barLeft + 4, barTop])
    expect(r.of('arcTo').some(c =>
      JSON.stringify(c.args) === JSON.stringify([barRight, barTop, barRight, barTop + barHeight, 4]),
    )).toBe(true)
    // By content, not by index — the ruler's own tick labels are fillText too.
    const barLabel = r.of('fillText').find(c => c.args[0] === 'voice.mp3')
    expect(barLabel?.args).toEqual(['voice.mp3', barLeft + 6, barTop + barHeight / 2])
  })

  it('gives two butted audio bars the same uniform CLIP_GUTTER_PX gap two butted video clips get, not a seamless touch', () => {
    const p = project({
      audio: {
        tracks: [
          audio({ id: 'a', start: 0, end: 5, lane: 0 }),
          audio({ id: 'b', start: 5, end: 9, lane: 0 }), // butted to `a` — no gap in time
        ],
      },
    } as unknown as Partial<Project>)
    const r = recordingContext()
    drawTimelineContent(r.ctx, scene({ project: p, layout: computeTimelineLayout(p), viewport: viewport({ pxPerSecond: 10 }) }))

    // Path order: the lane background's own roundRectPath moves first, then
    // each bar's fill path, one moveTo apiece (unselected, unmuted — fill and
    // border share the one path).
    const [, aMoveTo, bMoveTo] = r.of('moveTo').map(c => c.args as number[])
    const aLeft = aMoveTo[0] - AUDIO_ITEM_RADIUS_PX
    const bLeft = bMoveTo[0] - AUDIO_ITEM_RADIUS_PX
    // `a` spans [0,5) → raw x 0; `b` starts immediately after at raw x 50
    // (5s × 10px/s). Each bar's drawn left edge sits CLIP_GUTTER_PX in from
    // its raw span start — the identical inset a video clip's `clipBodyRect`
    // applies — so the two bars show a uniform 2×CLIP_GUTTER_PX gap rather
    // than touching.
    expect(aLeft).toBe(CLIP_GUTTER_PX)
    expect(bLeft).toBe(50 + CLIP_GUTTER_PX)
  })

  it('marks the overlap between two audio bars as a crossfade band', () => {
    const p = project({
      audio: { tracks: [audio({ id: 'a', start: 0, end: 5, lane: 0 }), audio({ id: 'b', start: 4, end: 9, lane: 0 })] },
    } as unknown as Partial<Project>)
    const r = recordingContext()
    drawTimelineContent(r.ctx, scene({ project: p, layout: computeTimelineLayout(p), viewport: viewport({ pxPerSecond: 10 }) }))
    expect(r.calls.some(c => c.method === 'set:strokeStyle' && c.args[0] === TIMELINE_COLORS.overlapHatch)).toBe(true)
  })

  it('leaves a muted bar out of the pairing — it is crossfading with nothing', () => {
    const p = project({
      audio: { tracks: [audio({ id: 'a', start: 0, end: 5, lane: 0 }), audio({ id: 'b', start: 4, end: 9, lane: 0, muted: true })] },
    } as unknown as Partial<Project>)
    const r = recordingContext()
    drawTimelineContent(r.ctx, scene({ project: p, layout: computeTimelineLayout(p), viewport: viewport({ pxPerSecond: 10 }) }))
    expect(r.calls.some(c => c.method === 'set:strokeStyle' && c.args[0] === TIMELINE_COLORS.overlapHatch)).toBe(false)
  })

  // ── Overlaps on a VISUAL row: previously not marked at all ──

  it('marks two overlapping clips on a video track', () => {
    // The bug this fixes: within a track the later clip simply wins, so this
    // span is one second of clip `a` that will never be seen — and the only
    // sign of it was the clip band's wash landing twice.
    const p = project({ tracks: [[clip({ id: 'a', start: 0, end: 5 }), clip({ id: 'b', start: 4, end: 9 })]] } as unknown as Partial<Project>)
    const r = recordingContext()
    drawTimelineContent(r.ctx, scene({ project: p, layout: computeTimelineLayout(p), viewport: viewport({ pxPerSecond: 10 }) }))
    expect(r.calls.some(c => c.method === 'set:strokeStyle' && c.args[0] === TIMELINE_COLORS.overlapHatch)).toBe(true)
  })

  it('draws no band for clips that merely touch', () => {
    // Butted-up clips are the normal case and must stay unmarked, or every
    // cut on the timeline would be hatched.
    const p = project({ tracks: [[clip({ id: 'a', start: 0, end: 5 }), clip({ id: 'b', start: 5, end: 9 })]] } as unknown as Partial<Project>)
    const r = recordingContext()
    drawTimelineContent(r.ctx, scene({ project: p, layout: computeTimelineLayout(p), viewport: viewport({ pxPerSecond: 10 }) }))
    expect(r.calls.some(c => c.method === 'set:strokeStyle' && c.args[0] === TIMELINE_COLORS.overlapHatch)).toBe(false)
  })

  it('draws the band over the clips it spans, not under them', () => {
    const p = project({ tracks: [[clip({ id: 'a', start: 0, end: 5 }), clip({ id: 'b', start: 4, end: 9 })]] } as unknown as Partial<Project>)
    const r = recordingContext()
    drawTimelineContent(r.ctx, scene({ project: p, layout: computeTimelineLayout(p), viewport: viewport({ pxPerSecond: 10 }) }))
    const lastClipFill = r.calls.map(c => c.method === 'set:fillStyle' ? c.args[0] : null).lastIndexOf(TRACK_PALETTE[0].fill)
    const bandAt = r.calls.findIndex(c => c.method === 'set:strokeStyle' && c.args[0] === TIMELINE_COLORS.overlapHatch)
    expect(bandAt).toBeGreaterThan(lastClipFill)
  })

  it('draws a selected clip\'s handles after every clip in the row', () => {
    // The bug: clip `b` overlaps the end of the selected clip `a`, so painting
    // handles in stacking order buried a's out handle under b. You could see
    // the clip was selected and had no way to see — or reach — its trailing
    // edge.
    const p = project({ tracks: [[clip({ id: 'a', start: 0, end: 5 }), clip({ id: 'b', start: 4, end: 9 })]] } as unknown as Partial<Project>)
    const r = recordingContext()
    drawTimelineContent(r.ctx, scene({ project: p, layout: computeTimelineLayout(p), selectedIds: ['a'], viewport: viewport({ pxPerSecond: 30 }) }))

    const handleAt = r.calls.map(c => c.method === 'set:fillStyle' ? c.args[0] : null).lastIndexOf(TIMELINE_COLORS.handleFill)
    const lastClipFill = r.calls.map(c => c.method === 'set:fillStyle' ? c.args[0] : null).lastIndexOf(TRACK_PALETTE[0].fill)
    expect(handleAt).toBeGreaterThan(lastClipFill)
    // …and over the overlap hatching as well, since the handle is the control.
    const bandAt = r.calls.findIndex(c => c.method === 'set:strokeStyle' && c.args[0] === TIMELINE_COLORS.overlapHatch)
    expect(handleAt).toBeGreaterThan(bandAt)
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

  // ── Captions (Phase 1: display only) ──

  describe('the caption band', () => {
    function projectWithCaptions(segments: CaptionSegment[]): Project {
      return project({
        tracks: [[clip({ id: 'base', start: 0, end: 20 })]],
        captions: { style: 'clean', segments },
      } as unknown as Partial<Project>)
    }

    it('draws one block per segment', () => {
      const p = projectWithCaptions([
        captionSegment({ id: 's0', start: 0, end: 2, text: 'a' }),
        captionSegment({ id: 's1', start: 2, end: 4, text: 'b' }),
        captionSegment({ id: 's2', start: 4, end: 6, text: 'c' }),
      ])
      const r = recordingContext()
      const stats = drawTimelineContent(r.ctx, scene({ project: p, layout: computeTimelineLayout(p) }))
      expect(stats.captionItemsDrawn).toBe(3)
      expect(r.of('set:fillStyle').filter(c => c.args[0] === CAPTION_PALETTE.fill)).toHaveLength(3)
    })

    it('highlights the block in scene.selectedIds and gives it handles; the others get neither', () => {
      const p = projectWithCaptions([
        captionSegment({ id: 's0', start: 0, end: 2, text: 'a' }),
        captionSegment({ id: 's1', start: 2, end: 4, text: 'b' }),
      ])
      const r = recordingContext()
      // Caption ids live in the SAME unified selectedIds array as clips/audio —
      // no separate `selectedCaptionId` scene field.
      drawTimelineContent(r.ctx, scene({ project: p, layout: computeTimelineLayout(p), selectedIds: ['s1'] }))

      expect(r.of('set:fillStyle').filter(c => c.args[0] === CAPTION_PALETTE.fillSelected)).toHaveLength(1)
      expect(r.of('set:fillStyle').filter(c => c.args[0] === CAPTION_PALETTE.fill)).toHaveLength(1)
      expect(r.of('set:strokeStyle').filter(c => c.args[0] === CAPTION_PALETTE.ring)).toHaveLength(1)
      // Exactly one block's worth of handles (2 pills: in + out).
      expect(r.of('set:fillStyle').filter(c => c.args[0] === TIMELINE_COLORS.handleFill)).toHaveLength(2)
    })

    it('honors hoveredHandle for the selected caption', () => {
      const p = projectWithCaptions([captionSegment({ id: 's0', start: 0, end: 2, text: 'a' })])
      const r = recordingContext()
      drawTimelineContent(r.ctx, scene({
        project: p,
        layout: computeTimelineLayout(p),
        selectedIds: ['s0'],
        hoveredHandle: { itemId: 's0', edge: 'out' },
      }))
      expect(r.of('set:fillStyle').some(c => c.args[0] === TIMELINE_COLORS.handleFillHovered)).toBe(true)
    })

    it('culls segments outside the visible range', () => {
      const p = projectWithCaptions([
        captionSegment({ id: 's0', start: 0, end: 2, text: 'a' }),
        captionSegment({ id: 's1', start: 500, end: 502, text: 'far away' }),
      ])
      const r = recordingContext()
      const stats = drawTimelineContent(r.ctx, scene({
        project: p, layout: computeTimelineLayout(p), viewport: viewport({ pxPerSecond: 10 }),
      }))
      expect(stats.captionItemsDrawn).toBe(1)
      expect(stats.itemsCulled).toBeGreaterThanOrEqual(1)
    })

    it('draws an id-less segment (before backfillCaptionIds runs) but never selects it', () => {
      const p = projectWithCaptions([{ text: 'no id yet', start: 0, end: 2 } as CaptionSegment])
      const r = recordingContext()
      const stats = drawTimelineContent(r.ctx, scene({ project: p, layout: computeTimelineLayout(p) }))
      expect(stats.captionItemsDrawn).toBe(1)
      expect(r.of('set:fillStyle').some(c => c.args[0] === CAPTION_PALETTE.fillSelected)).toBe(false)
    })

    it('is a no-op on a project with no captions', () => {
      const p = project({ tracks: [[clip({ id: 'base' })]] } as unknown as Partial<Project>)
      const r = recordingContext()
      const stats = drawTimelineContent(r.ctx, scene({ project: p, layout: computeTimelineLayout(p) }))
      expect(stats.captionItemsDrawn).toBe(0)
      expect(r.of('set:fillStyle').some(c => c.args[0] === CAPTION_PALETTE.fill)).toBe(false)
    })

    // ── N bands (Phase 3) ──

    it('paints every band\'s background, including a hole lane that draws no blocks', () => {
      const p = projectWithCaptions([
        captionSegment({ id: 's0', lane: 0, start: 0, end: 2, text: 'a' }),
        captionSegment({ id: 's2', lane: 2, start: 4, end: 6, text: 'c' }),
        // Lane 1 is a hole — no segment sits there, but it still gets a band.
      ])
      const layout = computeTimelineLayout(p)
      expect(layout.captions).toHaveLength(3)
      const holeBand = layout.captions!.find(c => c.lane === 1)!
      expect(holeBand.segments).toEqual([])

      const r = recordingContext()
      const stats = drawTimelineContent(r.ctx, scene({ project: p, layout, viewport: viewport({ pxPerSecond: 10 }) }))

      // Two real segments drawn; the hole lane draws none.
      expect(stats.captionItemsDrawn).toBe(2)
      // Its background is still painted. `drawRowBackground`'s `roundRectPath`
      // opens with `moveTo(x + radius, y)`, so finding that call at the hole
      // band's own y proves the fill pass ran for it despite the empty
      // segment list — this is what stops the timeline jumping by a whole
      // row height mid-drag when a caption moves out of a lane that was
      // otherwise alone.
      expect(r.of('moveTo').some(c => c.args[0] === ROW_RADIUS_PX && c.args[1] === holeBand.y)).toBe(true)
    })
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

  // ── The snap guide: what makes a strong magnet legible ──

  it('draws no guide when no gesture is snapped', () => {
    const r = recordingContext()
    drawTimelineOverlay(r.ctx, {
      viewport: viewport({ pxPerSecond: 40, scrollSeconds: 0 }),
      currentTime: 5,
      snapTime: null,
      surfaceWidth: 1000,
      surfaceHeight: 160,
    })
    expect(r.of('set:fillStyle').some(c => c.args[0] === TIMELINE_COLORS.snapGuide)).toBe(false)
  })

  it('marks the snapped boundary in cyan, with an arrowhead at each end', () => {
    const r = recordingContext()
    drawTimelineOverlay(r.ctx, {
      viewport: viewport({ pxPerSecond: 40, scrollSeconds: 0 }),
      currentTime: 5,
      snapTime: 2,
      surfaceWidth: 1000,
      surfaceHeight: 160,
    })
    const rects = r.of('fillRect')
    // Playhead first (5s × 40 = 200), then the guide at 2s × 40 = 80.
    expect(rects).toHaveLength(2)
    expect(rects[1].args).toEqual([80 - SNAP_GUIDE_WIDTH_PX / 2, 0, SNAP_GUIDE_WIDTH_PX, 160])
    // Two triangles — the caps are what stop this reading as a third playhead.
    expect(r.of('closePath')).toHaveLength(2)
    expect(r.of('moveTo').map(c => c.args)).toEqual([
      [80 - SNAP_GUIDE_CAP_HALF_WIDTH_PX, 0],
      [80 - SNAP_GUIDE_CAP_HALF_WIDTH_PX, 160],
    ])
  })

  it('draws the guide LAST, so snapping to the playhead still looks snapped', () => {
    const r = recordingContext()
    drawTimelineOverlay(r.ctx, {
      viewport: viewport({ pxPerSecond: 40, scrollSeconds: 0 }),
      currentTime: 3,
      cursorTime: 1,
      snapTime: 3,
      surfaceWidth: 1000,
      surfaceHeight: 160,
    })
    expect(r.of('set:fillStyle').map(c => c.args[0])).toEqual([
      TIMELINE_COLORS.cursor,
      TIMELINE_COLORS.playhead,
      TIMELINE_COLORS.snapGuide,
    ])
  })

  it('carries the tier through to the painter', () => {
    const r = recordingContext()
    drawTimelineOverlay(r.ctx, {
      viewport: viewport({ pxPerSecond: 40, scrollSeconds: 0 }),
      currentTime: 5,
      snapTime: 2,
      snapStrength: 'weak',
      surfaceWidth: 1000,
      surfaceHeight: 160,
    })
    expect(r.of('set:fillStyle').map(c => c.args[0])).toEqual([
      TIMELINE_COLORS.playhead,
      TIMELINE_COLORS.snapGuideWeak,
    ])
  })

  it('culls the guide when it scrolls off-screen', () => {
    const r = recordingContext()
    drawTimelineOverlay(r.ctx, {
      viewport: viewport({ pxPerSecond: 40, scrollSeconds: 0 }),
      currentTime: 5,
      snapTime: 400,
      surfaceWidth: 1000,
      surfaceHeight: 160,
    })
    expect(r.count('fillRect')).toBe(1)
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
    const base = rulerBaseline(zoomedIn.viewport)
    expect(r.count('fillText') - base.fillText).toBeLessThanOrEqual(drawn)
    expect(r.count('fillRect') - base.fillRect).toBeLessThanOrEqual(rowCount + drawn * 4)
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
    // The ruler is a fixed cost at a fixed viewport, so it cancels in the
    // difference and is subtracted from the absolute bound.
    const base = rulerBaseline(viewport(window))
    expect(Math.abs(b.calls.length - a.calls.length)).toBeLessThan(60)
    expect(b.calls.length - base.calls).toBeLessThan(200)
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

  it('marks a muted track\'s row so the painter can gray its clips\' waveforms', () => {
    const p = {
      id: 'p',
      tracks: [
        { id: 't0', items: [clip({ id: 'c0' })] },
        { id: 't1', items: [clip({ id: 'o0', type: 'overlay' })], muted: true },
      ],
    } as unknown as Project
    const layout = computeTimelineLayout(p)
    expect(layout.rows.find(r => r.trackIdx === 1)?.trackMuted).toBe(true)
    expect(layout.rows.find(r => r.trackIdx === 0)?.trackMuted).toBe(false)
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

describe('drawTimelineContent — an audio track with no start/end', () => {
  // Regression: `intersectsRange(undefined, undefined, range)` is false, so the
  // lane was culled and the timeline showed an empty row while the export was
  // correct. See `resolveAudioWindow` in timeline-model.ts.
  const p = {
    id: 'p',
    tracks: [[{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10 }]],
    audio: { tracks: [{ id: 'bed', src: 'song.mp3' }] },
  } as unknown as Project

  it('draws the bar instead of culling it', () => {
    const layout = computeTimelineLayout(p)
    expect(layout.lanes).toHaveLength(1)
    const r = recordingContext()
    const stats = drawTimelineContent(r.ctx, scene({ project: p, layout }))
    expect(stats.audioItemsDrawn).toBe(1)
    expect(stats.itemsCulled).toBe(0)
  })

  it('gives it a positive width', () => {
    const layout = computeTimelineLayout(p)
    const [t] = layout.lanes[0].tracks
    expect(t.end - t.start).toBeGreaterThan(0)
  })
})
