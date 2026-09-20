import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import AudioPanel, { buildAudioItems, kindLabel } from '../AudioPanel'
import type { Voiceover } from '../BrollAudioPanel'
import type { AudioTrack } from '@/lib/types/schema'

/** Mirrors the adapter's real shape closely enough to assert on (`fileUrl` in `lib/api.ts`). */
const fileUrl = (path: string) => `/api/files?path=${encodeURIComponent(path)}`

function track(over: Partial<AudioTrack> & Pick<AudioTrack, 'id' | 'src'>): AudioTrack {
  return { start: 0, end: 15, ...over }
}

/** The Neon Dawn fixture's shape: four beds, one lane, back to back, no labels. */
const FOUR_BEDS: AudioTrack[] = [
  track({ id: '1-lyria-s27', src: '/p/audio/lyria/cut-s27.wav', start: 0, end: 15, lane: 0, sourceDuration: 15 }),
  track({ id: '2-lyria-s43', src: '/p/audio/lyria/cut-s43.wav', start: 15, end: 30, lane: 0, sourceDuration: 15 }),
  track({ id: '3-lyria-s11', src: '/p/audio/lyria/cut-s11.wav', start: 30, end: 45, lane: 0, sourceDuration: 15 }),
  track({ id: '4-synth', src: '/p/audio/synth/neon-dawn-synth.wav', start: 45, end: 60, lane: 0, sourceDuration: 15 }),
]

function usedOf(tracks: AudioTrack[]): Set<string> {
  return new Set(tracks.map(t => t.src).filter(Boolean))
}

function cards(): HTMLElement[] {
  return screen.queryAllByTestId('audio-card')
}

function audioEls(container: HTMLElement): HTMLAudioElement[] {
  return Array.from(container.querySelectorAll('audio'))
}

describe('buildAudioItems', () => {
  it('emits one item per timeline track, ordered by lane then start', () => {
    const tracks = [
      track({ id: 'b', src: '/b.wav', start: 10, lane: 1 }),
      track({ id: 'a', src: '/a.wav', start: 5, lane: 0 }),
      track({ id: 'c', src: '/c.wav', start: 0, lane: 1 }),
      track({ id: 'd', src: '/d.wav', start: 0 }), // no lane -> lane 0
    ]
    const items = buildAudioItems({ tracks, usedSrcs: usedOf(tracks) })
    expect(items.map(i => i.key)).toEqual(['d', 'a', 'c', 'b'])
    expect(items.every(i => i.kind === 'timeline' && i.placed)).toBe(true)
  })

  it('does NOT de-duplicate tracks sharing one src — 40 labelled segments stay 40 cards', () => {
    // The Daubert Demo shape: one narration file split across many labelled
    // segments. De-duplicating by src would collapse the project to one card.
    const tracks = Array.from({ length: 40 }, (_, i) =>
      track({ id: `seg-${i}`, src: '/p/vo/full.wav', start: i * 3, end: i * 3 + 3, label: `Segment ${i}` }),
    )
    const items = buildAudioItems({ tracks, usedSrcs: usedOf(tracks) })
    expect(items).toHaveLength(40)
    expect(items[0].name).toBe('Segment 0')
    expect(items[39].name).toBe('Segment 39')
    expect(new Set(items.map(i => i.path)).size).toBe(1)
  })

  it('names a timeline item by its label, falling back to the basename', () => {
    const tracks = [
      track({ id: 'x', src: '/p/a/raw-name.wav', label: 'Main theme' }),
      track({ id: 'y', src: '/p/a/unlabelled.wav' }),
    ]
    const items = buildAudioItems({ tracks, usedSrcs: usedOf(tracks) })
    expect(items.map(i => i.name)).toEqual(['Main theme', 'unlabelled.wav'])
  })

  it('carries placement, type, muted and duration through from the track', () => {
    const tracks = [
      track({ id: 'x', src: '/a.wav', start: 45, end: 60, type: 'music', muted: true, sourceDuration: 15 }),
    ]
    const [item] = buildAudioItems({ tracks, usedSrcs: usedOf(tracks) })
    expect(item.placement).toBe('0:45–1:00')
    expect(item.trackType).toBe('music')
    expect(item.muted).toBe(true)
    expect(item.duration).toBe(15)
  })

  it('appends voiceover files after the timeline items, in take/assembled/cleaned order', () => {
    const tracks = [track({ id: 't', src: '/p/vo/vo_01_IMG_1.wav' })]
    const voiceover: Voiceover = {
      takes: ['/p/vo/IMG_1.MOV', '/p/vo/IMG_2.MOV'],
      src: '/p/vo/assembled.wav',
      cleanedSrc: '/p/vo/cleaned.wav',
    }
    const items = buildAudioItems({ tracks, voiceover, usedSrcs: usedOf(tracks) })
    expect(items.map(i => i.kind)).toEqual(['timeline', 'take', 'take', 'assembled', 'cleaned'])
  })

  it('collapses a voiceover file that IS a placed track into the single timeline card', () => {
    // The overlap this design exists to handle: on a finished edit the cleaned
    // narration is often the same file as a placed track.
    const tracks = [track({ id: 't', src: '/p/vo/cleaned.wav' })]
    const voiceover: Voiceover = { src: '/p/vo/cleaned.wav', cleanedSrc: '/p/vo/cleaned.wav' }
    const items = buildAudioItems({ tracks, voiceover, usedSrcs: usedOf(tracks) })
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('timeline')
    expect(items[0].placed).toBe(true)
  })

  it('marks a submitted take as placed via stem matching, not exact path', () => {
    // The real b-roll shape: the placed wav is a DIFFERENT file from the
    // submitted take, sharing only its stem. An exact match would wrongly
    // report the take as unused — this is why isFootageInUse is kept here.
    const tracks = [track({ id: 't', src: '/p/vo/vo_02_IMG_0979.wav' })]
    const voiceover: Voiceover = { takes: ['/p/takes/IMG_0979.MOV', '/p/takes/IMG_9999.MOV'] }
    const items = buildAudioItems({ tracks, voiceover, usedSrcs: usedOf(tracks) })
    const takes = items.filter(i => i.kind === 'take')
    expect(takes.map(i => [i.name, i.placed])).toEqual([
      ['IMG_0979.MOV', true],
      ['IMG_9999.MOV', false],
    ])
  })

  it('returns an empty pool for a project with neither tracks nor voiceover', () => {
    expect(buildAudioItems({ tracks: [], usedSrcs: new Set() })).toEqual([])
  })

  it('skips a track with no src', () => {
    const tracks = [{ id: 'bad', src: '', start: 0, end: 1 } as AudioTrack]
    expect(buildAudioItems({ tracks, usedSrcs: new Set() })).toEqual([])
  })
})

describe('kindLabel', () => {
  it('labels timeline items and reuses BrollAudioPanel labels for voiceover kinds', () => {
    expect(kindLabel('timeline')).toBe('On the timeline')
    expect(kindLabel('take')).toBe('Submitted take')
    expect(kindLabel('assembled')).toBe('Assembled voiceover')
    expect(kindLabel('cleaned')).toBe('Cleaned voiceover')
  })
})

describe('AudioPanel', () => {
  it('renders one card and one audio player per item', () => {
    const { container } = render(<AudioPanel tracks={FOUR_BEDS} usedSrcs={usedOf(FOUR_BEDS)} fileUrl={fileUrl} />)
    expect(cards()).toHaveLength(4)
    expect(audioEls(container)).toHaveLength(4)
  })

  it('points each player at fileUrl(path)', () => {
    const { container } = render(<AudioPanel tracks={FOUR_BEDS} usedSrcs={usedOf(FOUR_BEDS)} fileUrl={fileUrl} />)
    expect(audioEls(container).map(el => el.getAttribute('src'))).toEqual(
      FOUR_BEDS.map(t => fileUrl(t.src)),
    )
  })

  it('uses a bare controls player that never preloads (no Web Audio, no transport)', () => {
    const { container } = render(
      <AudioPanel tracks={[FOUR_BEDS[0]]} usedSrcs={usedOf(FOUR_BEDS)} fileUrl={fileUrl} />,
    )
    const el = audioEls(container)[0]
    expect(el).toHaveAttribute('controls')
    expect(el).toHaveAttribute('preload', 'none')
  })

  it('marks every card as placed or not placed', () => {
    const tracks = [track({ id: 't', src: '/p/vo/vo_02_IMG_0979.wav' })]
    const voiceover: Voiceover = { takes: ['/p/takes/IMG_0979.MOV', '/p/takes/IMG_9999.MOV'] }
    render(<AudioPanel tracks={tracks} voiceover={voiceover} usedSrcs={usedOf(tracks)} fileUrl={fileUrl} />)

    // Every card carries exactly one of the two marks — never neither.
    expect(cards()).toHaveLength(3)
    expect(cards().map(c => c.getAttribute('data-placed'))).toEqual(['true', 'true', 'false'])
    expect(screen.getAllByText('Added')).toHaveLength(2)
    expect(screen.getAllByText('Not placed')).toHaveLength(1)
  })

  it('shows the Footage-style duration badge and the placement span', () => {
    render(<AudioPanel tracks={FOUR_BEDS} usedSrcs={usedOf(FOUR_BEDS)} fileUrl={fileUrl} />)
    expect(screen.getAllByText('0:15')).not.toHaveLength(0)
    expect(screen.getByText(/0:45–1:00/)).toBeInTheDocument()
  })

  it('falls back to durationBySrc when the track carries no sourceDuration', () => {
    const tracks = [track({ id: 'x', src: '/a.wav' })]
    render(
      <AudioPanel
        tracks={tracks}
        usedSrcs={usedOf(tracks)}
        durationBySrc={new Map([['/a.wav', 42]])}
        fileUrl={fileUrl}
      />,
    )
    expect(screen.getByText('0:42')).toBeInTheDocument()
  })

  it('marks a muted track', () => {
    const tracks = [track({ id: 'm', src: '/a/quiet.wav', muted: true })]
    render(<AudioPanel tracks={tracks} usedSrcs={usedOf(tracks)} fileUrl={fileUrl} />)
    expect(screen.getByText('Muted')).toBeInTheDocument()
  })

  it('shows an empty state and no players when the project has no audio at all', () => {
    const { container } = render(<AudioPanel tracks={[]} usedSrcs={new Set()} fileUrl={fileUrl} />)
    expect(screen.getByText('No audio in this project yet.')).toBeInTheDocument()
    expect(audioEls(container)).toHaveLength(0)
    expect(cards()).toHaveLength(0)
  })

  it('surfaces a broll project’s voiceover files as cards in the same grid', () => {
    const tracks = [track({ id: 't', src: '/p/vo/vo_01_IMG_1.wav', label: 'Hook' })]
    const voiceover: Voiceover = {
      takes: ['/p/takes/IMG_1.MOV'],
      src: '/p/vo/assembled.wav',
      cleanedSrc: '/p/vo/cleaned.wav',
    }
    const { container } = render(
      <AudioPanel tracks={tracks} voiceover={voiceover} usedSrcs={usedOf(tracks)} fileUrl={fileUrl} />,
    )
    expect(cards()).toHaveLength(4)
    expect(screen.getByText('Hook')).toBeInTheDocument()
    expect(screen.getByText('IMG_1.MOV')).toBeInTheDocument()
    expect(screen.getByText('assembled.wav')).toBeInTheDocument()
    expect(screen.getByText('cleaned.wav')).toBeInTheDocument()
    // Every card — voiceover ones included — gets its own audition player.
    expect(audioEls(container)).toHaveLength(4)
    expect(screen.getByText('Submitted take')).toBeInTheDocument()
    expect(screen.getByText('Assembled voiceover')).toBeInTheDocument()
  })

  it('keeps the AudioLines fallback when no peaks fetcher is available', () => {
    const { container } = render(<AudioPanel tracks={FOUR_BEDS} usedSrcs={usedOf(FOUR_BEDS)} fileUrl={fileUrl} />)
    expect(container.querySelectorAll('[data-testid="waveform-preview"]')).toHaveLength(0)
  })
})
