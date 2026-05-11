import { useState, type FC } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangleIcon, XIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import type { Workspace } from '../../../electron/config/schema';

interface DeleteWorkspaceDialogProps {
  workspace: Workspace | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const DeleteWorkspaceDialog: FC<DeleteWorkspaceDialogProps> = ({
  workspace,
  open,
  onOpenChange,
}) => {
  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const isMatch = workspace ? confirmText === workspace.name : false;

  const handleDelete = async () => {
    if (!isMatch || !workspace) return;
    setIsDeleting(true);
    try {
      await app.workspaces.delete({ id: workspace.id });
      onOpenChange(false);
    } finally {
      setIsDeleting(false);
      setConfirmText('');
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setConfirmText('');
    onOpenChange(nextOpen);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:pointer-events-none" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[10000] w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border/70 bg-popover/95 p-5 shadow-2xl backdrop-blur-md data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:pointer-events-none">
          <div className="flex items-center justify-between">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-foreground">
              <AlertTriangleIcon size={18} className="text-destructive" />
              Delete workspace
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                <XIcon size={16} />
              </button>
            </Dialog.Close>
          </div>

          <Dialog.Description asChild>
            <div className="mt-3 space-y-2 text-sm text-muted-foreground">
              <p>
                This will permanently remove <strong className="text-foreground">{workspace?.name}</strong> from
                your workspaces. Conversations and tasks scoped to this workspace will become unscoped.
              </p>
              <p className="text-xs text-muted-foreground/70">
                Your files on disk will not be affected — only the workspace
                metadata is deleted.
              </p>
            </div>
          </Dialog.Description>

          <div className="mt-4">
            <label className="text-xs font-medium text-muted-foreground">
              Type <strong className="text-foreground">{workspace?.name}</strong> to confirm:
            </label>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={workspace?.name ?? ''}
              autoFocus
              className="mt-1 w-full rounded-lg border border-border/70 bg-background/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/30 outline-none focus:border-destructive/50 focus:ring-1 focus:ring-destructive/20"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && isMatch && !isDeleting) {
                  void handleDelete();
                }
              }}
            />
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-lg px-3.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={!isMatch || isDeleting}
              onClick={handleDelete}
              className="rounded-lg bg-destructive px-3.5 py-1.5 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-40"
            >
              {isDeleting ? 'Deleting…' : 'Delete Workspace'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
