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
          'titlebar-no-drag mx-2.5 mt-2 mb-1 flex items-center gap-2 rounded-lg',
          'border border-dashed border-sidebar-border/60',
          'px-2.5 py-1.5 text-sm text-muted-foreground/50',
          'transition-colors hover:border-sidebar-border hover:text-muted-foreground/70',
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
        'titlebar-no-drag mx-2.5 mt-2 mb-1 flex items-center gap-2 rounded-lg',
        'px-2.5 py-1.5 text-sm',
        'transition-colors hover:bg-sidebar-accent/40',
        className,
      )}
      {...props}
    >
      <div
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
        style={{ backgroundColor: workspace.color }}
      >
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="1" y="2.5" width="9" height="1.2" rx="0.6" fill="rgba(255,255,255,0.85)" />
          <rect x="1" y="5" width="9" height="1.2" rx="0.6" fill="rgba(255,255,255,0.85)" />
          <rect x="1" y="7.5" width="6" height="1.2" rx="0.6" fill="rgba(255,255,255,0.85)" />
        </svg>
      </div>
      <span className="flex-1 truncate text-left text-xs font-medium text-sidebar-foreground">
        {workspace.name}
      </span>
      <ChevronDownIcon size={13} className="shrink-0 text-muted-foreground/60" />
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
      {deleteTarget && (
        <DeleteWorkspaceDialog
          workspace={deleteTarget}
          open={!!deleteTarget}
          onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        />
      )}
    </>
  );
};
