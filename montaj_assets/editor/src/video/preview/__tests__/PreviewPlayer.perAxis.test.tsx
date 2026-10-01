/**
 * The tracks[0] clip under per-axis scale, through the real PreviewPlayer.
 *
 * The essay's presenter sits in a 1016×572 box (`scaleX`/`scaleY`, with
 * `scale: 1`). The base-clip transform used to read `scale` only, so the preview
 * drew the presenter across the whole 1080-wide frame at 1080×608 while the
 * export drew it at 1016×572. These render PreviewPlayer on both picture paths
 * and require the picture to land where the export (encode-segment.js) puts it.
 * The shared model is `placementModel.ts`; the engine's own plan math is
 * `engine/__tests__/scheduler-perAxis.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import PreviewPlayer from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import { __setEngineCapabilityForTests } from '../../../engine/eligibility'
import { drawPlanFor } from '../../../engine/scheduler'
import type { EditorProject as Project, VisualItem } from '../../../schema'
import { exportPlacement, expectPlacementClose, previewPlacement } from './placementModel'

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

const W = 1080
const H = 1920
const TOL_PX = 2
const PRESENTER = { scale: 1, scaleX: 0.9407407407, scaleY: 0.2979166667, offsetX: 0, offsetY: 32.6041666667 }

function clip(over: Record<string, unknown>): VisualItem {
  return { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0, ...over } as unknown as VisualItem
}

function renderPreview(item: VisualItem, opts: { engine?: boolean; selected?: boolean; onOverlayChange?: (id: string, c: unknown) => void } = {}) {
  const project = { id: 'p', status: 'draft', settings: { resolution: [W, H], fps: 30 }, tracks: [[item]] } as unknown as Project
  const utils = render(
    <PreviewPlayer
      project={project}
      clock={createPlaybackClock(0)}
      compileOverlay={async () => (() => null) as never}
      fileUrl={(p) => p}
      engine={opts.engine ? { enabled: true } : undefined}
      selectedOverlayId={opts.selected ? item.id : undefined}
      onOverlayChange={opts.onOverlayChange}
    />,
  )
  // The aspect-locked, overflow-hidden frame (inside its fit container).
  const frame = utils.container.querySelector('[data-montaj-preview-frame]') as HTMLElement
  return { ...utils, frame }
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
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

describe('PreviewPlayer — tracks[0] clip with per-axis scale', () => {
  it('legacy <video>: the presenter lands in its 1016×572 box, as exported', () => {
    const item = clip(PRESENTER)
    const { container, frame } = renderPreview(item)
    const video = container.querySelector('video') as HTMLElement
    const preview = previewPlacement(video, frame, W, H, { mediaW: 1920, mediaH: 1080 })
    expectPlacementClose(preview, exportPlacement(item, W, H, 1920, 1080), TOL_PX)
  })

  it('engine canvas: the painted picture lands in the same box', async () => {
    __setEngineCapabilityForTests(true)
    const item = clip({ ...PRESENTER, proxySrc: 'a_proxy.mp4' })
    const { container } = renderPreview(item, { engine: true })
    const canvas = await waitFor(() => {
      const c = container.querySelector('canvas')
      expect(c).not.toBeNull()
      return c as HTMLElement
    })
    // Read after the switch: the engine path mounts a fresh root.
    const frame = container.querySelector('[data-montaj-preview-frame]') as HTMLElement
    // The engine paints the design canvas; the proxy decodes at 1280×720.
    const plan = drawPlanFor(item, 1280, 720, W, H)
    const preview = previewPlacement(canvas, frame, W, H, { mediaW: 1280, mediaH: 720, canvas: { backingW: W, backingH: H, plan } })
    expectPlacementClose(preview, exportPlacement(item, W, H, 1920, 1080), TOL_PX)
  })

  it('a zoom keeps a per-axis clip per-axis: scaleX/scaleY scale with it', () => {
    const onOverlayChange = vi.fn()
    const item = clip(PRESENTER)
    const { container } = renderPreview(item, { selected: true, onOverlayChange })
    const outline = container.querySelector('[style*="outline"]') as HTMLElement
    fireEvent.wheel(outline, { deltaY: -1 })
    expect(onOverlayChange).toHaveBeenCalledTimes(1)
    const [id, changes] = onOverlayChange.mock.calls[0]
    expect(id).toBe('c0')
    expect(changes.scale).toBeCloseTo(1.06, 12)
    expect(changes.scaleX).toBeCloseTo(PRESENTER.scaleX * 1.06, 9)
    expect(changes.scaleY).toBeCloseTo(PRESENTER.scaleY * 1.06, 9)
  })
})

describe('PreviewPlayer — uniform scale is unchanged (regression guard)', () => {
  it('lands where the export draws it', () => {
    const item = clip({ scale: 0.5, offsetX: 10, offsetY: -5 })
    const { container, frame } = renderPreview(item)
    const video = container.querySelector('video') as HTMLElement
    const preview = previewPlacement(video, frame, W, H, { mediaW: 1920, mediaH: 1080 })
    expectPlacementClose(preview, exportPlacement(item, W, H, 1920, 1080), TOL_PX)
  })

  it('keeps the same container transform, with an inert media box inside it', () => {
    const { container } = renderPreview(clip({ scale: 0.5, offsetX: 10, offsetY: -5 }))
    const box = (container.querySelector('video') as HTMLElement).parentElement as HTMLElement
    expect(box.style.transform).toBe('')
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['0px', '0px', '100%', '100%'])
    expect((box.parentElement as HTMLElement).style.transform).toBe('translate(10%, -5%) scale(0.5, 0.5)')
  })

  it('a zoom of a uniform clip still commits only `scale`', () => {
    const onOverlayChange = vi.fn()
    const { container } = renderPreview(clip({ scale: 1 }), { selected: true, onOverlayChange })
    fireEvent.wheel(container.querySelector('[style*="outline"]') as HTMLElement, { deltaY: -1 })
    expect(Object.keys(onOverlayChange.mock.calls[0][1])).toEqual(['scale'])
  })
})
