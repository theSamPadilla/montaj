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

const clip = { id: 'v-0', type: 'video', src: 'a.mp4', start: 0, end: 4, sourceWidth: 1920, sourceHeight: 1080 } as VisualItem

describe('crop tool, video mode (PV55 phase 2)', () => {
  it('a keyed video crop locks to the keys pixel aspect: <video> stays, shape choices go', () => {
    const { container } = render(<VideoSourceCropModal item={clip} resolveSrc={() => 'a.mp4'} lockAspect={1}
      initialCrop={{ x: 0.1, y: 0, w: 0.5625, h: 1 }} onApply={vi.fn()} onSrcDimsLoaded={vi.fn()} onClose={vi.fn()} />)
    expect(container.querySelector('video')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Free|1:1|16:9|9:16/ })).toBeNull()
    // corner handles only: the aspect is locked
    expect(screen.queryByTestId('crop-handle-n')).toBeNull()
    expect(screen.getByTestId('crop-handle-se')).toBeTruthy()
  })
  it('opens on initialCrop untrimmed (a video contain-fits its crop)', () => {
    const onApply = vi.fn()
    render(<VideoSourceCropModal item={clip} resolveSrc={() => 'a.mp4'} lockAspect={1}
      initialCrop={{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }} onApply={onApply} onSrcDimsLoaded={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Apply crop' }))
    const c = onApply.mock.calls[0][0]
    expect([c.x, c.y, c.w, c.h]).toEqual([0.1, 0.2, 0.3, 0.4])
  })
  it('an unkeyed video keeps the shape choices', () => {
    render(<VideoSourceCropModal item={clip} resolveSrc={() => 'a.mp4'} onApply={vi.fn()} onSrcDimsLoaded={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Free/ })).toBeTruthy()
  })
})
