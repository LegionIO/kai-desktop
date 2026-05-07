import { useState, forwardRef, type FC } from 'react';
import { ChevronDownIcon, FolderPlusIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { app } from '@/lib/ipc-client';
import { WorkspaceDropdown } from './WorkspaceDropdown';
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog';
import { DeleteWorkspaceDialog } from './DeleteWorkspaceDialog';
import type { Workspace } from '../../../electron/config/schema';

// ── Selector button (the trigger) ────────────────────────────────────────
// forwardRef so Radix DropdownMenu.Trigger asChild can attach its ref + handlers

const SelectorButton = forwardRef<
  HTMLButtonElement,
  { workspace: Workspace | null } & React.ComponentPropsWithoutRef<'button'>
>(({ workspace, className, ...props }, ref) => {
  if (!workspace) {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          'titlebar-no-drag flex items-center gap-2 rounded-full',
          'border border-dashed border-border/60',
          'px-3 py-1.5 text-sm text-muted-foreground/50',
          'transition-colors hover:border-border hover:text-muted-foreground/70',
          className,
        )}
        {...props}
      >
        <FolderPlusIcon size={14} className="shrink-0" />
        <span className="truncate text-xs">Open a workspace…</span>
      </button>
    );
  }

  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'titlebar-no-drag flex items-center gap-2 rounded-full',
        'border border-border/70 px-3 py-1.5 text-sm',
        'transition-colors hover:bg-muted/40',
        className,
      )}
      {...props}
    >
      <div
        className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded"
        style={{ backgroundColor: workspace.color }}
      >
        <svg width="10" height="10" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="1" y="2.5" width="9" height="1.2" rx="0.6" fill="rgba(255,255,255,0.85)" />
          <rect x="1" y="5" width="9" height="1.2" rx="0.6" fill="rgba(255,255,255,0.85)" />
          <rect x="1" y="7.5" width="6" height="1.2" rx="0.6" fill="rgba(255,255,255,0.85)" />
        </svg>
      </div>
      <span className="truncate text-xs font-medium text-foreground">
        {workspace.name}
      </span>
      <ChevronDownIcon size={12} className="shrink-0 text-muted-foreground/50" />
    </button>
  );
});
SelectorButton.displayName = 'SelectorButton';

// ── WorkspaceSelector (orchestrates dropdown + dialogs) ──────────────────

interface WorkspaceSelectorProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeWorkspace: Workspace | null;
}

export const WorkspaceSelector: FC<WorkspaceSelectorProps> = ({
  workspaces,
  activeWorkspaceId,
  activeWorkspace,
}) => {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Workspace | null>(null);

  const handleSelectWorkspace = async (workspaceId: string) => {
    setDropdownOpen(false);
    await app.workspaces.setActive({ id: workspaceId });
  };

  const handleCreateNew = () => {
    setDropdownOpen(false);
    setCreateOpen(true);
  };

  const handleRequestDelete = (workspace: Workspace) => {
    setDropdownOpen(false);
    setDeleteTarget(workspace);
    setDeleteOpen(true);
  };

  const handleDeleteOpenChange = (open: boolean) => {
    setDeleteOpen(open);
    if (!open) {
      // Clear target after close animation completes
      setTimeout(() => setDeleteTarget(null), 300);
    }
  };

  return (
    <>
      <WorkspaceDropdown
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        open={dropdownOpen}
        onOpenChange={setDropdownOpen}
        onSelect={handleSelectWorkspace}
        onCreateNew={handleCreateNew}
        onRequestDelete={handleRequestDelete}
        trigger={<SelectorButton workspace={activeWorkspace} />}
      />
      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
      <DeleteWorkspaceDialog
        workspace={deleteTarget}
        open={deleteOpen}
        onOpenChange={handleDeleteOpenChange}
      />
    </>
  );
};
