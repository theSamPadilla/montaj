/**
 * editor-core/preview/OverlayPreview — unit tests.
 *
 * The overlay compiler is injected via the `compileOverlay` prop so no module
 * mock is needed. Each test passes its own fake compiler directly.
 */

import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { OverlayFactory } from '../../types'

// ── Import component under test ──────────────────────────────────────────────

import { OverlayPreview } from '../OverlayPreview'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Factory that returns a simple div with a test id. */
const trivialFactory: OverlayFactory = (_frame, _fps, _duration, _props) =>
  React.createElement('div', { 'data-testid': 'overlay-output' }, 'hello overlay')

/** A compileOverlay prop that always resolves with the given factory. */
const makeCompiler =
  (factory: OverlayFactory) =>
  (_template: string): Promise<OverlayFactory> =>
    Promise.resolve(factory)

/** A compileOverlay prop that always rejects with the given error. */
const makeFailingCompiler =
  (message: string) =>
  (_template: string): Promise<OverlayFactory> =>
    Promise.reject(new Error(message))

/** A compileOverlay prop that never resolves (simulates in-flight). */
const pendingCompiler = (_template: string): Promise<OverlayFactory> =>
  new Promise(() => {})

const DEFAULT_PROPS = {
  template: '/path/to/overlay.jsx',
  props: { text: 'hi' },
  frame: 0,
  fps: 30,
  duration: 60,
  compileOverlay: makeCompiler(trivialFactory),
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
    render(<OverlayPreview {...DEFAULT_PROPS} compileOverlay={pendingCompiler} />)

    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('renders the factory output when compilation succeeds', async () => {
    render(<OverlayPreview {...DEFAULT_PROPS} />)

    await waitFor(() =>
      expect(screen.getByTestId('overlay-output')).toBeInTheDocument(),
    )
    expect(screen.getByTestId('overlay-output')).toHaveTextContent('hello overlay')
  })

  it('passes frame/fps/duration/props to the factory', async () => {
    const factorySpy = vi.fn(trivialFactory)

    render(
      <OverlayPreview
        template="/t.jsx"
        props={{ color: 'red' }}
        frame={12}
        fps={24}
        duration={90}
        compileOverlay={makeCompiler(factorySpy)}
      />,
    )

    await waitFor(() => expect(factorySpy).toHaveBeenCalled())
    expect(factorySpy).toHaveBeenCalledWith(12, 24, 90, expect.objectContaining({ color: 'red' }))
  })

  it('surfaces an error badge when compileOverlay rejects', async () => {
    render(
      <OverlayPreview
        {...DEFAULT_PROPS}
        compileOverlay={makeFailingCompiler('bad JSX syntax')}
      />,
    )

    await waitFor(() =>
      expect(screen.getByRole('alert')).toBeInTheDocument(),
    )
    const alert = screen.getByRole('alert')
    expect(alert).toBeInTheDocument()
  })

  it('surfaces an error badge when the factory throws at render time', async () => {
    const throwingFactory: OverlayFactory = () => {
      throw new Error('runtime render error')
    }

    render(
      <OverlayPreview
        {...DEFAULT_PROPS}
        compileOverlay={makeCompiler(throwingFactory)}
      />,
    )

    await waitFor(() =>
      expect(screen.getByRole('alert')).toBeInTheDocument(),
    )
  })

  it('re-compiles when template changes', async () => {
    const factory1: OverlayFactory = () =>
      React.createElement('div', { 'data-testid': 'v1' }, 'v1')
    const factory2: OverlayFactory = () =>
      React.createElement('div', { 'data-testid': 'v2' }, 'v2')

    const compilerSpy = vi.fn()
    compilerSpy.mockResolvedValueOnce(factory1).mockResolvedValueOnce(factory2)

    const { rerender } = render(
      <OverlayPreview {...DEFAULT_PROPS} template="/overlay-v1.jsx" compileOverlay={compilerSpy} />,
    )
    await waitFor(() => expect(screen.getByTestId('v1')).toBeInTheDocument())

    rerender(<OverlayPreview {...DEFAULT_PROPS} template="/overlay-v2.jsx" compileOverlay={compilerSpy} />)
    await waitFor(() => expect(screen.getByTestId('v2')).toBeInTheDocument())

    expect(compilerSpy).toHaveBeenCalledTimes(2)
  })

  it('accepts a custom loading node', async () => {
    render(
      <OverlayPreview
        {...DEFAULT_PROPS}
        compileOverlay={pendingCompiler}
        loading={<div data-testid="custom-loading">Loading…</div>}
      />,
    )

    expect(screen.getByTestId('custom-loading')).toBeInTheDocument()
  })

  it('accepts a custom errorState node', async () => {
    render(
      <OverlayPreview
        {...DEFAULT_PROPS}
        compileOverlay={makeFailingCompiler('boom')}
        errorState={<div data-testid="custom-error">Error!</div>}
      />,
    )

    await waitFor(() =>
      expect(screen.getByTestId('custom-error')).toBeInTheDocument(),
    )
  })
})
