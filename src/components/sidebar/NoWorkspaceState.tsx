import type { FC } from 'react';
import { FolderOpenIcon } from 'lucide-react';

interface NoWorkspaceStateProps {
  onCreateWorkspace: () => void;
}

export const NoWorkspaceState: FC<NoWorkspaceStateProps> = ({ onCreateWorkspace }) => (
  <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
    <FolderOpenIcon size={44} className="text-muted-foreground/10" strokeWidth={1.2} />
    <h3 className="mt-4 text-xs font-medium text-muted-foreground/40">
      No workspace open
    </h3>
    <p className="mt-1 max-w-[180px] text-[11px] leading-relaxed text-muted-foreground/25">
      Create a workspace to organize your chats and tasks by project.
    </p>
    <button
      type="button"
      onClick={onCreateWorkspace}
      className="mt-4 rounded-lg border border-sidebar-border/60 bg-sidebar-accent/30 px-3.5 py-1.5 text-xs text-muted-foreground/60 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
    >
      Create Workspace
    </button>
  </div>
);
