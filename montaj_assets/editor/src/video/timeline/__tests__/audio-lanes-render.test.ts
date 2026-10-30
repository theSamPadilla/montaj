/// <reference types="vitest/globals" />
/**
 * Lanes are layout only. `stampAudioLanes` writes `lane` onto audio tracks the
 * next time a project is edited; this proves that changes nothing anything
 * PLAYS: the export's ffmpeg inputs and mix graph (`render/mix-audio.js`), the
 * NLE export's audio tracks (`render/nle/timeline.js`) and the preview's mix
 * plan (`engine/mix/audio-plan.ts`) are identical for a stamped project and the
 * same project unstamped.
 */
import { describe, it, expect } from 'vitest'
import type { Project } from '../../../types'
import type { AudioTrack } from '../../../schema'
import { stampAudioLanes } from '../timeline-model'
import { buildMixPlan, type ConformedSource } from '../../../engine/mix/audio-plan'
// @ts-expect-error — plain JS from the render package, no type declarations
import { buildAudioTrackFilters, buildAudioTrackInputs } from '../../../../../render/mix-audio.js'
// @ts-expect-error — plain JS from the render package, no type declarations
import { buildNleTimeline } from '../../../../../render/nle/timeline.js'

function aiProject(): Project {
  const vo: AudioTrack[] = Array.from({ length: 6 }, (_, i) => ({
    id: `vo-seg-${i}`, type: 'voiceover', src: `/media/vo-${i}.wav`, start: i * 2, end: (i + 1) * 2, inPoint: 0, outPoint: 2,
  }))
  return {
    id: 'p',
    settings: { fps: 30, resolution: [1080, 1920] },
    tracks: [{ id: 'trk-0', items: [{ id: 'c0', type: 'video', src: '/media/a.mp4', start: 0, end: 12, inPoint: 0, outPoint: 12, sourceDuration: 20 }] }],
    audio: {
      tracks: [
        ...vo,
        { id: 'music', type: 'music', src: '/media/bed.mp3', start: 0, end: 12, volume: 0.4, fadeOut: 1, ducking: { enabled: true, depth: -12 } },
        { id: 'sfx', type: 'sfx', src: '/media/hit.wav', start: 3, end: 4, lane: 2 },
        { id: 'sfx2', type: 'sfx', src: '/media/hit.wav', start: 3.5, end: 4.5 },
      ],
    },
  } as unknown as Project
}

const conform = (src: string): ConformedSource => ({ url: `conform:${src}`, format: 'pcm_s16le', sampleRate: 48000, channels: 2, frames: 48000 * 30 })

describe('stamped audio lanes change nothing the render plays', () => {
  const plain = aiProject()
  const stamped = stampAudioLanes(plain)

  it('the fixture really is stamped', () => {
    expect(stamped).not.toBe(plain)
    expect(stamped.audio!.tracks.every(t => typeof t.lane === 'number')).toBe(true)
    expect(plain.audio!.tracks.filter(t => t.lane == null).length).toBeGreaterThan(0)
  })

  it('export: the same ffmpeg audio inputs and mix graph', () => {
    expect(buildAudioTrackInputs(stamped.audio!.tracks)).toEqual(buildAudioTrackInputs(plain.audio!.tracks))
    expect(buildAudioTrackFilters(stamped.audio!.tracks, 1, '[0:a]')).toEqual(buildAudioTrackFilters(plain.audio!.tracks, 1, '[0:a]'))
  })

  it('NLE export: the same audio tracks', () => {
    const opts = { projectDir: '/proj' }
    expect(buildNleTimeline(plain, opts).audioTracks.filter((t: { source: string }) => t.source === 'audio.tracks')).toHaveLength(9)
    expect(buildNleTimeline(stamped, opts).audioTracks).toEqual(buildNleTimeline(plain, opts).audioTracks)
  })

  it('preview: the same mix plan', () => {
    expect(JSON.stringify(buildMixPlan(plain as never, conform))).toContain('lane:vo-seg-0')
    expect(buildMixPlan(stamped as never, conform)).toEqual(buildMixPlan(plain as never, conform))
  })
})
