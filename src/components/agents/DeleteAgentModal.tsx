/**
 * DeleteAgentModal — portal-based delete confirmation dialog for agents.
 * Used by all delete triggers (sidebar context menu, breadcrumb dropdown, danger zone).
 */

import type { FC } from 'react';
import { createPortal } from 'react-dom';

interface DeleteAgentModalProps {
  agentName: string;
  onConfirm: () => void;
  onClose: () => void;
}

export const DeleteAgentModal: FC<DeleteAgentModalProps> = ({ agentName, onConfirm, onClose }) => {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-sm rounded-2xl border border-border/50 bg-popover/95 p-6 shadow-2xl backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-foreground">Delete {agentName}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Are you sure you want to delete <span className="font-medium text-foreground">{agentName}</span>? This action cannot be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-border/70 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { onConfirm(); onClose(); }}
            className="rounded-xl bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90"
          >
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
