/**
 * The preview frame stays W:H in a parent of any shape.
 *
 * It was `h-full max-w-full` plus `aspect-ratio`, which stops being W:H as soon
 * as the parent is narrower than the frame's aspect: the width clamps, the
 * height does not. A 16:9 project in the editor with its panels open played
 * squashed on the engine path, whose canvas fills the frame. See `fitBox.ts`.
 *
 * jsdom does no layout, so these check the contract the browser lays out: the
 * frame's parent is a size container and the frame takes the contain-fit width,
 * with nothing left that pins its height. The browser measurement is in the
 * commit that added this file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import PreviewPlayer from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import { __setEngineCapabilityForTests } from '../../../engine/eligibility'
import type { EditorProject as Project, VisualItem } from '../../../schema'
import { FIT_PARENT_STYLE, fitBoxStyle } from '../fitBox'
import { getOverlayDesignCanvas } from '../../design-canvas'

vi.mock('../../../engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../engine')>()
  return {
    ...actual,
    createEngine: () => ({
      attach() {},
      play() {},
      pause() {},
      seek() {},
      updateProject() {},
      status: () => ({ transport: 'paused', picture: 'black', clipId: null, seeking: false, clock: 'fallback' }),
      clock: { now: () => 0, playing: false, kind: 'fallback' },
      stats: () => ({ fps: 0, dropped: 0, buffered: 0, clock: 'fallback' }),
      dispose() {},
    }),
  }
})

const clip = { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 4, inPoint: 0 } as unknown as VisualItem

function renderPreview(resolution: [number, number], engine: boolean) {
  const project = { id: 'p', status: 'draft', settings: { resolution, fps: 30 }, tracks: [[clip]] } as unknown as Project
  return render(
    <PreviewPlayer
      project={project}
      clock={createPlaybackClock(0)}
      compileOverlay={async () => (() => null) as never}
      fileUrl={(p) => p}
      engine={engine ? { enabled: true } : undefined}
    />,
  )
}

beforeEach(() => {
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
  __setEngineCapabilityForTests(null)
})

describe('fitBoxStyle', () => {
  it('is the smaller of the full width and the width the full height allows', () => {
    expect(fitBoxStyle(1920, 1080)).toEqual({
      aspectRatio: '1920 / 1080',
      width: 'min(100cqw, calc(100cqh * 1920 / 1080))',
    })
  })
})

describe.each([
  ['legacy <video>', false],
  ['engine canvas', true],
])('PreviewPlayer frame (%s)', (_label, engine) => {
  for (const resolution of [[1920, 1080], [1080, 1920]] as [number, number][]) {
    it(`${resolution.join('x')}: contain-fitted in a size container, height not pinned`, () => {
      if (engine) __setEngineCapabilityForTests(true)
      const { container } = renderPreview(resolution, engine)
      const frame = container.querySelector('[data-montaj-preview-frame]') as HTMLElement | null
      expect(frame).not.toBeNull()
      // The old box pinned its height and clamped only its width.
      expect(frame!.className).not.toMatch(/\bh-full\b/)
      expect(frame!.className).not.toMatch(/\bmax-w-full\b/)
      const [w, h] = getOverlayDesignCanvas(resolution)
      // Read back through a scratch element: jsdom folds the calc() to one term.
      const expected = document.createElement('div')
      expected.style.width = fitBoxStyle(w, h).width as string
      expect(frame!.style.width).toBe(expected.style.width)
      expect(frame!.style.width).toMatch(/^min\(100cqw, /)
      expect(frame!.style.height).toBe('')
      expect(frame!.getAttribute('style')).toContain(`aspect-ratio: ${w} / ${h}`)
      const parent = frame!.parentElement as HTMLElement
      expect(parent.getAttribute('style')).toContain(`container-type: ${FIT_PARENT_STYLE.containerType}`)
    })
  }
})
