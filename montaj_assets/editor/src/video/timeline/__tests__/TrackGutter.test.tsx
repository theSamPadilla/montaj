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

describe('TrackGutter — settings popover', () => {
  it('is closed until the icon is clicked, then opens', () => {
    render(<TrackGutter project={project()} onToggleTrackEnabled={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByLabelText('Video'))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('the icon renders as a plain, non-interactive label when no settings callback at all is wired', () => {
    render(<TrackGutter project={project()} />)
    expect(screen.getByLabelText('Video').tagName).toBe('SPAN')
    expect(screen.getByLabelText('Audio').tagName).toBe('SPAN')
  })

  it('shows Volume, Mute, and Skip for a visual track', () => {
    render(
      <TrackGutter
        project={project()}
        onToggleTrackEnabled={vi.fn()}
        onSetTrackVolume={vi.fn()}
        onSetTrackMuted={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByLabelText('Video'))
    expect(screen.getByLabelText('Video volume')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Mute video track' })).toBeTruthy()
    // Distinct from the rail's own 'Skip video track' eye button — same
    // action, but two controls can't share one accessible name.
    expect(screen.getByRole('switch', { name: 'Skip track' })).toBeTruthy()
  })

  it('shows Volume and Mute for an audio lane, with no Skip control', () => {
    render(<TrackGutter project={project()} onSetLaneVolume={vi.fn()} onSetLaneMuted={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Audio'))
    expect(screen.getByLabelText('Audio lane volume')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Mute audio lane' })).toBeTruthy()
    expect(screen.queryByText('Skip')).toBeNull()
  })

  it('only shows the sections whose own callback is wired (no dead controls)', () => {
    // onSetTrackMuted omitted — its section must not render even though the
    // button itself does (onSetTrackVolume alone is enough to wire it).
    render(<TrackGutter project={project()} onSetTrackVolume={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Video'))
    expect(screen.getByLabelText('Video volume')).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Mute video track' })).toBeNull()
  })

  it('previews a visual-track volume drag on change and commits once on release', () => {
    const onSetTrackVolume = vi.fn()
    render(<TrackGutter project={project()} onSetTrackVolume={onSetTrackVolume} />)
    fireEvent.click(screen.getByLabelText('Video'))
    const input = screen.getByLabelText('Video volume') as HTMLInputElement

    fireEvent.change(input, { target: { value: '1.5' } })
    expect(onSetTrackVolume).toHaveBeenCalledTimes(1)
    expect(onSetTrackVolume).toHaveBeenCalledWith(0, 1.5, false)

    fireEvent.pointerUp(input)
    expect(onSetTrackVolume).toHaveBeenCalledTimes(2)
    expect(onSetTrackVolume).toHaveBeenLastCalledWith(0, 1.5, true)
  })

  it('reports the volume for the track the popover actually belongs to', () => {
    const onSetTrackVolume = vi.fn()
    render(<TrackGutter project={project()} onSetTrackVolume={onSetTrackVolume} />)
    fireEvent.click(screen.getByLabelText('Overlay'))
    const input = screen.getByLabelText('Overlay volume') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0.3' } })
    expect(onSetTrackVolume).toHaveBeenCalledWith(1, 0.3, false)
  })

  it('mute fires once per click with the toggled value (no preview/commit split)', () => {
    const onSetTrackMuted = vi.fn()
    render(<TrackGutter project={project()} onSetTrackMuted={onSetTrackMuted} />)
    fireEvent.click(screen.getByLabelText('Video'))
    fireEvent.click(screen.getByRole('switch', { name: 'Mute video track' }))
    expect(onSetTrackMuted).toHaveBeenCalledTimes(1)
    expect(onSetTrackMuted).toHaveBeenCalledWith(0, true)
  })

  it("the popover's Skip switch calls the same onToggleTrackEnabled the inline eye icon calls", () => {
    const onToggleTrackEnabled = vi.fn()
    render(<TrackGutter project={project()} onToggleTrackEnabled={onToggleTrackEnabled} />)
    fireEvent.click(screen.getByLabelText('Video'))
    fireEvent.click(screen.getByRole('switch', { name: 'Skip track' }))
    expect(onToggleTrackEnabled).toHaveBeenCalledWith(0, false)
  })

  it('lane volume/mute callbacks fire with every AudioTrack id sharing the lane', () => {
    const onSetLaneVolume = vi.fn()
    const onSetLaneMuted = vi.fn()
    const p = project({
      audio: {
        tracks: [
          { id: 'a0', src: 'v.mp3', start: 0, end: 2, lane: 0 },
          { id: 'a1', src: 'w.mp3', start: 2, end: 4, lane: 0 },
        ],
      },
    } as Partial<Project>)
    render(<TrackGutter project={p} onSetLaneVolume={onSetLaneVolume} onSetLaneMuted={onSetLaneMuted} />)
    fireEvent.click(screen.getByLabelText('Audio'))

    const volumeInput = screen.getByLabelText('Audio lane volume') as HTMLInputElement
    fireEvent.change(volumeInput, { target: { value: '0.5' } })
    expect(onSetLaneVolume).toHaveBeenCalledWith(['a0', 'a1'], 0.5, false)
    fireEvent.pointerUp(volumeInput)
    expect(onSetLaneVolume).toHaveBeenCalledWith(['a0', 'a1'], 0.5, true)

    fireEvent.click(screen.getByRole('switch', { name: 'Mute audio lane' }))
    expect(onSetLaneMuted).toHaveBeenCalledWith(['a0', 'a1'], true)
  })

  it('a lane whose tracks disagree on muted displays the lane as unmuted', () => {
    const p = project({
      audio: {
        tracks: [
          { id: 'a0', src: 'v.mp3', start: 0, end: 2, lane: 0, muted: true },
          { id: 'a1', src: 'w.mp3', start: 2, end: 4, lane: 0, muted: false },
        ],
      },
    } as Partial<Project>)
    render(<TrackGutter project={p} onSetLaneMuted={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Audio'))
    expect(screen.getByRole('switch', { name: 'Mute audio lane' }).getAttribute('aria-checked')).toBe('false')
  })

  it('closes on outside click', () => {
    render(<TrackGutter project={project()} onToggleTrackEnabled={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Video'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
