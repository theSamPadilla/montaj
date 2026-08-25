/**
 * editor-core/preview/OverlayPreview
 *
 * Host-agnostic React component that compiles and renders a JSX overlay
 * template. The overlay compiler is injected via the `compileOverlay` prop so
 * this component has no dependency on any host module (no import from
 * '@/lib/overlay-eval'). The host wires in the compiler from its adapter.
 *
 * States:
 *   - Compiling  → `loading` node (default: spinner with role="status").
 *   - Compile or runtime error → `errorState` node (default: red badge with role="alert").
 *   - Success    → factory output element.
 */

import React, { useEffect, useState } from 'react'
import type { OverlayFactory } from '../types'
import { Loader } from '../ui/Loader'

// ── Defaults ─────────────────────────────────────────────────────────────────

function DefaultSpinner(): React.ReactElement {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Loader size="sm" />
    </div>
  )
}

function DefaultErrorState(): React.ReactElement {
  return (
    <div
      role="alert"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          borderRadius: 6,
          background: 'rgba(220, 38, 38, 0.15)',
          color: 'rgb(220, 38, 38)',
          fontSize: 12,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontWeight: 500,
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>overlay error</span>
      </div>
    </div>
  )
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface OverlayPreviewProps {
  /**
   * Host-supplied compiler. Receives a template path and returns a compiled
   * OverlayFactory. Injected from the adapter so editor-core never imports
   * the host's overlay-eval module directly.
   */
  compileOverlay: (template: string) => Promise<OverlayFactory>

  /**
   * Path to the overlay template file. Passed to the injected compileOverlay.
   * Matches OverlayElement.overlay.template from Montaj's schema.
   */
  template: string

  /**
   * Runtime props forwarded to the overlay factory.
   * Matches OverlayElement.overlay.props.
   */
  props: Record<string, unknown>

  /**
   * Frame number to render. Matches OverlayElement.frame or the caller's
   * scrubber position.
   */
  frame: number

  /** Frames per second. Passed to the factory alongside frame. */
  fps: number

  /**
   * Duration in frames. Passed to the factory as `durationFrames`.
   * Mirrors how SlideCanvas derives duration from element.overlay.props.duration.
   */
  duration: number

  /** Shown while compileOverlay is in-flight. Default: spinner. */
  loading?: React.ReactNode

  /** Shown on compile error or factory runtime error. Default: red badge. */
  errorState?: React.ReactNode
}

// ── Component ─────────────────────────────────────────────────────────────────

export function OverlayPreview({
  compileOverlay,
  template,
  props,
  frame,
  fps,
  duration,
  loading,
  errorState,
}: OverlayPreviewProps): React.ReactElement {
  const [factory, setFactory] = useState<OverlayFactory | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let cancelled = false
    // Reset state when template changes so the loading spinner re-appears.
    setFactory(null)
    setError(null)

    compileOverlay(template)
      .then((f) => {
        if (!cancelled) setFactory(() => f)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)))
      })

    return () => {
      cancelled = true
    }
  }, [template])

  const loadingNode = loading ?? <DefaultSpinner />
  const errorNode = errorState ?? <DefaultErrorState />

  if (error) return <>{errorNode}</>
  if (!factory) return <>{loadingNode}</>

  try {
    const out = factory(frame, fps, duration, props)
    return out ?? <>{errorNode}</>
  } catch {
    return <>{errorNode}</>
  }
}
