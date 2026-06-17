import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type { ImageElement, Slide } from '../../types'
import SlideCanvas from '../SlideCanvas'

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
afterEach(() => vi.restoreAllMocks())

function makeSlide(el: ImageElement): Slide {
  return { id: 'slide-0', base_color: '#ffffff', elements: [el] }
}

describe('SlideCanvas crop display', () => {
  it('renders the oversized-cover crop variant when element.crop is present (non-interactive)', async () => {
    const el: ImageElement = {
      id: 'el-img',
      type: 'image',
      src: 'a.png',
      x: 0,
      y: 0,
      w: 200,
      h: 200,
      rotation: 0,
      crop: { x: 0.25, y: 0.1, w: 0.5, h: 0.5 },
    }
    const { container } = render(
      <SlideCanvas
        slide={makeSlide(el)}
        width={1080}
        height={1080}
        interactive={false}
        scale={1}
        resolveImageSrc={(e) => e.src}
      />,
    )

    const img = await waitFor(() => {
      const found = container.querySelector('[data-element-id="el-img"] img') as HTMLImageElement
      if (!found) throw new Error('img not rendered')
      return found
    })

    // Oversized cover: width = 100/cw = 200%, height = 100/ch = 200%.
    expect(img.style.width).toBe('200%')
    expect(img.style.height).toBe('200%')
    // marginLeft = -cx*100/cw = -0.25*100/0.5 = -50%; marginTop = -0.1*100/0.5 = -20%.
    expect(img.style.marginLeft).toBe('-50%')
    expect(img.style.marginTop).toBe('-20%')
    // Tailwind-preflight defeat.
    expect(img.style.maxWidth).toBe('none')
    expect(img.style.maxHeight).toBe('none')

    // The crop wrapper clips overflow.
    const wrapper = img.parentElement as HTMLElement
    expect(wrapper.style.overflow).toBe('hidden')
  })

  it('renders plain contain (no crop wrapper) when element.crop is absent', async () => {
    const el: ImageElement = {
      id: 'el-img',
      type: 'image',
      src: 'a.png',
      x: 0,
      y: 0,
      w: 200,
      h: 200,
      rotation: 0,
    }
    const { container } = render(
      <SlideCanvas
        slide={makeSlide(el)}
        width={1080}
        height={1080}
        interactive={false}
        scale={1}
        resolveImageSrc={(e) => e.src}
      />,
    )

    const img = await waitFor(() => {
      const found = container.querySelector('[data-element-id="el-img"] img') as HTMLImageElement
      if (!found) throw new Error('img not rendered')
      return found
    })
    // Uncropped images use `contain` to mirror the renderer (no-crop branch in
    // render/templates/slide.jsx) so logos/escudos keep aspect in both paths.
    expect(img.style.objectFit).toBe('contain')
    expect(img.style.width).toBe('100%')
    expect(img.style.height).toBe('100%')
  })
})
