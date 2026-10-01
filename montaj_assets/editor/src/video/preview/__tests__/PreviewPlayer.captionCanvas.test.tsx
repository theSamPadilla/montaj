/**
 * PreviewPlayer hands CaptionPreview the project's design canvas: the same
 * `getOverlayDesignCanvas(settings.resolution)` the frame and the overlays are
 * laid out on, and the 1080-short-edge canvas render.js captures captions at.
 * CaptionPreview used a fixed 1080×1920 of its own, which clipped every caption
 * out of a landscape preview (see CaptionPreview.canvas.test.tsx).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import PreviewPlayer from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import type { EditorProject as Project, VisualItem } from '../../../schema'

const captionProps: Array<Record<string, unknown>> = []
vi.mock('../CaptionPreview', () => ({
  default: (props: Record<string, unknown>) => { captionProps.push(props); return null },
}))

const clip = { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0 } as unknown as VisualItem

function renderPreview(resolution: [number, number] | undefined) {
  const project = {
    id: 'p', status: 'draft',
    settings: { ...(resolution ? { resolution } : {}), fps: 30 },
    tracks: [[clip]],
    captions: { style: 'subtitle', segments: [{ id: 'cap-0', text: 'hello', start: 0, end: 2 }] },
  } as unknown as Project
  return render(
    <PreviewPlayer
      project={project}
      clock={createPlaybackClock(0)}
      compileOverlay={async () => (() => null) as never}
      fileUrl={(p) => p}
    />,
  )
}

beforeEach(() => {
  captionProps.length = 0
  vi.spyOn(console, 'info').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PreviewPlayer — caption design canvas', () => {
  it.each([
    ['1920x1080', [1920, 1080], [1920, 1080]],
    ['3840x2160 (design canvas is 1080 short edge, as in render.js)', [3840, 2160], [1920, 1080]],
    ['1080x1920', [1080, 1920], [1080, 1920]],
    ['no resolution (9:16 default)', undefined, [1080, 1920]],
  ] as Array<[string, [number, number] | undefined, [number, number]]>)(
    '%s: passes the design canvas to CaptionPreview',
    (_label, resolution, expected) => {
      renderPreview(resolution)
      expect(captionProps.length).toBeGreaterThan(0)
      expect(captionProps[captionProps.length - 1].designCanvas).toEqual(expected)
    },
  )
})
