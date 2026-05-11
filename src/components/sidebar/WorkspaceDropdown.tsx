import { useState, type FC, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  CheckIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { cn } from '@/lib/utils';
import { InlineRenameInput } from './InlineRenameInput';
import type { Workspace } from '../../../electron/config/schema';

// ── Single workspace row ─────────────────────────────────────────────────

const WorkspaceRow: FC<{
  workspace: Workspace;
  isActive: boolean;
  onSelect: () => void;
  onRequestDelete: (workspace: Workspace) => void;
}> = ({ workspace, isActive, onSelect, onRequestDelete }) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const handleRename = async (newName: string) => {
    await app.workspaces.rename({ id: workspace.id, name: newName });
    setIsRenaming(false);
  };

  return (
    <DropdownMenu.Item
      className={cn(
        'group relative flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none transition-colors',
        'cursor-default data-[highlighted]:bg-muted/70',
      )}
      onSelect={(e) => {
        if (isRenaming || overflowOpen) {
          e.preventDefault();
          return;
        }
        onSelect();
      }}
    >
      {/* Color icon */}
      <div
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
        style={{ backgroundColor: workspace.color }}
      >
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="0.5" y="2" width="8" height="1" rx="0.5" fill="rgba(255,255,255,0.85)" />
          <rect x="0.5" y="4" width="8" height="1" rx="0.5" fill="rgba(255,255,255,0.85)" />
          <rect x="0.5" y="6" width="5.5" height="1" rx="0.5" fill="rgba(255,255,255,0.85)" />
        </svg>
      </div>

      {/* Name or rename input */}
      {isRenaming ? (
        <InlineRenameInput
          defaultValue={workspace.name}
          onCommit={handleRename}
          onCancel={() => setIsRenaming(false)}
        />
      ) : (
        <span className="flex-1 truncate text-foreground">{workspace.name}</span>
      )}

      {/* Active checkmark */}
      {isActive && !isRenaming && (
        <CheckIcon size={14} className="shrink-0 text-muted-foreground/60" />
      )}

      {/* Overflow menu (visible on hover or when open) */}
      {!isRenaming && (
        <DropdownMenu.Root open={overflowOpen} onOpenChange={setOverflowOpen}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                'rounded p-0.5 text-muted-foreground/40 transition-opacity hover:text-muted-foreground',
                overflowOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
              )}
            >
              <MoreHorizontalIcon size={14} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="right"
              align="start"
              sideOffset={4}
              className="z-[10001] min-w-[140px] rounded-xl border border-border/70 bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-md"
            >
              <DropdownMenu.Item
                className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors data-[highlighted]:bg-muted/70"
                onSelect={(e) => {
                  e.preventDefault();
                  setOverflowOpen(false);
                  setIsRenaming(true);
                }}
              >
                <PencilIcon size={13} className="text-muted-foreground" />
                Rename
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-destructive outline-none transition-colors data-[highlighted]:bg-destructive/10"
                onSelect={() => {
                  // Let Radix close the dropdown naturally (cleans up body pointer-events)
                  // then open the delete dialog after the close completes
                  setTimeout(() => onRequestDelete(workspace), 0);
                }}
              >
                <Trash2Icon size={13} />
                Delete…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </DropdownMenu.Item>
  );
};

// ── Workspace Dropdown ───────────────────────────────────────────────────

interface WorkspaceDropdownProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (workspaceId: string) => void;
  onCreateNew: () => void;
  onRequestDelete: (workspace: Workspace) => void;
  trigger: ReactNode;
}

export const WorkspaceDropdown: FC<WorkspaceDropdownProps> = ({
  workspaces,
  activeWorkspaceId,
  open,
  onOpenChange,
  onSelect,
  onCreateNew,
  onRequestDelete,
  trigger,
}) => {
  // Sort by last-used first
  const sorted = [...workspaces].sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        {trigger}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-[9999] w-[var(--radix-dropdown-menu-trigger-width)] min-w-[200px] rounded-xl border border-border/70 bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-md"
        >
          {sorted.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground/50">
              No workspaces yet
            </div>
          ) : (
            sorted.map((ws) => (
              <WorkspaceRow
                key={ws.id}
                workspace={ws}
                isActive={ws.id === activeWorkspaceId}
                onSelect={() => onSelect(ws.id)}
                onRequestDelete={onRequestDelete}
              />
            ))
          )}

          <DropdownMenu.Separator className="my-1 h-px bg-border/50" />

          <DropdownMenu.Item
            className="flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground outline-none transition-colors data-[highlighted]:bg-muted/70 data-[highlighted]:text-foreground"
            onSelect={onCreateNew}
          >
            <PlusIcon size={14} />
            New workspace…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};
