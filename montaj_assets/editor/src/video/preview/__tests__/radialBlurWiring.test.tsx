/// <reference types="vitest/globals" />
import { act, render } from '@testing-library/react'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import OverlayItemsLayer from '../OverlayItemsLayer'
import PreviewPlayer from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import { BlurWrappers, blurSourceIn, type ItemBlurParts } from '../itemBlur'
import { drawRadialBlur } from '../radialBlurGL'
import { mediaBoxOf } from './mediaBox'

// Where the preview's spin and zoom surface goes and what it reads
// (itemBlur.tsx `BlurWrappers`): a RadialBlurSurface canvas inside the clip's
// media box, after the blur wrappers, drawing from the media they hold; once
// it draws, the back wrapper turns to opacity 0, so the media stays mounted
// (and decoding, and routing its audio) unseen; on failure the media shows.
// WebGL itself is measured in a real Chromium (editor/browser/radial-blur.test.mjs);
// here the shared pass is a stub that records what it was asked to draw.

const draws: Array<{ source: unknown; type: string; amount: number; pictureRect: unknown; sourceRect: unknown }> = []
let answer: 'drawn' | 'unsupported' = 'drawn'

vi.mock('../radialBlurGL', async (importOriginal) => {
  const real = await importOriginal<typeof import('../radialBlurGL')>()
  return {
    ...real,
    radialBlurAvailable: () => true,
    onRadialBlurRestored: () => () => {},
    watchVideoFrames: () => () => {},
    drawRadialBlur: vi.fn((job: { source: unknown; type: string; amount: number; pictureRect: unknown; sourceRect: unknown }) => {
      draws.push(job)
      return answer
    }),
  }
})

const RENDER_SCALE = 0.2
const lastDraw = () => draws[draws.length - 1]
const emptySnap = { x: [], y: [] } as never

function layerFor(items: VisualItem[]) {
  const tracks = [[{ id: 'base', type: 'video', src: 'base.mp4', start: 0, end: 10, inPoint: 0 } as VisualItem], items]
  const project = { id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks } as unknown as EditorProject
  return (
    <OverlayItemsLayer project={project} currentTime={5} isPlaying={false} isCanvasProject={false}
      overlayTracks={tracks.slice(1)} tracks0NonVideo={[]} renderScale={RENDER_SCALE} selectedOverlayId={undefined}
      containerRef={{ current: document.createElement('div') }} dragState={null} setDragState={vi.fn()}
      liveOffset={null} liveScale={null} liveRotation={null} snapGuides={emptySnap} snapRotation={null}
      compileOverlay={vi.fn(async (): Promise<OverlayFactory> => () => null)} fileUrl={(pth: string) => pth} />
  )
}

const back = (mediaBox: Element) => mediaBox.querySelector('[data-montaj-blur-back]') as HTMLElement

beforeEach(() => {
  draws.length = 0
  answer = 'drawn'
  vi.mocked(drawRadialBlur).mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('spin and zoom on overlay-track clips', () => {
  const card = { id: 'bg', type: 'video', src: 'bg.mp4', start: 0, end: 10, inPoint: 0, scale: 3.2,
    sourceWidth: 1920, sourceHeight: 1080 } as VisualItem

  it('a video: the surface in its media box reads the <video>, which stays mounted at opacity 0', () => {
    const { container } = render(layerFor([{ ...card, blur: 30, blurType: 'spin', blurX: 0.3, blurY: 0.6 }]))
    const video = container.querySelector('video[src="bg.mp4"]') as HTMLVideoElement
    const mediaBox = mediaBoxOf(video)
    const surface = mediaBox.querySelector('canvas[data-montaj-radial-blur="spin"]')
    expect(surface).not.toBeNull()
    // After the wrappers, so it paints over them, inside the box the mask cuts.
    expect(mediaBox.querySelector('[data-montaj-blur-turn]')!.compareDocumentPosition(surface!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const last = lastDraw()
    expect(last.source).toBe(video)
    expect([last.type, last.amount]).toEqual(['spin', 30])
    expect((last.pictureRect as { h: number }).h).toBeCloseTo((9 / 16) / (16 / 9), 6)
    expect(back(mediaBox).style.opacity).toBe('0')
    expect(back(mediaBox).contains(video)).toBe(true)
    // No SVG filter for these.
    expect(mediaBox.style.filter).toBe('')
  })

  it('an image: the surface reads the <img>, kept mounted at opacity 0', () => {
    const img = { id: 'im', type: 'image', src: 'im.png', start: 0, end: 10, scale: 1, blur: 40, blurType: 'zoom', fit: 'fill' } as VisualItem
    const { container } = render(layerFor([img]))
    const el = container.querySelector('img[src="im.png"]') as HTMLImageElement
    expect(lastDraw().source).toBe(el)
    expect(back(mediaBoxOf(el)).style.opacity).toBe('0')
  })

  it('the media never remounts as the type changes (uniform, spin, zoom, linear, none), and shows again off spin and zoom', () => {
    const { container, rerender } = render(layerFor([{ ...card, blur: 40 }]))
    const video = container.querySelector('video[src="bg.mp4"]')
    const steps: Array<[Partial<VisualItem>, string]> = [
      [{ blur: 30, blurType: 'spin' }, '0'],
      [{ blur: 40, blurType: 'zoom' }, '0'],
      [{ blur: 40, blurType: 'linear', blurAngle: 30 }, ''],
      [{ blur: 25, blurType: 'spin', blurX: 0.1 }, '0'],
      [{}, ''],
    ]
    for (const [over, opacity] of steps) {
      rerender(layerFor([{ ...card, ...over }]))
      expect(container.querySelector('video[src="bg.mp4"]')).toBe(video)
      expect(back(mediaBoxOf(video!)).style.opacity).toBe(opacity)
      expect(!!container.querySelector('canvas[data-montaj-radial-blur]')).toBe(opacity === '0')
    }
  })

  it('failure (no WebGL2, a lost context, a cross-origin source): no surface, the media shows unblurred', () => {
    answer = 'unsupported'
    const { container } = render(layerFor([{ ...card, blur: 30, blurType: 'spin' }]))
    const video = container.querySelector('video[src="bg.mp4"]') as HTMLElement
    expect(container.querySelector('canvas[data-montaj-radial-blur]')).toBeNull()
    expect(back(mediaBoxOf(video)).style.opacity).toBe('')
  })
})

describe('spin and zoom on the base clip', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      constructor(private cb: (entries: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 270, height: 480 } }]) }
      unobserve() {}
      disconnect() {}
    }
    ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
      state = 'running'
      createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
      createMediaElementSource() { return { connect() {}, disconnect() {} } }
      get destination() { return {} }
      close() {}
    }
  })

  it('the legacy path: the surface reads the active <video> slot, marked data-montaj-blur-source; both slots stay mounted', () => {
    const item = { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 10, inPoint: 0, scale: 3.2, blur: 40, blurType: 'zoom',
      sourceWidth: 960, sourceHeight: 540 } as VisualItem
    const project = { id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [[item]] } as unknown as EditorProject
    const { container } = render(
      <PreviewPlayer project={project} clock={createPlaybackClock(1)} compileOverlay={async () => (() => null) as never} fileUrl={(p) => p} />,
    )
    const videos = container.querySelectorAll('video')
    expect(videos).toHaveLength(2)
    const active = container.querySelector('video[data-montaj-blur-source]')
    expect(active).toBe(videos[0])
    expect(lastDraw().source).toBe(active)
    const mediaBox = mediaBoxOf(videos[0])
    expect(mediaBox.querySelector('canvas[data-montaj-radial-blur="zoom"]')).not.toBeNull()
    expect(back(mediaBox).style.opacity).toBe('0')
    // The legacy <video> path keeps a transparent letterbox: nothing behind the surface.
    expect(mediaBox.querySelector('[data-montaj-blur-backing]')).toBeNull()
  })
})

describe('BlurWrappers on the engine canvas', () => {
  const parts = (over: Partial<NonNullable<ItemBlurParts['radial']>> = {}): ItemBlurParts => ({
    style: {}, turnStyle: { display: 'contents' }, backStyle: { display: 'contents' }, defs: null,
    radial: { type: 'spin', amount: 30, center: { x: 0.5, y: 0.5 }, pictureRect: { x: 0, y: 0.3, w: 1, h: 0.4 },
      sourceRect: { x: 0, y: 0.3, w: 1, h: 0.4 }, scale: 1, playing: false, ...over },
  })

  it('reads the engine canvas, redraws on each paint, and keeps the black bars under the surface', () => {
    let paint: (() => void) | null = null
    const redraw = vi.fn((fn: () => void) => { paint = fn; return () => { paint = null } })
    const { container, unmount } = render(
      <div>
        <BlurWrappers blur={parts()} redraw={redraw} backing="#000">
          <canvas data-montaj-engine-canvas="" />
        </BlurWrappers>
      </div>,
    )
    const canvas = container.querySelector('canvas[data-montaj-engine-canvas]')
    expect(lastDraw().source).toBe(canvas)
    expect(lastDraw().sourceRect).toEqual({ x: 0, y: 0.3, w: 1, h: 0.4 })
    expect(redraw).toHaveBeenCalled()
    const before = draws.length
    act(() => paint!())
    expect(draws.length).toBe(before + 1)
    const backing = container.querySelector('[data-montaj-blur-backing]') as HTMLElement
    expect(backing.style.background).toMatch(/^(#000|rgb\(0, 0, 0\))$/)
    // Under the surface: before it in the box.
    expect(backing.compareDocumentPosition(container.querySelector('canvas[data-montaj-radial-blur]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    unmount()
    expect(paint).toBeNull()
  })

  it('blurSourceIn: the marked element, else the only <video>, else the <img>, else the engine canvas', () => {
    const root = document.createElement('div')
    root.innerHTML = '<video></video><video data-montaj-blur-source=""></video>'
    expect(blurSourceIn(root)).toBe(root.querySelectorAll('video')[1])
    root.innerHTML = '<video></video><img>'
    expect(blurSourceIn(root)).toBe(root.querySelector('video'))
    root.innerHTML = '<div><img></div>'
    expect(blurSourceIn(root)).toBe(root.querySelector('img'))
    root.innerHTML = '<canvas data-montaj-engine-canvas=""></canvas>'
    expect(blurSourceIn(root)).toBe(root.querySelector('canvas'))
    expect(blurSourceIn(null)).toBeNull()
  })
})
