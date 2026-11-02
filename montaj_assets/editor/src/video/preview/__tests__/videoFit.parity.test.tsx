/**
 * §669: a video item's `fit` in the preview, matching the export.
 *
 * The export (encode-segment.js buildVideoItemFilterParts) crops the source
 * first, then fits the cropped region into the item's box: contain scales it
 * inside and pads, cover scales it to fill (`force_original_aspect_ratio=
 * increase`) and crops the overflow CENTRED, fill stretches it. So under cover
 * the box shows the centred box-aspect cut of the (cropped) source, and under
 * fill the whole (cropped) source; both leave no bars. Each preview path is
 * checked against that: the legacy <video> CSS (`sourceCropVideoStyle` and the
 * element's object-fit), the engine canvas (`drawPlanFor`), the overlay-track
 * <video> (OverlayItemsLayer) and the base clip (PreviewPlayer).
 */
import { render } from '@testing-library/react'
import { sourceCropVideoStyle } from '../sourceCropStyle'
import { drawPlanFor } from '../../../engine/scheduler'
import OverlayItemsLayer from '../OverlayItemsLayer'
import PreviewPlayer from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'

/** The source rect the export shows under cover: the box's aspect, centred in the (cropped) source. */
function renderCoverWindow(srcW: number, srcH: number, boxW: number, boxH: number) {
  const a = boxW / boxH
  const w = srcW / srcH > a ? srcH * a : srcW
  const h = srcW / srcH > a ? srcH : srcW / a
  return { x: (srcW - w) / 2, y: (srcH - h) / 2, w, h }
}

/** Where `sourceCropVideoStyle` puts the crop sub-rect, as ratios of the frame. */
function placedCrop(style: React.CSSProperties, crop: { x: number; y: number; w: number; h: number }) {
  const W = parseFloat(style.width as string) / 100
  const H = parseFloat(style.height as string) / 100
  const L = parseFloat(style.left as string) / 100
  const T = parseFloat(style.top as string) / 100
  return { left: L + crop.x * W, top: T + crop.y * H, width: crop.w * W, height: crop.h * H }
}

describe('§669 the CSS crop style is fit-aware', () => {
  const crop = { x: 0.5, y: 0, w: 0.5, h: 1 } // the right half of a 3:4 source: 0.375, narrower than 9:16
  const base = { crop, sourceWidth: 1440, sourceHeight: 1920, frameWidth: 1080, frameHeight: 1920 }

  it('contain is unchanged, and the default', () => {
    expect(sourceCropVideoStyle({ ...base, fit: 'contain' })).toEqual(sourceCropVideoStyle(base))
    const p = placedCrop(sourceCropVideoStyle(base)!, crop)
    expect(p.height).toBeCloseTo(1, 6)
    expect(p.width).toBeLessThan(1) // side bars
  })

  it('cover: the crop covers the frame, centred, overflowing on one axis only', () => {
    const p = placedCrop(sourceCropVideoStyle({ ...base, fit: 'cover' })!, crop)
    expect(p.width).toBeCloseTo(1, 6)
    expect(p.height).toBeGreaterThan(1)
    expect(p.left).toBeCloseTo(0, 6)
    expect(p.top).toBeCloseTo((1 - p.height) / 2, 6)
    // The export's centred cut of the 720x1920 crop into 9:16: 720 x 1280, from y 320.
    const cut = renderCoverWindow(720, 1920, 1080, 1920)
    expect(-p.top / p.height * 1920).toBeCloseTo(cut.y, 3)
    expect(1 / p.height * 1920).toBeCloseTo(cut.h, 3)
  })

  it('fill: the crop is the frame exactly', () => {
    const p = placedCrop(sourceCropVideoStyle({ ...base, fit: 'fill' })!, crop)
    expect([p.left, p.top, p.width, p.height].map((v) => +v.toFixed(6))).toEqual([0, 0, 1, 1])
  })
})

describe('§669 the engine canvas draws the fit the export does', () => {
  // The §668 clip's converted copy: 1308x1744 decoded, 3:4, in a 9:16 frame.
  it('cover, no crop: the whole frame, from the centred box-aspect cut of the frame', () => {
    const plan = drawPlanFor({ fit: 'cover' } as never, 1308, 1744, 1080, 1920)
    expect([plan.dx, plan.dy, plan.dw, plan.dh]).toEqual([0, 0, 1080, 1920])
    const cut = renderCoverWindow(1308, 1744, 1080, 1920)
    expect(plan.sx).toBeCloseTo(cut.x, 6)
    expect(plan.sy).toBeCloseTo(cut.y, 6)
    expect(plan.sw).toBeCloseTo(cut.w, 6)
    expect(plan.sh).toBeCloseTo(cut.h, 6)
  })

  it('fill, no crop: the whole source stretched to the frame', () => {
    const plan = drawPlanFor({ fit: 'fill' } as never, 1308, 1744, 1080, 1920)
    expect(plan).toEqual({ sx: 0, sy: 0, sw: 1308, sh: 1744, dx: 0, dy: 0, dw: 1080, dh: 1920 })
  })

  it('no fit is contain, as before', () => {
    const plan = drawPlanFor({} as never, 1308, 1744, 1080, 1920)
    expect(plan.dw).toBe(1080)
    expect(plan.dh).toBeCloseTo(1440, 6)
  })

  it('cover with a crop: the crop first, then the centred cut of it covers the frame', () => {
    const item = { fit: 'cover', sourceCrop: { x: 0.5, y: 0, w: 0.5, h: 1 }, sourceWidth: 1440, sourceHeight: 1920 }
    const plan = drawPlanFor(item as never, 1308, 1744, 1080, 1920)
    expect([plan.dx, plan.dy, plan.dw, plan.dh]).toEqual([0, 0, 1080, 1920])
    const cut = renderCoverWindow(654, 1744, 1080, 1920)
    expect(plan.sx).toBeCloseTo(654 + cut.x, 6)
    expect(plan.sy).toBeCloseTo(cut.y, 6)
    expect(plan.sw).toBeCloseTo(cut.w, 6)
    expect(plan.sh).toBeCloseTo(cut.h, 6)
  })

  it('cover on a per-axis box covers the stretched box', () => {
    const plan = drawPlanFor({ fit: 'cover', scaleX: 2, scaleY: 1 } as never, 1308, 1744, 1080, 1920)
    // The plan fits into a frame twice as wide and squeezes x back: the whole frame still.
    expect([plan.dx, plan.dy, plan.dw, plan.dh]).toEqual([0, 0, 1080, 1920])
    const cut = renderCoverWindow(1308, 1744, 2160, 1920)
    expect(plan.sw).toBeCloseTo(cut.w, 6)
    expect(plan.sh).toBeCloseTo(cut.h, 6)
  })
})

const emptySnap = { x: false, y: false, left: false, right: false, top: false, bottom: false }

function overlayVideo(item: VisualItem) {
  const project = { id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [[]] } as unknown as EditorProject
  const utils = render(
    <OverlayItemsLayer project={project} currentTime={1} isPlaying={false} isCanvasProject={false}
      overlayTracks={[[item]]} tracks0NonVideo={[]} renderScale={0.2} selectedOverlayId={undefined}
      containerRef={{ current: document.createElement('div') }} dragState={null} setDragState={vi.fn()}
      liveOffset={null} liveScale={null} liveRotation={null} snapGuides={emptySnap} snapRotation={null}
      compileOverlay={vi.fn(async (): Promise<OverlayFactory> => () => null)} fileUrl={(p: string) => p} />,
  )
  return utils.container.querySelector('video') as HTMLVideoElement
}

describe('§669 an overlay-track video honours its fit', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())
  const vid = (over: Partial<VisualItem> = {}) => ({
    id: 'v', type: 'video', src: '/a.mp4', start: 0, end: 5, inPoint: 0, sourceWidth: 1440, sourceHeight: 1920, ...over,
  }) as VisualItem

  it('cover draws object-fit cover', () => {
    expect(overlayVideo(vid({ fit: 'cover' })).style.objectFit).toBe('cover')
  })
  it('fill draws object-fit fill', () => {
    expect(overlayVideo(vid({ fit: 'fill' })).style.objectFit).toBe('fill')
  })
  it('no fit draws contain, as before', () => {
    expect(overlayVideo(vid()).style.objectFit).toBe('contain')
  })
  it('cover with a crop sizes the element so the crop covers the box', () => {
    const crop = { x: 0.5, y: 0, w: 0.5, h: 1 }
    const el = overlayVideo(vid({ fit: 'cover', sourceCrop: crop }))
    const want = sourceCropVideoStyle({ crop, sourceWidth: 1440, sourceHeight: 1920, frameWidth: 1080, frameHeight: 1920, fit: 'cover' })!
    expect(el.style.width).toBe(want.width)
    expect(el.style.top).toBe(want.top)
  })
})

describe('§669 the base clip honours its fit', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      constructor(private cb: (entries: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 100, height: 100 } }]) }
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
  afterEach(() => vi.restoreAllMocks())

  function baseVideo(over: Partial<VisualItem>) {
    const item = { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, sourceWidth: 1440, sourceHeight: 1920, ...over } as VisualItem
    const project = { id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [[item]] } as unknown as EditorProject
    const utils = render(
      <PreviewPlayer project={project} clock={createPlaybackClock(1)} selectedOverlayId={undefined}
        onOverlayChange={() => {}} compileOverlay={async () => (() => null) as never} fileUrl={(p) => p} />,
    )
    return utils.container.querySelector('video') as HTMLVideoElement
  }

  it('cover draws object-fit cover; no fit stays contain', () => {
    expect(baseVideo({ fit: 'cover' }).style.objectFit).toBe('cover')
    expect(baseVideo({}).style.objectFit).toBe('contain')
  })
})
