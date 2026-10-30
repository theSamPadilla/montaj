/// <reference types="vitest/globals" />
/**
 * An edit that does not drag starts from the project with its drawn audio rows
 * written down (`stampAudioLanes`), so a clip it did not touch never moves to
 * another row. Lane-less A[0-5], B[3-8], C[6-10] pack A and C on one row, B on
 * the next; deleting A and re-packing would swap B and C.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import type { Project } from '../../../types'
import { createPlaybackClock } from '../../playback-clock'
import { deleteSelection } from '../multiSelectOps'
import { computeDerivedTiming, groupAudioLanes } from '../timeline-model'
import Timeline from '../Timeline'
import { installCanvasHarness } from './_canvasSelect'

let uninstall: () => void
beforeEach(() => { uninstall = installCanvasHarness() })
afterEach(() => { cleanup(); uninstall() })

function abc(): Project {
  return {
    id: 'p1',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [[{ id: 'clip-0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, outPoint: 10 }]],
    audio: {
      tracks: [
        { id: 'A', type: 'voiceover', src: 'a.wav', start: 0, end: 5 },
        { id: 'B', type: 'voiceover', src: 'b.wav', start: 3, end: 8 },
        { id: 'C', type: 'voiceover', src: 'c.wav', start: 6, end: 10 },
      ],
    },
  } as unknown as Project
}

const rows = (p: Project) =>
  groupAudioLanes(p.audio!.tracks, computeDerivedTiming(p).contentDuration).map(l => l.tracks.map(t => t.id))

describe('Timeline — Delete never moves an untouched audio clip to another row', () => {
  it('the fixture: re-packing after deleting A would swap B and C', () => {
    expect(rows(abc())).toEqual([['A', 'C'], ['B']])
    expect(rows(deleteSelection(abc(), ['A']))).toEqual([['B'], ['C']])
  })

  it('deleting A keeps C on its row and B on its own', () => {
    const onProjectChange = vi.fn()
    const onOverlayEdit = vi.fn()
    const { container } = render(
      <Timeline project={abc()} clock={createPlaybackClock(0)} selectedIds={['A']}
        onProjectChange={onProjectChange} onOverlayEdit={onOverlayEdit} onSelectIds={vi.fn()} />,
    )
    ;(container.firstElementChild as HTMLElement).focus()
    fireEvent.keyDown(document.body, { key: 'Delete' })
    expect(onOverlayEdit).toHaveBeenCalledTimes(1)
    const updated = onOverlayEdit.mock.calls[0][0] as Project
    expect(updated.audio!.tracks.map(t => [t.id, t.lane])).toEqual([['B', 1], ['C', 0]])
    // The live preview and the commit carry the same rows.
    expect(onProjectChange.mock.calls[0][0]).toBe(updated)
  })
})
