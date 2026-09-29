/// <reference types="vitest/globals" />
import { render, screen, fireEvent } from '@testing-library/react'
import type { VisualItem } from '../../schema'
import { VideoSourceCropModal } from '../VideoSourceCropModal'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    cb: ResizeObserverCallback
    constructor(cb: ResizeObserverCallback) { this.cb = cb }
    observe() { this.cb([{ contentRect: { width: 800, height: 450 } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
    disconnect() {}
  })
})
afterEach(() => vi.unstubAllGlobals())

const still = { id: 'img-0', type: 'image', src: 'photo.jpg', start: 0, end: 4 } as VisualItem
function load(img: HTMLImageElement, w: number, h: number) {
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: w })
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: h })
  fireEvent.load(img)
}

describe('crop tool, still mode (PV55)', () => {
  it('draws the photo, not a <video>, with no shape choices and no subtitle', () => {
    const { container } = render(<VideoSourceCropModal item={still} resolveSrc={() => 'photo.jpg'} lockAspect={9 / 16}
      onApply={vi.fn()} onSrcDimsLoaded={vi.fn()} onClose={vi.fn()} />)
    expect(container.querySelector('img')).toBeTruthy()
    expect(container.querySelector('video')).toBeNull()
    expect(screen.queryByRole('button', { name: /Free|1:1|16:9|9:16/ })).toBeNull()
    expect(screen.queryByText(/Position and zoom live on the canvas/)).toBeNull()
  })
  it('opens on what the box shows: the full frame trimmed to the box shape', () => {
    const onApply = vi.fn()
    const { container } = render(<VideoSourceCropModal item={still} resolveSrc={() => 'photo.jpg'} lockAspect={9 / 16}
      onApply={onApply} onSrcDimsLoaded={vi.fn()} onClose={vi.fn()} />)
    load(container.querySelector('img')!, 2696, 1524)
    fireEvent.click(screen.getByRole('button', { name: 'Apply crop' }))
    const c = onApply.mock.calls[0][0]
    expect(c.h).toBeCloseTo(1, 9)
    expect(c.w).toBeCloseTo((1524 * 9) / 16 / 2696, 9)
    expect(c.x).toBeCloseTo((1 - c.w) / 2, 9)
  })
  it('opens on initialCrop when given (the crop at the playhead)', () => {
    const onApply = vi.fn()
    const at = { x: 0.6, y: 0, w: (1524 * 9) / 16 / 2696, h: 1 }
    const { container } = render(<VideoSourceCropModal item={still} resolveSrc={() => 'photo.jpg'} lockAspect={9 / 16}
      initialCrop={at} onApply={onApply} onSrcDimsLoaded={vi.fn()} onClose={vi.fn()} />)
    load(container.querySelector('img')!, 2696, 1524)
    fireEvent.click(screen.getByRole('button', { name: 'Apply crop' }))
    const c = onApply.mock.calls[0][0]
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(c[k]).toBeCloseTo(at[k], 9)
  })
  it('a video item is unchanged: <video> and the shape choices', () => {
    const { container } = render(<VideoSourceCropModal item={{ ...still, type: 'video', src: 'a.mp4' } as VisualItem}
      resolveSrc={() => 'a.mp4'} onApply={vi.fn()} onSrcDimsLoaded={vi.fn()} onClose={vi.fn()} />)
    expect(container.querySelector('video')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Free/ })).toBeTruthy()
  })
})
