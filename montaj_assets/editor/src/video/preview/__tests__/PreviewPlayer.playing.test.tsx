/**
 * `onPlayingChange` — PreviewPlayer pushes the ACTIVE transport's playing
 * state to the host (VideoEditor feeds it to the agent context report). Driven
 * through the same `transportRef` seam the keymap uses, on a canvas project so
 * play/pause is a pure state flip with no media element in the way.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import PreviewPlayer, { type TransportHandle } from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import type { EditorProject as Project } from '../../../schema'

function makeCanvasProject(): Project {
  return {
    id: 'p-canvas',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [[{ id: 'o1', type: 'overlay', src: 'a.jsx', start: 0, end: 4, props: {} }]],
  } as unknown as Project
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
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
})
afterEach(() => { vi.restoreAllMocks() })

describe('PreviewPlayer onPlayingChange', () => {
  it('reports paused on mount, then each real play/pause change', () => {
    const transportRef: MutableRefObject<TransportHandle | null> = { current: null }
    const onPlayingChange = vi.fn()
    render(
      <PreviewPlayer
        project={makeCanvasProject()}
        clock={createPlaybackClock(0)}
        compileOverlay={async () => (() => null) as never}
        fileUrl={(p) => p}
        transportRef={transportRef}
        onPlayingChange={onPlayingChange}
      />,
    )
    expect(onPlayingChange.mock.calls).toEqual([[false]])
    act(() => { transportRef.current!.togglePlay() })
    expect(onPlayingChange.mock.lastCall).toEqual([true])
    act(() => { transportRef.current!.togglePlay() })
    expect(onPlayingChange.mock.lastCall).toEqual([false])
    expect(onPlayingChange).toHaveBeenCalledTimes(3)
  })
})
