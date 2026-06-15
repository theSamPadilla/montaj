/**
 * editor-core/preview/OverlayPreview — unit tests.
 *
 * overlay-eval is mocked at the module level so we never hit fetch, Babel,
 * or any file system. Each test controls what compileOverlay resolves to.
 */

import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import type { OverlayFactory } from '@/lib/overlay-eval'

// ── Mock overlay-eval ────────────────────────────────────────────────────────

vi.mock('@/lib/overlay-eval', () => ({
  compileOverlay: vi.fn(),
}))

import { compileOverlay } from '@/lib/overlay-eval'

const mockCompileOverlay = compileOverlay as Mock

// ── Import component under test ──────────────────────────────────────────────

import { OverlayPreview } from '../OverlayPreview'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Factory that returns a simple div with a test id. */
const trivialFactory: OverlayFactory = (_frame, _fps, _duration, _props) =>
  React.createElement('div', { 'data-testid': 'overlay-output' }, 'hello overlay')

const DEFAULT_PROPS = {
  template: '/path/to/overlay.jsx',
  props: { text: 'hi' },
  frame: 0,
  fps: 30,
  duration: 60,
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OverlayPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows a loading state while compiling', async () => {
    // compileOverlay never resolves during this test
    mockCompileOverlay.mockReturnValue(new Promise(() => {}))

    render(<OverlayPreview {...DEFAULT_PROPS} />)

    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('renders the factory output when compilation succeeds', async () => {
    mockCompileOverlay.mockResolvedValue(trivialFactory)

    render(<OverlayPreview {...DEFAULT_PROPS} />)

    await waitFor(() =>
      expect(screen.getByTestId('overlay-output')).toBeInTheDocument(),
    )
    expect(screen.getByTestId('overlay-output')).toHaveTextContent('hello overlay')
  })

  it('passes frame/fps/duration/props to the factory', async () => {
    const factorySpy = vi.fn(trivialFactory)
    mockCompileOverlay.mockResolvedValue(factorySpy)

    render(
      <OverlayPreview
        template="/t.jsx"
        props={{ color: 'red' }}
        frame={12}
        fps={24}
        duration={90}
      />,
    )

    await waitFor(() => expect(factorySpy).toHaveBeenCalled())
    expect(factorySpy).toHaveBeenCalledWith(12, 24, 90, expect.objectContaining({ color: 'red' }))
  })

  it('surfaces an error badge when compileOverlay rejects', async () => {
    mockCompileOverlay.mockRejectedValue(new Error('bad JSX syntax'))

    render(<OverlayPreview {...DEFAULT_PROPS} />)

    await waitFor(() =>
      expect(screen.getByRole('alert')).toBeInTheDocument(),
    )
    // Error badge should be visible; the message is truncated
    const alert = screen.getByRole('alert')
    expect(alert).toBeInTheDocument()
  })

  it('surfaces an error badge when the factory throws at render time', async () => {
    const throwingFactory: OverlayFactory = () => {
      throw new Error('runtime render error')
    }
    mockCompileOverlay.mockResolvedValue(throwingFactory)

    render(<OverlayPreview {...DEFAULT_PROPS} />)

    await waitFor(() =>
      expect(screen.getByRole('alert')).toBeInTheDocument(),
    )
  })

  it('re-compiles when template changes', async () => {
    const factory1: OverlayFactory = () =>
      React.createElement('div', { 'data-testid': 'v1' }, 'v1')
    const factory2: OverlayFactory = () =>
      React.createElement('div', { 'data-testid': 'v2' }, 'v2')

    mockCompileOverlay.mockResolvedValueOnce(factory1).mockResolvedValueOnce(factory2)

    const { rerender } = render(
      <OverlayPreview {...DEFAULT_PROPS} template="/overlay-v1.jsx" />,
    )
    await waitFor(() => expect(screen.getByTestId('v1')).toBeInTheDocument())

    rerender(<OverlayPreview {...DEFAULT_PROPS} template="/overlay-v2.jsx" />)
    await waitFor(() => expect(screen.getByTestId('v2')).toBeInTheDocument())

    expect(mockCompileOverlay).toHaveBeenCalledTimes(2)
  })

  it('accepts a custom loading node', async () => {
    mockCompileOverlay.mockReturnValue(new Promise(() => {}))

    render(
      <OverlayPreview
        {...DEFAULT_PROPS}
        loading={<div data-testid="custom-loading">Loading…</div>}
      />,
    )

    expect(screen.getByTestId('custom-loading')).toBeInTheDocument()
  })

  it('accepts a custom errorState node', async () => {
    mockCompileOverlay.mockRejectedValue(new Error('boom'))

    render(
      <OverlayPreview
        {...DEFAULT_PROPS}
        errorState={<div data-testid="custom-error">Error!</div>}
      />,
    )

    await waitFor(() =>
      expect(screen.getByTestId('custom-error')).toBeInTheDocument(),
    )
  })
})
