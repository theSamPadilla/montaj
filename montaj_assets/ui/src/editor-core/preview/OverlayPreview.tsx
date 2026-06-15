/**
 * editor-core/preview/OverlayPreview
 *
 * Host-agnostic React component that compiles and renders a JSX overlay
 * template using Montaj's existing overlay-eval pipeline.
 *
 * Prop shape mirrors mission-control's OverlayPreview, but is backed by
 * Montaj's lib/overlay-eval (Babel transpile + per-src cache) instead of
 * MC's fetch-based variant. No network call to MC is made.
 *
 * States:
 *   - Compiling  → `loading` node (default: spinner with role="status").
 *   - Compile or runtime error → `errorState` node (default: red badge with role="alert").
 *   - Success    → factory output element.
 */

import React, { useEffect, useState } from 'react'
import { compileOverlay, type OverlayFactory } from '@/lib/overlay-eval'

// ── Defaults ─────────────────────────────────────────────────────────────────

function DefaultSpinner(): React.ReactElement {
  return (
    <div
      role="status"
      aria-label="Loading overlay"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'rgba(255, 255, 255, 0.65)',
      }}
    >
      <svg
        width="36"
        height="36"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <g>
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
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
   * Path to the overlay template file. Passed directly to compileOverlay,
   * which fetches via /api/files?path=… when not already an absolute URL.
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
