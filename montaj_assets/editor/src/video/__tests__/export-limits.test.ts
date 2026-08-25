import { describe, it, expect } from 'vitest'
import {
  maxExportResolution,
  maxExportFps,
  availableResolutionTiers,
  availableFpsTiers,
  currentResolutionTier,
} from '../export-limits'
import type { EditorProject as Project, VisualItem, VisualTrack } from '../../schema'

function vtracks(...items: VisualItem[][]): VisualTrack[] {
  return items.map((its, i) => ({ id: `trk-${i}`, items: its }))
}

// Minimal project factory — only the fields export-limits touches.
function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    status: 'draft',
    settings: { resolution: [1080, 1920] },
    tracks: vtracks([]),
    ...over,
  }
}

let nextId = 0
function videoClip(over: Partial<VisualItem> = {}): VisualItem {
  nextId += 1
  return { id: `v${nextId}`, type: 'video', start: 0, end: 5, ...over }
}

describe('maxExportResolution', () => {
  it('returns settings.resolution verbatim when tracks is absent', () => {
    const p = makeProject({ tracks: undefined })
    expect(maxExportResolution(p)).toEqual([1080, 1920])
  })

  it('returns settings.resolution verbatim for empty tracks / no video items', () => {
    const p = makeProject({ tracks: vtracks([], [{ id: 'o1', type: 'overlay', start: 0, end: 5 }]) })
    expect(maxExportResolution(p)).toEqual([1080, 1920])
  })

  it('returns settings.resolution verbatim for a track shape with no items array (legacy tolerance)', () => {
    // Legacy fixtures sometimes carry a track shape missing .items, or the whole
    // tracks field. Normalizer must swallow both without throwing.
    const p1 = makeProject({ tracks: [{ id: 't0' } as unknown as VisualTrack] })
    expect(maxExportResolution(p1)).toEqual([1080, 1920])
    const p2 = makeProject({ tracks: undefined })
    expect(maxExportResolution(p2)).toEqual([1080, 1920])
  })

  it('returns settings.resolution verbatim when video items are missing sourceWidth/sourceHeight', () => {
    const p = makeProject({ tracks: vtracks([videoClip()]) })
    expect(maxExportResolution(p)).toEqual([1080, 1920])
  })

  it('returns the 1080 tier unchanged when all video items are 1080x1920', () => {
    const p = makeProject({
      settings: { resolution: [1080, 1920] },
      tracks: vtracks([videoClip({ sourceWidth: 1080, sourceHeight: 1920 })]),
    })
    expect(maxExportResolution(p)).toEqual([1080, 1920])
  })

  it('returns [2160, 3840] for a portrait project with a 2160x3840 clip', () => {
    const p = makeProject({
      settings: { resolution: [1080, 1920] },
      tracks: vtracks([videoClip({ sourceWidth: 2160, sourceHeight: 3840 })]),
    })
    expect(maxExportResolution(p)).toEqual([2160, 3840])
  })

  it('returns [3840, 2160] for a landscape project with a 3840x2160 clip', () => {
    const p = makeProject({
      settings: { resolution: [1920, 1080] },
      tracks: vtracks([videoClip({ sourceWidth: 3840, sourceHeight: 2160 })]),
    })
    expect(maxExportResolution(p)).toEqual([3840, 2160])
  })

  it('picks the 4K tier when clips are mixed 1080p and 4K', () => {
    const p = makeProject({
      settings: { resolution: [1080, 1920] },
      tracks: vtracks([
        videoClip({ sourceWidth: 1080, sourceHeight: 1920 }),
        videoClip({ sourceWidth: 2160, sourceHeight: 3840 }),
      ]),
    })
    expect(maxExportResolution(p)).toEqual([2160, 3840])
  })

  it('returns settings.resolution verbatim when the source is smaller than the smallest tier', () => {
    const p = makeProject({
      settings: { resolution: [1080, 1920] },
      tracks: vtracks([videoClip({ sourceWidth: 480, sourceHeight: 640 })]),
    })
    expect(maxExportResolution(p)).toEqual([1080, 1920])
  })

  it('keeps the long side proportional and even for a non-16:9 project aspect', () => {
    const p = makeProject({
      settings: { resolution: [1000, 1777] },
      tracks: vtracks([videoClip({ sourceWidth: 1080, sourceHeight: 3000 })]),
    })
    const [w, h] = maxExportResolution(p)
    expect(w).toBe(1080)
    expect(h % 2).toBe(0)
    // proportional to the project aspect (1777/1000), within half a pixel of rounding
    expect(h / w).toBeCloseTo(1777 / 1000, 1)
  })
})

describe('maxExportFps', () => {
  it('returns 30 when settings.fps is 30', () => {
    expect(maxExportFps(makeProject({ settings: { resolution: [1080, 1920], fps: 30 } }))).toBe(30)
  })

  it('defaults to 30 when settings.fps is absent', () => {
    expect(maxExportFps(makeProject({ settings: { resolution: [1080, 1920] } }))).toBe(30)
  })

  it('returns 60 when settings.fps is 60', () => {
    expect(maxExportFps(makeProject({ settings: { resolution: [1080, 1920], fps: 60 } }))).toBe(60)
  })
})

describe('availableResolutionTiers', () => {
  it('excludes 1440 and 2160 for a 1080p-sourced project', () => {
    const p = makeProject({
      settings: { resolution: [1080, 1920] },
      tracks: vtracks([videoClip({ sourceWidth: 1080, sourceHeight: 1920 })]),
    })
    const tiers = availableResolutionTiers(p)
    expect(tiers.some(([w, h]) => Math.min(w, h) === 1440)).toBe(false)
    expect(tiers.some(([w, h]) => Math.min(w, h) === 2160)).toBe(false)
  })

  it('includes 1080 and 2160 for a 4K-sourced project', () => {
    const p = makeProject({
      settings: { resolution: [1080, 1920] },
      tracks: vtracks([videoClip({ sourceWidth: 2160, sourceHeight: 3840 })]),
    })
    const tiers = availableResolutionTiers(p)
    expect(tiers.some(([w, h]) => Math.min(w, h) === 1080)).toBe(true)
    expect(tiers.some(([w, h]) => Math.min(w, h) === 2160)).toBe(true)
  })

  it('filters against the project own short-side when there are no video clips', () => {
    const p = makeProject({ settings: { resolution: [1080, 1920] }, tracks: vtracks([]) })
    const tiers = availableResolutionTiers(p)
    expect(tiers.every(([w, h]) => Math.min(w, h) <= 1080)).toBe(true)
    expect(tiers.some(([w, h]) => Math.min(w, h) === 1080)).toBe(true)
    expect(tiers.some(([w, h]) => Math.min(w, h) === 1440)).toBe(false)
  })

  it('falls back to a single entry equal to settings.resolution when source is below every tier', () => {
    const p = makeProject({
      settings: { resolution: [1080, 1920] },
      tracks: vtracks([videoClip({ sourceWidth: 480, sourceHeight: 640 })]),
    })
    expect(availableResolutionTiers(p)).toEqual([[1080, 1920]])
  })
})

describe('availableFpsTiers', () => {
  it('returns [24, 30] when settings.fps is 30', () => {
    expect(availableFpsTiers(makeProject({ settings: { resolution: [1080, 1920], fps: 30 } }))).toEqual([24, 30])
  })

  it('returns [24, 30, 60] when settings.fps is 60', () => {
    expect(availableFpsTiers(makeProject({ settings: { resolution: [1080, 1920], fps: 60 } }))).toEqual([
      24, 30, 60,
    ])
  })
})

describe('currentResolutionTier', () => {
  it('returns [1080, 1920] for a matching project with a 4K source', () => {
    const p = makeProject({
      settings: { resolution: [1080, 1920] },
      tracks: vtracks([videoClip({ sourceWidth: 2160, sourceHeight: 3840 })]),
    })
    expect(currentResolutionTier(p)).toEqual([1080, 1920])
  })

  it('returns the closest tier <= current when current matches no standard tier', () => {
    const p = makeProject({
      settings: { resolution: [1000, 2000] },
      tracks: vtracks([videoClip({ sourceWidth: 2160, sourceHeight: 3840 })]),
    })
    const tier = currentResolutionTier(p)
    expect(tier).toBeDefined()
    expect(Math.min(...tier!)).toBe(720)
  })
})
