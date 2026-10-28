/// <reference types="vitest/globals" />
import { render } from '@testing-library/react'
import { maskAt, maskSvg, opacityAt } from '@bycrux/timeline-core'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import OverlayItemsLayer from '../OverlayItemsLayer'

// §616 — a clip's keyframed opacity, its mask (with feather) and its blend
// mode in the preview, through the real OverlayItemsLayer. Every expected
// value comes from the timeline-core functions the export samples.
//
// Where each lands, and why:
//   - opacity and mix-blend-mode on the item's WRAPPER: it is a direct child of
//     the preview frame, the stacking context the base clip and the lower
//     tracks paint into, so the blend sees them as its backdrop. Put on
//     anything inside the wrapper, the blend would see only the wrapper (whose
//     transform makes it its own isolated group) and do nothing.
//   - the mask on the item's MEDIA BOX: its CSS box IS the item's box (frame x
//     scaleX by frame x scaleY on a per-axis item, the full frame under a
//     uniform scale), so the SVG's viewBox maps onto it without distortion and
//     the feather stays round under a per-axis scale. It also keeps the mask
//     off the selection outline and handles, which the wrapper carries.

const emptySnap = { x: false, y: false, left: false, right: false, top: false, bottom: false }
const RENDER_SCALE = 0.2
// The preview frame in pixels: the 1080x1920 design canvas at RENDER_SCALE.
const FRAME_W = 1080 * RENDER_SCALE
const FRAME_H = 1920 * RENDER_SCALE

const FADE_IN = [{ prop: 'opacity' as const, points: [{ t: 0, value: 0 }, { t: 8, value: 1 }] }]
const MASK = { shape: 'ellipse' as const, x: 0.5, y: 0.4, w: 0.7, h: 0.5, feather: 0.08 }

function maskImageFor(item: VisualItem, localT: number, boxW: number, boxH: number): string {
  return `url("data:image/svg+xml,${encodeURIComponent(maskSvg(maskAt(item, localT)!, boxW, boxH))}")`
}

function renderProject(tracks: VisualItem[][], currentTime: number) {
  const project = {
    id: 'p',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks,
  } as unknown as EditorProject
  const utils = render(
    <OverlayItemsLayer
      project={project}
      currentTime={currentTime}
      isPlaying={false}
      isCanvasProject={false}
      overlayTracks={tracks.slice(1)}
      tracks0NonVideo={tracks[0].filter(i => i.type !== 'video')}
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
  // An image or video sits in its media box, inside its wrapper.
  const mediaOf = (sel: string) => {
    const el = utils.container.querySelector(sel) as HTMLElement
    const mediaBox = el.parentElement as HTMLElement
    return { mediaBox, wrapper: mediaBox.parentElement as HTMLElement }
  }
  return { ...utils, mediaOf }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('OverlayItemsLayer — clip compositing (§616)', () => {
  const NOW = 5

  const base = { id: 'base', type: 'video', src: 'base.mp4', start: 0, end: 10, inPoint: 0 } as VisualItem
  const bg = {
    id: 'bg', type: 'image', src: 'bg.png', start: 1, end: 9,
    blendMode: 'screen', mask: MASK, keyframes: FADE_IN,
  } as VisualItem
  const mid = {
    id: 'mid', type: 'image', src: 'mid.png', start: 1, end: 9,
    scaleX: 0.5, scaleY: 0.8,
    blendMode: 'screen', mask: MASK, keyframes: FADE_IN,
  } as VisualItem
  const top = {
    id: 'top', type: 'video', src: 'top.mp4', start: 1, end: 9, inPoint: 0,
    scale: 0.6,
    blendMode: 'screen', mask: { ...MASK, shape: 'rect' as const, radius: 0.4 }, keyframes: FADE_IN,
  } as VisualItem

  const cases: Array<[string, VisualItem, string, number, number]> = [
    ['an image on track 0', bg, 'img[src="bg.png"]', 1, 1],
    ['an image on track 1 (per-axis)', mid, 'img[src="mid.png"]', 0.5, 0.8],
    ['a video on track 2', top, 'video[src="top.mp4"]', 0.6, 0.6],
  ]

  for (const [label, item, sel, sx, sy] of cases) {
    it(`${label}: keyframed opacity and the blend on the wrapper, the mask on the media box`, () => {
      const { mediaOf } = renderProject([[base, bg], [mid], [top]], NOW)
      const { mediaBox, wrapper } = mediaOf(sel)
      const localT = NOW - item.start

      expect(wrapper.style.opacity).toBe(String(opacityAt(item, localT)))
      expect(Number(wrapper.style.opacity)).toBeCloseTo(0.5)
      expect(wrapper.style.mixBlendMode).toBe('screen')
      expect(wrapper.style.maskImage).toBe('')

      // The item's box in preview pixels.
      expect(mediaBox.style.maskImage).toBe(maskImageFor(item, localT, FRAME_W * sx, FRAME_H * sy))
      expect(mediaBox.style.maskSize).toBe('100% 100%')
      expect(mediaBox.style.maskRepeat).toBe('no-repeat')
      expect(mediaBox.style.maskMode).toBe('luminance')
      expect(mediaBox.style.mixBlendMode).toBe('')
    })
  }

  it('the media box is laid out at the box itself on a per-axis item, so the mask is not stretched', () => {
    const { mediaOf } = renderProject([[base], [mid], []], NOW)
    const { mediaBox } = mediaOf('img[src="mid.png"]')
    expect(mediaBox.style.width).toBe('50%')
    expect(mediaBox.style.height).toBe('80%')
  })

  it('a keyframed mask moves with the playhead', () => {
    const item = {
      ...mid,
      keyframes: [{ prop: 'maskX' as const, points: [{ t: 0, value: 0.1 }, { t: 8, value: 0.9 }] }],
    } as VisualItem
    const at3 = renderProject([[base], [item], []], 3)
    const m3 = at3.mediaOf('img[src="mid.png"]').mediaBox.style.maskImage
    at3.unmount()
    const at7 = renderProject([[base], [item], []], 7)
    const m7 = at7.mediaOf('img[src="mid.png"]').mediaBox.style.maskImage
    expect(m3).toBe(maskImageFor(item, 2, FRAME_W * 0.5, FRAME_H * 0.8))
    expect(m7).toBe(maskImageFor(item, 6, FRAME_W * 0.5, FRAME_H * 0.8))
    expect(m3).not.toBe(m7)
  })

  it('a plain clip carries no mask and no blend', () => {
    const plain = { id: 'plain', type: 'image', src: 'plain.png', start: 0, end: 10 } as VisualItem
    const { mediaOf } = renderProject([[base], [plain], []], NOW)
    const { mediaBox, wrapper } = mediaOf('img[src="plain.png"]')
    expect(wrapper.style.opacity).toBe('1')
    expect(wrapper.style.mixBlendMode).toBe('')
    expect(mediaBox.style.maskImage).toBe('')
  })

  it('the crossfade factor still multiplies a clip\'s keyframed opacity', () => {
    // a: [0,4), b: [3,7) on one track; at t=3.5 the pair is half through (p = 0.5).
    const a = { id: 'a', type: 'image', src: 'a.png', start: 0, end: 4 } as VisualItem
    const b = {
      id: 'b', type: 'image', src: 'b.png', start: 3, end: 7,
      keyframes: [{ prop: 'opacity' as const, points: [{ t: 0, value: 0.4 }, { t: 1, value: 0.8 }] }],
    } as VisualItem
    const { mediaOf } = renderProject([[base], [a, b]], 3.5)
    expect(mediaOf('img[src="a.png"]').wrapper.style.opacity).toBe('1')
    expect(Number(mediaOf('img[src="b.png"]').wrapper.style.opacity)).toBeCloseTo(opacityAt(b, 0.5) * 0.5)
  })

  it('an overlay is unchanged: a stray mask and blend draw nothing, its opacity still animates', () => {
    const overlay = {
      id: 'ov', type: 'overlay', src: 'o.jsx', start: 0, end: 10, props: {},
      mask: MASK, blendMode: 'screen', keyframes: FADE_IN,
    } as unknown as VisualItem
    const { container } = renderProject([[base], [overlay]], 4)
    const wrapper = container.querySelector('div') as HTMLElement
    expect(wrapper.style.opacity).toBe(String(opacityAt(overlay, 4)))
    expect(wrapper.style.mixBlendMode).toBe('')
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('*'))) {
      expect(el.style.maskImage).toBe('')
    }
  })
})
