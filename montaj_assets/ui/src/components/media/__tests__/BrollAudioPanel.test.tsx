import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import BrollAudioPanel, { buildAudioFootageItems, type Voiceover } from '../BrollAudioPanel'

const fileUrl = (p: string) => `/files?path=${p}`

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
