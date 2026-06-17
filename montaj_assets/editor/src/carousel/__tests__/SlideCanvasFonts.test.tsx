import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type { OverlayElement, Slide } from '../../types'

// Spy on the shared font loader so we can assert the carousel overlay path
// invokes it with the element's googleFonts list (unit-level — we do not assert
// actual font bytes load in jsdom).
const { ensureGoogleFontsLoaded } = vi.hoisted(() => ({ ensureGoogleFontsLoaded: vi.fn() }))
vi.mock('../../lib/google-fonts', () => ({ ensureGoogleFontsLoaded }))

import SlideCanvas from '../SlideCanvas'

beforeEach(() => {
  ensureGoogleFontsLoaded.mockClear()
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
afterEach(() => vi.restoreAllMocks())

function makeSlide(el: OverlayElement): Slide {
  return { id: 'slide-0', base_color: '#ffffff', elements: [el] }
}

describe('SlideCanvas carousel overlay Google Fonts', () => {
  it('loads an overlay element’s googleFonts via the shared helper', async () => {
    const el: OverlayElement = {
      id: 'el-ov',
      type: 'overlay',
      overlay: { template: '/overlays/lp-text.jsx', props: { text: 'Hola' } },
      frame: 0,
      x: 0,
      y: 0,
      w: 400,
      h: 120,
      rotation: 0,
      googleFonts: ['Syne:wght@800', 'Inter:wght@400'],
    }
    render(
      <SlideCanvas
        slide={makeSlide(el)}
        width={1080}
        height={1080}
        interactive={false}
        scale={1}
        compileOverlay={vi.fn(async () => () => null)}
      />,
    )

    await waitFor(() =>
      expect(ensureGoogleFontsLoaded).toHaveBeenCalledWith(['Syne:wght@800', 'Inter:wght@400']),
    )
  })

  it('does not throw when an overlay element has no googleFonts', async () => {
    const el: OverlayElement = {
      id: 'el-ov',
      type: 'overlay',
      overlay: { template: '/overlays/lp-text.jsx', props: { text: 'Hola' } },
      frame: 0,
      x: 0,
      y: 0,
      w: 400,
      h: 120,
      rotation: 0,
    }
    render(
      <SlideCanvas
        slide={makeSlide(el)}
        width={1080}
        height={1080}
        interactive={false}
        scale={1}
        compileOverlay={vi.fn(async () => () => null)}
      />,
    )
    // Helper is still invoked (with undefined) — it no-ops internally.
    await waitFor(() => expect(ensureGoogleFontsLoaded).toHaveBeenCalledWith(undefined))
  })
})
