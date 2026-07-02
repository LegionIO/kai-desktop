import { Component, type ReactNode, type ErrorInfo } from 'react';
import { ShieldAlertIcon } from 'lucide-react';

type Props = {
  pluginName?: string;
  /** Re-mount the subtree (clearing the error) when this key changes. */
  resetKey?: unknown;
  fallback?: (error: Error, pluginName?: string) => ReactNode;
  children: ReactNode;
};

type State = { error: Error | null };

/**
 * Scoped error boundary for plugin-rendered UI. Catches render-time exceptions
 * from plugin components (panels, modals, banners, settings, consent) so a
 * broken plugin degrades to an inline error card instead of taking down the
 * whole app via the top-level ErrorBoundary.
 */
export class PluginErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const label = this.props.pluginName ? `plugin "${this.props.pluginName}"` : 'plugin surface';
    console.error(`[PluginErrorBoundary] ${label} crashed:`, error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.props.pluginName);
      }
      return (
        <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
          <ShieldAlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {this.props.pluginName
                ? `The "${this.props.pluginName}" plugin failed to render.`
                : 'A plugin failed to render.'}
            </p>
            <p className="mt-0.5 break-words font-mono text-[10px] opacity-80">{this.state.error.message}</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
