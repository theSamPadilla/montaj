/**
 * §616 — the tracks[0] base clip's opacity, mask and blend mode, through the
 * real PreviewPlayer, on both picture paths (the legacy `<video>` slots and the
 * engine canvas). Same split as an item (OverlayItemsLayer.composite.test.tsx):
 * opacity and the blend on the transform container, a direct child of the
 * frame; the mask on the media box inside it, whose CSS box is the clip's box.
 *
 * Also pins where blending happens. `mix-blend-mode` blends with whatever is
 * already painted in the nearest isolated group, and every stacking context is
 * one. So the base clip's container and each item's wrapper must share ONE
 * parent with nothing isolating between them: the preview frame, which is
 * itself `isolation: isolate` (the group the export's canvas corresponds to,
 * black underneath).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { maskAt, maskSvg, opacityAt } from '@bycrux/timeline-core'
import PreviewPlayer from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import { __setEngineCapabilityForTests } from '../../../engine/eligibility'
import type { EditorProject as Project, VisualItem } from '../../../schema'
import { mediaBoxOf } from './mediaBox'

vi.mock('../../../engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../engine')>()
  return {
    ...actual,
    createEngine: () => ({
      attach() {},
      play() {},
      pause() {},
      seek() {},
      updateProject() {},
      status: () => ({ transport: 'paused', picture: 'black', clipId: null, seeking: false, clock: 'fallback' }),
      clock: { now: () => 0, playing: false, kind: 'fallback' },
      stats: () => ({ fps: 0, dropped: 0, buffered: 0, clock: 'fallback' }),
      dispose() {},
    }),
  }
})

// The preview frame's measured size, px.
const FRAME_W = 270
const FRAME_H = 480
const PLAYHEAD = 6 // start 2, so localT 4

function clip(over: Partial<VisualItem> = {}): VisualItem {
  return {
    id: 'c0', type: 'video', src: 'a.mp4', start: 2, end: 12, inPoint: 0,
    scaleX: 0.8, scaleY: 0.5,
    blendMode: 'add',
    mask: { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.8, h: 0.6, feather: 0.1, invert: true },
    keyframes: [
      { prop: 'opacity', points: [{ t: 0, value: 0.2 }, { t: 8, value: 1 }] },
      { prop: 'maskRotation', points: [{ t: 0, value: 0 }, { t: 8, value: 90 }] },
    ],
    ...over,
  } as VisualItem
}

function maskImageFor(item: VisualItem, localT: number, boxW: number, boxH: number): string {
  return `url("data:image/svg+xml,${encodeURIComponent(maskSvg(maskAt(item, localT)!, boxW, boxH))}")`
}

function renderPreview(tracks: VisualItem[][], engine = false) {
  const project = { id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks } as unknown as Project
  return render(
    <PreviewPlayer
      project={project}
      clock={createPlaybackClock(PLAYHEAD)}
      compileOverlay={async () => (() => null) as never}
      fileUrl={(p) => p}
      engine={engine ? { enabled: true } : undefined}
    />,
  )
}

/** The picture surface's media box and transform container. */
function baseLayers(surface: HTMLElement) {
  const mediaBox = mediaBoxOf(surface)
  return { mediaBox, container: mediaBox.parentElement as HTMLElement }
}

function expectComposited(surface: HTMLElement, item: VisualItem) {
  const { mediaBox, container } = baseLayers(surface)
  const localT = PLAYHEAD - item.start
  expect(container.style.opacity).toBe(String(opacityAt(item, localT)))
  expect(Number(container.style.opacity)).toBeCloseTo(0.6)
  expect(container.style.mixBlendMode).toBe('plus-lighter')
  expect(container.style.maskImage).toBe('')
  // The clip's box in preview pixels: the frame at (scaleX, scaleY).
  expect(mediaBox.style.maskImage).toBe(maskImageFor(item, localT, FRAME_W * 0.8, FRAME_H * 0.5))
  expect(mediaBox.style.maskMode).toBe('luminance')
  expect(mediaBox.style.maskSize).toBe('100% 100%')
  // Laid out at that box, so the SVG is not stretched.
  expect(mediaBox.style.width).toBe('80%')
  expect(mediaBox.style.height).toBe('50%')
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private cb: (entries: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: FRAME_W, height: FRAME_H } }]) }
    unobserve() {}
    disconnect() {}
  }
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

afterEach(() => {
  vi.restoreAllMocks()
  __setEngineCapabilityForTests(null)
})

describe('PreviewPlayer — the base clip composites (§616)', () => {
  it('legacy <video>: opacity and blend on the container, the mask on the media box', () => {
    const item = clip()
    const { container } = renderPreview([[item]])
    expectComposited(container.querySelector('video') as HTMLElement, item)
  })

  it('engine canvas: the same', async () => {
    __setEngineCapabilityForTests(true)
    const item = clip({ proxySrc: 'a_proxy.mp4' })
    const { container } = renderPreview([[item]], true)
    const canvas = await waitFor(() => {
      const c = container.querySelector('canvas')
      expect(c).not.toBeNull()
      return c as HTMLElement
    })
    // The canvas may sit in a wrapper of EngineSurface's own: walk up to the
    // media box, the frame's grandchild.
    const frame = container.querySelector('[data-montaj-preview-frame]') as HTMLElement
    let surface: HTMLElement = canvas
    while (surface.parentElement?.parentElement?.parentElement !== frame) surface = surface.parentElement as HTMLElement
    // The fresh root measures its frame in an effect after the canvas mounts.
    await waitFor(() => expectComposited(surface, item))
  })

  it('a plain clip gets no opacity, mask or blend (unchanged)', () => {
    const item = { id: 'c0', type: 'video', src: 'a.mp4', start: 2, end: 12, inPoint: 0 } as VisualItem
    const { container } = renderPreview([[item]])
    const { mediaBox, container: box } = baseLayers(container.querySelector('video') as HTMLElement)
    expect(box.style.opacity).toBe('')
    expect(box.style.mixBlendMode).toBe('')
    expect(mediaBox.style.maskImage).toBe('')
  })

  it('the base container and an item wrapper share the frame as their parent, nothing isolating between', () => {
    const item = clip()
    const upper = { id: 'up', type: 'image', src: 'up.png', start: 0, end: 12, blendMode: 'screen' } as VisualItem
    const { container } = renderPreview([[item], [upper]])
    const frame = container.querySelector('[data-montaj-preview-frame]') as HTMLElement
    const base = baseLayers(container.querySelector('video') as HTMLElement).container
    const wrapper = mediaBoxOf(container.querySelector('img[src="up.png"]') as HTMLElement).parentElement as HTMLElement

    expect(base.parentElement).toBe(frame)
    expect(wrapper.parentElement).toBe(frame)
    expect(wrapper.style.mixBlendMode).toBe('screen')
    // The frame is the isolated group they blend in; neither isolates itself.
    expect(frame.style.isolation).toBe('isolate')
    expect(base.style.isolation).toBe('')
    expect(wrapper.style.isolation).toBe('')
  })
})
