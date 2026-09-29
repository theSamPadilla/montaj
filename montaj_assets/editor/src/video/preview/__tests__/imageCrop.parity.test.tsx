/// <reference types="vitest/globals" />
/**
 * PREVIEW / EXPORT PARITY for a still with a `sourceCrop` (PV55).
 *
 * The export crops the image BEFORE fitting it into its box (encode-segment.js).
 * Each case renders the real `OverlayItemsLayer`, loads the <img> at its natural
 * size, reads where the DOM puts the media, and requires it to match
 * `exportPlacement` within the export's whole-pixel rounding.
 */
import { render, fireEvent } from '@testing-library/react'
import { geometryAt } from '@bycrux/timeline-core'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import OverlayItemsLayer from '../OverlayItemsLayer'
import { exportPlacement, expectPlacementClose, previewPlacement } from './placementModel'

const W = 1080
const H = 1920
const TOL_PX = 2

const emptySnap = { x: false, y: false, left: false, right: false, top: false, bottom: false }
const UPPER_BOX = { scale: 1, scaleX: 0.9555555556, scaleY: 0.6302083333, offsetX: 0, offsetY: -17.2395833333 }

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {})
})
afterEach(() => vi.restoreAllMocks())

function load(img: HTMLImageElement, w: number, h: number) {
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: w })
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: h })
  fireEvent.load(img)
}

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
  return { ...utils, frame: utils.container as HTMLElement }
}

function placementsFor(
  item: VisualItem, mediaW: number, mediaH: number,
  where: 'overlay' | 'track0' = 'overlay', currentTime?: number, exportItem: VisualItem = item,
) {
  const { container, frame } = renderLayer(item, where, currentTime)
  load(container.querySelector('img') as HTMLImageElement, mediaW, mediaH)
  const media = container.querySelector('img') as HTMLElement
  return {
    preview: previewPlacement(media, frame, W, H, { mediaW, mediaH }),
    exported: exportPlacement(exportItem, W, H, mediaW, mediaH),
  }
}

describe('a cropped still: the preview crops before it fits, as the export does', () => {
  it('1. uniform box, cover (a wide photo cropped to a narrow strip), overlay track', () => {
    const item = { id: 'a', type: 'image', src: 'a.jpg', start: 0, end: 4, fit: 'cover', sourceCrop: { x: 0.5, y: 0, w: 0.3164, h: 1 } } as VisualItem
    const { preview, exported } = placementsFor(item, 2696, 1524)
    expectPlacementClose(preview, exported, TOL_PX)
  })

  it('2. the same on tracks[0]', () => {
    const item = { id: 'a', type: 'image', src: 'a.jpg', start: 0, end: 4, fit: 'cover', sourceCrop: { x: 0.5, y: 0, w: 0.3164, h: 1 } } as VisualItem
    const { preview, exported } = placementsFor(item, 2696, 1524, 'track0')
    expectPlacementClose(preview, exported, TOL_PX)
  })

  const crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }
  it.each(['cover', 'contain', 'fill'] as const)('%s in the per-axis upper-track box', (fit) => {
    const item = { id: 'u', type: 'image', src: 'u.png', start: 0, end: 4, fit, sourceCrop: crop, ...UPPER_BOX } as VisualItem
    const { preview, exported } = placementsFor(item, 1600, 900)
    expectPlacementClose(preview, exported, TOL_PX)
  })

  it('6. animated: a panning crop at t=1 matches the still crop of that instant', () => {
    const item = {
      id: 'k', type: 'image', src: 'k.jpg', start: 0, end: 4, fit: 'cover',
      sourceCrop: { x: 0, y: 0, w: 0.3164, h: 1 },
      keyframes: [{ prop: 'cropX', points: [{ t: 0, value: 0 }, { t: 2, value: 0.68 }] }],
    } as VisualItem
    const twin = { ...item, keyframes: undefined, fit: 'cover', sourceCrop: geometryAt(item, 'image', 1).sourceCrop } as VisualItem
    expect(twin.sourceCrop!.x).toBeGreaterThan(0.1)
    const { preview, exported } = placementsFor(item, 2696, 1524, 'overlay', 1, twin)
    expectPlacementClose(preview, exported, TOL_PX)
  })
})
