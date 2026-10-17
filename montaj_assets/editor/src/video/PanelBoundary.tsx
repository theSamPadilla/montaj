import { Component, Fragment, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  /** Said in the error: "<name> hit an error." */
  name: string
  /** Sizes the error to the panel it stands in for, so the layout does not move. */
  className?: string
  style?: CSSProperties
  children?: ReactNode
}
interface State { error: Error | null; attempt: number }

/**
 * One mounted panel of the editor (preview, timeline, a side panel, the
 * inspector). When it throws, only that panel is replaced by a short error and
 * Retry; the rest of the editor keeps working. Retry mounts the panel afresh.
 * Logged through console.error, which the desktop app writes to its log.
 * Renders its children bare (no wrapper) so a panel's flex sizing is unchanged.
 */
export class PanelBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[editor panel crash] ${this.props.name}: ${error.message}\n${error.stack ?? ''}\n${info.componentStack ?? ''}`)
  }

  render() {
    const { error, attempt } = this.state
    if (!error) return <Fragment key={attempt}>{this.props.children}</Fragment>
    return (
      <div
        role="alert"
        data-testid="panel-error"
        className={`flex flex-col items-center justify-center gap-2 overflow-hidden p-3 text-center text-xs text-[var(--editor-text)] ${this.props.className ?? ''}`}
        style={this.props.style}
      >
        <span>{this.props.name} hit an error.</span>
        <button
          type="button"
          onClick={() => this.setState({ error: null, attempt: attempt + 1 })}
          className="rounded-full border border-[var(--editor-border)] px-3 py-1 font-semibold hover:border-[var(--editor-accent)]"
        >
          Retry
        </button>
      </div>
    )
  }
}

export default PanelBoundary
