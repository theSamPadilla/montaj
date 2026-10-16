/// <reference types="vite/client" />
// §244: the caption panel's Languages row (`captions.showLangs`) and the preview drawing only the languages on.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { Project, OverlayFactory } from '../types'
import type { Captions, CaptionSegment } from '../schema'
import type { PlaybackClock } from './playback-clock'
import CaptionListPanel, { captionLanguages } from './CaptionListPanel'
import CaptionPreview from './preview/CaptionPreview'

afterEach(() => cleanup())
Element.prototype.scrollIntoView = vi.fn()

const SRC: CaptionSegment = { id: 'cap-0', text: 'hello world', start: 0, end: 2 }
const ES: CaptionSegment = { id: 'cap-1', text: 'hola mundo', start: 0, end: 2, lane: 1, lang: 'es', translationOf: ['cap-0'] }
const FR: CaptionSegment = { id: 'cap-2', text: 'salut monde', start: 0, end: 2, lane: 2, lang: 'fr', translationOf: ['cap-0'] }

function mountPanel(captions: Partial<Captions>, extra: { onAddLanguage?: (have: string[]) => Promise<void> | void } = {}) {
  const track = { style: 'plate', segments: [SRC], ...captions } as Captions
  const project = { id: 'p1', captions: track } as unknown as Project
  const clock: PlaybackClock = { get: () => 0, set: vi.fn(), subscribe: () => () => {} }
  const onCaptionEdit = vi.fn()
  render(
    <CaptionListPanel captionTrack={track} project={project} currentTime={0} selectedIds={[]} onSelectCaption={vi.fn()}
      onCaptionEdit={onCaptionEdit} onProjectChange={vi.fn()} fps={30} clock={clock} {...extra} />,
  )
  return { onCaptionEdit }
}
const chip = (name: string) => screen.getByRole('button', { name })
const lastEdit = (fn: ReturnType<typeof vi.fn>) => (fn.mock.calls.at(-1)![0] as Project).captions!

describe('captionLanguages', () => {
  it('names the source from the track\'s recorded language, "Original" when unknown, then each translation', () => {
    expect(captionLanguages({ lang: 'en', segments: [SRC, ES, FR] })).toEqual([
      { key: 'en', label: 'English' }, { key: 'es', label: 'Spanish' }, { key: 'fr', label: 'French' },
    ])
    expect(captionLanguages({ segments: [SRC, ES] })).toEqual([{ key: 'source', label: 'Original' }, { key: 'es', label: 'Spanish' }])
  })
})

describe('Languages row', () => {
  it('shows with one language: that chip is on and locked, no translation needed', () => {
    const { onCaptionEdit } = mountPanel({ lang: 'en' })
    expect(chip('English')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('English')).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(chip('English'))
    expect(onCaptionEdit).not.toHaveBeenCalled()
  })

  it('no recorded language: the source chip reads Original', () => {
    mountPanel({ segments: [SRC, ES] })
    expect(chip('Original')).toBeInTheDocument()
  })

  it('both on by default (no showLangs); switching one off writes the list of those on', () => {
    const { onCaptionEdit } = mountPanel({ lang: 'en', segments: [SRC, ES] })
    expect(chip('English')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('Spanish')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(chip('English'))
    expect(lastEdit(onCaptionEdit).showLangs).toEqual(['es'])
  })

  it('the last one on cannot be switched off', () => {
    const { onCaptionEdit } = mountPanel({ lang: 'en', segments: [SRC, ES], showLangs: ['es'] })
    expect(chip('Spanish')).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(chip('Spanish'))
    expect(onCaptionEdit).not.toHaveBeenCalled()
  })

  it('switching the second one back on clears the field (everything draws)', () => {
    const { onCaptionEdit } = mountPanel({ lang: 'en', segments: [SRC, ES], showLangs: ['es'] })
    fireEvent.click(chip('English'))
    expect('showLangs' in lastEdit(onCaptionEdit)).toBe(false)
  })

  it('scales to three languages: two on, switching a third on is all of them', () => {
    const { onCaptionEdit } = mountPanel({ lang: 'en', segments: [SRC, ES, FR], showLangs: ['en', 'fr'] })
    expect(chip('Spanish')).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(chip('Spanish'))
    expect('showLangs' in lastEdit(onCaptionEdit)).toBe(false)
  })

  it('a stale list (no such language left) reads as all on', () => {
    mountPanel({ lang: 'en', segments: [SRC, ES], showLangs: ['de'] })
    expect(chip('English')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('Spanish')).toHaveAttribute('aria-pressed', 'true')
  })

  it('"+ Language" only when the host can hand over a prompt', () => {
    mountPanel({ lang: 'en' })
    expect(screen.queryByRole('button', { name: '+ Language' })).toBeNull()
  })

  it('"+ Language" hands the host the languages the track has, with no popover of its own', () => {
    const onAddLanguage = vi.fn()
    mountPanel({ lang: 'en', segments: [SRC, ES] }, { onAddLanguage })
    fireEvent.click(chip('+ Language'))
    expect(onAddLanguage).toHaveBeenCalledWith(['en', 'es'])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy prompt' })).toBeNull()
  })

  it('an unknown source language goes as "source"', () => {
    const onAddLanguage = vi.fn()
    mountPanel({}, { onAddLanguage })
    fireEvent.click(chip('+ Language'))
    expect(onAddLanguage).toHaveBeenCalledWith(['source'])
  })

  it('"+ Language" stays at the end of the row with several languages', () => {
    mountPanel({ lang: 'en', segments: [SRC, ES] }, { onAddLanguage: vi.fn() })
    const names = Array.from(screen.getByRole('group', { name: 'Caption languages' }).querySelectorAll('button')).map(b => b.textContent)
    expect(names).toEqual(['English', 'Spanish', '+ Language'])
  })
})

describe('preview draws only the languages on', () => {
  beforeEach(() => {
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      cb: (e: unknown[]) => void
      constructor(cb: (e: unknown[]) => void) { this.cb = cb }
      observe() { this.cb([{ contentRect: { width: 540, height: 960 } }]) }
      unobserve() {}
      disconnect() {}
    }
    Range.prototype.getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect)
  })

  async function drawn(track: Captions): Promise<string[]> {
    let seen: string[] = []
    const compileOverlay = vi.fn(async (): Promise<OverlayFactory> =>
      (_f: number, _fps: number, _d: number, props: Record<string, unknown>): ReactElement | null => {
        seen = (props.segments as Captions['segments']).map(s => s.id as string)
        expect('showLangs' in props).toBe(false)
        return <div data-testid="drawn" />
      })
    const { container } = render(<CaptionPreview track={track} currentTime={1} fps={30} compileOverlay={compileOverlay} resolveCaptionTemplate={s => s} designCanvas={[1080, 1920]} />)
    await waitFor(() => expect(container.querySelector('[data-testid="drawn"]')).not.toBeNull())
    return seen
  }

  it('everything by default, Spanish alone, English alone', async () => {
    const base = { style: 'plate', lang: 'en', segments: [SRC, ES] } as Captions
    expect(await drawn(base)).toEqual(['cap-0', 'cap-1'])
    cleanup()
    expect(await drawn({ ...base, showLangs: ['es'] })).toEqual(['cap-1'])
    cleanup()
    expect(await drawn({ ...base, showLangs: ['en'] })).toEqual(['cap-0'])
  })
})
