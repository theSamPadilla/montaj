/// <reference types="vitest/globals" />
/**
 * Dragging a clip to another row, end to end through the pointer machine:
 * press, a few moves to the destination row's drawn position, release, and the
 * committed project re-laid out the way the canvas lays out the echoed project.
 * One case each for audio, video and overlay, plus the audio rows that must not
 * move when one clip changes row.
 */
import { describe, it, expect } from 'vitest'
import type { Project } from '../../../../types'
import type { AudioTrack } from '../../../../schema'
import { ROW_GAP_PX, computeAutoCrossfade, computeDerivedTiming, groupAudioLanes, normalizeTracks, stampAudioLanes } from '../../timeline-model'
import { DARK_TIMELINE_PALETTE, LIGHT_TIMELINE_PALETTE, computeTimelineLayout, drawTimelineContent, type DrawContext } from '../draw'
import { NO_MODIFIERS, createPointerMachine, type PointerContext, type PointerEffect } from '../pointer-machine'

const VIEWPORT = { pxPerSecond: 100, scrollSeconds: 0, widthPx: 2000 }

function ctxFor(project: Project): PointerContext {
  const { snapBoundaries, totalDuration } = computeDerivedTiming(project)
  return {
    project, layout: computeTimelineLayout(project), viewport: VIEWPORT, selectedIds: [],
    snapBoundaries, totalDuration, rippleMode: false, playheadTime: -100, fps: 30,
    snapConfig: { attractPx: 0, releasePx: 0, weakAttractPx: 0, weakReleasePx: 0 },
  }
}

type Point = { x: number; y: number }

/** Press at `from`, move there in four steps, release. Every effect, and the committed project. */
function drag(project: Project, from: Point, to: Point) {
  const m = createPointerMachine()
  const ctx = ctxFor(project)
  const effects: PointerEffect[] = []
  effects.push(...m.dispatch({ type: 'pointerDown', point: from, modifiers: NO_MODIFIERS, ctx }))
  for (let i = 1; i <= 4; i++) {
    const point = { x: from.x + (to.x - from.x) * i / 4, y: from.y + (to.y - from.y) * i / 4 }
    effects.push(...m.dispatch({ type: 'pointerMove', point, modifiers: NO_MODIFIERS, ctx }))
  }
  const up = m.dispatch({ type: 'pointerUp', point: to, modifiers: NO_MODIFIERS, ctx })
  effects.push(...up)
  const commits = up.filter((e): e is Extract<PointerEffect, { type: 'commit' }> => e.type === 'commit')
  expect(commits).toHaveLength(1)
  return { committed: commits[0].project, effects }
}

function rowMid(project: Project, trackIdx: number): number {
  const row = computeTimelineLayout(project).rows.find(r => r.trackIdx === trackIdx)!
  return Math.round(row.y + row.height / 2)
}

function laneMid(project: Project, laneIndex: number): number {
  const lane = computeTimelineLayout(project).lanes.find(l => l.laneIndex === laneIndex)!
  return Math.round(lane.y + lane.height / 2)
}

/** The id of the track holding `itemId`, read off the drawn rows of `project`. */
function trackIdOf(project: Project, itemId: string): string | undefined {
  const row = computeTimelineLayout(project).rows.find(r => r.items.some(i => i.id === itemId))
  return row === undefined ? undefined : normalizeTracks(project).tracks![row.trackIdx].id
}

/** Track ids per drawn audio row, top row first. */
function audioRows(project: Project): string[][] {
  return computeTimelineLayout(project).lanes.map(l => l.tracks.map(t => t.id))
}

function laneOf(project: Project, id: string): number | undefined {
  return project.audio!.tracks.find(t => t.id === id)!.lane
}

const ROW_STRIDE = (lane: { height: number }) => lane.height + ROW_GAP_PX

function audioProject(tracks: AudioTrack[]): Project {
  return {
    id: 'p',
    tracks: [{ id: 'trk-0', items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 20, inPoint: 0, outPoint: 20, sourceDuration: 20 }] }],
    audio: { tracks },
  } as unknown as Project
}

// ── Audio ────────────────────────────────────────────────────────────────

describe('audio: dragging a clip into the row above', () => {
  // No lanes anywhere, as an AI writes it: music first, so its row is on top;
  // two voice clips that overlap, so they pack into two voice rows.
  const project = () => audioProject([
    { id: 'music', type: 'music', src: 'm.mp3', start: 0, end: 10 },
    { id: 'voA', type: 'voiceover', src: 'a.wav', start: 0, end: 2 },
    { id: 'voB', type: 'voiceover', src: 'b.wav', start: 1.5, end: 3 },
  ] as AudioTrack[])

  it('starts as three rows: music, voA, voB', () => {
    expect(audioRows(project())).toEqual([['music'], ['voA'], ['voB']])
  })

  it('puts the clip IN the row above, next to the clip there, and moves no other row', () => {
    const p = project()
    // voB's body at 2.5 s, up one row and 0.5 s right, so it sits after voA (2..3.5).
    const { committed } = drag(p, { x: 250, y: laneMid(p, 2) }, { x: 300, y: laneMid(p, 1) })
    const voB = committed.audio!.tracks.find(t => t.id === 'voB')!
    expect(voB.start).toBeCloseTo(2)
    expect(audioRows(committed)).toEqual([['music'], ['voA', 'voB']])
    // Every lane written down, music's where it was drawn.
    expect(laneOf(committed, 'music')).toBe(0)
    expect(laneOf(committed, 'voA')).toBe(1)
    expect(laneOf(committed, 'voB')).toBe(1)
  })

  it('stays in that row after the project is grouped again', () => {
    const p = project()
    const { committed } = drag(p, { x: 250, y: laneMid(p, 2) }, { x: 300, y: laneMid(p, 1) })
    const regrouped = groupAudioLanes(committed.audio!.tracks, computeDerivedTiming(committed).contentDuration)
    expect(regrouped.map(l => l.tracks.map(t => t.id))).toEqual([['music'], ['voA', 'voB']])
  })

  it('never renumbers a row mid-drag: every transient frame keeps music on top', () => {
    const p = project()
    const { effects } = drag(p, { x: 250, y: laneMid(p, 2) }, { x: 300, y: laneMid(p, 1) })
    const frames = effects.filter((e): e is Extract<PointerEffect, { type: 'projectChange' }> => e.type === 'projectChange')
    expect(frames.length).toBeGreaterThan(0)
    for (const f of frames) expect(audioRows(f.project)[0]).toEqual(['music'])
  })

  it('highlights the destination row while over it, and takes the highlight down on release', () => {
    const p = project()
    const { effects } = drag(p, { x: 250, y: laneMid(p, 2) }, { x: 300, y: laneMid(p, 1) })
    const drops = effects.filter((e): e is Extract<PointerEffect, { type: 'dropLane' }> => e.type === 'dropLane')
    expect(drops.map(d => d.laneIndex)).toEqual([1, null])
  })

  it('a drag that stays in its own row highlights nothing', () => {
    const p = project()
    const { effects } = drag(p, { x: 250, y: laneMid(p, 2) }, { x: 400, y: laneMid(p, 2) })
    expect(effects.some(e => e.type === 'dropLane')).toBe(false)
  })
})

describe('audio: a person-made overlap on one row is a crossfade, kept as dropped', () => {
  const project = () => audioProject([
    { id: 'music', type: 'music', src: 'm.mp3', start: 0, end: 10 },
    { id: 'voA', type: 'voiceover', src: 'a.wav', start: 0, end: 2 },
    { id: 'voB', type: 'voiceover', src: 'b.wav', start: 1.5, end: 3 },
  ] as AudioTrack[])

  // Auto packing never makes that overlap: the two voice clips start on two rows.
  it('auto packing splits the overlapping clips', () => {
    expect(audioRows(project())).toEqual([['music'], ['voA'], ['voB']])
  })

  // Straight up one row, no horizontal travel: voB lands in voA's row overlapping it by 0.5 s.
  const dropped = () => {
    const p = project()
    return drag(p, { x: 250, y: laneMid(p, 2) }, { x: 250, y: laneMid(p, 1) }).committed
  }

  it('stays on that row exactly as dropped', () => {
    const c = dropped()
    expect(c.audio!.tracks.find(t => t.id === 'voB')).toMatchObject({ start: 1.5, end: 3, lane: 1 })
    expect(audioRows(c)).toEqual([['music'], ['voA', 'voB']])
  })

  it('survives a re-render: grouping again never splits or re-packs it', () => {
    const c = dropped()
    const regrouped = groupAudioLanes(c.audio!.tracks, computeDerivedTiming(c).contentDuration)
    expect(regrouped.map(l => [l.laneIndex, l.tracks.map(t => t.id)])).toEqual([[0, ['music']], [1, ['voA', 'voB']]])
  })

  it('survives a save: stamping leaves explicit lanes alone, and the crossfade is found', () => {
    const c = dropped()
    // The commit path (`commitTimelineEdit`): stamp, then the audio crossfade pass.
    expect(stampAudioLanes(c)).toBe(c)
    const saved = computeAutoCrossfade(stampAudioLanes(c))!
    expect(saved).not.toBeNull()
    expect(saved.audio!.tracks.find(t => t.id === 'voA')!.fadeOut).toBe(0.5)
    expect(saved.audio!.tracks.find(t => t.id === 'voB')!.fadeIn).toBe(0.5)
    expect(saved.audio!.tracks.find(t => t.id === 'voB')).toMatchObject({ start: 1.5, end: 3, lane: 1 })
    expect(audioRows(saved)).toEqual([['music'], ['voA', 'voB']])
    // And a second save is a no-op.
    expect(computeAutoCrossfade(stampAudioLanes(saved))).toBeNull()
  })
})

describe('audio: sparse lanes move one drawn row per row of travel', () => {
  const project = () => audioProject([
    { id: 'x', src: 'x.mp3', start: 0, end: 2, lane: 0 },
    { id: 'y', src: 'y.mp3', start: 4, end: 6, lane: 5 },
  ] as AudioTrack[])

  it('up one row from lane 5 lands on lane 0, the row drawn above it', () => {
    const p = project()
    const { committed } = drag(p, { x: 500, y: laneMid(p, 5) }, { x: 500, y: laneMid(p, 0) })
    expect(laneOf(committed, 'y')).toBe(0)
    expect(audioRows(committed)).toEqual([['x', 'y']])
  })

  it('down one row from lane 0 lands on lane 5', () => {
    const p = project()
    const { committed } = drag(p, { x: 100, y: laneMid(p, 0) }, { x: 100, y: laneMid(p, 5) })
    expect(laneOf(committed, 'x')).toBe(5)
  })

  it('down past the last row opens one new row under it', () => {
    const p = project()
    const lane5 = computeTimelineLayout(p).lanes.find(l => l.laneIndex === 5)!
    const { committed } = drag(p, { x: 100, y: laneMid(p, 0) }, { x: 100, y: laneMid(p, 0) + ROW_STRIDE(lane5) * 3 })
    expect(laneOf(committed, 'x')).toBe(6)
  })

  it('clamps at the top row', () => {
    const p = project()
    const { committed } = drag(p, { x: 500, y: laneMid(p, 5) }, { x: 500, y: laneMid(p, 5) - 1000 })
    expect(laneOf(committed, 'y')).toBe(0)
  })
})

// ── Visual ───────────────────────────────────────────────────────────────

describe('video: dragging a clip to another video track', () => {
  const project = () => ({
    id: 'p',
    tracks: [
      { id: 'trk-0', items: [
        { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 5, inPoint: 0, outPoint: 5, sourceDuration: 20 },
        { id: 'c1', type: 'video', src: 'b.mp4', start: 5, end: 8, inPoint: 0, outPoint: 3, sourceDuration: 20 },
      ] },
      { id: 'trk-1', items: [{ id: 'v1', type: 'video', src: 'c.mp4', start: 0, end: 3, inPoint: 0, outPoint: 3, sourceDuration: 20 }] },
    ],
  }) as unknown as Project

  it('lands on the track it is dropped on, not on a new track', () => {
    const p = project()
    const { committed } = drag(p, { x: 650, y: rowMid(p, 0) }, { x: 650, y: rowMid(p, 1) })
    expect(trackIdOf(committed, 'c1')).toBe('trk-1')
    expect(committed.tracks).toHaveLength(2)
  })

  it('and back down onto the base track', () => {
    const p = project()
    const { committed } = drag(p, { x: 150, y: rowMid(p, 1) }, { x: 1050, y: rowMid(p, 0) })
    expect(trackIdOf(committed, 'v1')).toBe('trk-0')
  })
})

describe('overlay: dragging a graphic to another overlay track', () => {
  const project = () => ({
    id: 'p',
    tracks: [
      { id: 'trk-0', items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10, sourceDuration: 20 }] },
      { id: 'trk-1', items: [{ id: 'o1', type: 'overlay', start: 0, end: 2 }] },
      { id: 'trk-2', items: [{ id: 'o2', type: 'overlay', start: 5, end: 7 }, { id: 'o3', type: 'image', src: 'p.png', start: 8, end: 9 }] },
      { id: 'trk-3', items: [{ id: 'o4', type: 'overlay', start: 3, end: 4 }] },
    ],
  }) as unknown as Project

  it('up one row lands on the track drawn above it', () => {
    const p = project()
    const { committed } = drag(p, { x: 100, y: rowMid(p, 1) }, { x: 100, y: rowMid(p, 2) })
    expect(trackIdOf(committed, 'o1')).toBe('trk-2')
  })

  it('down one row lands on the track drawn below it, not two below', () => {
    const p = project()
    const { committed } = drag(p, { x: 350, y: rowMid(p, 3) }, { x: 350, y: rowMid(p, 2) })
    expect(trackIdOf(committed, 'o4')).toBe('trk-2')
  })

  it('an image moves the same way', () => {
    const p = project()
    const { committed } = drag(p, { x: 850, y: rowMid(p, 2) }, { x: 850, y: rowMid(p, 3) })
    expect(trackIdOf(committed, 'o3')).toBe('trk-3')
  })

  it('above the top row mints a new track', () => {
    const p = project()
    const top = computeTimelineLayout(p).rows[0]
    const { committed } = drag(p, { x: 100, y: rowMid(p, 1) }, { x: 100, y: top.y - 4 })
    expect(committed.tracks).toHaveLength(4)   // trk-1 emptied and pruned, one minted
    expect(trackIdOf(committed, 'o1')).not.toMatch(/^trk-[0-3]$/)
  })

  it('never onto the video track: the kind gate still holds', () => {
    const p = project()
    const { committed } = drag(p, { x: 100, y: rowMid(p, 1) }, { x: 100, y: rowMid(p, 0) })
    expect(trackIdOf(committed, 'o1')).not.toBe('trk-0')
  })
})

// ── The drop highlight ───────────────────────────────────────────────────

function recorder() {
  const calls: Array<{ method: string; args: unknown[]; strokeStyle?: unknown }> = []
  const props: Record<string, unknown> = {}
  const ctx = new Proxy({}, {
    get(_t, prop: string) {
      if (prop in props) return props[prop]
      if (prop === 'createLinearGradient') return () => ({ addColorStop: () => {} })
      return (...args: unknown[]) => { calls.push({ method: prop, args, strokeStyle: props.strokeStyle }) }
    },
    set(_t, prop: string, value: unknown) { props[prop] = value; return true },
  }) as unknown as DrawContext
  return { ctx, calls }
}

describe('drop-target lane highlight', () => {
  const project = audioProject([
    { id: 'a', src: 'a.mp3', start: 0, end: 2, lane: 0 },
    { id: 'b', src: 'b.mp3', start: 0, end: 2, lane: 1 },
  ] as AudioTrack[])
  const layout = computeTimelineLayout(project)
  const lane1 = layout.lanes.find(l => l.laneIndex === 1)!

  function paint(dropTargetLane: number | null, mode: 'dark' | 'light' = 'dark') {
    const { ctx, calls } = recorder()
    drawTimelineContent(ctx, { project, viewport: VIEWPORT, layout, selectedIds: [], surfaceWidth: 1000, surfaceHeight: layout.height, dropTargetLane, mode })
    return calls.filter(c => c.method === 'strokeRect' && c.args[1] === lane1.y + 0.5)
  }

  it('outlines the target lane in the accent, on top of its usual divider', () => {
    const outlines = paint(1)
    expect(outlines.map(c => c.strokeStyle)).toEqual([DARK_TIMELINE_PALETTE.colors.rowDivider, DARK_TIMELINE_PALETTE.colors.snapGuide])
  })

  it('draws nothing extra without a target', () => {
    expect(paint(null).map(c => c.strokeStyle)).toEqual([DARK_TIMELINE_PALETTE.colors.rowDivider])
  })

  it('uses the light accent in light mode', () => {
    expect(paint(1, 'light').map(c => c.strokeStyle)).toEqual([LIGHT_TIMELINE_PALETTE.colors.rowDivider, LIGHT_TIMELINE_PALETTE.colors.snapGuide])
  })
})

// ── Rows hold still mid-drag ─────────────────────────────────────────────

describe('rows do not collapse while a drag empties one', () => {
  function frames(effects: PointerEffect[]): Project[] {
    return effects.filter((e): e is Extract<PointerEffect, { type: 'projectChange' }> => e.type === 'projectChange').map(e => e.project)
  }

  it('audio: the emptied lane stays drawn (holdLanes), so the row under the pointer does not slide up', () => {
    const p = audioProject([
      { id: 'a', src: 'a.mp3', start: 0, end: 2, lane: 0 },
      { id: 'b', src: 'b.mp3', start: 4, end: 6, lane: 1 },
      { id: 'c', src: 'c.mp3', start: 8, end: 10, lane: 2 },
    ] as AudioTrack[])
    const pressLanes = computeTimelineLayout(p).lanes
    const { effects } = drag(p, { x: 500, y: laneMid(p, 1) }, { x: 500, y: laneMid(p, 2) })
    const holds = effects.filter((e): e is Extract<PointerEffect, { type: 'holdLanes' }> => e.type === 'holdLanes')
    expect(holds.map(h => h.lanes)).toEqual([[0, 1, 2], null])
    // The last transient frame has b in lane 2 and nothing in lane 1.
    const all = frames(effects)
    const last = all[all.length - 1]
    expect(computeTimelineLayout(last).lanes.map(l => l.laneIndex)).toEqual([0, 2])
    // Laid out with the held lanes, every lane is where the press drew it.
    const held = computeTimelineLayout(last, [], [0, 1, 2]).lanes
    expect(held.map(l => [l.laneIndex, l.y])).toEqual(pressLanes.map(l => [l.laneIndex, l.y]))
    expect(held[1].tracks).toEqual([])
  })

  it('visual: the emptied track keeps its row on every transient frame, and the drop prunes it', () => {
    const p = {
      id: 'p',
      tracks: [
        { id: 'trk-0', items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10, sourceDuration: 20 }] },
        { id: 'trk-1', items: [{ id: 'o1', type: 'overlay', start: 0, end: 2 }] },
        { id: 'trk-2', items: [{ id: 'o2', type: 'overlay', start: 4, end: 6 }] },
        { id: 'trk-3', items: [{ id: 'o3', type: 'overlay', start: 8, end: 9 }] },
      ],
    } as unknown as Project
    const pressRows = computeTimelineLayout(p).rows.map(r => r.y)
    const { committed, effects } = drag(p, { x: 500, y: rowMid(p, 2) }, { x: 500, y: rowMid(p, 3) })
    for (const f of frames(effects)) {
      expect(normalizeTracks(f).tracks!.map(t => t.id)).toEqual(['trk-0', 'trk-1', 'trk-2', 'trk-3'])
      expect(computeTimelineLayout(f).rows.map(r => r.y)).toEqual(pressRows)
    }
    expect(trackIdOf(committed, 'o2')).toBe('trk-3')
    expect(normalizeTracks(committed).tracks!.map(t => t.id)).toEqual(['trk-0', 'trk-1', 'trk-3'])
  })
})

// ── The base track survives a drag ───────────────────────────────────────

describe('the base track survives its only clip being dragged above the top row', () => {
  it('the clip goes back on the base track, which keeps its id and settings', () => {
    const p = {
      id: 'p',
      tracks: [
        { id: 'base', volume: 0.5, muted: true, enabled: false, items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 5, inPoint: 0, outPoint: 5, sourceDuration: 20 }] },
        { id: 'trk-1', items: [{ id: 'o1', type: 'overlay', start: 0, end: 2 }] },
      ],
    } as unknown as Project
    const top = computeTimelineLayout(p).rows[0]
    const { committed } = drag(p, { x: 250, y: rowMid(p, 0) }, { x: 350, y: top.y - 4 })
    const tracks = normalizeTracks(committed).tracks!
    expect(tracks.map(t => t.id)).toEqual(['base', 'trk-1'])
    expect(tracks[0]).toMatchObject({ id: 'base', volume: 0.5, muted: true, enabled: false })
    expect(tracks[0].items.map(i => [i.id, i.start])).toEqual([['c0', 1]])
  })

  it('a base track holding other clips still lets one go to a new track', () => {
    const p = {
      id: 'p',
      tracks: [
        { id: 'base', items: [
          { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 5, inPoint: 0, outPoint: 5, sourceDuration: 20 },
          { id: 'c1', type: 'video', src: 'b.mp4', start: 5, end: 8, inPoint: 0, outPoint: 3, sourceDuration: 20 },
        ] },
      ],
    } as unknown as Project
    const top = computeTimelineLayout(p).rows[0]
    const { committed } = drag(p, { x: 650, y: rowMid(p, 0) }, { x: 650, y: top.y - 4 })
    const tracks = normalizeTracks(committed).tracks!
    expect(tracks).toHaveLength(2)
    expect(tracks[0].id).toBe('base')
    expect(trackIdOf(committed, 'c1')).not.toBe('base')
  })
})

// ── Visual drop-target highlight ─────────────────────────────────────────

describe('the visual row a drag will drop on is highlighted, a new row included', () => {
  const project = () => ({
    id: 'p',
    tracks: [
      { id: 'trk-0', items: [{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10, sourceDuration: 20 }] },
      { id: 'trk-1', items: [{ id: 'o1', type: 'overlay', start: 0, end: 2 }] },
      { id: 'trk-2', items: [{ id: 'o2', type: 'overlay', start: 5, end: 7 }] },
    ],
  }) as unknown as Project
  const dropTracks = (effects: PointerEffect[]) =>
    effects.filter((e): e is Extract<PointerEffect, { type: 'dropTrack' }> => e.type === 'dropTrack').map(e => e.itemId)

  it('onto another track: highlighted while there, taken down on release', () => {
    const p = project()
    expect(dropTracks(drag(p, { x: 100, y: rowMid(p, 1) }, { x: 100, y: rowMid(p, 2) }).effects)).toEqual(['o1', null])
  })

  it('staying on its own track highlights nothing', () => {
    const p = project()
    expect(dropTracks(drag(p, { x: 100, y: rowMid(p, 1) }, { x: 300, y: rowMid(p, 1) }).effects)).toEqual([])
  })

  it('above the top row: the new row it opens is the one highlighted', () => {
    const p = project()
    const top = computeTimelineLayout(p).rows[0]
    const { effects } = drag(p, { x: 100, y: rowMid(p, 1) }, { x: 100, y: top.y - 4 })
    expect(dropTracks(effects)).toEqual(['o1', null])
    const frames = effects.filter((e): e is Extract<PointerEffect, { type: 'projectChange' }> => e.type === 'projectChange')
    const last = frames[frames.length - 1].project
    const row = computeTimelineLayout(last).rows.find(r => r.items.some(i => i.id === 'o1'))!
    expect(normalizeTracks(last).tracks![row.trackIdx].id).not.toMatch(/^trk-[0-2]$/)
  })

  it('below the last audio row: the new lane it opens is the one highlighted', () => {
    const p = audioProject([
      { id: 'x', src: 'x.mp3', start: 0, end: 2, lane: 0 },
      { id: 'y', src: 'y.mp3', start: 4, end: 6, lane: 5 },
    ] as AudioTrack[])
    const lane5 = computeTimelineLayout(p).lanes.find(l => l.laneIndex === 5)!
    const { effects } = drag(p, { x: 100, y: laneMid(p, 0) }, { x: 100, y: laneMid(p, 0) + ROW_STRIDE(lane5) * 3 })
    const drops = effects.filter((e): e is Extract<PointerEffect, { type: 'dropLane' }> => e.type === 'dropLane').map(e => e.laneIndex)
    expect(drops[drops.length - 2]).toBe(6)
    expect(drops[drops.length - 1]).toBeNull()
  })

  it('the painter outlines the row holding the dragged clip, in the accent', () => {
    const p = project()
    const layout = computeTimelineLayout(p)
    const row = layout.rows.find(r => r.trackIdx === 2)!
    const { ctx, calls } = recorder()
    drawTimelineContent(ctx, { project: p, viewport: VIEWPORT, layout, selectedIds: [], surfaceWidth: 1000, surfaceHeight: layout.height, dropTargetItem: 'o2' })
    const outlines = calls.filter(c => c.method === 'strokeRect' && c.args[1] === row.y + 0.5).map(c => c.strokeStyle)
    expect(outlines).toEqual([DARK_TIMELINE_PALETTE.colors.rowDivider, DARK_TIMELINE_PALETTE.colors.snapGuide])
  })
})
