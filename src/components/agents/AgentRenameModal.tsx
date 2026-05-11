/**
 * AgentRenameModal — portal-based rename dialog for agents.
 * Matches the same pattern as RenameChatModal.
 */

import { useState, type FC } from 'react';
import { createPortal } from 'react-dom';

interface AgentRenameModalProps {
  initialValue: string;
  onSave: (newName: string) => void;
  onClose: () => void;
}

export const AgentRenameModal: FC<AgentRenameModalProps> = ({ initialValue, onSave, onClose }) => {
  const [value, setValue] = useState(initialValue);

  const handleSave = () => {
    const trimmed = value.trim();
    if (trimmed) onSave(trimmed);
    else onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-sm rounded-2xl border border-border/50 bg-popover/95 p-6 shadow-2xl backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-foreground">Rename agent</h2>
        <input
          ref={(el) => { if (el) setTimeout(() => { el.focus(); el.select(); }, 50); }}
          className="mt-4 w-full rounded-xl border border-border/70 bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/40"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
            if (e.key === 'Escape') onClose();
          }}
        />
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
            onClick={handleSave}
            className="rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/90"
          >
            Rename
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
