/// <reference types="vitest/globals" />
/**
 * When the base clip's blur is drawn at all (PreviewPlayer `blurred`): only
 * while the picture shows and the playhead is inside the clip. `activeClip`
 * falls back to the last clip in a gap and past the end, where the slots go
 * to opacity 0 and the engine clears to black; a spin or zoom surface there
 * would keep showing the last frame it drew. And on the engine path the
 * Preparing placeholder and the HUD render outside the wrapper a spin or zoom
 * surface hides.
 */
import { act, render, waitFor } from '@testing-library/react'
import PreviewPlayer from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import { __setEngineCapabilityForTests } from '../../../engine/eligibility'
import type { EngineDeps, EngineStatus } from '../../../engine'
import type { EditorProject, VisualItem } from '../../../schema'

vi.mock('../radialBlurGL', async (importOriginal) => {
  const real = await importOriginal<typeof import('../radialBlurGL')>()
  return {
    ...real,
    radialBlurAvailable: () => true,
    onRadialBlurRestored: () => () => {},
    watchVideoFrames: () => () => {},
    drawRadialBlur: vi.fn(() => 'drawn'),
  }
})

let deps: EngineDeps | null = null
let status: EngineStatus = { transport: 'paused', picture: 'video', clipId: 'c0', seeking: false, clock: 'fallback' } as EngineStatus
vi.mock('../../../engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../engine')>()
  return {
    ...actual,
    createEngine: (_p: unknown, d: EngineDeps) => {
      deps = d
      return {
        attach() {},
        play() {},
        pause() {},
        seek() {},
        updateProject() {},
        setRate() {},
        status: () => status,
        clock: { now: () => 0, playing: false, kind: 'fallback' },
        stats: () => ({ fps: 0, dropped: 0, buffered: 0, clock: 'fallback' }),
        mixerScrub: () => null,
        dispose() {},
      }
    },
  }
})

const spin = { blur: 30, blurType: 'spin', sourceWidth: 1080, sourceHeight: 1920 }
const clip = (id: string, start: number, end: number, over: Record<string, unknown> = {}) =>
  ({ id, type: 'video', src: `${id}.mp4`, start, end, inPoint: 0, ...spin, ...over }) as unknown as VisualItem

function project(items: VisualItem[], id = 'p'): EditorProject {
  return { id, status: 'draft', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [items] } as unknown as EditorProject
}

function renderAt(p: EditorProject, t: number, engine?: { enabled: boolean; debugHud?: boolean }) {
  return render(
    <PreviewPlayer project={p} clock={createPlaybackClock(t)} compileOverlay={async () => (() => null) as never}
      fileUrl={(x) => x} engine={engine} />,
  )
}

const surface = (root: ParentNode) => root.querySelector('canvas[data-montaj-radial-blur]')
const back = (root: ParentNode) => root.querySelector('[data-montaj-blur-back]') as HTMLElement

beforeEach(() => {
  deps = null
  status = { transport: 'paused', picture: 'video', clipId: 'c0', seeking: false, clock: 'fallback' } as EngineStatus
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private cb: (entries: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 270, height: 480 } }]) }
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

describe('the base clip blur only inside the clip, while the picture shows (legacy path)', () => {
  it('inside the clip: the surface draws', () => {
    const { container } = renderAt(project([clip('c0', 0, 3), clip('c1', 5, 10)]), 1)
    expect(surface(container)).not.toBeNull()
  })

  it('in a gap: no surface, the slots stay as they are (opacity 0 through the gap)', () => {
    const { container } = renderAt(project([clip('c0', 0, 3), clip('c1', 5, 10)]), 4)
    expect(surface(container)).toBeNull()
    expect(back(container).style.opacity).toBe('')
  })

  it('past the end: no surface', () => {
    const { container } = renderAt(project([clip('c0', 0, 3)]), 7)
    expect(surface(container)).toBeNull()
  })
})

describe('the base clip blur on the engine path', () => {
  const engineProject = (over: Record<string, unknown> = {}) => project([clip('c0', 0, 10, { proxySrc: 'c0p.mp4', ...over })], 'pe')

  async function mounted(p: EditorProject, engine: { enabled: boolean; debugHud?: boolean } = { enabled: true }) {
    __setEngineCapabilityForTests(true)
    const r = renderAt(p, 1, engine)
    await waitFor(() => expect(r.container.querySelector('canvas[data-montaj-engine-canvas]')).not.toBeNull())
    act(() => deps!.onStatusChange?.({ ...status }))
    return r
  }

  it('a picture that turns black or preparing (the engine clears): the surface goes, its last frame with it', async () => {
    const { container } = await mounted(engineProject())
    expect(surface(container)).not.toBeNull()
    act(() => deps!.onStatusChange?.({ ...status, picture: 'black' }))
    expect(surface(container)).toBeNull()
    expect(back(container).style.opacity).toBe('')
    act(() => deps!.onStatusChange?.({ ...status, picture: 'video' }))
    expect(surface(container)).not.toBeNull()
  })

  it('the Preparing placeholder shows with a spin blur: outside the hidden wrapper', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { container } = await mounted(engineProject())
      act(() => deps!.onStatusChange?.({ ...status, picture: 'preparing' }))
      act(() => { vi.advanceTimersByTime(500) })
      const placeholder = container.querySelector('.montaj-engine-preparing') as HTMLElement
      expect(placeholder).not.toBeNull()
      expect(back(container).contains(placeholder)).toBe(false)
      // Nothing it sits in is hidden.
      for (let el: HTMLElement | null = placeholder; el; el = el.parentElement) expect(el.style.opacity).not.toBe('0')
    } finally {
      vi.useRealTimers()
    }
  })

  it('the debug HUD stays visible while a spin surface hides the canvas', async () => {
    const { container } = await mounted(engineProject(), { enabled: true, debugHud: true })
    expect(surface(container)).not.toBeNull()
    expect(back(container).style.opacity).toBe('0')
    const hud = container.querySelector('.montaj-engine-debug-hud') as HTMLElement | null
    expect(hud).not.toBeNull()
    expect(back(container).contains(hud)).toBe(false)
  })
})
