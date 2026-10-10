/**
 * §190 T3: the hook's audio elements in mixer mode. A lane the preview mixer's
 * plan covers gets no `<audio>` element (the mixer plays it); a lane the plan
 * left out keeps exactly today's element; an overlay-track video's sound is
 * the mixer's only when the plan covers its source (`audioInMix`). The engine
 * is faked at the seam this hook sees: `onMixerChange`, as the engine
 * publishes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { EditorProject as Project } from '../../../schema'
import type { EngineStatus, MixerState } from '../../../engine'

Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
  configurable: true,
  get(this: HTMLMediaElement & { __paused?: boolean }) { return this.__paused !== false },
})
HTMLMediaElement.prototype.play = function (this: HTMLMediaElement & { __paused?: boolean }) {
  this.__paused = false
  return Promise.resolve()
}
HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement & { __paused?: boolean }) {
  this.__paused = true
}

;(window as unknown as { AudioContext: unknown }).AudioContext = class {
  state = 'running'
  destination = {}
  resume() { return Promise.resolve() }
  createMediaElementSource() { return { connect() {} } }
  createGain() { return { gain: { value: 1 }, connect() {} } }
}

interface FakeEngine {
  deps: {
    onTime?: (t: number, raw?: number) => void
    onStatusChange?: (s: EngineStatus) => void
    onMixerChange?: (s: MixerState) => void
    mixer?: false | object
  }
  transport: EngineStatus['transport']
  play(): void
}

const engines = vi.hoisted(() => [] as FakeEngine[])

vi.mock('../../../engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../engine')>()
  return {
    ...actual,
    createEngine: (_project: Project, deps: FakeEngine['deps']) => {
      const status = (): EngineStatus => ({ transport: engine.transport, picture: 'video', clipId: null, seeking: false, clock: 'audio' })
      const engine = {
        deps,
        transport: 'paused' as EngineStatus['transport'],
        attach: () => {},
        play: () => { engine.transport = 'playing'; deps.onStatusChange?.(status()) },
        pause: () => { engine.transport = 'paused'; deps.onStatusChange?.(status()) },
        seek: () => {},
        setRate: () => {},
        updateProject: () => {},
        status,
        clock: { now: () => 0, playing: false, kind: 'audio' as const },
        stats: () => ({ fps: 0, dropped: 0, buffered: 0, clock: 'audio' as const }),
        acquireDemux: () => Promise.reject(new Error('no demux here')),
        dispose: () => {},
      }
      engines.push(engine)
      return engine
    },
  }
})

import { useEnginePlayback } from '../useEnginePlayback'

const MUSIC = '/media/music.mp3'
const VO = '/media/vo.wav'

function project(id = 'p'): Project {
  return {
    id,
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [{ id: 'main', items: [{ id: 'c', type: 'video', src: '/media/a.mov', proxySrc: '/p/a.mp4', start: 0, end: 10 }] }],
    audio: {
      tracks: [
        { id: 'music', src: MUSIC, start: 0, end: 10, inPoint: 0, volume: 1 },
        { id: 'vo', src: VO, start: 0, end: 10, inPoint: 0, volume: 1 },
      ],
    },
  } as unknown as Project
}

const mixing = (unconformedLanes: string[] = [], unconformedOverlays: string[] = []): MixerState => ({
  active: true,
  unconformedLanes: new Set(unconformedLanes),
  unconformedOverlays: new Set(unconformedOverlays),
})

describe('useEnginePlayback in mixer mode', () => {
  let RealAudio: typeof Audio
  const elements: HTMLAudioElement[] = []

  beforeEach(() => {
    engines.length = 0
    elements.length = 0
    RealAudio = window.Audio
    ;(window as unknown as { Audio: unknown }).Audio = class extends RealAudio {
      constructor(src?: string) {
        super(src)
        elements.push(this as unknown as HTMLAudioElement)
      }
    }
  })
  afterEach(() => {
    ;(window as unknown as { Audio: unknown }).Audio = RealAudio
    delete (window as unknown as { __montajSharedCtx?: unknown }).__montajSharedCtx
  })

  function setup(muted = false) {
    const view = renderHook(({ p }: { p: Project }) => useEnginePlayback(p, 0, () => {}, (path) => path, muted), {
      initialProps: { p: project() },
    })
    return { view, engine: engines[engines.length - 1] }
  }

  /** Elements still loading a lane: a removed one has its `src` cleared. */
  const live = () => elements.filter((el) => (el.getAttribute('src') ?? '') !== '')

  it('a muted host builds its engine without a mixer; an audible one leaves the default', () => {
    expect(setup(true).engine.deps.mixer).toBe(false)
    expect(setup(false).engine.deps.mixer).toBeUndefined()
  })

  it("outside mixer mode every lane plays through its own element, as today", () => {
    setup()
    expect(elements).toHaveLength(2)
    expect(live()).toHaveLength(2)
  })

  it('a lane in the plan loses its element; the one the plan left out keeps the same element', () => {
    const { engine } = setup()
    const [music, vo] = elements
    act(() => { engine.deps.onMixerChange?.(mixing([VO])) })

    expect(elements).toHaveLength(2) // nothing re-created
    expect(music.paused).toBe(true)
    expect(music.getAttribute('src') ?? '').toBe('')
    expect(vo.src).toContain(VO)

    // Playing, only the left-out lane is driven.
    act(() => { engine.play() })
    act(() => { engine.deps.onTime?.(3, 3) })
    expect(vo.paused).toBe(false)
    expect(music.paused).toBe(true)
  })

  it('leaving the mixer gives the lane its element back', () => {
    const { engine } = setup()
    act(() => { engine.deps.onMixerChange?.(mixing()) })
    expect(live()).toHaveLength(0)
    act(() => { engine.deps.onMixerChange?.({ active: false, unconformedLanes: new Set(), unconformedOverlays: new Set() }) })
    expect(live()).toHaveLength(2)
  })

  it('audioInMix: an overlay video is the mixer\'s only in mixer mode, and only when the plan covers its source', () => {
    const { view, engine } = setup()
    expect(view.result.current.audioInMix('/media/broll.mov')).toBe(false)
    act(() => { engine.deps.onMixerChange?.(mixing([], ['/media/pending.mov'])) })
    expect(view.result.current.audioInMix('/media/broll.mov')).toBe(true)
    expect(view.result.current.audioInMix('/media/pending.mov')).toBe(false)
  })

  it('a new engine (another project) starts on today\'s path', () => {
    const { view, engine } = setup()
    act(() => { engine.deps.onMixerChange?.(mixing()) })
    expect(view.result.current.audioInMix('/media/broll.mov')).toBe(true)
    view.rerender({ p: project('other') })
    expect(engines).toHaveLength(2)
    expect(view.result.current.audioInMix('/media/broll.mov')).toBe(false)
  })
})
