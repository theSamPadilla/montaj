/**
 * OverlayErrorBoundary — catches render-phase errors thrown by compiled overlay JSX
 * so a single broken overlay can't crash the whole editor.
 *
 * overlay-eval's try/catch only wraps the synchronous factory call. If the factory
 * returns an element whose component is undefined (e.g. `Ph.CircuitBoard` — not a real
 * Phosphor name), React throws minified error #130 during reconciliation, escaping
 * the factory's try/catch and unmounting the entire app tree. This boundary contains
 * that fault and shows the broken overlay's filename instead.
 *
 * Auto-recovery:
 *   - `watchPath`: subscribes to /api/files/stream and clears the error on file save,
 *     so editing the overlay's source recovers the preview without a page reload.
 *   - `resetKey`: clears the error whenever this value changes between renders. Use
 *     for non-path-backed sources like caption styles or template ids.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  /** Filename or label shown in the fallback UI. */
  label: string
  /** Optional path to watch via /api/files/stream — clears the error on file change. */
  watchPath?: string
  /** Optional reset key — clears the error when its value changes between renders. */
  resetKey?: string | number
  children: ReactNode
}

interface State {
  error: Error | null
}

export default class OverlayErrorBoundary extends Component<Props, State> {
  private es: EventSource | null = null
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn(`[OverlayErrorBoundary] ${this.props.label} (render):`, error, info.componentStack)
  }

  componentDidMount() {
    this.openWatcher()
  }

  componentDidUpdate(prev: Props) {
    if (prev.watchPath !== this.props.watchPath) {
      this.closeWatcher()
      this.openWatcher()
    }
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  componentWillUnmount() {
    this.closeWatcher()
  }

  private openWatcher() {
    const { watchPath } = this.props
    if (!watchPath) return
    this.es = new EventSource(`/api/files/stream?path=${encodeURIComponent(watchPath)}`)
    this.es.onmessage = () => {
      if (this.state.error) this.setState({ error: null })
    }
  }

  private closeWatcher() {
    this.es?.close()
    this.es = null
  }

  render() {
    if (this.state.error) {
      return (
        <div className="absolute inset-0 flex items-end justify-center p-2 pointer-events-none z-50">
          <div className="bg-red-950/85 border border-red-700 text-red-300 text-[11px] px-3 py-2 rounded font-mono max-w-full">
            <div className="truncate">overlay error: {this.props.label}</div>
            <div className="truncate opacity-75">{this.state.error.message}</div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
