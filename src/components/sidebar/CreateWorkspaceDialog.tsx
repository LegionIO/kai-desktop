import { useState, type FC } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { FolderIcon, XIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const CreateWorkspaceDialog: FC<CreateWorkspaceDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const [name, setName] = useState('');
  const [directory, setDirectory] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBrowse = async () => {
    setError(null);
    const result = await app.workspaces.browseDirectory();
    if (result) {
      setDirectory(result.path);
      if (!name.trim()) {
        setName(result.name);
      }
    }
  };

  const handleCreate = async () => {
    if (!name.trim() || !directory) return;
    setIsCreating(true);
    setError(null);
    try {
      await app.workspaces.create({ name: name.trim(), directory });
      onOpenChange(false);
      // Reset form
      setName('');
      setDirectory('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setIsCreating(false);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setName('');
      setDirectory('');
      setError(null);
    }
    onOpenChange(nextOpen);
  };

  const isValid = name.trim().length > 0 && directory.length > 0;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:pointer-events-none" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[10000] w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border/70 bg-popover/95 p-5 shadow-2xl backdrop-blur-md data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:pointer-events-none">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-foreground">
              New Workspace
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

          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            A workspace links to a directory on your machine and scopes chats and tasks to that project.
          </Dialog.Description>

          {/* Name field */}
          <div className="mt-4">
            <label className="text-xs font-medium text-muted-foreground">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project"
              autoFocus
              className="mt-1 w-full rounded-lg border border-border/70 bg-background/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && isValid && !isCreating) {
                  void handleCreate();
                }
              }}
            />
          </div>

          {/* Directory field */}
          <div className="mt-3">
            <label className="text-xs font-medium text-muted-foreground">
              Directory
            </label>
            <div className="mt-1 flex gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border/70 bg-background/50 px-3 py-2">
                {directory ? (
                  <>
                    <FolderIcon size={14} className="shrink-0 text-muted-foreground/60" />
                    <span className="truncate text-sm text-foreground">{directory}</span>
                  </>
                ) : (
                  <span className="text-sm text-muted-foreground/40">/path/to/project</span>
                )}
              </div>
              <button
                type="button"
                onClick={handleBrowse}
                className="shrink-0 rounded-lg border border-border/70 bg-background/50 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                Browse…
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <p className="mt-2 text-xs text-destructive">{error}</p>
          )}

          {/* Actions */}
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
              disabled={!isValid || isCreating}
              onClick={handleCreate}
              className="rounded-lg bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
            >
              {isCreating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
