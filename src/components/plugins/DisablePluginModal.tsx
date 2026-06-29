import type { FC } from 'react';
import { createPortal } from 'react-dom';

interface DisablePluginModalProps {
  /** Display name of the plugin being disabled. */
  displayName: string;
  /** Called with `persist: true` (until re-enable) or `false` (this session only). */
  onConfirm: (persist: boolean) => void;
  onCancel: () => void;
}

/**
 * Shared confirmation for disabling a plugin, offering the two disable modes
 * (persistent vs session-only). Used from the plugins list, the sidebar context
 * menu, and the breadcrumb dropdown so the UX stays identical everywhere.
 */
export const DisablePluginModal: FC<DisablePluginModalProps> = ({ displayName, onConfirm, onCancel }) =>
  createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-sm rounded-2xl border border-border/50 bg-popover/95 p-6 shadow-2xl backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-foreground">Disable plugin</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Stop <span className="font-medium text-foreground">{displayName}</span> now. Its tools and background activity
          are torn down immediately; it stays installed and keeps its settings.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => onConfirm(true)}
            className="flex flex-col items-start rounded-xl border border-border/70 px-4 py-3 text-left transition-colors hover:bg-muted/50"
          >
            <span className="text-sm font-medium text-foreground">Disable until I re-enable</span>
            <span className="text-xs text-muted-foreground">Stays disabled across restarts.</span>
          </button>
          <button
            type="button"
            onClick={() => onConfirm(false)}
            className="flex flex-col items-start rounded-xl border border-border/70 px-4 py-3 text-left transition-colors hover:bg-muted/50"
          >
            <span className="text-sm font-medium text-foreground">Disable for this session</span>
            <span className="text-xs text-muted-foreground">Re-enabled automatically next time the app starts.</span>
          </button>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-border/70 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
