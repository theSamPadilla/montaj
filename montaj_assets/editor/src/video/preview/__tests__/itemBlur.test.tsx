/// <reference types="vitest/globals" />
import { render } from '@testing-library/react'
import { blurSigmaPx } from '@bycrux/timeline-core'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import OverlayItemsLayer from '../OverlayItemsLayer'
import PreviewPlayer from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import { blurFilterSpec, linearBlurRegion, pictureSizeFor, radialBlurSpec } from '../itemBlur'
import { mediaBoxOf } from './mediaBox'

// A clip's blur in the preview: an SVG filter on the clip's media box that cuts
// the source to the picture's rect, blurs it, renormalises by the blurred alpha
// (feColorMatrix alpha = 1) and keeps the picture's alpha; its sigma the
// export's (design pixels on the 1080 short edge) at the scale on screen.
// Chromium's pixels against the export's are measured in
// render/test/item-blur-preview-parity.test.mjs; this file pins what the
// editor writes.
//
// On-screen parity with the export: the export blurs at
// `blur * min(outW, outH) / 1080` output pixels (timeline-core blurSigmaPx).
// The preview frame shows the design canvas at `renderScale` screen pixels per
// design pixel, so the same blur on screen is `blur * renderScale`. A uniform
// clip's media box is under the wrapper's `scale(s)`, so the filter's own
// stdDeviation is that over `s`; a per-axis clip's media box has a net scale of 1.

const CANVAS = { canvasW: 1080, canvasH: 1920 }

describe('blurFilterSpec', () => {
  const item = { id: 'v', type: 'video', start: 0, end: 1, blur: 40 } as VisualItem

  it('a uniform clip: the screen sigma over the wrapper scale; the region is the contain-fitted picture', () => {
    const spec = blurFilterSpec({ item, renderScale: 0.25, ...CANVAS, scaleX: 3.2, scaleY: 3.2 }, { w: 960, h: 540 })!
    expect(spec.sigma).toBeCloseTo(40 * 0.25 / 3.2, 10)
    // On screen: sigma * 3.2 = 10 px = the export's 40 px at 1080 wide, shown at 0.25.
    expect(spec.sigma * 3.2).toBeCloseTo(blurSigmaPx(item, 1080, 1920) * 0.25, 10)
    // 16:9 footage in the 9:16 box: full width, a centred band.
    const h = (9 / 16) / (16 / 9)
    expect(spec.rect.x).toBe(0)
    expect(spec.rect.w).toBe(1)
    expect(spec.rect.h).toBeCloseTo(h, 10)
    expect(spec.rect.y).toBeCloseTo((1 - h) / 2, 10)
    // A uniform media box is the frame in its own pixels.
    expect(spec.box).toEqual({ w: 270, h: 480 })
  })

  it('a per-axis clip: the screen sigma as is (net scale 1)', () => {
    const spec = blurFilterSpec({ item, renderScale: 0.25, ...CANVAS, scaleX: 0.8, scaleY: 0.5 }, null)!
    expect(spec.sigma).toBeCloseTo(10, 10)
    expect(spec.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    // A per-axis media box is the clip's box.
    expect(spec.box.w).toBeCloseTo(270 * 0.8, 10)
    expect(spec.box.h).toBeCloseTo(480 * 0.5, 10)
  })

  it('no blur: null', () => {
    expect(blurFilterSpec({ item: { ...item, blur: 0 }, renderScale: 0.25, ...CANVAS, scaleX: 1, scaleY: 1 }, null)).toBeNull()
    expect(blurFilterSpec({ item: { ...item, blur: undefined }, renderScale: 0.25, ...CANVAS, scaleX: 1, scaleY: 1 }, null)).toBeNull()
  })

  it('a linear clip: the angle (mod 180) rides the spec, and the local pixels per screen pixel; uniform has none', () => {
    const lin = { ...item, blurType: 'linear', blurAngle: 210 } as VisualItem
    const spec = blurFilterSpec({ item: lin, renderScale: 0.25, ...CANVAS, scaleX: 2, scaleY: 2 }, null)!
    expect(spec.angle).toBe(30)
    expect(spec.perScreenPx).toBe(0.5)
    expect(blurFilterSpec({ item, renderScale: 0.25, ...CANVAS, scaleX: 2, scaleY: 2 }, null)!.angle).toBeNull()
  })

  it('linearBlurRegion: the picture\'s rect turned by -angle about the box centre, plus 2 px', () => {
    const box = { w: 200, h: 100 }
    const whole = { x: 0, y: 0, w: 1, h: 1 }
    const r0 = linearBlurRegion(whole, box, 0)
    expect([r0.x * 200, r0.y * 100, r0.w * 200, r0.h * 100].map(v => Math.round(v * 1000) / 1000)).toEqual([-2, -2, 204, 104])
    // At 90 degrees the 200 x 100 picture stands 100 wide and 200 tall, about the same centre.
    const r90 = linearBlurRegion(whole, box, 90)
    expect(r90.w * 200).toBeCloseTo(104, 6)
    expect(r90.h * 100).toBeCloseTo(204, 6)
    expect(r90.x * 200).toBeCloseTo(50 - 2, 6)
    expect(r90.y * 100).toBeCloseTo(-50 - 2, 6)
  })

  it('spin and zoom take no SVG filter (they draw on a canvas: radialBlurSpec)', () => {
    for (const blurType of ['spin', 'zoom'] as const) {
      expect(blurFilterSpec({ item: { ...item, blurType, blurX: 0.3 }, renderScale: 0.25, ...CANVAS, scaleX: 1, scaleY: 1 }, null)).toBeNull()
    }
  })
})

describe('radialBlurSpec', () => {
  const video = (over: Partial<VisualItem> = {}) =>
    ({ id: 'v', type: 'video', start: 0, end: 1, blur: 30, blurType: 'spin', blurX: 0.3, blurY: 0.6, ...over }) as VisualItem
  const image = (over: Partial<VisualItem> = {}) =>
    ({ id: 'i', type: 'image', start: 0, end: 1, blur: 40, blurType: 'zoom', ...over }) as VisualItem
  const at = (item: VisualItem, over: Record<string, unknown> = {}) =>
    ({ item, renderScale: 0.25, ...CANVAS, scaleX: 1, scaleY: 1, ...over })
  const h = (9 / 16) / (16 / 9)

  it('uniform, linear or no blur: null', () => {
    expect(radialBlurSpec(at(video({ blurType: undefined })), { w: 1920, h: 1080 })).toBeNull()
    expect(radialBlurSpec(at(video({ blurType: 'linear' })), { w: 1920, h: 1080 })).toBeNull()
    expect(radialBlurSpec(at(video({ blur: 0 })), { w: 1920, h: 1080 })).toBeNull()
  })

  it('a video: type, amount, centre; the footage contain-fitted in the box; the whole source', () => {
    const r = radialBlurSpec(at(video({ sourceWidth: 1920, sourceHeight: 1080 }), { scaleX: 3.2, scaleY: 3.2 }), null)!
    expect([r.type, r.amount, r.center]).toEqual(['spin', 30, { x: 0.3, y: 0.6 }])
    expect(r.pictureRect.x).toBe(0)
    expect(r.pictureRect.h).toBeCloseTo(h, 6)
    expect(r.sourceRect).toBeUndefined()
    // The wrapper's uniform scale is the box's on-screen scale; a per-axis box is 1.
    expect(r.scale).toBe(3.2)
    expect(radialBlurSpec(at(video({ sourceWidth: 1920, sourceHeight: 1080 }), { scaleX: 1, scaleY: 0.5 }), null)!.scale).toBe(1)
  })

  it('a video\'s crop is its source rect only with its stored size (as the export); unknown size: null (sharp until known)', () => {
    const crop = { x: 0.25, y: 0, w: 0.5, h: 1 }
    expect(radialBlurSpec(at(video({ sourceWidth: 1920, sourceHeight: 1080 }), { crop }), null)!.sourceRect).toEqual(crop)
    expect(radialBlurSpec(at(video(), { crop }), { w: 1920, h: 1080 })!.sourceRect).toBeUndefined()
    expect(radialBlurSpec(at(video()), null)).toBeNull()
  })

  it('the engine canvas spans the box: its source rect is the picture\'s rect', () => {
    const r = radialBlurSpec(at(video({ sourceWidth: 1920, sourceHeight: 1080 }), { engineCanvas: true }), null)!
    expect(r.sourceRect).toEqual(r.pictureRect)
  })

  it('a cover image: the whole box, from the centred part of the image at the box\'s aspect; fill: the crop stretched; contain: fitted', () => {
    // A 1000x1000 image in a 9:16 box: the middle 9/16 of its width.
    const cover = radialBlurSpec(at(image(), { fit: 'cover' }), { w: 1000, h: 1000 })!
    expect(cover.pictureRect).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(cover.sourceRect!.w).toBeCloseTo(9 / 16, 6)
    expect(cover.sourceRect!.x).toBeCloseTo((1 - 9 / 16) / 2, 6)
    expect(cover.sourceRect!.h).toBe(1)
    expect(radialBlurSpec(at(image(), { fit: 'cover' }), null)).toBeNull()
    const crop = { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }
    expect(radialBlurSpec(at(image(), { fit: 'fill', crop }), null)).toMatchObject({ pictureRect: { x: 0, y: 0, w: 1, h: 1 }, sourceRect: crop })
    const contain = radialBlurSpec(at(image(), { fit: 'contain', crop }), { w: 1000, h: 1000 })!
    expect(contain.sourceRect).toEqual(crop)
    expect(contain.pictureRect.w).toBe(1)
    expect(contain.pictureRect.h).toBeCloseTo(9 / 16, 6)
  })
})

describe('pictureSizeFor', () => {
  const video = (over: Partial<VisualItem> = {}) => ({ id: 'v', type: 'video', start: 0, end: 1, ...over }) as VisualItem
  const image = (over: Partial<VisualItem> = {}) => ({ id: 'i', type: 'image', start: 0, end: 1, ...over }) as VisualItem

  it('a cover or fill image fills its box: null', () => {
    expect(pictureSizeFor(image(), undefined, 'cover', { w: 100, h: 50 })).toBeNull()
    expect(pictureSizeFor(image(), undefined, 'fill', { w: 100, h: 50 })).toBeNull()
  })
  it('a contain image: its natural size, cropped', () => {
    expect(pictureSizeFor(image(), undefined, 'contain', { w: 100, h: 50 })).toEqual({ w: 100, h: 50 })
    expect(pictureSizeFor(image(), { x: 0, y: 0, w: 0.5, h: 1 }, 'contain', { w: 100, h: 50 })).toEqual({ w: 50, h: 50 })
  })
  it('a video: its stored size (cropped), else the probed one, uncropped without a stored size (as the export)', () => {
    expect(pictureSizeFor(video({ sourceWidth: 1920, sourceHeight: 1080 }), undefined, undefined, null)).toEqual({ w: 1920, h: 1080 })
    expect(pictureSizeFor(video({ sourceWidth: 1920, sourceHeight: 1080 }), { x: 0, y: 0, w: 0.25, h: 1 }, undefined, null))
      .toEqual({ w: 480, h: 1080 })
    expect(pictureSizeFor(video(), { x: 0, y: 0, w: 0.25, h: 1 }, undefined, { w: 960, h: 540 })).toEqual({ w: 960, h: 540 })
    expect(pictureSizeFor(video(), undefined, undefined, null)).toBeNull()
  })
})

// ── Through the real layers ─────────────────────────────────────────────────

const emptySnap = { x: false, y: false, left: false, right: false, top: false, bottom: false }

function filterOf(el: HTMLElement): SVGFilterElement {
  const m = /^url\("?#([^")]+)"?\)$/.exec(el.style.filter)
  expect(m, `filter style ${el.style.filter}`).not.toBeNull()
  const f = document.getElementById(m![1]) as unknown as SVGFilterElement
  expect(f).not.toBeNull()
  return f
}

describe('OverlayItemsLayer — a clip\'s blur', () => {
  const RENDER_SCALE = 0.2

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {})
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  function renderLayer(items: VisualItem[]) {
    const tracks = [[{ id: 'base', type: 'video', src: 'base.mp4', start: 0, end: 10, inPoint: 0 } as VisualItem], items]
    const project = { id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks } as unknown as EditorProject
    return render(
      <OverlayItemsLayer
        project={project}
        currentTime={5}
        isPlaying={false}
        isCanvasProject={false}
        overlayTracks={tracks.slice(1)}
        tracks0NonVideo={[]}
        renderScale={RENDER_SCALE}
        selectedOverlayId={undefined}
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
  }

  it('a blurred video: the filter on its media box, cut to the footage, renormalised, at the scaled sigma, in sRGB', () => {
    const card = { id: 'bg', type: 'video', src: 'bg.mp4', start: 0, end: 10, inPoint: 0, scale: 3.2, blur: 40,
      sourceWidth: 960, sourceHeight: 540 } as VisualItem
    const { container } = renderLayer([card])
    const mediaBox = mediaBoxOf(container.querySelector('video[src="bg.mp4"]') as HTMLElement)
    const f = filterOf(mediaBox)
    expect(f.getAttribute('filterUnits')).toBe('objectBoundingBox')
    expect(f.getAttribute('color-interpolation-filters')).toBe('sRGB')
    const h = (9 / 16) / (16 / 9)
    expect(Number(f.getAttribute('x'))).toBe(0)
    expect(Number(f.getAttribute('width'))).toBe(1)
    expect(Number(f.getAttribute('height'))).toBeCloseTo(h, 3)
    expect(Number(f.getAttribute('y'))).toBeCloseTo((1 - h) / 2, 3)
    // The primitives, in order: cut to the picture, blur, renormalise, alpha back.
    expect([...f.children].map(c => c.tagName)).toEqual(['feFlood', 'feComposite', 'feGaussianBlur', 'feColorMatrix', 'feComposite'])
    const [flood, cut, blur, renorm, back] = [...f.children]
    // The footage's rect in the media box's own pixels (the frame, 216 x 384).
    expect(Number(flood.getAttribute('x'))).toBe(0)
    expect(Number(flood.getAttribute('width'))).toBeCloseTo(216, 3)
    expect(Number(flood.getAttribute('y'))).toBeCloseTo(384 * (1 - h) / 2, 3)
    expect(Number(flood.getAttribute('height'))).toBeCloseTo(384 * h, 3)
    expect(flood.getAttribute('flood-color')).toBe('#fff')
    expect([cut.getAttribute('in'), cut.getAttribute('in2'), cut.getAttribute('operator')])
      .toEqual(['SourceGraphic', flood.getAttribute('result'), 'in'])
    expect(blur.getAttribute('in')).toBe(cut.getAttribute('result'))
    // 40 design px at 0.2 screen px each, under the wrapper's scale(3.2).
    expect(Number(blur.getAttribute('stdDeviation'))).toBeCloseTo(40 * RENDER_SCALE / 3.2, 4)
    expect(renorm.getAttribute('values')!.split(/\s+/).map(Number)).toEqual([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1])
    expect([back.getAttribute('in'), back.getAttribute('in2'), back.getAttribute('operator')])
      .toEqual([renorm.getAttribute('result'), cut.getAttribute('result'), 'in'])
    // The SVG renders after the media, inside the box.
    expect(mediaBox.lastElementChild?.tagName.toLowerCase()).toBe('svg')
  })

  it('a blurred cover image: the whole box is the region', () => {
    const img = { id: 'im', type: 'image', src: 'im.png', start: 0, end: 10, scaleX: 0.8, scaleY: 0.5, blur: 25 } as VisualItem
    const { container } = renderLayer([img])
    const mediaBox = mediaBoxOf(container.querySelector('img[src="im.png"]') as HTMLElement)
    const f = filterOf(mediaBox)
    expect([f.getAttribute('x'), f.getAttribute('y'), f.getAttribute('width'), f.getAttribute('height')]).toEqual(['0', '0', '1', '1'])
    // Per-axis: net scale 1, the screen sigma as is.
    expect(Number(f.querySelector('feGaussianBlur')!.getAttribute('stdDeviation'))).toBeCloseTo(25 * RENDER_SCALE, 4)
  })

  it('a linear blur: the media box cuts to the picture; the turned wrapper blurs along its x; the turned-back one cuts the source', () => {
    const card = { id: 'bg', type: 'video', src: 'bg.mp4', start: 0, end: 10, inPoint: 0, scale: 0.5, blur: 40,
      blurType: 'linear', blurAngle: 30, sourceWidth: 1920, sourceHeight: 1080 } as VisualItem
    const { container } = renderLayer([card])
    const video = container.querySelector('video[src="bg.mp4"]') as HTMLElement
    const mediaBox = mediaBoxOf(video)
    const turn = mediaBox.querySelector('[data-montaj-blur-turn]') as HTMLElement
    const back = turn.querySelector('[data-montaj-blur-back]') as HTMLElement
    expect(back.contains(video)).toBe(true)
    // No filter on the media box itself: the cut to the 16:9 band, axis-aligned.
    expect(mediaBox.style.filter).toBe('')
    const h = (9 / 16) / (16 / 9)
    const top = Math.round(((1 - h) / 2) * 1e6) / 1e4
    expect(mediaBox.style.clipPath).toBe(`inset(${top}% 0% ${top}% 0%)`)
    expect(turn.style.transform).toBe('rotate(30deg)')
    expect(back.style.transform).toBe('rotate(-30deg)')
    const blur = filterOf(turn)
    expect(blur.getAttribute('data-montaj-blur-angle')).toBe('30')
    // Along x only, at the screen sigma over the wrapper's scale (0.5).
    const sd = blur.querySelector('feGaussianBlur')!.getAttribute('stdDeviation')!.split(' ').map(Number)
    expect(sd[0]).toBeCloseTo(40 * RENDER_SCALE / 0.5, 4)
    expect(sd[1]).toBe(0)
    expect(blur.querySelector('feColorMatrix')!.getAttribute('values')).toBe('1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1')
    expect(blur.querySelector('feMorphology')!.getAttribute('radius')).toBe('2')
    const cut = filterOf(back)
    expect(cut.querySelector('feFlood')).not.toBeNull()
    expect(Number(cut.getAttribute('height'))).toBeCloseTo(h, 3)
  })

  it('the wrappers are always there, inert without a linear blur, and the media never remounts as the blur changes', () => {
    const base = { id: 'bg', type: 'video', src: 'bg.mp4', start: 0, end: 10, inPoint: 0, scale: 0.5 } as VisualItem
    const { container, rerender } = renderLayer([base])
    const video = container.querySelector('video[src="bg.mp4"]') as HTMLElement
    const turn = () => container.querySelector('[data-montaj-blur-turn]') as HTMLElement
    expect(turn().style.display).toBe('contents')
    expect((turn().firstElementChild as HTMLElement).style.display).toBe('contents')
    const again = (item: VisualItem) => {
      const tracks = [[{ id: 'base', type: 'video', src: 'base.mp4', start: 0, end: 10, inPoint: 0 } as VisualItem], [item]]
      const project = { id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks } as unknown as EditorProject
      rerender(
        <OverlayItemsLayer project={project} currentTime={5} isPlaying={false} isCanvasProject={false}
          overlayTracks={tracks.slice(1)} tracks0NonVideo={[]} renderScale={RENDER_SCALE} selectedOverlayId={undefined}
          containerRef={{ current: document.createElement('div') }} dragState={null} setDragState={vi.fn()}
          liveOffset={null} liveScale={null} liveRotation={null} snapGuides={emptySnap} snapRotation={null}
          compileOverlay={vi.fn(async (): Promise<OverlayFactory> => () => null)} fileUrl={(pth: string) => pth} />,
      )
    }
    again({ ...base, blur: 40 })
    expect(container.querySelector('video[src="bg.mp4"]')).toBe(video)
    again({ ...base, blur: 40, blurType: 'linear', blurAngle: 45 })
    expect(container.querySelector('video[src="bg.mp4"]')).toBe(video)
    expect(turn().style.transform).toBe('rotate(45deg)')
    again(base)
    expect(container.querySelector('video[src="bg.mp4"]')).toBe(video)
    expect(turn().style.display).toBe('contents')
  })

  it('spin and zoom: no SVG filter; without WebGL2 (jsdom) no surface either, the clip shows sharp', () => {
    const card = { id: 'bg', type: 'video', src: 'bg.mp4', start: 0, end: 10, inPoint: 0, scale: 0.5, blur: 40, blurType: 'zoom',
      sourceWidth: 1920, sourceHeight: 1080 } as VisualItem
    const { container } = renderLayer([card])
    const video = container.querySelector('video[src="bg.mp4"]') as HTMLElement
    const mediaBox = mediaBoxOf(video)
    expect(mediaBox.style.filter).toBe('')
    expect(container.querySelector('filter[data-montaj-blur]')).toBeNull()
    expect(container.querySelector('canvas[data-montaj-radial-blur]')).toBeNull()
    expect((mediaBox.querySelector('[data-montaj-blur-back]') as HTMLElement).style.opacity).toBe('')
  })

  it('no blur: no filter and no SVG (unchanged)', () => {
    const card = { id: 'bg', type: 'video', src: 'bg.mp4', start: 0, end: 10, inPoint: 0, scale: 0.5 } as VisualItem
    const { container } = renderLayer([card])
    const mediaBox = mediaBoxOf(container.querySelector('video[src="bg.mp4"]') as HTMLElement)
    expect(mediaBox.style.filter).toBe('')
    expect(container.querySelector('filter[data-montaj-blur]')).toBeNull()
  })
})

describe('PreviewPlayer — the base clip\'s blur', () => {
  const FRAME_W = 270
  const FRAME_H = 480

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
  afterEach(() => vi.restoreAllMocks())

  it('the blurred base clip filters its media box at blur x renderScale / scale', () => {
    const item = { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, scale: 3.2, blur: 40,
      sourceWidth: 960, sourceHeight: 540 } as VisualItem
    const project = { id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [[item]] } as unknown as EditorProject
    const { container } = render(
      <PreviewPlayer project={project} clock={createPlaybackClock(1)} compileOverlay={async () => (() => null) as never} fileUrl={(p) => p} />,
    )
    const mediaBox = mediaBoxOf(container.querySelector('video') as HTMLElement)
    const f = filterOf(mediaBox)
    // renderScale = 270 / 1080 = 0.25: 40 design px are 10 screen px, 3.125 under scale(3.2).
    expect(Number(f.querySelector('feGaussianBlur')!.getAttribute('stdDeviation'))).toBeCloseTo(40 * (FRAME_W / 1080) / 3.2, 4)
    expect(Number(f.getAttribute('height'))).toBeCloseTo((9 / 16) / (16 / 9), 3)
  })

  it('a linear base clip turns its wrappers around the slots, the media box cut to the footage', () => {
    const item = { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, scale: 3.2, blur: 40,
      blurType: 'linear', blurAngle: 120, sourceWidth: 960, sourceHeight: 540 } as VisualItem
    const project = { id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [[item]] } as unknown as EditorProject
    const { container } = render(
      <PreviewPlayer project={project} clock={createPlaybackClock(1)} compileOverlay={async () => (() => null) as never} fileUrl={(p) => p} />,
    )
    const videos = container.querySelectorAll('video')
    expect(videos).toHaveLength(2)
    const mediaBox = mediaBoxOf(videos[0])
    expect(mediaBoxOf(videos[1])).toBe(mediaBox)
    expect(mediaBox.style.clipPath).toMatch(/^inset\(/)
    const turn = mediaBox.querySelector('[data-montaj-blur-turn]') as HTMLElement
    expect(turn.style.transform).toBe('rotate(120deg)')
    const sd = filterOf(turn).querySelector('feGaussianBlur')!.getAttribute('stdDeviation')!.split(' ').map(Number)
    expect(sd[0]).toBeCloseTo(40 * (FRAME_W / 1080) / 3.2, 4)
    expect(sd[1]).toBe(0)
  })
})
