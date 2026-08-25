/// <reference types="vitest/globals" />
/**
 * The track x item audio fold: a track's volume/mute settings combine with
 * an item's own to produce what actually plays. Volume multiplies (never
 * replaces, so a clip an editor already turned down stays proportionally
 * quieter under a track pulled down too); mute is either/or (either one
 * silences it). Mirrored by `effectiveItemAudio` in
 * montaj_assets/render/project-tracks.js for the render path — the two must
 * agree.
 */
import { describe, it, expect } from 'vitest'
import { effectiveItemAudio } from '../timeline-model'

describe('effectiveItemAudio', () => {
  it('multiplies track and item volume', () => {
    expect(effectiveItemAudio({ volume: 0.5 }, { volume: 0.4 }).volume).toBeCloseTo(0.2)
  })

  it('does not let track volume replace a clip volume that was already turned down', () => {
    const track = { volume: 0.5 }
    const loud = effectiveItemAudio(track, { volume: 1.0 })
    const quiet = effectiveItemAudio(track, { volume: 0.4 })
    expect(loud.volume / quiet.volume).toBeCloseTo(1.0 / 0.4)
  })

  it('defaults to unity volume when both track and item omit it', () => {
    expect(effectiveItemAudio({}, {}).volume).toBe(1)
  })

  it('respects an explicit item volume of 0 (nullish coalescing, not falsy)', () => {
    expect(effectiveItemAudio({ volume: 1 }, { volume: 0 }).volume).toBe(0)
  })

  it('mutes when the track is muted, regardless of the item', () => {
    expect(effectiveItemAudio({ muted: true }, { muted: false }).muted).toBe(true)
  })

  it('mutes when the item is muted, regardless of the track', () => {
    expect(effectiveItemAudio({ muted: false }, { muted: true }).muted).toBe(true)
  })

  it('is unmuted only when neither track nor item is muted', () => {
    expect(effectiveItemAudio({}, {}).muted).toBe(false)
  })

  it('tolerates undefined/null track and item', () => {
    expect(effectiveItemAudio(undefined, undefined)).toEqual({ volume: 1, muted: false })
    expect(effectiveItemAudio(null, null)).toEqual({ volume: 1, muted: false })
  })
})
