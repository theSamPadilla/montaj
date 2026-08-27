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
import { render, screen, waitFor } from '@testing-library/react'
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

/**
 * Two overlapping track-0 video clips — c1 starts (3) before c0 ends (5) and
 * does not contain it, a real `transitionPairs()` pair per
 * `engineRequiredReason`'s test in eligibility.test.ts. `withProxy` controls
 * whether the pair is also engine-shape-eligible, so the same fixture serves
 * both the "still building proxies" legacy case and the "engine running"
 * case.
 */
function makeCrossfadeProject(withProxy: boolean): Project {
  const proxy = withProxy ? { proxySrc: 'proxy.mp4' } : {}
  return {
    id: withProxy ? 'p-crossfade-proxy' : 'p-crossfade-no-proxy',
    status: 'draft',
    settings: { resolution: [1080, 1920], fps: 30 },
    tracks: [[
      { id: 'c0', type: 'video', src: 'a.mp4', start: 0, end: 5, ...proxy },
      { id: 'c1', type: 'video', src: 'b.mp4', start: 3, end: 8, ...proxy },
    ]],
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

describe('PreviewPlayer legacy crossfade banner (Task 10b)', () => {
  it('warns that crossfades are missing when a crossfading project falls back to legacy', async () => {
    // No proxySrc => shape-ineligible => legacy player, which cannot blend.
    renderPreview(makeCrossfadeProject(false))
    await screen.findByText(/crossfades will not appear/i)
  })

  it('shows no such warning when the engine is running', async () => {
    __setEngineCapabilityForTests(true)
    renderPreview(makeCrossfadeProject(true), { enabled: true })

    // Wait for the engine to actually take over (canvas mounted, legacy
    // <video> slots gone) before asserting the banner's absence — otherwise
    // the assertion could pass trivially on the pre-decision render.
    await waitFor(() => expect(document.querySelector('canvas')).not.toBeNull())
    expect(screen.queryByText(/crossfades will not appear/i)).toBeNull()
  })

  it('shows no such warning on a legacy project that has no crossfade', () => {
    // A single track-0 clip: engineRequiredReason is trivially null
    // (transitionPairs needs 2+ items), and the flag is absent so this is
    // legacy synchronously, same as the "flag absent" test above.
    renderPreview(makeProject())
    expect(screen.queryByText(/crossfades will not appear/i)).toBeNull()
  })
})
