/**
 * PreviewPlayer derives the overlay scale from the observed container width and
 * the CURRENT design canvas. The observer used to be set up once with the first
 * render's canvas width, so a resolution change while mounted scaled overlays
 * against the old canvas until the container happened to resize.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import PreviewPlayer from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import type { EditorProject as Project, VisualItem } from '../../../schema'

const layerProps: Array<Record<string, unknown>> = []
vi.mock('../OverlayItemsLayer', () => ({
  default: (props: Record<string, unknown>) => { layerProps.push(props); return null },
}))
vi.mock('../CaptionPreview', () => ({ default: () => null }))

const observers: Array<(entries: unknown[]) => void> = []

const clip = { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0 } as unknown as VisualItem

function projectAt(resolution: [number, number]) {
  return {
    id: 'p', status: 'draft',
    settings: { resolution, fps: 30 },
    tracks: [[clip]],
  } as unknown as Project
}

const ui = (project: Project, clock: ReturnType<typeof createPlaybackClock>) => (
  <PreviewPlayer project={project} clock={clock} compileOverlay={async () => (() => null) as never} fileUrl={(p) => p} />
)

const lastScale = () => layerProps[layerProps.length - 1].renderScale

beforeEach(() => {
  layerProps.length = 0
  observers.length = 0
  vi.spyOn(console, 'info').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(cb: (entries: unknown[]) => void) { observers.push(cb) }
    observe() {}
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

afterEach(() => { vi.restoreAllMocks() })

describe('PreviewPlayer — overlay scale', () => {
  it('is 1 before the observer fires', () => {
    render(ui(projectAt([1080, 1920]), createPlaybackClock(0)))
    expect(lastScale()).toBe(1)
  })

  it('9:16: observed width / 1080', () => {
    render(ui(projectAt([1080, 1920]), createPlaybackClock(0)))
    act(() => { observers.forEach((cb) => cb([{ contentRect: { width: 540, height: 960 } }])) })
    expect(lastScale()).toBe(540 / 1080)
  })

  it('follows a resolution change without the observer firing again', () => {
    const clock = createPlaybackClock(0)
    const { rerender } = render(ui(projectAt([1080, 1920]), clock))
    act(() => { observers.forEach((cb) => cb([{ contentRect: { width: 540, height: 960 } }])) })
    expect(lastScale()).toBe(540 / 1080)
    rerender(ui(projectAt([1920, 1080]), clock))
    expect(lastScale()).toBe(540 / 1920)
  })
})
