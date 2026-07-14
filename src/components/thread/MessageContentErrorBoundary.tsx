import { Component, type ReactNode, type ErrorInfo } from 'react';

type Props = {
  children: ReactNode;
  /**
   * A value that changes whenever the message's content changes (e.g. the part
   * count). When it changes after an error, the boundary resets and re-renders
   * its children — so a TRANSIENT render error (assistant-ui's tapClientLookup
   * throwing on a momentarily stale part index during rapid streaming updates)
   * self-heals on the next content update instead of staying broken.
   */
  resetKey: unknown;
};

type State = { errored: boolean; lastResetKey: unknown };

/**
 * Localized error boundary around a single assistant message's rendered content.
 *
 * assistant-ui renders each content part via a positionally-keyed PartByIndex
 * client. During a fast streaming turn with many interleaved text/tool parts,
 * the content array is rebuilt on every delta; a mounted PartByIndex can briefly
 * reference an index beyond the (momentarily shorter) array, and
 * `tapClientLookup` throws `Index N out of bounds`. Unguarded, that render error
 * propagates to the top-level boundary and blanks the whole app mid-stream.
 *
 * This boundary contains the blast radius to the one message and auto-recovers:
 * when `resetKey` changes (the next content update), it clears the error and
 * re-renders — so the transient race no longer crashes the thread.
 */
export class MessageContentErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { errored: false, lastResetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { errored: true };
  }

  // Clear the error the moment a new resetKey arrives (runs BEFORE render, so the
  // children re-render fresh on the same commit — a plain componentDidUpdate
  // reset would re-run the already-errored fiber instead).
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.lastResetKey) {
      return { errored: false, lastResetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn(
      '[MessageContentErrorBoundary] recovered from a message-content render error:',
      error.message,
      info.componentStack,
    );
  }

  render() {
    if (this.state.errored) {
      return <span className="text-xs italic text-muted-foreground/60">rendering…</span>;
    }
    return this.props.children;
  }
}
