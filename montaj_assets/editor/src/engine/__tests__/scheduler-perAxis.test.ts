/**
 * The engine's picture under per-axis scale.
 *
 * The canvas's backing store is always the design canvas (frame-shaped), and CSS
 * stretches it over the clip's media box (`transformStyle.ts`'s
 * `mediaBoxStyle`, inside `videoTransformContainerStyle`'s container). When
 * `scaleX` ≠ `scaleY` that box is not frame-shaped, so a plan that fits the
 * picture to the backing store comes out stretched. `drawPlanFor` has to fit to
 * the box's aspect instead. These build the same three nested boxes
 * PreviewPlayer renders around the canvas and require the picture to land where
 * the export (encode-segment.js) puts it.
 */
import { describe, expect, it } from 'vitest'
import type { VisualItem } from '../../schema'
import { containFitPlan, drawPlanFor, sourceCropDrawPlan } from '../scheduler'
import { mediaBoxStyle, videoTransformContainerStyle } from '../../video/preview/transformStyle'
import { exportPlacement, expectPlacementClose, previewPlacement } from '../../video/preview/__tests__/placementModel'

const W = 1080
const H = 1920
const TOL_PX = 2

// The essay's presenter: a 1016×572 box low on a 9:16 canvas.
const PRESENTER = { scale: 1, scaleX: 0.9407407407, scaleY: 0.2979166667, offsetX: 0, offsetY: 32.6041666667 }

/** frame > transform container > media box > canvas, styled as PreviewPlayer styles them. */
function mountCanvas(item: VisualItem) {
  const frame = document.createElement('div')
  const container = document.createElement('div')
  container.className = 'absolute inset-0'
  Object.assign(container.style, videoTransformContainerStyle(item))
  const box = document.createElement('div')
  Object.assign(box.style, mediaBoxStyle(item))
  const canvas = document.createElement('canvas')
  Object.assign(canvas.style, { position: 'absolute', left: '0px', top: '0px', width: '100%', height: '100%' })
  box.appendChild(canvas)
  container.appendChild(box)
  frame.appendChild(container)
  return { frame, canvas }
}

function placements(item: VisualItem, sourceW: number, sourceH: number, codedW: number, codedH: number) {
  const { frame, canvas } = mountCanvas(item)
  const plan = drawPlanFor(item, codedW, codedH, W, H)
  return {
    preview: previewPlacement(canvas, frame, W, H, { mediaW: codedW, mediaH: codedH, canvas: { backingW: W, backingH: H, plan } }),
    exported: exportPlacement(item, W, H, sourceW, sourceH),
  }
}

describe('drawPlanFor — per-axis scale', () => {
  it('a 16:9 presenter in the essay box lands where the export draws it', () => {
    const item = { id: 'c', type: 'video', src: 'a.mp4', start: 0, end: 4, ...PRESENTER } as VisualItem
    const { preview, exported } = placements(item, 1920, 1080, 1280, 720)
    expectPlacementClose(preview, exported, TOL_PX)
  })

  it('a letterboxed source (4:3 in the same box) is contained, not stretched', () => {
    const item = { id: 'c', type: 'video', src: 'a.mp4', start: 0, end: 4, ...PRESENTER } as VisualItem
    const { preview, exported } = placements(item, 1440, 1080, 960, 720)
    expectPlacementClose(preview, exported, TOL_PX)
  })

  it('a sourceCrop is fitted to the box too', () => {
    const item = {
      id: 'c', type: 'video', src: 'a.mp4', start: 0, end: 4, ...PRESENTER,
      sourceCrop: { x: 0.1, y: 0.2, w: 0.8, h: 0.5 }, sourceWidth: 1920, sourceHeight: 1080,
    } as VisualItem
    const { preview, exported } = placements(item, 1920, 1080, 1280, 720)
    expectPlacementClose(preview, exported, TOL_PX)
  })
})

describe('drawPlanFor — uniform scale is untouched (regression guard)', () => {
  it('the plan is exactly the frame contain-fit', () => {
    const item = { id: 'c', type: 'video', src: 'a.mp4', start: 0, end: 4, scale: 0.5, offsetX: 10, offsetY: -5 } as VisualItem
    expect(drawPlanFor(item, 1280, 720, W, H)).toEqual(containFitPlan(1280, 720, W, H))
  })

  it('the crop plan is exactly the frame crop plan', () => {
    const crop = { x: 0.25, y: 0, w: 0.5, h: 1 }
    const item = { id: 'c', type: 'video', src: 'a.mp4', start: 0, end: 4, scale: 0.7, sourceCrop: crop, sourceWidth: 1920, sourceHeight: 1080 } as VisualItem
    expect(drawPlanFor(item, 1280, 720, W, H)).toEqual(sourceCropDrawPlan({
      crop, sourceWidth: 1920, sourceHeight: 1080, codedWidth: 1280, codedHeight: 720, frameWidth: W, frameHeight: H,
    }))
  })

  it('and it lands where the export draws it', () => {
    const item = { id: 'c', type: 'video', src: 'a.mp4', start: 0, end: 4, scale: 0.5, offsetX: 10, offsetY: -5 } as VisualItem
    const { preview, exported } = placements(item, 1920, 1080, 1280, 720)
    expectPlacementClose(preview, exported, TOL_PX)
  })
})
