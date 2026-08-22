/// <reference types="vitest/globals" />
/**
 * The left rail that names each track. Its whole job is alignment: a label that
 * sits at a different y than the clips it describes is worse than no label, so
 * these assert it positions off the SAME layout the canvas paints from.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import TrackGutter, { visualTrackKind } from '../TrackGutter'
import { computeTimelineLayout } from '../canvas/draw'
import type { Project } from '../../../types'
import type { VisualItem } from '../../../schema'

afterEach(() => cleanup())

const video = (id: string, over: Partial<VisualItem> = {}): VisualItem =>
  ({ id, type: 'video', src: 'a.mp4', start: 0, end: 2, ...over }) as VisualItem
const overlay = (id: string, over: Partial<VisualItem> = {}): VisualItem =>
  ({ id, type: 'overlay', src: '/p/overlays/text_line.jsx', start: 0, end: 2, ...over }) as VisualItem

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p',
    tracks: [[video('c0')], [overlay('o0')]],
    audio: { tracks: [{ id: 'a0', src: 'v.mp3', start: 0, end: 2, lane: 0 }] },
    ...over,
  } as unknown as Project
}

describe('visualTrackKind', () => {
  it('reads the kind off the items, since tracks are untyped in the schema', () => {
    expect(visualTrackKind([video('a'), video('b')])).toBe('video')
    expect(visualTrackKind([overlay('a')])).toBe('overlay')
  })

  it('has no answer for an empty track rather than guessing "video"', () => {
    expect(visualTrackKind([])).toBeNull()
  })

  it('falls back to the first item on a mixed track', () => {
    expect(visualTrackKind([overlay('a'), video('b')])).toBe('overlay')
  })
})

describe('TrackGutter', () => {
  it('names each row by what it holds, plus the audio lane and the caption row', () => {
    // Icon-only cells: the name is the accessible name (and the hover tooltip),
    // not on-screen text.
    render(<TrackGutter project={project()} />)
    expect(screen.getByLabelText('Video')).toBeTruthy()
    expect(screen.getByLabelText('Overlay')).toBeTruthy()
    expect(screen.getByLabelText('Audio')).toBeTruthy()
    expect(screen.getByLabelText('Captions')).toBeTruthy()
  })

  it('places every label at the y its own row occupies in the canvas layout', () => {
    // The alignment invariant. Both surfaces read one `computeTimelineLayout`,
    // so this fails the moment the rail starts deriving geometry of its own.
    const p = project()
    const layout = computeTimelineLayout(p)
    const { container } = render(<TrackGutter project={p} layout={layout} />)

    const positioned = [...container.querySelectorAll<HTMLElement>('.absolute')]
    const seen = positioned.map(el => ({ top: el.style.top, height: el.style.height }))

    for (const row of layout.rows) {
      expect(seen).toContainEqual({ top: `${row.y}px`, height: `${row.height}px` })
    }
    for (const lane of layout.lanes) {
      expect(seen).toContainEqual({ top: `${lane.y}px`, height: `${lane.height}px` })
    }
  })

  it('gives the base track its taller cell, not a uniform row height', () => {
    const p = project()
    const layout = computeTimelineLayout(p)
    render(<TrackGutter project={p} layout={layout} />)

    const base = layout.rows.find(r => r.trackIdx === 0)!
    const overlayRow = layout.rows.find(r => r.trackIdx === 1)!
    expect(base.height).toBeGreaterThan(overlayRow.height)
  })

  it('omits the caption cell when the caption row is not shown', () => {
    render(<TrackGutter project={project()} showCaptionRow={false} />)
    expect(screen.queryByLabelText('Captions')).toBeNull()
  })

  it('labels an empty track rather than rendering a blank cell', () => {
    render(<TrackGutter project={project({ tracks: [{ id: 'trk-0', items: [] }] } as Partial<Project>)} />)
    expect(screen.getByLabelText('Track')).toBeTruthy()
  })

  it('renders without an audio lane or captions on a bare project', () => {
    const bare = { id: 'p', tracks: [[video('c0')]] } as unknown as Project
    render(<TrackGutter project={bare} showCaptionRow={false} />)
    expect(screen.getByLabelText('Video')).toBeTruthy()
    expect(screen.queryByLabelText('Audio')).toBeNull()
  })
})

describe('TrackGutter — skip', () => {
  it('shows no skip control when the host has not wired the edit channel', () => {
    // A button that silently does nothing is worse than no button.
    render(<TrackGutter project={project()} />)
    expect(screen.queryByLabelText(/^Skip /)).toBeNull()
  })

  it('offers a skip toggle per visual track when wired', () => {
    render(<TrackGutter project={project()} onToggleTrackEnabled={vi.fn()} />)
    expect(screen.getByLabelText('Skip video track')).toBeTruthy()
    expect(screen.getByLabelText('Skip overlay track')).toBeTruthy()
  })

  it('reports the track index and the NEW enabled value', () => {
    const onToggle = vi.fn()
    render(<TrackGutter project={project()} onToggleTrackEnabled={onToggle} />)
    fireEvent.click(screen.getByLabelText('Skip video track'))
    expect(onToggle).toHaveBeenCalledWith(0, false)
  })

  it('re-enables a skipped track', () => {
    const onToggle = vi.fn()
    const p = { id: 'p', tracks: [{ id: 't0', items: [video('c0')], enabled: false }] } as unknown as Project
    render(<TrackGutter project={p} showCaptionRow={false} onToggleTrackEnabled={onToggle} />)
    fireEvent.click(screen.getByLabelText('Skip video track'))
    expect(onToggle).toHaveBeenCalledWith(0, true)
  })

  it('marks a skipped track pressed, so the state is readable without colour', () => {
    const p = { id: 'p', tracks: [{ id: 't0', items: [video('c0')], enabled: false }] } as unknown as Project
    render(<TrackGutter project={p} showCaptionRow={false} onToggleTrackEnabled={vi.fn()} />)
    expect(screen.getByLabelText('Skip video track').getAttribute('aria-pressed')).toBe('true')
  })

  it('treats a legacy-shaped project as all-enabled', () => {
    const legacy = { id: 'p', tracks: [[video('c0')]] } as unknown as Project
    render(<TrackGutter project={legacy} showCaptionRow={false} onToggleTrackEnabled={vi.fn()} />)
    expect(screen.getByLabelText('Skip video track').getAttribute('aria-pressed')).toBe('false')
  })
})

describe('TrackGutter — rail controls and settings', () => {
  const wired = {
    onToggleTrackEnabled: vi.fn(),
    onSetTrackVolume: vi.fn(),
    onSetTrackMuted: vi.fn(),
  }

  it('puts mute and skip in the RAIL, and volume behind the gear', () => {
    // Mute and skip are flipped constantly while cutting and need to be seen at
    // a glance, so they are inline; the gear is for what you set once.
    render(<TrackGutter project={project()} {...wired} />)
    expect(screen.getByRole('button', { name: 'Mute video track' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Skip video track' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Video track settings' }))
    expect(screen.getByLabelText('Video volume')).toBeTruthy()
  })

  it('offers NO audio controls on an overlay-only track', () => {
    // Overlay and image items carry no audio — `VisualItem.volume`/`muted` are
    // video-only — so a mute button or volume slider there could do nothing.
    render(<TrackGutter project={project()} {...wired} />)
    expect(screen.queryByRole('button', { name: 'Mute overlay track' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Overlay track settings' })).toBeNull()
    // Skip still applies — you can hide an overlay track.
    expect(screen.getByRole('button', { name: 'Skip overlay track' })).toBeTruthy()
  })

  it('gives a MIXED track audio controls, reading the items not the track kind', () => {
    const mixed = {
      id: 'p',
      tracks: [{ id: 't0', items: [overlay('o0'), video('c0')] }],
    } as unknown as Project
    render(<TrackGutter project={mixed} showCaptionRow={false} {...wired} />)
    expect(screen.getByRole('button', { name: 'Mute overlay track' })).toBeTruthy()
  })

  it('the type icon is a plain label, never the settings trigger', () => {
    // It used to double as the trigger, which made it impossible to tell what
    // was clickable.
    render(<TrackGutter project={project()} {...wired} />)
    expect(screen.getByLabelText('Video').tagName).toBe('SPAN')
  })

  it('renders no gear when volume is not wired', () => {
    render(<TrackGutter project={project()} onToggleTrackEnabled={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Video track settings' })).toBeNull()
  })

  it('toggles mute from the rail with the new value', () => {
    const onSetTrackMuted = vi.fn()
    render(<TrackGutter project={project()} {...wired} onSetTrackMuted={onSetTrackMuted} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mute video track' }))
    expect(onSetTrackMuted).toHaveBeenCalledWith(0, true)
  })

  it('shows a muted track as pressed, so the state reads without colour', () => {
    const p = { id: 'p', tracks: [{ id: 't0', items: [video('c0')], muted: true }] } as unknown as Project
    render(<TrackGutter project={p} showCaptionRow={false} {...wired} />)
    expect(screen.getByRole('button', { name: 'Mute video track' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('gives an audio lane mute inline and volume behind the gear, but no skip', () => {
    render(<TrackGutter project={project()} onSetLaneVolume={vi.fn()} onSetLaneMuted={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Mute audio lane' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Skip audio/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Audio lane settings' }))
    expect(screen.getByLabelText('Audio lane volume')).toBeTruthy()
  })

  it('fans a lane mute out over every track id in the lane', () => {
    const onSetLaneMuted = vi.fn()
    const twoTrackLane = {
      id: 'p',
      tracks: [{ id: 't0', items: [video('c0')] }],
      audio: { tracks: [
        { id: 'a0', src: 'v.mp3', start: 0, end: 2, lane: 0 },
        { id: 'a1', src: 'm.mp3', start: 0, end: 2, lane: 0 },
      ] },
    } as unknown as Project
    render(<TrackGutter project={twoTrackLane} showCaptionRow={false} onSetLaneMuted={onSetLaneMuted} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mute audio lane' }))
    expect(onSetLaneMuted).toHaveBeenCalledWith(['a0', 'a1'], true)
  })

  it('previews a volume drag and commits once on release', () => {
    const onSetTrackVolume = vi.fn()
    render(<TrackGutter project={project()} {...wired} onSetTrackVolume={onSetTrackVolume} />)
    fireEvent.click(screen.getByRole('button', { name: 'Video track settings' }))
    const slider = screen.getByLabelText('Video volume')

    fireEvent.change(slider, { target: { value: '0.5' } })
    expect(onSetTrackVolume).toHaveBeenLastCalledWith(0, 0.5, false)

    fireEvent.pointerUp(slider)
    expect(onSetTrackVolume).toHaveBeenLastCalledWith(0, 0.5, true)
  })
})
