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
import type { Captions, VisualItem } from '../../../schema'

afterEach(() => cleanup())

const video = (id: string, over: Partial<VisualItem> = {}): VisualItem =>
  ({ id, type: 'video', src: 'a.mp4', start: 0, end: 2, ...over }) as VisualItem
const overlay = (id: string, over: Partial<VisualItem> = {}): VisualItem =>
  ({ id, type: 'overlay', src: '/p/overlays/text_line.jsx', start: 0, end: 2, ...over }) as VisualItem
const captions = (over: Partial<Captions> = {}): Captions =>
  ({ style: 'clean', segments: [{ text: 'hello', start: 0, end: 1 }], ...over })

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
    // not on-screen text. The caption cell only renders when the layout has a
    // band to align with (see 'TrackGutter — caption cell alignment' below),
    // so this project needs actual caption segments.
    render(<TrackGutter project={project({ captions: captions() })} />)
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

  it('omits the caption cell when showCaptionRow is false, even though the layout carries a caption band', () => {
    const p = project({ captions: captions() })
    expect(computeTimelineLayout(p).captions).toBeTruthy()
    render(<TrackGutter project={p} showCaptionRow={false} />)
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

describe('TrackGutter — caption cell alignment', () => {
  // The caption row moved from a DOM strip below the canvas to a band INSIDE
  // the canvas layout, so its rail cell has to be positioned like every other
  // row rather than trail the gutter as its own flex cell.

  it('positions the caption cell at layout.captions[0].y/height, inside the same block the track rows live in', () => {
    const p = project({ captions: captions() })
    const layout = computeTimelineLayout(p)
    expect(layout.captions).toHaveLength(1)

    const { container } = render(<TrackGutter project={p} layout={layout} showCaptionRow />)

    const cell = screen.getByLabelText('Captions')
    // `.absolute` is the wrapper VisualTrackRailRow/AudioLaneRailRow both use —
    // finding it via `closest` rather than asserting on RailCell itself proves
    // the cell is wrapped the SAME way the other rows are, not styled directly.
    const wrapper = cell.closest('.absolute') as HTMLElement
    expect(wrapper).toBeTruthy()
    expect(wrapper.style.top).toBe(`${layout.captions![0].y}px`)
    expect(wrapper.style.height).toBe(`${layout.captions![0].height}px`)

    // Structural, not a snapshot: the wrapper is a DESCENDANT of the `.relative`
    // block the track rows and audio lanes are absolutely positioned inside —
    // not a trailing sibling after it.
    const relativeBlock = container.querySelector('.relative')!
    expect(relativeBlock.contains(wrapper)).toBe(true)
  })

  it('renders no caption cell on a project with no captions, even though showCaptionRow defaults true, and nothing else shifts', () => {
    const p = project() // no `captions` field — the layout carries no bands at all
    const layout = computeTimelineLayout(p)
    expect(layout.captions).toBeUndefined()

    const { container } = render(<TrackGutter project={p} layout={layout} />)
    expect(screen.queryByLabelText('Captions')).toBeNull()

    // The row/lane cells still land exactly where the (caption-less) layout
    // says they do — missing bands don't leave a gap or shift anything.
    const positioned = [...container.querySelectorAll<HTMLElement>('.absolute')]
    const seen = positioned.map(el => ({ top: el.style.top, height: el.style.height }))
    for (const row of layout.rows) {
      expect(seen).toContainEqual({ top: `${row.y}px`, height: `${row.height}px` })
    }
    for (const lane of layout.lanes) {
      expect(seen).toContainEqual({ top: `${lane.y}px`, height: `${lane.height}px` })
    }
  })

  it('renders N cells, one per band, each at its own band y — "Captions 1"…"Captions N" once there is more than one', () => {
    const p = project({
      captions: captions({
        segments: [
          { text: 'a', start: 0, end: 1, lane: 0 },
          { text: 'b', start: 0, end: 1, lane: 1 },
          { text: 'c', start: 0, end: 1, lane: 2 },
        ],
      }),
    })
    const layout = computeTimelineLayout(p)
    expect(layout.captions).toHaveLength(3)

    render(<TrackGutter project={p} layout={layout} showCaptionRow />)

    // The bare "Captions" label is gone once there is more than one band.
    expect(screen.queryByLabelText('Captions')).toBeNull()
    for (const band of layout.captions!) {
      const cell = screen.getByLabelText(`Captions ${band.lane + 1}`)
      const wrapper = cell.closest('.absolute') as HTMLElement
      expect(wrapper.style.top).toBe(`${band.y}px`)
      expect(wrapper.style.height).toBe(`${band.height}px`)
    }
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

  it('shows no magnet control when the host has not wired onSetLaneMagnet', () => {
    render(<TrackGutter project={project()} onSetLaneMuted={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /^Magnetic /i })).toBeNull()
  })

  it('offers a magnet toggle per audio lane when wired, reflecting the OFF default', () => {
    render(<TrackGutter project={project()} onSetLaneMagnet={vi.fn()} />)
    const toggle = screen.getByRole('button', { name: 'Magnetic audio lane' })
    expect(toggle).toBeTruthy()
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
  })

  it('reflects an ON magnetic lane', () => {
    const p = {
      id: 'p',
      tracks: [{ id: 't0', items: [video('c0')] }],
      audio: { tracks: [{ id: 'a0', src: 'v.mp3', start: 0, end: 2, lane: 0, magnetic: true }] },
    } as unknown as Project
    render(<TrackGutter project={p} showCaptionRow={false} onSetLaneMagnet={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Magnetic audio lane' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('fans a lane magnet toggle out over every track id in the lane, with the NEW value', () => {
    const onSetLaneMagnet = vi.fn()
    const twoTrackLane = {
      id: 'p',
      tracks: [{ id: 't0', items: [video('c0')] }],
      audio: { tracks: [
        { id: 'a0', src: 'v.mp3', start: 0, end: 2, lane: 0 },
        { id: 'a1', src: 'm.mp3', start: 0, end: 2, lane: 0 },
      ] },
    } as unknown as Project
    render(<TrackGutter project={twoTrackLane} showCaptionRow={false} onSetLaneMagnet={onSetLaneMagnet} />)
    fireEvent.click(screen.getByRole('button', { name: 'Magnetic audio lane' }))
    expect(onSetLaneMagnet).toHaveBeenCalledWith(['a0', 'a1'], true)
  })

  it('reads a lane as magnetic only when EVERY track in it is', () => {
    const mixedLane = {
      id: 'p',
      tracks: [{ id: 't0', items: [video('c0')] }],
      audio: { tracks: [
        { id: 'a0', src: 'v.mp3', start: 0, end: 2, lane: 0, magnetic: true },
        { id: 'a1', src: 'm.mp3', start: 0, end: 2, lane: 0 },
      ] },
    } as unknown as Project
    render(<TrackGutter project={mixedLane} showCaptionRow={false} onSetLaneMagnet={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Magnetic audio lane' }).getAttribute('aria-pressed')).toBe('false')
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
