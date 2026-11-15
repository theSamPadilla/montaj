/**
 * §733: the transport handle's `setRate` (the J/K/L shuttle) on the legacy
 * `<video>` path. It used to be a no-op there, so the shuttle's 1.5x/2x/4x
 * showed in the badge and the preview played on at 1x. Now it reaches the
 * legacy hook (its slots), and the overlay layer's videos follow it too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import PreviewPlayer, { type TransportHandle } from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import type { EditorProject as Project } from '../../../schema'

// No proxySrc and no engine: the legacy <video> path.
function makeProject(): Project {
  return {
    id: 'p-legacy',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [
      [{ id: 'base', type: 'video', src: 'base.mp4', start: 0, end: 4, inPoint: 0, outPoint: 6, speed: 1.5 }],
      [{ id: 'over', type: 'video', src: 'over.mp4', start: 0, end: 4, inPoint: 0, outPoint: 8, speed: 2 }],
    ],
  } as unknown as Project
}

let rates: WeakMap<HTMLMediaElement, number>
let restore: () => void = () => {}
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
    state = 'running'
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createMediaElementSource() { return { connect() {}, disconnect() {} } }
    get destination() { return {} }
    resume() { return Promise.resolve() }
    close() {}
  }
  // Chrome's rate setter and a play()/pause() jsdom lacks.
  rates = new WeakMap()
  const proto = HTMLMediaElement.prototype
  const rate = Object.getOwnPropertyDescriptor(proto, 'playbackRate')
  const play = proto.play, pause = proto.pause
  Object.defineProperty(proto, 'playbackRate', {
    configurable: true,
    get() { return rates.get(this) ?? 1 },
    set(v: number) {
      if (!(v >= 0.0625 && v <= 16)) throw new DOMException(`The provided playback rate (${v}) is not in the supported playback range.`, 'NotSupportedError')
      rates.set(this, v)
    },
  })
  proto.play = function () { return Promise.resolve() }
  proto.pause = function () {}
  restore = () => {
    if (rate) Object.defineProperty(proto, 'playbackRate', rate)
    proto.play = play
    proto.pause = pause
  }
})
afterEach(() => { restore(); vi.restoreAllMocks() })

function videoBySrc(container: HTMLElement, name: string): HTMLVideoElement {
  const v = [...container.querySelectorAll('video')].find((el) => (el.getAttribute('src') ?? '').includes(name))
  if (!v) throw new Error(`no <video> for ${name}`)
  return v
}

describe('PreviewPlayer: the shuttle rate on the legacy path', () => {
  it('the transport handle\'s setRate reaches the legacy slots and the overlay videos', () => {
    const transportRef: MutableRefObject<TransportHandle | null> = { current: null }
    const { container } = render(
      <PreviewPlayer
        project={makeProject()}
        clock={createPlaybackClock(0)}
        compileOverlay={async () => (() => null) as never}
        fileUrl={(p) => p}
        transportRef={transportRef}
      />,
    )
    const base = videoBySrc(container, 'base.mp4')
    const over = videoBySrc(container, 'over.mp4')
    expect(over.playbackRate).toBe(2)

    act(() => { transportRef.current!.setRate(2) })
    expect(base.playbackRate).toBe(3) // speed 1.5 x 2
    expect(over.playbackRate).toBe(4) // speed 2 x 2

    act(() => { transportRef.current!.setRate(1) })
    expect(base.playbackRate).toBe(1.5)
    expect(over.playbackRate).toBe(2)
  })
})
