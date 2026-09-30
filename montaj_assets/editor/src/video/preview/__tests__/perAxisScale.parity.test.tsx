/// <reference types="vitest/globals" />
/**
 * PREVIEW / EXPORT PARITY for items placed with per-axis scale.
 *
 * An item with `scaleX` ≠ `scaleY` occupies a box that is not the canvas's
 * shape. The export fits the media straight into that box (encode-segment.js:
 * cover/contain/fill for an image, crop → decrease-fit → pad for a video). The
 * preview used to fit the media to the whole FRAME and then squash the result
 * with the wrapper's `scale(sx, sy)` — on the operator's 2026-09-28 essay a
 * photo in a 1032×1210 box drew a third flatter than the export, and a cropped
 * screen recording ignored its crop entirely.
 *
 * Each case renders the real `OverlayItemsLayer`, reads where the DOM puts the
 * media (`previewPlacement`), and requires it to match where the export's own
 * box and fit put it (`exportPlacement`), within the export's even-pixel
 * rounding. The per-axis numbers are the real project's.
 *
 * The export half of the same claim — that encode-segment.js really does fit
 * into these boxes — is `render/test/per-axis-box-parity.test.mjs`.
 */
import { render } from '@testing-library/react'
import { geometryAt } from '@bycrux/timeline-core'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import OverlayItemsLayer from '../OverlayItemsLayer'
import { exportPlacement, expectPlacementClose, previewPlacement } from './placementModel'

const W = 1080
const H = 1920
// The export even-rounds box sizes and rounds positions and crop dims; the
// preview draws the exact fractions. Nothing else may differ.
const TOL_PX = 2

const emptySnap = { x: false, y: false, left: false, right: false, top: false, bottom: false }

// The essay's upper-track box (1032×1210, raised 17%) — every photo and screen
// recording on tracks[1] carries these exact values.
const UPPER_BOX = { scale: 1, scaleX: 0.9555555556, scaleY: 0.6302083333, offsetX: 0, offsetY: -17.2395833333 }

// jsdom implements neither; OverlayVideo pauses on mount.
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {})
})
afterEach(() => vi.restoreAllMocks())

function renderLayer(item: VisualItem, where: 'overlay' | 'track0' = 'overlay', currentTime = item.start + 0.5) {
  const utils = render(
    <OverlayItemsLayer
      project={{ id: 'p', status: 'draft', settings: { resolution: [W, H], fps: 30 }, tracks: [[]] } as unknown as EditorProject}
      currentTime={currentTime}
      isPlaying={false}
      isCanvasProject={false}
      overlayTracks={where === 'overlay' ? [[item]] : [[]]}
      tracks0NonVideo={where === 'track0' ? [item] : []}
      renderScale={1}
      containerRef={{ current: document.createElement('div') }}
      dragState={null}
      setDragState={vi.fn()}
      liveOffset={null}
      liveScale={null}
      liveRotation={null}
      snapGuides={emptySnap}
      snapRotation={null}
      compileOverlay={vi.fn(async (): Promise<OverlayFactory> => () => null)}
      fileUrl={(pth: string) => pth}
    />,
  )
  const media = utils.container.querySelector('img, video') as HTMLElement
  return { ...utils, media, frame: utils.container as HTMLElement }
}

function placementsFor(
  item: VisualItem, mediaW: number, mediaH: number, where: 'overlay' | 'track0' = 'overlay',
  currentTime?: number, exportItem: VisualItem = item,
) {
  const { media, frame } = renderLayer(item, where, currentTime)
  return {
    preview: previewPlacement(media, frame, W, H, { mediaW, mediaH }),
    exported: exportPlacement(exportItem, W, H, mediaW, mediaH),
  }
}

describe('per-axis scale: the preview fits media into the box the export does', () => {
  it('upper-track image, cover (a landscape photo in the essay box)', () => {
    const item = { id: 'top-article-hook', type: 'image', src: 'hook.png', start: 0, end: 2.6238, fit: 'cover', ...UPPER_BOX } as VisualItem
    const { preview, exported } = placementsFor(item, 1600, 900)
    expectPlacementClose(preview, exported, TOL_PX)
  })

  it('upper-track image, contain', () => {
    const item = { id: 'i', type: 'image', src: 'i.png', start: 0, end: 4, fit: 'contain', ...UPPER_BOX } as VisualItem
    const { preview, exported } = placementsFor(item, 1600, 900)
    expectPlacementClose(preview, exported, TOL_PX)
  })

  it('tracks[0] background image', () => {
    const item = { id: 'bg', type: 'image', src: 'bg.png', start: 0, end: 4, fit: 'cover', ...UPPER_BOX } as VisualItem
    const { preview, exported } = placementsFor(item, 1600, 900, 'track0')
    expectPlacementClose(preview, exported, TOL_PX)
  })

  it('upper-track video with sourceCrop (the essay screen recording, crop from the top)', () => {
    const item = {
      id: 'top-screen-open', type: 'video', src: 'screen.mp4', start: 2.6238, end: 6.5, inPoint: 0,
      sourceCrop: { x: 0, y: 0, w: 1, h: 0.5393 }, sourceWidth: 1206, sourceHeight: 2622, ...UPPER_BOX,
    } as VisualItem
    const { preview, exported } = placementsFor(item, 1206, 2622)
    expectPlacementClose(preview, exported, TOL_PX)
  })

  it('upper-track video with an offset sourceCrop (the essay hands clip)', () => {
    const item = {
      id: 'top-hands-logistics', type: 'video', src: 'hands.mp4', start: 20.3, end: 24.4602, inPoint: 0,
      sourceCrop: { x: 0, y: 0.17, w: 1, h: 0.6595 }, sourceWidth: 720, sourceHeight: 1280, ...UPPER_BOX,
    } as VisualItem
    const { preview, exported } = placementsFor(item, 720, 1280)
    expectPlacementClose(preview, exported, TOL_PX)
  })

  it('upper-track video without a crop, letterboxed in its box', () => {
    const item = { id: 'v', type: 'video', src: 'v.mp4', start: 0, end: 4, inPoint: 0, ...UPPER_BOX } as VisualItem
    const { preview, exported } = placementsFor(item, 1920, 1080)
    expectPlacementClose(preview, exported, TOL_PX)
  })
})

describe('a keyframed video crop (PV55 phase 2): the preview follows the sampled crop', () => {
  it('upper-track video panning cropX, at t=1, matches the still crop of that instant', () => {
    const item = {
      id: 'kv', type: 'video', src: 'kv.mp4', start: 0, end: 4, inPoint: 0,
      sourceCrop: { x: 0, y: 0, w: 0.48, h: 1 }, sourceWidth: 1920, sourceHeight: 1080,
      keyframes: [{ prop: 'cropX', points: [{ t: 0, value: 0 }, { t: 2, value: 0.5 }] }], ...UPPER_BOX,
    } as VisualItem
    // The export at that instant is exactly this still crop.
    const twin = { ...item, keyframes: undefined, sourceCrop: geometryAt(item, 'video', 1).sourceCrop } as VisualItem
    expect(twin.sourceCrop!.x).toBeCloseTo(0.25, 6)
    const { preview, exported } = placementsFor(item, 1920, 1080, 'overlay', 1, twin)
    expectPlacementClose(preview, exported, TOL_PX)
  })
})

describe('uniform scale renders exactly as before (regression guard)', () => {
  // These held before the per-axis fix too: with sx === sy, fitting to the
  // frame and then scaling is the same as fitting to the box.
  it('image, uniform scale with offsets', () => {
    const item = { id: 'u', type: 'image', src: 'u.png', start: 0, end: 4, fit: 'cover', scale: 0.5, offsetX: 10, offsetY: -5 } as VisualItem
    const { preview, exported } = placementsFor(item, 1600, 900)
    expectPlacementClose(preview, exported, TOL_PX)
  })

  it('video, uniform scale with offsets', () => {
    const item = { id: 'u', type: 'video', src: 'u.mp4', start: 0, end: 4, inPoint: 0, scale: 0.6, offsetX: -8, offsetY: 12 } as VisualItem
    const { preview, exported } = placementsFor(item, 1920, 1080)
    expectPlacementClose(preview, exported, TOL_PX)
  })

  it('the media box of a uniform item is the plain full box, and the media element is untouched', () => {
    const item = { id: 'u', type: 'image', src: 'u.png', start: 0, end: 4, fit: 'cover', scale: 0.5, offsetX: 10, offsetY: -5 } as VisualItem
    const { media } = renderLayer(item)
    const box = media.parentElement as HTMLElement
    expect(box.style.transform).toBe('')
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['0px', '0px', '100%', '100%'])
    expect(media.className).toBe('absolute inset-0 w-full h-full pointer-events-none')
    expect(media.style.objectFit).toBe('cover')
    // The wrapper keeps the parity-pinned template (OverlayItemsLayer.keyframes.test.tsx).
    expect((box.parentElement as HTMLElement).style.transform).toBe('translate(10%, -5%) rotate(0deg) scale(0.5, 0.5)')
  })

  it('a video without sourceCrop keeps its object-contain element', () => {
    const item = { id: 'u', type: 'video', src: 'u.mp4', start: 0, end: 4, inPoint: 0, scale: 0.6 } as VisualItem
    const { media } = renderLayer(item)
    expect(media.className).toBe('absolute inset-0 w-full h-full object-contain pointer-events-none')
  })
})
