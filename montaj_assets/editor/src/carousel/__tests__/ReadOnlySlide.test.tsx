import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type { ImageElement, OverlayElement, Slide } from '../../types'
import ReadOnlySlide from '../ReadOnlySlide'

// ── ResizeObserver mock plumbing ──────────────────────────────────────────────
// jsdom has no ResizeObserver. We capture the instances so autoFit tests can
// drive a callback with a controlled parent size.
let roInstances: Array<{ cb: ResizeObserverCallback; el: Element | null }> = []
beforeEach(() => {
  roInstances = []
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    cb: ResizeObserverCallback
    el: Element | null = null
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb
      roInstances.push(this)
    }
    observe(el: Element) {
      this.el = el
    }
    unobserve() {}
    disconnect() {}
  }
})
afterEach(() => vi.restoreAllMocks())

const imgEl: ImageElement = {
  id: 'el-img',
  type: 'image',
  src: 'a.png',
  x: 100,
  y: 100,
  w: 200,
  h: 200,
  rotation: 0,
}

const overlayEl: OverlayElement = {
  id: 'el-ov',
  type: 'overlay',
  overlay: { template: '/overlays/lp-text.jsx', props: { text: 'Hola' } },
  frame: 0,
  x: 50,
  y: 800,
  w: 400,
  h: 120,
  rotation: 0,
}

function makeSlide(elements: Slide['elements']): Slide {
  return { id: 'slide-0', base_color: '#ffffff', elements }
}

describe('ReadOnlySlide', () => {
  it("renders a slide's image + overlay non-interactively (no interactive chrome)", async () => {
    const { container } = render(
      <ReadOnlySlide
        slide={makeSlide([imgEl, overlayEl])}
        width={1080}
        height={1080}
        scale={0.5}
        resolveImageSrc={(el) => el.src}
        compileOverlay={vi.fn(async () => () => null)}
      />,
    )

    // Image element renders.
    const img = await waitFor(() => {
      const el = container.querySelector('[data-element-id="el-img"]') as HTMLElement
      if (!el) throw new Error('image wrapper not yet rendered')
      return el
    })

    // Non-interactive: the canvas root must not advertise interactivity, and the
    // element wrappers must not receive pointer events (no selection chrome).
    expect(container.querySelector('[data-interactive]')).toBeNull()
    expect(img.style.pointerEvents).toBe('none')

    // No resize / rotate handles rendered in read-only mode.
    expect(container.querySelector('[data-testid="rotate-handle"]')).toBeNull()
    expect(container.querySelector('[data-testid="resize-handle-nw"]')).toBeNull()
  })

  it('applies the explicit scale when provided', async () => {
    const { container } = render(
      <ReadOnlySlide
        slide={makeSlide([imgEl])}
        width={1080}
        height={1080}
        scale={0.5}
        resolveImageSrc={(el) => el.src}
      />,
    )
    // displayW = width * scale = 1080 * 0.5 = 540.
    await waitFor(() => {
      const inner = container.querySelector('[data-element-id="el-img"]') as HTMLElement
      if (!inner) throw new Error('not rendered')
    })
    const canvas = container.querySelector('div > div') as HTMLElement
    // The SlideCanvas root sets width to displayW; find a node sized 540px.
    const sized = Array.from(container.querySelectorAll('div')).some(
      (d) => (d as HTMLElement).style.width === '540px',
    )
    expect(sized).toBe(true)
    expect(canvas).toBeTruthy()
  })

  it('measures the parent and applies a fitted scale when autoFit is on', async () => {
    const { container } = render(
      <ReadOnlySlide
        slide={makeSlide([imgEl])}
        width={1080}
        height={1080}
        autoFit
        resolveImageSrc={(el) => el.src}
      />,
    )

    // A ResizeObserver was created and is observing the root.
    await waitFor(() => expect(roInstances.length).toBeGreaterThan(0))
    const ro = roInstances[0]
    expect(ro.el).not.toBeNull()

    // Drive the observer: parent of the root is 540x540 → fit = 540/1080 = 0.5.
    const root = ro.el as HTMLElement
    Object.defineProperty(root, 'clientWidth', { value: 540, configurable: true })
    Object.defineProperty(root, 'clientHeight', { value: 540, configurable: true })
    ro.cb([], ro as unknown as ResizeObserver)

    // After measuring, SlideCanvas renders at displayW = 1080 * 0.5 = 540.
    await waitFor(() => {
      const sized = Array.from(container.querySelectorAll('div')).some(
        (d) => (d as HTMLElement).style.width === '540px',
      )
      expect(sized).toBe(true)
    })
  })
})
