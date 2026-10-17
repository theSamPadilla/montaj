import { describe, it, expect } from 'vitest'
import { selectedAudioTrack } from '../selection'
import type { EditorProject } from '../../schema'

const base = { id: 'p1', status: 'draft', settings: { resolution: [1080, 1920] }, tracks: [] } as unknown as EditorProject

describe('selectedAudioTrack', () => {
  // A marker click puts the marker's id in the selection; no clip or track has it.
  it('does not throw for a marker id when the project has audio: {} (no tracks list)', () => {
    const project = { ...base, audio: {}, markers: [{ id: 'mk-1', t: 18.7, label: '2' }] } as unknown as EditorProject
    expect(() => selectedAudioTrack(project, 'mk-1')).not.toThrow()
    expect(selectedAudioTrack(project, 'mk-1')).toBeNull()
  })
  it('does not throw with no audio at all, or no id', () => {
    expect(selectedAudioTrack(base, 'mk-1')).toBeNull()
    expect(selectedAudioTrack(base, null)).toBeNull()
  })
  it('still finds a real audio track', () => {
    const project = { ...base, audio: { tracks: [{ id: 'a1', src: '/a.wav' }] } } as unknown as EditorProject
    expect(selectedAudioTrack(project, 'a1')?.id).toBe('a1')
  })
})
