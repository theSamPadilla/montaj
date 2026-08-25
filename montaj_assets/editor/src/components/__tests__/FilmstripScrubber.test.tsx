/// <reference types="vitest/globals" />
/**
 * FilmstripScrubber — smoke test. jsdom has no 2D canvas and never fires a
 * real `Image` load event, so both are stubbed (same shape as
 * `TimelineCanvas.test.tsx`'s recorder and `ReadOnlySlide.test.tsx`'s
 * ResizeObserver mock). What matters here: the index is fetched exactly once
 * with `{ projectId, src: proxySrc }`, the component renders a canvas without
 * throwing, and a resolved index eventually clears the loading state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, cleanup, fireEvent } from '@testing-library/react'
import type { FilmstripIndex } from '../../types'
import FilmstripScrubber from '../FilmstripScrubber'

let realGetContext: typeof HTMLCanvasElement.prototype.getContext
let realGetRect: typeof Element.prototype.getBoundingClientRect
let realImage: typeof Image

const drawImageCalls: unknown[][] = []

class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 320
  naturalHeight = 320
  width = 320
  height = 320
  private _src = ''
  get src() { return this._src }
  set src(v: string) {
    this._src = v
    // Simulate an async decode, same as a real <img> firing `load` later.
    queueMicrotask(() => this.onload?.())
  }
}

beforeEach(() => {
  drawImageCalls.length = 0

  realGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function () {
    return {
      clearRect: () => {},
      drawImage: (...args: unknown[]) => { drawImageCalls.push(args) },
    } as unknown as CanvasRenderingContext2D
  } as unknown as typeof HTMLCanvasElement.prototype.getContext

  realGetRect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 120, width: 200, height: 120, toJSON: () => ({}) } as DOMRect
  }

  realImage = globalThis.Image
  ;(globalThis as unknown as { Image: unknown }).Image = FakeImage
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  HTMLCanvasElement.prototype.getContext = realGetContext
  Element.prototype.getBoundingClientRect = realGetRect
  ;(globalThis as unknown as { Image: unknown }).Image = realImage
})

const fakeIndex: FilmstripIndex = {
  sheets: [{
    path: 'proj1/filmstrips/proxy-0.jpg',
    cols: 2,
    rows: 1,
    tiles: [{ t: 0, row: 0, col: 0 }, { t: 5, row: 0, col: 1 }],
  }],
  interval: 5,
  tileWidth: 160,
}

describe('FilmstripScrubber', () => {
  it('fetches the filmstrip index once with { projectId, src: proxySrc } and renders a canvas', async () => {
    const getFilmstrip = vi.fn().mockResolvedValue(fakeIndex)
    const fileUrl = vi.fn((path: string) => `https://cdn.example/${path}`)

    const { container } = render(
      <FilmstripScrubber
        projectId="proj1"
        proxySrc="proxy.mp4"
        sourceDuration={10}
        getFilmstrip={getFilmstrip}
        fileUrl={fileUrl}
      />,
    )

    expect(getFilmstrip).toHaveBeenCalledTimes(1)
    expect(getFilmstrip).toHaveBeenCalledWith({ projectId: 'proj1', src: 'proxy.mp4' })

    const canvas = container.querySelector('canvas')
    expect(canvas).toBeTruthy()

    // Poster frame paints once the index resolves and the sheet image decodes.
    await waitFor(() => expect(drawImageCalls.length).toBeGreaterThan(0))
    expect(fileUrl).toHaveBeenCalledWith('proj1/filmstrips/proxy-0.jpg')

    // The loading placeholder is gone once the index has resolved.
    await waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull())
  })

  it('does not crash and shows a neutral state when getFilmstrip rejects', async () => {
    const getFilmstrip = vi.fn().mockRejectedValue(new Error('no filmstrip'))
    const fileUrl = vi.fn((path: string) => path)

    const { container } = render(
      <FilmstripScrubber
        projectId="proj1"
        proxySrc="proxy.mp4"
        sourceDuration={10}
        getFilmstrip={getFilmstrip}
        fileUrl={fileUrl}
      />,
    )

    expect(container.querySelector('canvas')).toBeTruthy()
    await waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toBe('No preview'))
  })

  it('re-fetches when proxySrc changes but not on a mere callback-identity change', async () => {
    const getFilmstrip = vi.fn().mockResolvedValue(fakeIndex)
    const fileUrl = (path: string) => path

    const { rerender } = render(
      <FilmstripScrubber
        projectId="proj1"
        proxySrc="proxy-a.mp4"
        sourceDuration={10}
        getFilmstrip={getFilmstrip}
        fileUrl={fileUrl}
      />,
    )
    await waitFor(() => expect(getFilmstrip).toHaveBeenCalledTimes(1))

    // Fresh closure identity, same proxySrc: must NOT trigger a re-fetch.
    const getFilmstrip2 = vi.fn().mockResolvedValue(fakeIndex)
    rerender(
      <FilmstripScrubber
        projectId="proj1"
        proxySrc="proxy-a.mp4"
        sourceDuration={10}
        getFilmstrip={getFilmstrip2}
        fileUrl={fileUrl}
      />,
    )
    expect(getFilmstrip2).not.toHaveBeenCalled()

    // A real proxySrc change fetches again (via whichever callback is current).
    rerender(
      <FilmstripScrubber
        projectId="proj1"
        proxySrc="proxy-b.mp4"
        sourceDuration={10}
        getFilmstrip={getFilmstrip2}
        fileUrl={fileUrl}
      />,
    )
    await waitFor(() => expect(getFilmstrip2).toHaveBeenCalledWith({ projectId: 'proj1', src: 'proxy-b.mp4' }))
  })

  it('attaches no scrub handler when interactive={false}', async () => {
    const getFilmstrip = vi.fn().mockResolvedValue(fakeIndex)
    const fileUrl = (path: string) => path

    const { container } = render(
      <FilmstripScrubber
        projectId="proj1"
        proxySrc="proxy.mp4"
        sourceDuration={10}
        getFilmstrip={getFilmstrip}
        fileUrl={fileUrl}
        interactive={false}
      />,
    )

    const canvas = container.querySelector('canvas')!
    // The static poster still paints once the index/sheet resolve.
    await waitFor(() => expect(drawImageCalls.length).toBeGreaterThan(0))
    const afterPoster = drawImageCalls.length

    // A pointer move must NOT scrub (no handler attached) — no extra draw.
    fireEvent.pointerMove(canvas, { clientX: 150 })
    expect(drawImageCalls.length).toBe(afterPoster)
  })

  it('letterboxes the poster when fit="contain"', async () => {
    const getFilmstrip = vi.fn().mockResolvedValue(fakeIndex)
    const fileUrl = (path: string) => path

    render(
      <FilmstripScrubber
        projectId="proj1"
        proxySrc="proxy.mp4"
        sourceDuration={10}
        getFilmstrip={getFilmstrip}
        fileUrl={fileUrl}
        interactive={false}
        fit="contain"
      />,
    )

    await waitFor(() => expect(drawImageCalls.length).toBeGreaterThan(0))
    const last = drawImageCalls[drawImageCalls.length - 1]
    // Canvas is 200×120 (mocked rect, dpr 1). The poster tile is one column of a
    // 320×320 two-col sheet → a 160×320 portrait rect (aspect 0.5). Contained in
    // the landscape canvas it pillarboxes to a 60×120 box centered at x=70.
    // args = [image, sx, sy, sw, sh, destX, destY, destW, destH].
    expect(last[7]).toBe(60)  // dest width
    expect(last[8]).toBe(120) // dest height
    expect(last[5]).toBe(70)  // dest x (centered)
    expect(last[6]).toBe(0)   // dest y
  })
})
