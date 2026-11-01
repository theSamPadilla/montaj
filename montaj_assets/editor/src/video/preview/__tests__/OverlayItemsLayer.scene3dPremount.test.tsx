/// <reference types="vitest/globals" />
import { render, cleanup } from '@testing-library/react'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import OverlayItemsLayer from '../OverlayItemsLayer'
import LoadingCover, { readLoadState } from '../LoadingCover'

afterEach(cleanup)

// A 3D scene item (overlay, src engine:scene3d) is presented in [start - 1.5, end + 0.5), hidden outside
// [start, end); a video keeps its 0.4 s pre-roll.
const project = { id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [[]] } as unknown as EditorProject
const snap = { x: false, y: false, left: false, right: false, top: false, bottom: false }
const factory: OverlayFactory = (frame) => <span data-testid="probe" data-frame={frame} />
const compileOverlay = async () => factory
const scene = { id: 's1', type: 'overlay', src: 'engine:scene3d', start: 10, end: 14, props: {} } as unknown as VisualItem
const video = { id: 'v1', type: 'video', src: '/m/b.mp4', start: 10, end: 14 } as unknown as VisualItem

function layer(t: number, items: VisualItem[], extra: { holdTime?: number; selected?: string } = {}) {
  return (
    <OverlayItemsLayer
      project={project} currentTime={t} holdTime={extra.holdTime} isPlaying={false} isCanvasProject={false}
      overlayTracks={[items]} tracks0NonVideo={[]} renderScale={0.2} selectedOverlayId={extra.selected}
      onOverlayChange={vi.fn()} onEditOverlay={vi.fn()} containerRef={{ current: document.createElement('div') }}
      dragState={null} setDragState={vi.fn()} liveOffset={null} liveScale={null} liveRotation={null}
      snapGuides={snap} snapRotation={null} compileOverlay={compileOverlay} fileUrl={(p: string) => p}
    />
  )
}

const wrapper = (c: HTMLElement) => c.querySelector('[data-montaj-premount]') as HTMLElement | null

describe('a 3D scene item pre-mounts', () => {
  it('mounts hidden 1.5 s before its start, on frame 0, inert', async () => {
    const { container, findByTestId } = render(layer(8.5, [scene], { selected: 's1' }))
    const probe = await findByTestId('probe')
    expect(probe.getAttribute('data-frame')).toBe('0')
    const w = wrapper(container)!
    expect(w).not.toBeNull()
    expect(w.style.opacity).toBe('0')
    expect(w.style.visibility).toBe('hidden')
    expect(w.className).toContain('pointer-events-none')
    expect(w.style.outline).toBe('')
    expect(container.querySelectorAll('[class*="cursor-"]').length).toBe(0)
  })

  it('is not mounted earlier than that', () => {
    const { container } = render(layer(8.4, [scene]))
    expect(container.querySelector('[data-montaj-premount]')).toBeNull()
    expect(container.querySelector('[data-testid="probe"]')).toBeNull()
  })

  it('is shown normally inside its span, with no premount mark', async () => {
    const { container, findByTestId } = render(layer(11, [scene]))
    expect((await findByTestId('probe')).getAttribute('data-frame')).toBe('30')
    expect(wrapper(container)).toBeNull()
    expect((container.firstElementChild as HTMLElement).style.visibility).toBe('')
  })

  it('stays mounted hidden until 0.5 s after its end, on its last frame, then unmounts', async () => {
    const { container, findByTestId, rerender } = render(layer(14.4, [scene]))
    expect((await findByTestId('probe')).getAttribute('data-frame')).toBe('119')
    expect(wrapper(container)).not.toBeNull()
    rerender(layer(14.5, [scene]))
    expect(container.querySelector('[data-testid="probe"]')).toBeNull()
  })

  it('a video keeps its 0.4 s pre-roll', () => {
    const { container, rerender } = render(layer(9.5, [video]))
    expect(container.querySelector('video')).toBeNull()
    rerender(layer(9.7, [video]))
    expect(container.querySelector('video')).not.toBeNull()
    expect(wrapper(container)).toBeNull()
  })

  it('hover time does not unmount a scene mounted at the playhead', async () => {
    const { container, findByTestId, rerender } = render(layer(11, [scene]))
    await findByTestId('probe')
    rerender(layer(2, [scene], { holdTime: 11 }))
    expect(container.querySelector('[data-testid="probe"]')).not.toBeNull()
    expect(wrapper(container)).not.toBeNull() // hidden: hover time is outside its span
    rerender(layer(2, [scene]))
    expect(container.querySelector('[data-testid="probe"]')).toBeNull()
  })
})

describe('loading markers in a pre-mounted item', () => {
  it('readLoadState ignores them, and counts them once the item is visible', () => {
    const root = document.createElement('div')
    root.innerHTML = '<div data-montaj-premount=""><i data-montaj-loading="3D scene"></i></div>'
    expect(readLoadState(root)).toEqual({ loading: null, error: null })
    root.innerHTML = '<div data-montaj-premount=""><i data-montaj-loading="a"></i></div><b data-montaj-loading="b"></b>'
    expect(readLoadState(root).loading).toBe('b')
    root.firstElementChild!.removeAttribute('data-montaj-premount')
    expect(readLoadState(root).loading).toBe('a')
  })

  it('the cover appears when the hidden item becomes visible', async () => {
    const { render: r, act, screen } = await import('@testing-library/react').then((m) => ({ render: m.render, act: m.act, screen: m.screen }))
    const root = document.createElement('div')
    root.innerHTML = '<div id="w" data-montaj-premount=""><i data-montaj-loading="3D scene"></i></div>'
    document.body.appendChild(root)
    r(<LoadingCover containerRef={{ current: root }} />)
    await act(async () => {})
    expect(screen.queryByTestId('preview-loading-cover')).toBeNull()
    await act(async () => { root.querySelector('#w')!.removeAttribute('data-montaj-premount') })
    expect(screen.getByTestId('preview-loading-cover')).not.toBeNull()
    root.remove()
  })
})
