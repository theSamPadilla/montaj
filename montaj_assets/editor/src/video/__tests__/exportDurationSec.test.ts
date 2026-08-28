/**
 * The export dialog's duration — what the cover-frame picker samples across.
 *
 * This used to be derived from the track-0 VIDEO items alone, which is a safe
 * reading only when track 0 holds footage. An overlay-only project (the
 * animations workflow emits exactly that: one track of nothing but overlays)
 * therefore reported 0, and the picker had no frames to offer — on a project
 * that renders perfectly well and is entirely made of pickable frames.
 */
import { describe, it, expect } from 'vitest'
import { exportDurationSec } from '../VideoEditor'
import type { EditorProject, VisualItem } from '../../schema'

const video = (id: string, start: number, end: number): VisualItem =>
  ({ id, type: 'video', src: `/${id}.mp4`, start, end }) as VisualItem
const overlay = (id: string, start: number, end: number): VisualItem =>
  ({ id, type: 'overlay', src: `/${id}.jsx`, start, end }) as VisualItem

function proj(tracks: { items: VisualItem[]; enabled?: boolean }[]): EditorProject {
  return {
    id: 'p', status: 'draft', settings: { resolution: [1920, 1080], fps: 30 },
    tracks: tracks.map((t, i) => ({ id: `trk-${i}`, ...t })),
  } as EditorProject
}

describe('exportDurationSec', () => {
  it('spans an overlay-only project, which used to report 0', () => {
    // The Daubert-demo shape: one track, overlays only, no video anywhere.
    expect(exportDurationSec(proj([{ items: [overlay('o1', 0, 5), overlay('o2', 5, 12)] }]))).toBe(12)
  })

  it('reaches an overlay that outlives the last video clip', () => {
    // An outro card after the final clip is ordinary, and its frames are just
    // as pickable as the footage before it — the render encodes to 14, so the
    // picker has to offer the whole 14.
    expect(exportDurationSec(proj([
      { items: [video('v', 0, 8)] },
      { items: [overlay('outro', 8, 14)] },
    ]))).toBe(14)
  })

  it('still matches the video end when video is the longest thing', () => {
    // The common case must not move.
    expect(exportDurationSec(proj([
      { items: [video('a', 0, 4), video('b', 4, 9)] },
      { items: [overlay('o', 0, 3)] },
    ]))).toBe(9)
  })

  it('ignores a disabled track, which the render also skips', () => {
    expect(exportDurationSec(proj([
      { items: [video('v', 0, 6)] },
      { items: [overlay('o', 0, 30)], enabled: false },
    ]))).toBe(6)
  })

  it('is 0 for a project with nothing on any track', () => {
    expect(exportDurationSec(proj([{ items: [] }]))).toBe(0)
  })
})
