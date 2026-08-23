import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { VisualItem } from '@/lib/types/schema'

vi.mock('@bycrux/editor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bycrux/editor')>()
  return {
    ...actual,
    FilmstripScrubber: (props: { proxySrc: string; sourceDuration: number }) => (
      <div data-testid="filmstrip-scrubber" data-proxy-src={props.proxySrc} data-source-duration={props.sourceDuration} />
    ),
  }
})

import BrollAudioPanel, {
  buildAudioFootageItems,
  isFootageInUse,
  resamplePeaksToBars,
  type Voiceover,
} from '../BrollAudioPanel'

const fileUrl = (p: string) => `/files?path=${p}`

/** Interleaved `[min, max, ...]` fixture, well within int16 range. */
function fakePeaks(totalSamples: number): number[] {
  const peaks: number[] = []
  for (let i = 0; i < totalSamples; i++) {
    peaks.push(-1000 - i, 1000 + i)
  }
  return peaks
}

function source(overrides: Partial<VisualItem> = {}): VisualItem {
  return {
    id: 'src-1',
    type: 'video',
    src: '/vo/IMG_0979.MOV',
    start: 0,
    end: 0,
    sourceDuration: 12,
    proxySrc: '/vo/IMG_0979_proxy.mp4',
    ...overrides,
  }
}

function baseProps(overrides: Partial<React.ComponentProps<typeof BrollAudioPanel>> = {}) {
  return {
    voiceover: undefined as Voiceover | undefined,
    usedSrcs: new Set<string>(),
    fileUrl,
    ...overrides,
  }
}

describe('buildAudioFootageItems', () => {
  it('lists takes first, then assembled, then cleaned', () => {
    const items = buildAudioFootageItems({
      src: '/vo/full.wav',
      takes: ['/vo/IMG_0978.MOV', '/vo/IMG_0979.MOV'],
      cleanedSrc: '/vo/full_cut.wav',
    })
    expect(items).toEqual([
      { path: '/vo/IMG_0978.MOV', kind: 'take' },
      { path: '/vo/IMG_0979.MOV', kind: 'take' },
      { path: '/vo/full.wav', kind: 'assembled' },
      { path: '/vo/full_cut.wav', kind: 'cleaned' },
    ])
  })

  it('de-duplicates by path, first kind wins (single-take: src IS the take)', () => {
    const items = buildAudioFootageItems({
      src: '/vo/take.wav',
      takes: ['/vo/take.wav'],
      cleanedSrc: '/vo/take.wav',
    })
    expect(items).toEqual([{ path: '/vo/take.wav', kind: 'take' }])
  })

  it('returns nothing when voiceover is absent', () => {
    expect(buildAudioFootageItems(undefined)).toEqual([])
  })
})

describe('BrollAudioPanel', () => {
  it('renders one card per take plus the assembled and cleaned entries', () => {
    render(
      <BrollAudioPanel
        {...baseProps({
          voiceover: {
            src: '/vo/full.wav',
            takes: ['/vo/IMG_0978.MOV', '/vo/IMG_0979.MOV'],
            cleanedSrc: '/vo/full_cut.wav',
          },
        })}
      />,
    )
    expect(screen.getByText('IMG_0978.MOV')).toBeInTheDocument()
    expect(screen.getByText('IMG_0979.MOV')).toBeInTheDocument()
    expect(screen.getByText('full.wav')).toBeInTheDocument()
    expect(screen.getByText('full_cut.wav')).toBeInTheDocument()
    expect(screen.getAllByText('Submitted take')).toHaveLength(2)
    expect(screen.getByText('Assembled voiceover')).toBeInTheDocument()
    expect(screen.getByText('Cleaned voiceover')).toBeInTheDocument()
  })

  it('shows the Added badge only for items whose path is on the timeline', () => {
    render(
      <BrollAudioPanel
        {...baseProps({
          voiceover: { src: '/vo/full.wav', takes: ['/vo/a.wav', '/vo/b.wav'] },
          usedSrcs: new Set(['/vo/a.wav']),
        })}
      />,
    )
    expect(screen.getAllByText('Added')).toHaveLength(1)
  })

  it('shows a duration chip when the src has a known sourceDuration', () => {
    render(
      <BrollAudioPanel
        {...baseProps({
          voiceover: { src: '/vo/full.wav' },
          durationBySrc: new Map([['/vo/full.wav', 65]]),
        })}
      />,
    )
    expect(screen.getByText('1:05')).toBeInTheDocument()
  })

  it('links each card to the resolved file url', () => {
    render(<BrollAudioPanel {...baseProps({ voiceover: { src: '/vo/full.wav' } })} />)
    const link = screen.getByText('full.wav').closest('a') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/files?path=/vo/full.wav')
  })

  it('renders the empty state when there is no voiceover audio', () => {
    render(<BrollAudioPanel {...baseProps()} />)
    expect(screen.getByText('No voiceover audio yet.')).toBeInTheDocument()
  })
})

describe('isFootageInUse', () => {
  it('matches a submitted take by stem against a per-take extracted audio src', () => {
    expect(isFootageInUse('/vo/IMG_0979.MOV', new Set(['/vo/vo_02_IMG_0979.wav']))).toBe(true)
  })

  it('matches the assembled/cleaned narration when used directly (exact path)', () => {
    expect(isFootageInUse('/vo/voiceover_full_cut.wav', new Set(['/vo/voiceover_full_cut.wav']))).toBe(true)
  })

  it('matches the assembled/cleaned narration by basename when the used src has a different absolute prefix', () => {
    expect(isFootageInUse('/vo/voiceover_full_cut.wav', new Set(['/workspace/audio/voiceover_full_cut.wav']))).toBe(true)
  })

  it('returns false for a take that is not referenced by any used src', () => {
    expect(isFootageInUse('/vo/IMG_0980.MOV', new Set(['/vo/vo_02_IMG_0979.wav']))).toBe(false)
  })

  it('returns false against an empty usedSrcs set', () => {
    expect(isFootageInUse('/vo/IMG_0979.MOV', new Set())).toBe(false)
  })
})

describe('resamplePeaksToBars', () => {
  it('returns exactly `count` bars', () => {
    expect(resamplePeaksToBars(fakePeaks(100), 28)).toHaveLength(28)
  })

  it('returns an empty array for empty peaks or a non-positive count', () => {
    expect(resamplePeaksToBars([], 28)).toEqual([])
    expect(resamplePeaksToBars(fakePeaks(10), 0)).toEqual([])
  })

  it('normalizes int16-range values into roughly [-1, 1]', () => {
    const bars = resamplePeaksToBars([-32768, 32767], 1)
    expect(bars).toHaveLength(1)
    expect(bars[0].min).toBeCloseTo(-1, 3)
    expect(bars[0].max).toBeCloseTo(1, 3)
  })

  it('still produces `count` bars when there are fewer samples than bars (zoomed-in repeat)', () => {
    expect(resamplePeaksToBars(fakePeaks(5), 28)).toHaveLength(28)
  })
})

describe('BrollAudioPanel audio waveform preview', () => {
  it('renders a waveform preview once peaks resolve', async () => {
    const getWaveformPeaks = vi.fn(async () => ({
      samplesPerSecond: 50,
      start: 0,
      duration: 10,
      peaks: fakePeaks(40),
    }))
    render(
      <BrollAudioPanel
        {...baseProps({
          voiceover: { src: '/vo/full.wav' },
          projectId: 'proj-1',
          getWaveformPeaks,
        })}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('waveform-preview')).toBeInTheDocument())
    expect(getWaveformPeaks).toHaveBeenCalledWith({ projectId: 'proj-1', src: '/vo/full.wav', samplesPerSecond: 50 })
  })

  it('falls back to the icon (no waveform preview) when the peaks fetch rejects', async () => {
    const getWaveformPeaks = vi.fn(async () => {
      throw new Error('boom')
    })
    render(
      <BrollAudioPanel
        {...baseProps({
          voiceover: { src: '/vo/full.wav' },
          projectId: 'proj-1',
          getWaveformPeaks,
        })}
      />,
    )
    await waitFor(() => expect(getWaveformPeaks).toHaveBeenCalled())
    expect(screen.queryByTestId('waveform-preview')).not.toBeInTheDocument()
  })

  it('keeps the icon and never fetches when getWaveformPeaks is not supplied', () => {
    render(<BrollAudioPanel {...baseProps({ voiceover: { src: '/vo/full.wav' }, projectId: 'proj-1' })} />)
    expect(screen.queryByTestId('waveform-preview')).not.toBeInTheDocument()
  })
})

describe('BrollAudioPanel video-take thumbnail', () => {
  it('renders a filmstrip poster when the take matches a source with a proxy', () => {
    render(
      <BrollAudioPanel
        {...baseProps({
          voiceover: { src: '/vo/full.wav', takes: ['/vo/IMG_0979.MOV'] },
          projectId: 'proj-1',
          sources: [source()],
          getFilmstrip: vi.fn(async () => ({ sheets: [], interval: 1, tileWidth: 160 })),
        })}
      />,
    )
    const scrubber = screen.getByTestId('filmstrip-scrubber')
    expect(scrubber.getAttribute('data-proxy-src')).toBe('/vo/IMG_0979_proxy.mp4')
    expect(scrubber.getAttribute('data-source-duration')).toBe('12')
  })

  it('keeps the FileVideo icon when no source matches the take', () => {
    render(
      <BrollAudioPanel
        {...baseProps({
          voiceover: { src: '/vo/full.wav', takes: ['/vo/IMG_0979.MOV'] },
          projectId: 'proj-1',
          sources: [],
          getFilmstrip: vi.fn(async () => ({ sheets: [], interval: 1, tileWidth: 160 })),
        })}
      />,
    )
    expect(screen.queryByTestId('filmstrip-scrubber')).not.toBeInTheDocument()
  })

  it('keeps the FileVideo icon when the matching source has no proxySrc', () => {
    render(
      <BrollAudioPanel
        {...baseProps({
          voiceover: { src: '/vo/full.wav', takes: ['/vo/IMG_0979.MOV'] },
          projectId: 'proj-1',
          sources: [source({ proxySrc: undefined })],
          getFilmstrip: vi.fn(async () => ({ sheets: [], interval: 1, tileWidth: 160 })),
        })}
      />,
    )
    expect(screen.queryByTestId('filmstrip-scrubber')).not.toBeInTheDocument()
  })
})
