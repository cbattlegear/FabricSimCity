import { Component, createRef, type ReactNode } from 'react'

type Props = { label: string; children: ReactNode }
type State = { hasError: boolean }

/**
 * Catches failures from lazily-loaded surfaces (rejected dynamic import() chunks
 * or a render error inside the loaded module). A bare <Suspense> only handles the
 * pending state, so without this boundary a chunk-load failure would unmount the
 * whole app with no recovery path. On error it renders a focused role="alert" so
 * assistive technology announces the failure, and offers an explicit reload.
 */
export class ChunkErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }
  private readonly alertRef = createRef<HTMLDivElement>()

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidUpdate(_prevProps: Props, prevState: State): void {
    if (this.state.hasError && !prevState.hasError) this.alertRef.current?.focus()
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    return (
      <section className="chunk-error" role="alert" tabIndex={-1} ref={this.alertRef}>
        <strong>{this.props.label}</strong>
        <p>
          This part of the page failed to load. This can happen after a network interruption or an
          application update. Check your connection, then reload the page.
        </p>
        <button type="button" onClick={() => window.location.reload()}>Reload page</button>
      </section>
    )
  }
}
