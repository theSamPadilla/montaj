/// <reference types="vitest/globals" />
/**
 * Right-click on a track header: hide/mute and remove, with an in-page confirm
 * for a track that holds clips.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import TrackGutter from '../TrackGutter'
import type { Project } from '../../../types'
import type { VisualItem } from '../../../schema'

afterEach(() => cleanup())

const video = (id: string, start = 0): VisualItem =>
  ({ id, type: 'video', src: 'a.mp4', start, end: start + 2 }) as VisualItem

function project(over: Record<string, unknown> = {}): Project {
  return {
    id: 'p',
    tracks: [[video('c0')], [video('c1'), video('c2', 2)], []],
    audio: { tracks: [
      { id: 'a0', src: 'v.mp3', start: 0, end: 2, lane: 0 },
      { id: 'a1', src: 'w.mp3', start: 0, end: 2, lane: 1 },
    ] },
    ...over,
  } as unknown as Project
}

function setup(p: Project, mode: 'dark' | 'light' = 'dark') {
  const fns = {
    onToggleTrackEnabled: vi.fn(),
    onSetLaneMuted: vi.fn(),
    onRemoveTrack: vi.fn(),
    onRemoveAudioLane: vi.fn(),
  }
  const utils = render(<TrackGutter project={p} mode={mode} {...fns} />)
  const all = () => Array.from(utils.container.querySelectorAll('[data-rail-cell]')) as HTMLElement[]
  // Rows run top-down, so the highest visual track comes first, then the audio lanes.
  const nVisual = Array.isArray(p.tracks) ? p.tracks.length : 0
  const cells = () => {
    const a = all()
    return [...a.slice(0, nVisual).reverse(), ...a.slice(nVisual)]
  }
  return { ...fns, cells }
}

describe('TrackGutter right-click menu', () => {
  it('opens the menu on a visual header and Hide toggles enabled', () => {
    const f = setup(project())
    const ev = fireEvent.contextMenu(f.cells()[0])
    expect(ev).toBe(false) // native menu prevented
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide track' }))
    expect(f.onToggleTrackEnabled).toHaveBeenCalledWith(0, false)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('reads Show track on a hidden track and re-enables it', () => {
    const f = setup(project({ tracks: [{ id: 't0', items: [video('c0')], enabled: false }, [video('c1')]] }))
    fireEvent.contextMenu(f.cells()[0])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show track' }))
    expect(f.onToggleTrackEnabled).toHaveBeenCalledWith(0, true)
  })

  it('removes an empty track at once, with no dialog', () => {
    const f = setup(project())
    fireEvent.contextMenu(f.cells()[2])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove track' }))
    expect(f.onRemoveTrack).toHaveBeenCalledWith(2)
    expect(screen.queryByText(/Remove track and/)).toBeNull()
  })

  it('asks first for a track with clips; Cancel keeps it, Remove removes it', () => {
    const f = setup(project())
    fireEvent.contextMenu(f.cells()[1])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove track' }))
    expect(screen.getByText('Remove track and 2 clips?')).toBeTruthy()
    expect(f.onRemoveTrack).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(f.onRemoveTrack).not.toHaveBeenCalled()
    expect(screen.queryByText('Remove track and 2 clips?')).toBeNull()

    fireEvent.contextMenu(f.cells()[1])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove track' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(f.onRemoveTrack).toHaveBeenCalledWith(1)
  })

  it('says 1 clip for a single clip', () => {
    const f = setup(project())
    fireEvent.contextMenu(f.cells()[0])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove track' }))
    expect(screen.getByText('Remove track and 1 clip?')).toBeTruthy()
  })

  it('disables Remove on the last video track', () => {
    const f = setup(project({ tracks: [[video('c0')]] }))
    fireEvent.contextMenu(f.cells()[0])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove track' }))
    expect(f.onRemoveTrack).not.toHaveBeenCalled()
    expect(screen.queryByText(/Remove track and/)).toBeNull()
  })

  it('audio lane: Mute track fans out to the lane, then reads Unmute', () => {
    const f = setup(project())
    const lane = f.cells()[3]
    fireEvent.contextMenu(lane)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mute track' }))
    expect(f.onSetLaneMuted).toHaveBeenCalledWith(['a0'], true)
  })

  it('audio lane: Unmute track when the lane is muted', () => {
    const f = setup(project({ audio: { tracks: [
      { id: 'a0', src: 'v.mp3', start: 0, end: 2, lane: 0, muted: true },
      { id: 'a1', src: 'w.mp3', start: 0, end: 2, lane: 1 },
    ] } }))
    fireEvent.contextMenu(f.cells()[3])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unmute track' }))
    expect(f.onSetLaneMuted).toHaveBeenCalledWith(['a0'], false)
  })

  it('audio lane: removes after confirm; disabled on the last lane', () => {
    const f = setup(project())
    fireEvent.contextMenu(f.cells()[4])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove track' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(f.onRemoveAudioLane).toHaveBeenCalledWith(1)
    cleanup()

    const g = setup(project({ audio: { tracks: [{ id: 'a0', src: 'v.mp3', start: 0, end: 2, lane: 0 }] } }))
    fireEvent.contextMenu(g.cells()[3])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove track' }))
    expect(screen.queryByText(/Remove track and/)).toBeNull()
    expect(g.onRemoveAudioLane).not.toHaveBeenCalled()
  })

  it('light mode paints the menu with the theme vars', () => {
    const f = setup(project(), 'light')
    fireEvent.contextMenu(f.cells()[0])
    expect(screen.getByRole('menu').style.background).toContain('--editor-surface')
  })
})
