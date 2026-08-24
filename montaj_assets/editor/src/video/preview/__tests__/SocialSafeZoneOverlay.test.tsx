/// <reference types="vitest/globals" />
/**
 * SocialSafeZoneOverlay is a preview-only viewing aid (see the file-level
 * doc comment on the component) — these tests cover exactly what the spec
 * calls out: the chrome renders for a recognized platform, renders nothing
 * for an absent/unrecognized one, stays pointer-events-none throughout, and
 * scales off a measured container size rather than a fixed pixel value.
 *
 * jsdom does no layout, so ResizeObserver never fires on its own — each test
 * installs a controllable stub (mirrors the pattern in
 * `src/video/__tests__/captionPositioning.test.tsx`) that reports a size the
 * test chooses, and can re-fire with a different size mid-test.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import SocialSafeZoneOverlay from '../SocialSafeZoneOverlay'

afterEach(() => {
  cleanup()
})

/** Installs a ResizeObserver stub that reports `initial` the moment
 *  `observe()` is called, and returns a `fire` helper to report a different
 *  size later — e.g. simulating a pane drag or fullscreen toggle. */
function installResizeObserver(initial: { width: number; height: number }) {
  let cb: ((entries: { contentRect: { width: number; height: number } }[]) => void) | null = null
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(callback: typeof cb) { cb = callback }
    observe() { cb?.([{ contentRect: initial }]) }
    unobserve() {}
    disconnect() {}
  }
  return { fire: (width: number, height: number) => cb?.([{ contentRect: { width, height } }]) }
}

describe('SocialSafeZoneOverlay — activation', () => {
  it('renders nothing when no platform is given', () => {
    installResizeObserver({ width: 1080, height: 1920 })
    const { container } = render(<SocialSafeZoneOverlay />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for an unrecognized platform', () => {
    installResizeObserver({ width: 1080, height: 1920 })
    const { container } = render(<SocialSafeZoneOverlay platform="reels" />)
    expect(container.firstChild).toBeNull()
  })
})

describe('SocialSafeZoneOverlay — TikTok chrome', () => {
  it('renders the status bar, nav row, engagement rail and bottom-left credit block', () => {
    installResizeObserver({ width: 1080, height: 1920 })
    const { getByText, getAllByText } = render(<SocialSafeZoneOverlay platform="tiktok" />)

    // Status bar
    expect(getByText('9:41')).toBeTruthy()

    // Nav row — For You is the active tab
    expect(getByText('Explore')).toBeTruthy()
    expect(getByText('Following')).toBeTruthy()
    expect(getByText('For You')).toBeTruthy()

    // Right rail — one avatar + four counted actions, each labeled 2.8M
    expect(getAllByText('2.8M')).toHaveLength(4)

    // Bottom-left credit block
    expect(getByText('Your name')).toBeTruthy()
    expect(getByText('Here are some descriptions about videos')).toBeTruthy()
    expect(getByText('See original')).toBeTruthy()
  })

  it('never uses an em dash in its copy', () => {
    installResizeObserver({ width: 1080, height: 1920 })
    const { getByTestId } = render(<SocialSafeZoneOverlay platform="tiktok" />)
    expect(getByTestId('social-safe-zone-overlay').textContent).not.toContain('—')
  })
})

describe('SocialSafeZoneOverlay — never steals a click', () => {
  it('the root layer is pointer-events-none', () => {
    installResizeObserver({ width: 1080, height: 1920 })
    const { getByTestId } = render(<SocialSafeZoneOverlay platform="tiktok" />)
    const root = getByTestId('social-safe-zone-overlay')
    expect(root.className).toContain('pointer-events-none')
  })
})

describe('SocialSafeZoneOverlay — scales with its container, not a fixed pixel size', () => {
  it('a container matching the 1080×1920 design canvas scales 1:1', () => {
    installResizeObserver({ width: 1080, height: 1920 })
    const { getByTestId } = render(<SocialSafeZoneOverlay platform="tiktok" />)
    expect(getByTestId('social-safe-zone-canvas').style.transform).toContain('scale(1)')
  })

  it('a half-size container halves the scale, proportionally, not to a fixed px value', () => {
    const ro = installResizeObserver({ width: 1080, height: 1920 })
    const { getByTestId } = render(<SocialSafeZoneOverlay platform="tiktok" />)
    const canvas = getByTestId('social-safe-zone-canvas')
    expect(canvas.style.transform).toContain('scale(1)')

    act(() => { ro.fire(540, 960) })
    expect(canvas.style.transform).toContain('scale(0.5)')
  })

  it('a landscape (non-vertical) container contain-fits instead of overflowing', () => {
    // 16:9 landscape box: the design canvas is scaled by the SMALLER of the
    // two axis ratios (height-bound here) so the whole 1080×1920 chrome
    // stays inside the box on both axes rather than spilling past its
    // narrower dimension — the "does not break or overflow" degrade for a
    // non-vertical preview.
    installResizeObserver({ width: 1920, height: 1080 })
    const { getByTestId } = render(<SocialSafeZoneOverlay platform="tiktok" />)
    const canvas = getByTestId('social-safe-zone-canvas')
    const expectedScale = Math.min(1920 / 1080, 1080 / 1920)
    expect(canvas.style.transform).toContain(`scale(${expectedScale})`)

    const root = getByTestId('social-safe-zone-overlay')
    expect(root.className).toContain('overflow-hidden')
  })
})
