// CaptionPreview.canvas.test.tsx
//
// The caption layer is laid out on the project's design canvas (the same
// 1080-short-edge canvas the overlays use and render.js captures captions at),
// not a fixed 1080×1920. With the fixed portrait canvas a 1920×1080 project
// got a layer ~1.78× too tall for the player: a `bottom: 25%` caption landed
// below the frame and the wrapper's overflow-hidden clipped it, so captions
// never showed in a landscape preview. The drag maths divided Y by 1920 too.
//
// jsdom does no layout, so the geometry is read off the layer's own inline
// styles (width, height, transform scale), which are exactly what the browser
// lays out from, and the ResizeObserver stub reports a fixed player size.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, fireEvent } from '@testing-library/react'
import type { ReactElement } from 'react'
import CaptionPreview from '../CaptionPreview'
import { captionDragGeometry } from '../captionDragState'
import type { Captions } from '../../../schema'
import type { OverlayFactory } from '../../../types'

vi.mock('../captionDragState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../captionDragState')>()
  return { ...actual, captionDragGeometry: vi.fn(actual.captionDragGeometry) }
})

// The on-screen player size the ResizeObserver stub reports. Set per test.
let player = { width: 0, height: 0 }

function fixedRect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    left, top, right, bottom,
    width: right - left, height: bottom - top,
    x: left, y: top,
    toJSON: () => ({}),
  } as DOMRect
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    cb: (entries: unknown[]) => void
    constructor(cb: (entries: unknown[]) => void) { this.cb = cb }
    observe() { this.cb([{ contentRect: { width: player.width, height: player.height } }]) }
    unobserve() {}
    disconnect() {}
  }
  // measureCaptionContentRect walks text nodes through Range, which jsdom
  // lacks; any rect inside the player will do, the box is not under test.
  Range.prototype.getBoundingClientRect = vi.fn(() => fixedRect(100, 100, 200, 120))
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => fixedRect(0, 0, player.width, player.height),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
})

/** Every template in render/templates/captions anchors its caption 25% up from
 *  the bottom of the box it is given; this one does the same. */
const BOTTOM_PCT = 25

const compileOverlay = vi.fn(async (): Promise<OverlayFactory> =>
  (frame: number, fps: number, _d: number, props: Record<string, unknown>): ReactElement | null => {
    const segments = props.segments as Captions['segments']
    const active = segments.find((s) => frame / fps >= s.start && frame / fps < s.end)
    if (!active) return null
    return (
      <div data-testid="anchor" style={{ position: 'absolute', left: 0, right: 0, bottom: `${BOTTOM_PCT}%` }}>
        <span>{active.text}</span>
      </div>
    )
  })

const track: Captions = {
  style: 'subtitle',
  segments: [{ id: 'cap-0', text: 'hello', start: 0, end: 2 }],
}

function mount(designCanvas: [number, number], onCaptionSegmentChange = vi.fn()) {
  return render(
    <CaptionPreview
      track={track}
      currentTime={1}
      fps={30}
      compileOverlay={compileOverlay}
      resolveCaptionTemplate={(style) => `/tpl/${style}.jsx`}
      onSelectCaption={vi.fn()}
      onCaptionSegmentChange={onCaptionSegmentChange}
      designCanvas={designCanvas}
    />,
  )
}

/** The scaled caption layer: its design size and its scale, as laid out. */
async function layerGeometry(container: HTMLElement) {
  await waitFor(() => expect(container.querySelector('[data-testid="anchor"]')).not.toBeNull())
  const anchor = container.querySelector('[data-testid="anchor"]') as HTMLElement
  const layer = anchor.parentElement as HTMLElement
  const scale = Number(/^scale\(([^)]+)\)$/.exec(layer.style.transform)?.[1])
  return { width: parseFloat(layer.style.width), height: parseFloat(layer.style.height), scale }
}

/** Drag the selection box by (dx, dy) screen px and return the committed patch. */
function drag(container: HTMLElement, onChange: ReturnType<typeof vi.fn>, dx: number, dy: number) {
  const box = (container.querySelector('[style*="z-index: 50"]') as HTMLElement).firstElementChild as HTMLElement
  fireEvent.mouseDown(box, { clientX: 300, clientY: 200 })
  fireEvent.mouseMove(document, { clientX: 300 + dx, clientY: 200 + dy })
  fireEvent.mouseUp(document)
  expect(onChange).toHaveBeenCalledTimes(1)
  return onChange.mock.calls[0][1]
}

describe('CaptionPreview — landscape (1920×1080 design canvas)', () => {
  beforeEach(() => { player = { width: 960, height: 540 } })

  it('lays the caption layer out at 1920×1080 design px, scaled by player width / 1920', async () => {
    const { container } = mount([1920, 1080])
    expect(await layerGeometry(container)).toEqual({ width: 1920, height: 1080, scale: 960 / 1920 })
  })

  it('a bottom-anchored caption sits inside the player, not below it', async () => {
    const { container } = mount([1920, 1080])
    const g = await layerGeometry(container)
    // The scaled layer IS the player box, so nothing anchored inside the
    // layer can fall outside the frame.
    expect(g.width * g.scale).toBe(player.width)
    expect(g.height * g.scale).toBe(player.height)
    const anchorY = g.height * (1 - BOTTOM_PCT / 100) * g.scale
    expect(anchorY).toBeGreaterThan(0)
    expect(anchorY).toBeLessThanOrEqual(player.height)
  })

  it('drags with renderW 1920 / renderH 1080: 10% of the frame on each axis is 10%', async () => {
    const onChange = vi.fn()
    const { container } = mount([1920, 1080], onChange)
    await layerGeometry(container)
    // 96 screen px of a 960-wide player and 54 of a 540-tall one.
    const patch = drag(container, onChange, 96, 54)
    expect(vi.mocked(captionDragGeometry).mock.lastCall?.[3])
      .toEqual({ previewScale: 0.5, renderW: 1920, renderH: 1080 })
    expect(patch).toEqual({ offsetX: 10, offsetY: 10 })
  })
})

describe('CaptionPreview — 9:16 (1080×1920 design canvas) is unchanged', () => {
  beforeEach(() => { player = { width: 540, height: 960 } })

  it('lays the caption layer out at 1080×1920 design px, scaled by player width / 1080', async () => {
    const { container } = mount([1080, 1920])
    expect(await layerGeometry(container)).toEqual({ width: 1080, height: 1920, scale: 540 / 1080 })
  })

  it('drags with renderW 1080 / renderH 1920, as before', async () => {
    const onChange = vi.fn()
    const { container } = mount([1080, 1920], onChange)
    await layerGeometry(container)
    const patch = drag(container, onChange, 54, 96)
    expect(vi.mocked(captionDragGeometry).mock.lastCall?.[3])
      .toEqual({ previewScale: 0.5, renderW: 1080, renderH: 1920 })
    expect(patch).toEqual({ offsetX: 10, offsetY: 10 })
  })
})
