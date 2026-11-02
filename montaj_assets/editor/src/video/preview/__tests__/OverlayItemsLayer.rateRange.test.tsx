/// <reference types="vitest/globals" />
import { useRef } from 'react'
import { render } from '@testing-library/react'
import type { EditorProject, VisualItem } from '../../../schema'
import type { OverlayFactory } from '../../../types'
import { useDragOverlay } from '../useDragOverlay'
import OverlayItemsLayer from '../OverlayItemsLayer'

// An overlay-track video whose speed no <video> can play. Chrome accepts
// `playbackRate` only in [0.0625, 16] and throws outside it, so an AI-made
// near-freeze (`speed: 0.05`, Sam's b-arm1-paused) crashed the preview panel.
// Such a clip now holds its element paused and follows project time by seeking.

function project(item: VisualItem): EditorProject {
  return {
    id: 'p', status: 'draft', settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [{ id: 'main', items: [] }, { id: 'upper', items: [item] }],
  } as unknown as EditorProject
}

const clip = (over: Partial<VisualItem> = {}): VisualItem => ({
  id: 'b-arm1-paused', type: 'video', src: 'clip.mp4', start: 33.18, end: 36.29, inPoint: 9.24, outPoint: 9.3955, speed: 0.05, ...over,
} as VisualItem)

function Harness({ item, t, playing }: { item: VisualItem; t: number; playing: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const drag = useDragOverlay(containerRef, undefined)
  return (
    <div ref={containerRef}>
      <OverlayItemsLayer
        project={project(item)}
        currentTime={t}
        isPlaying={playing}
        isCanvasProject={false}
        overlayTracks={[[item]]}
        tracks0NonVideo={[]}
        renderScale={0.2}
        containerRef={containerRef}
        dragState={drag.dragState}
        setDragState={drag.setDragState}
        liveOffset={drag.liveOffset}
        liveScale={drag.liveScale}
        liveRotation={drag.liveRotation}
        snapGuides={drag.snapGuides}
        snapRotation={drag.snapRotation}
        compileOverlay={vi.fn(async (): Promise<OverlayFactory> => () => null)}
        fileUrl={(pth: string) => pth}
      />
    </div>
  )
}

// Chrome's rate setter and a play()/pause() that track `paused`, installed on
// the prototype so the element React creates gets them from the first render.
let plays = 0
let restore: () => void = () => {}
beforeEach(() => {
  plays = 0
  const proto = HTMLMediaElement.prototype
  const rate = Object.getOwnPropertyDescriptor(proto, 'playbackRate')
  const paused = Object.getOwnPropertyDescriptor(proto, 'paused')
  const ready = Object.getOwnPropertyDescriptor(proto, 'readyState')
  const play = proto.play, pause = proto.pause
  const state = new WeakMap<HTMLMediaElement, { rate: number; paused: boolean }>()
  const of = (el: HTMLMediaElement) => { let s = state.get(el); if (!s) state.set(el, s = { rate: 1, paused: true }); return s }
  Object.defineProperty(proto, 'playbackRate', {
    configurable: true,
    get() { return of(this).rate },
    set(v: number) {
      if (!(v >= 0.0625 && v <= 16)) throw new DOMException(`The provided playback rate (${v}) is not in the supported playback range.`, 'NotSupportedError')
      of(this).rate = v
    },
  })
  Object.defineProperty(proto, 'paused', { configurable: true, get() { return of(this).paused } })
  Object.defineProperty(proto, 'readyState', { configurable: true, get() { return 4 } })
  proto.play = function () { of(this).paused = false; plays++; return Promise.resolve() }
  proto.pause = function () { of(this).paused = true }
  restore = () => {
    if (rate) Object.defineProperty(proto, 'playbackRate', rate)
    if (paused) Object.defineProperty(proto, 'paused', paused)
    if (ready) Object.defineProperty(proto, 'readyState', ready)
    proto.play = play
    proto.pause = pause
  }
})
afterEach(() => restore())

function videoOf(container: HTMLElement): HTMLVideoElement {
  const video = container.querySelector('video')
  if (!video) throw new Error('no <video> rendered for the overlay-track clip')
  return video
}

describe('OverlayItemsLayer: a video too slow or too fast for a <video> element', () => {
  it('a 0.05x clip renders without throwing and holds paused while the preview plays', () => {
    const { container } = render(<Harness item={clip()} t={34} playing />)
    const v = videoOf(container)
    expect(v.paused).toBe(true)
    expect(plays).toBe(0)
    expect(v.playbackRate).toBe(0.0625)
  })

  it('a 0.05x clip follows project time by seeking to inPoint + 0.05 x elapsed', () => {
    const { container, rerender } = render(<Harness item={clip()} t={34} playing />)
    const v = videoOf(container)
    rerender(<Harness item={clip()} t={35} playing />)
    expect(v.currentTime).toBeCloseTo(9.24 + 0.05 * (35 - 33.18), 6)
    rerender(<Harness item={clip()} t={36} playing />)
    expect(v.currentTime).toBeCloseTo(9.24 + 0.05 * (36 - 33.18), 6)
  })

  it('a 20x clip holds paused and seeks to inPoint + 20 x elapsed', () => {
    const item = clip({ id: 'fast', start: 0, end: 2, inPoint: 0, outPoint: 40, speed: 20 })
    const { container, rerender } = render(<Harness item={item} t={0.5} playing />)
    const v = videoOf(container)
    rerender(<Harness item={item} t={1} playing />)
    expect(v.paused).toBe(true)
    expect(v.playbackRate).toBe(16)
    expect(v.currentTime).toBeCloseTo(20, 6)
  })

  it('an in-range clip still plays at its own speed', () => {
    const { container } = render(<Harness item={clip({ speed: 2, outPoint: 15.46 })} t={34} playing />)
    const v = videoOf(container)
    expect(v.paused).toBe(false)
    expect(v.playbackRate).toBe(2)
  })
})
