/**
 * SP4 T6 — `PreviewPlayer`'s flag/eligibility branch.
 *
 * Three properties, in the order the plan states them:
 *   1. flag OFF is not merely "eligible-but-unused" — the probe never runs and
 *      the two `<video>` slots render exactly as they always have;
 *   2. flag ON + ineligible → the legacy path plus ONE console line naming the
 *      reason (never a black frame, never a half-engine);
 *   3. flag ON + eligible → the canvas replaces the slots INSIDE the unchanged
 *      transform container, with the root's `isolation: isolate` and the
 *      handles/drag layer untouched.
 *
 * The engine module is mocked for the same reason as in
 * `useEnginePlayback.test.tsx`: jsdom has no WebCodecs, and what is under test
 * here is which surface mounts, not what it paints.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import PreviewPlayer from '../PreviewPlayer'
import { createPlaybackClock } from '../../playback-clock'
import { __setEngineCapabilityForTests } from '../../../engine/eligibility'
import type { EditorProject as Project } from '../../../schema'

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

function makeProject(clipOverrides: Record<string, unknown> = {}): Project {
  return {
    id: 'p-engine',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [[{ id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 4, ...clipOverrides }]],
  } as unknown as Project
}

function renderPreview(project: Project, engine?: { enabled: boolean }) {
  return render(
    <PreviewPlayer
      project={project}
      clock={createPlaybackClock(0)}
      compileOverlay={async () => (() => null) as never}
      fileUrl={(p) => p}
      engine={engine}
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
  ;(globalThis as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement.prototype.play = vi.fn(async () => {}) as never
  ;(globalThis as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement.prototype.pause = vi.fn(() => {}) as never
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

describe('PreviewPlayer engine branch', () => {
  it('flag absent → legacy slots, no probe, no console line', () => {
    const { container } = renderPreview(makeProject({ proxySrc: 'a_proxy.mp4' }))
    expect(container.querySelectorAll('video')).toHaveLength(2)
    expect(container.querySelector('canvas')).toBeNull()
    expect(console.info).not.toHaveBeenCalled()
  })

  it('flag on, project ineligible → legacy slots and exactly one console line with the reason', async () => {
    __setEngineCapabilityForTests(true)
    // No proxySrc on the only track-0 video item.
    const { container } = renderPreview(makeProject(), { enabled: true })

    await waitFor(() => expect(container.querySelectorAll('video')).toHaveLength(2))
    expect(container.querySelector('canvas')).toBeNull()
    expect(console.info).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.info).mock.calls[0][0]).toContain('no proxySrc yet')
  })

  it('flag on, browser incapable → legacy slots and the capability reason', async () => {
    __setEngineCapabilityForTests(false)
    const { container } = renderPreview(makeProject({ proxySrc: 'a_proxy.mp4' }), { enabled: true })

    await waitFor(() => expect(container.querySelectorAll('video')).toHaveLength(2))
    expect(console.info).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.info).mock.calls[0][0]).toContain('WebCodecs')
  })

  it('flag on, project eligible → canvas inside the untouched transform container', async () => {
    __setEngineCapabilityForTests(true)
    const { container } = renderPreview(makeProject({ proxySrc: 'a_proxy.mp4' }), { enabled: true })

    const canvas = await waitFor(() => {
      const c = container.querySelector('canvas')
      expect(c).not.toBeNull()
      return c!
    })
    expect(container.querySelectorAll('video')).toHaveLength(0)
    expect(console.info).not.toHaveBeenCalled()

    // The canvas sits where the active slot sat: z-index 1, inside the
    // transform container, which is itself inside the isolate root.
    expect(canvas.style.zIndex).toBe('1')
    const transformContainer = canvas.parentElement!
    expect(transformContainer.className).toBe('absolute inset-0')
    const root = transformContainer.parentElement!
    expect(root.style.isolation).toBe('isolate')

    // The play-toggle (z 10) and the paused play-button (z 100) still render
    // over it, unchanged.
    expect(root.querySelectorAll('div.absolute.inset-0.cursor-pointer')).toHaveLength(1)
    expect(root.querySelectorAll('svg')).toHaveLength(1)
  })
})
