/**
 * The one-way legacy → engine upgrade (`useEngineMode` in `PreviewPlayer.tsx`).
 *
 * A host can mount the editor while an agent is still building the project:
 * no clip has a `proxySrc` yet, so the load-time verdict is legacy. When the
 * proxies land the project qualifies, and the preview must move to the engine
 * without a reload, under four rules:
 *   - never while playing (it waits for the pause);
 *   - the playhead and the selection survive the move, and nothing starts
 *     playing because of it;
 *   - it never goes back (engine → legacy is not a thing this adds);
 *   - it is not a re-evaluation on every edit.
 *
 * Harness copied from `PreviewPlayer.engine.test.tsx`: the engine module is
 * mocked (jsdom has no WebCodecs), and what is under test is which surface is
 * mounted and what the move does to the transport and the clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, fireEvent, waitFor } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import PreviewPlayer, { type TransportHandle } from '../PreviewPlayer'
import { createPlaybackClock, type PlaybackClock } from '../../playback-clock'
import { __setEngineCapabilityForTests } from '../../../engine/eligibility'
import type { EditorProject as Project } from '../../../schema'

const engineSpy = vi.hoisted(() => ({
  created: [] as Array<{ startProjectS?: number }>,
  play: vi.fn(),
}))

vi.mock('../../../engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../engine')>()
  return {
    ...actual,
    createEngine: (_project: unknown, deps: { startProjectS?: number }) => {
      engineSpy.created.push(deps)
      return {
        attach() {},
        play: engineSpy.play,
        pause() {},
        seek() {},
        setRate() {},
        updateProject() {},
        status: () => ({ transport: 'paused', picture: 'black', clipId: null, seeking: false, clock: 'fallback' }),
        clock: { now: () => deps.startProjectS ?? 0, playing: false, kind: 'fallback' },
        stats: () => ({ fps: 0, dropped: 0, buffered: 0, clock: 'fallback' }),
        dispose() {},
      }
    },
  }
})

/** The same project before and after its proxy lands: one id, one clip. */
function makeProject(proxied: boolean, end = 4): Project {
  return {
    id: 'p-building',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [[{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end, ...(proxied ? { proxySrc: 'a_proxy.mp4' } : {}) }]],
  } as unknown as Project
}

interface Harness {
  clock: PlaybackClock
  transportRef: MutableRefObject<TransportHandle | null>
  onPlayingChange: ReturnType<typeof vi.fn>
  onOverlayChange: ReturnType<typeof vi.fn>
  onSelectCaption: ReturnType<typeof vi.fn>
  rerenderWith: (project: Project) => void
  container: HTMLElement
}

function mount(project: Project, playhead = 2.5): Harness {
  const clock = createPlaybackClock(playhead)
  const transportRef: MutableRefObject<TransportHandle | null> = { current: null }
  const onPlayingChange = vi.fn()
  const onOverlayChange = vi.fn()
  const onSelectCaption = vi.fn()
  const ui = (p: Project) => (
    <PreviewPlayer
      project={p}
      clock={clock}
      compileOverlay={async () => (() => null) as never}
      fileUrl={(path) => path}
      engine={{ enabled: true }}
      // The on-screen clip is selected, so its transform handles render: the
      // visible proof that the selection survived the move.
      selectedOverlayId="c0"
      onOverlayChange={onOverlayChange}
      onSelectCaption={onSelectCaption}
      transportRef={transportRef}
      onPlayingChange={onPlayingChange}
    />
  )
  const { container, rerender } = render(ui(project))
  return { clock, transportRef, onPlayingChange, onOverlayChange, onSelectCaption, rerenderWith: (p) => rerender(ui(p)), container }
}

const onLegacy = (c: HTMLElement) => c.querySelectorAll('video').length === 2 && c.querySelector('canvas') === null
const onEngine = (c: HTMLElement) => c.querySelectorAll('video').length === 0 && c.querySelector('canvas') !== null
/** The four corner handles of the selected clip's on-canvas transform box. */
const selectionHandles = (c: HTMLElement) => c.querySelectorAll('[style*="nwse-resize"]').length

/** Let the (microtask) eligibility probe resolve and every effect it queues run. */
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

beforeEach(() => {
  engineSpy.created.length = 0
  engineSpy.play.mockClear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement.prototype.play = vi.fn(async () => {}) as never
  ;(globalThis as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement.prototype.pause = vi.fn(() => {}) as never
  ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
    state = 'running'
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createMediaElementSource() { return { connect() {}, disconnect() {} } }
    get destination() { return {} }
    resume() { return Promise.resolve() }
    close() {}
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  __setEngineCapabilityForTests(null)
})

describe('PreviewPlayer legacy → engine upgrade', () => {
  it('moves to the engine once the proxies land, keeping the playhead and the selection, starting nothing', async () => {
    __setEngineCapabilityForTests(true)
    const h = mount(makeProject(false))
    await waitFor(() => expect(onLegacy(h.container)).toBe(true))
    expect(selectionHandles(h.container)).toBe(4)
    expect(h.clock.get()).toBe(2.5)

    h.rerenderWith(makeProject(true))
    await waitFor(() => expect(onEngine(h.container)).toBe(true))
    await settle()

    // Playhead: untouched in the host's clock, and the engine was built AT it.
    expect(h.clock.get()).toBe(2.5)
    expect(engineSpy.created.map((d) => d.startProjectS)).toEqual([2.5])
    // Selection: the same clip is still selected, and nothing asked the host
    // to change or clear a selection.
    expect(selectionHandles(h.container)).toBe(4)
    expect(h.onOverlayChange).not.toHaveBeenCalled()
    expect(h.onSelectCaption).not.toHaveBeenCalled()
    // No playback started: neither path's play(), and the transport says paused.
    expect(engineSpy.play).not.toHaveBeenCalled()
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
    expect(h.onPlayingChange.mock.calls.every(([p]) => p === false)).toBe(true)
    expect(h.transportRef.current?.isPlaying()).toBe(false)
    // The load-time line only; the upgrade itself is silent.
    expect(console.info).toHaveBeenCalledTimes(1)
  })

  it('waits for the pause when the proxies land mid-playback', async () => {
    __setEngineCapabilityForTests(true)
    const h = mount(makeProject(false))
    await waitFor(() => expect(onLegacy(h.container)).toBe(true))

    // The browser's own `play` event on the active slot: legacy is now playing.
    fireEvent.play(h.container.querySelectorAll('video')[0])
    await waitFor(() => expect(h.transportRef.current?.isPlaying()).toBe(true))

    h.rerenderWith(makeProject(true))
    await settle()
    expect(onLegacy(h.container)).toBe(true)
    expect(engineSpy.created).toHaveLength(0)

    // Pause, the way the browser reports it.
    fireEvent.pause(h.container.querySelectorAll('video')[0])
    await waitFor(() => expect(onEngine(h.container)).toBe(true))
    await settle()
    expect(engineSpy.created).toHaveLength(1)
    expect(engineSpy.play).not.toHaveBeenCalled()
    expect(h.transportRef.current?.isPlaying()).toBe(false)
  })

  it('never goes back: a clip losing its proxy after the upgrade keeps the engine', async () => {
    __setEngineCapabilityForTests(true)
    const h = mount(makeProject(false))
    await waitFor(() => expect(onLegacy(h.container)).toBe(true))
    h.rerenderWith(makeProject(true))
    await waitFor(() => expect(onEngine(h.container)).toBe(true))

    h.rerenderWith(makeProject(false, 5))
    await settle()
    expect(onEngine(h.container)).toBe(true)
    expect(engineSpy.created).toHaveLength(1)
  })

  it('a browser that cannot run the engine stays on legacy, says so once, and is not re-probed on later edits', async () => {
    __setEngineCapabilityForTests(false)
    const h = mount(makeProject(false))
    await waitFor(() => expect(onLegacy(h.container)).toBe(true))
    expect(console.info).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.info).mock.calls[0][0]).toContain('no proxySrc yet')

    h.rerenderWith(makeProject(true))
    await settle()
    expect(onLegacy(h.container)).toBe(true)
    expect(console.info).toHaveBeenCalledTimes(2)
    expect(vi.mocked(console.info).mock.calls[1][0]).toContain('WebCodecs')

    // Ordinary edits, and the proxy flickering away and back: no new probe.
    h.rerenderWith(makeProject(true, 5))
    h.rerenderWith(makeProject(false, 5))
    h.rerenderWith(makeProject(true, 6))
    await settle()
    expect(onLegacy(h.container)).toBe(true)
    expect(console.info).toHaveBeenCalledTimes(2)
    expect(engineSpy.created).toHaveLength(0)
  })
})
