/**
 * A heavy overlay at the playhead (a 3D scene item) marks itself `data-montaj-loading` until its first frame is on
 * screen, or `data-montaj-load-error` when it cannot load. The preview covers the picture while one is loading, so the
 * captions and other overlays never show alone on a black frame, and says so when it failed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, screen } from '@testing-library/react'
import { useRef } from 'react'
import LoadingCover, { LOADING_COVER_Z, readLoadState } from '../LoadingCover'
import PreviewPlayer from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import type { EditorProject as Project, VisualItem } from '../../../schema'

function el(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

describe('readLoadState', () => {
  it('nothing marked is nothing; a loading mark wins over an error; an empty value still counts', () => {
    expect(readLoadState(null)).toEqual({ loading: null, error: null })
    expect(readLoadState(el('<div></div>'))).toEqual({ loading: null, error: null })
    expect(readLoadState(el('<div data-montaj-loading="3D scene"></div>'))).toEqual({ loading: '3D scene', error: null })
    expect(readLoadState(el('<div data-montaj-load-error="3D scene"></div><div data-montaj-loading="3D scene"></div>'))).toEqual({ loading: '3D scene', error: null })
    expect(readLoadState(el('<div data-montaj-load-error="3D scene"></div>'))).toEqual({ loading: null, error: '3D scene' })
    expect(readLoadState(el('<div data-montaj-loading=""></div>'))).toEqual({ loading: 'overlay', error: null })
  })
})

function Host({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} data-testid="frame">
      {children}
      <LoadingCover containerRef={ref} />
    </div>
  )
}

describe('LoadingCover', () => {
  it('covers while an overlay loads, clears on its first frame, and a failure is a small label with no spinner', async () => {
    render(<Host><div data-testid="stage" data-montaj-loading="3D scene" /></Host>)
    const cover = await screen.findByTestId('preview-loading-cover')
    expect(cover.textContent).toBe('Loading 3D scene…')
    expect(cover.className).toContain('bg-black')
    expect(cover.querySelector('.animate-spin')).not.toBeNull()
    expect(cover.getAttribute('role')).toBe('status')
    expect(cover.className).toContain('pointer-events-none')

    // The stage drew its first frame: it drops the attribute and the cover goes.
    await act(async () => { screen.getByTestId('stage').removeAttribute('data-montaj-loading') })
    expect(screen.queryByTestId('preview-loading-cover')).toBeNull()

    // A failed load: a label, never the cover or a spinner.
    await act(async () => { screen.getByTestId('stage').setAttribute('data-montaj-load-error', '3D scene') })
    const failed = screen.getByTestId('preview-load-error')
    expect(failed.textContent).toBe("Couldn't load the 3D scene")
    expect(failed.className).not.toContain('bg-black ')
    expect(failed.querySelector('.animate-spin')).toBeNull()
    expect(screen.queryByTestId('preview-loading-cover')).toBeNull()
  })

  it('an overlay that mounts already loading is covered at once; one that unmounts takes the cover with it', async () => {
    const { rerender } = render(<Host />)
    expect(screen.queryByTestId('preview-loading-cover')).toBeNull()
    rerender(<Host><div data-montaj-loading="3D scene" /></Host>)
    await screen.findByTestId('preview-loading-cover')
    rerender(<Host />)
    await act(async () => {})
    expect(screen.queryByTestId('preview-loading-cover')).toBeNull()
  })
})

// The real PreviewPlayer: the overlay layer and the captions are stand-ins, so what is on top is what this checks.
const stage = vi.hoisted(() => ({ mark: 'loading' as 'loading' | 'error' | 'ready' }))
vi.mock('../OverlayItemsLayer', () => ({
  default: () => (
    <div style={{ position: 'absolute', zIndex: 12 }} data-testid="overlay-3d"
      {...(stage.mark === 'loading' ? { 'data-montaj-loading': '3D scene' } : stage.mark === 'error' ? { 'data-montaj-load-error': '3D scene' } : {})} />
  ),
}))
vi.mock('../CaptionPreview', () => ({ default: () => <div data-testid="caption" style={{ position: 'absolute', zIndex: 45 }}>HAVE YOU EVER WONDERED</div> }))

const clip = { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0 } as unknown as VisualItem
const project = {
  id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [[clip]],
  captions: { style: 'word', segments: [{ start: 0, end: 2, text: 'HAVE YOU EVER WONDERED' }] },
} as unknown as Project
const player = () => <PreviewPlayer project={project} clock={createPlaybackClock(0)} compileOverlay={async () => (() => null) as never} fileUrl={(p) => p} />

describe('PreviewPlayer: a 3D scene loading at the playhead', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {})
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
      state = 'running'
      createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
      createMediaElementSource() { return { connect() {}, disconnect() {} } }
      get destination() { return {} }
      close() {}
    }
  })
  afterEach(() => { vi.restoreAllMocks(); stage.mark = 'loading' })

  it('covers the captions and the overlays with the label until the scene draws, inside the preview frame', async () => {
    stage.mark = 'loading'
    const { container, rerender } = render(player())
    const cover = await screen.findByTestId('preview-loading-cover')
    const frame = container.querySelector('[data-montaj-preview-frame]')!
    expect(frame.contains(cover)).toBe(true)
    expect(Number(cover.style.zIndex)).toBe(LOADING_COVER_Z)
    expect(Number(cover.style.zIndex)).toBeGreaterThan(Number(screen.getByTestId('caption').style.zIndex))
    expect(Number(cover.style.zIndex)).toBeGreaterThan(Number(screen.getByTestId('overlay-3d').style.zIndex))
    // The 3D overlay stays mounted underneath, so it keeps loading.
    expect(frame.contains(screen.getByTestId('overlay-3d'))).toBe(true)

    stage.mark = 'ready'
    rerender(player())
    await act(async () => {})
    expect(screen.queryByTestId('preview-loading-cover')).toBeNull()
    expect(screen.getByTestId('caption').textContent).toBe('HAVE YOU EVER WONDERED')
  })

  it('a scene that cannot load says so and uncovers the rest', async () => {
    stage.mark = 'error'
    render(player())
    expect((await screen.findByTestId('preview-load-error')).textContent).toBe("Couldn't load the 3D scene")
    expect(screen.queryByTestId('preview-loading-cover')).toBeNull()
  })
})
