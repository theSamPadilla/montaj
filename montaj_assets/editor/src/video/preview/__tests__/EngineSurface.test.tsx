/**
 * SP4 T7 — the Preparing placeholder's show-delay and the debug HUD's gate.
 *
 * `EngineSurface`'s canvas plumbing (attach identity, z-index, transform
 * container placement) is T6's concern and already covered by
 * `PreviewPlayer.engine.test.tsx`. What's new here: the placeholder must
 * survive a sustained `preparing` but never flash for a one-tick transitional
 * one, and the HUD must render only when `debugHud` is truthy.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import EngineSurface from '../EngineSurface'
import type { EngineStats } from '../../../engine'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const noStats = () => null as EngineStats | null

describe('EngineSurface Preparing placeholder', () => {
  it('does not show for `video`, even well past the show-delay', () => {
    vi.useFakeTimers()
    render(<EngineSurface attach={() => {}} picture="video" getStats={noStats} />)
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(screen.queryByText('Preparing preview…')).toBeNull()
  })

  it('does not show for `black` or `opaque`', () => {
    vi.useFakeTimers()
    const { rerender } = render(<EngineSurface attach={() => {}} picture="black" getStats={noStats} />)
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(screen.queryByText('Preparing preview…')).toBeNull()

    rerender(<EngineSurface attach={() => {}} picture="opaque" getStats={noStats} />)
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(screen.queryByText('Preparing preview…')).toBeNull()
  })

  it('shows once `preparing` has been sustained past the show-delay', () => {
    vi.useFakeTimers()
    render(<EngineSurface attach={() => {}} picture="preparing" reason="no editing proxy yet" getStats={noStats} />)

    // Not yet — still inside the delay window.
    act(() => { vi.advanceTimersByTime(100) })
    expect(screen.queryByText('Preparing preview…')).toBeNull()

    act(() => { vi.advanceTimersByTime(200) })
    expect(screen.getByText('Preparing preview…')).toBeTruthy()
    expect(screen.getByText('Preparing preview…').closest('.montaj-engine-preparing')?.getAttribute('title')).toBe(
      'no editing proxy yet',
    )
  })

  it('never shows for a one-tick transitional `preparing` inside a boundary swap', () => {
    vi.useFakeTimers()
    const { rerender } = render(<EngineSurface attach={() => {}} picture="video" getStats={noStats} />)

    rerender(<EngineSurface attach={() => {}} picture="preparing" getStats={noStats} />)
    act(() => { vi.advanceTimersByTime(50) })
    // Resolves before the delay elapses — the very next clip's session landed.
    rerender(<EngineSurface attach={() => {}} picture="video" getStats={noStats} />)
    act(() => { vi.advanceTimersByTime(5_000) })

    expect(screen.queryByText('Preparing preview…')).toBeNull()
  })

  it('hides immediately when `preparing` resolves after already being shown', () => {
    vi.useFakeTimers()
    const { rerender } = render(<EngineSurface attach={() => {}} picture="preparing" getStats={noStats} />)
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByText('Preparing preview…')).toBeTruthy()

    rerender(<EngineSurface attach={() => {}} picture="video" getStats={noStats} />)
    expect(screen.queryByText('Preparing preview…')).toBeNull()
  })
})

describe('EngineSurface debug HUD gate', () => {
  it('renders nothing when `debugHud` is absent or false', () => {
    const { container, rerender } = render(
      <EngineSurface attach={() => {}} picture="video" getStats={noStats} />,
    )
    expect(container.querySelector('.montaj-engine-debug-hud')).toBeNull()

    rerender(<EngineSurface attach={() => {}} picture="video" debugHud={false} getStats={noStats} />)
    expect(container.querySelector('.montaj-engine-debug-hud')).toBeNull()
  })

  it('renders fps/dropped/buffered/clock when `debugHud` is true', () => {
    const stats: EngineStats = { fps: 29.97, dropped: 3, buffered: 5, clock: 'audio' }
    const { container } = render(
      <EngineSurface attach={() => {}} picture="video" debugHud getStats={() => stats} />,
    )
    const hud = container.querySelector('.montaj-engine-debug-hud')
    expect(hud).not.toBeNull()
    expect(hud!.textContent).toContain('fps 30.0')
    expect(hud!.textContent).toContain('dropped 3')
    expect(hud!.textContent).toContain('buffered 5')
    expect(hud!.textContent).toContain('clock audio')
  })

  it('renders regardless of the Preparing placeholder', () => {
    vi.useFakeTimers()
    const stats: EngineStats = { fps: 0, dropped: 0, buffered: 0, clock: 'fallback' }
    const { container } = render(
      <EngineSurface attach={() => {}} picture="preparing" debugHud getStats={() => stats} />,
    )
    act(() => { vi.advanceTimersByTime(300) })
    expect(container.querySelector('.montaj-engine-debug-hud')).not.toBeNull()
    expect(container.querySelector('.montaj-engine-preparing')).not.toBeNull()
  })
})
